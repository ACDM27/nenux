import sqlite3
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')
print(f"Database path: {db_path}")
print(f"File exists: {os.path.exists(db_path)}")

try:
    conn = sqlite3.connect(db_path, timeout=10)
    cursor = conn.cursor()
    
    # Try WAL checkpoint
    try:
        cursor.execute('PRAGMA wal_checkpoint(TRUNCATE)')
        result = cursor.fetchone()
        print(f"WAL checkpoint result: {result}")
    except Exception as e:
        print(f"WAL checkpoint failed: {e}")
    
    # Find empty DM conversations with bot members
    cursor.execute("""
        SELECT c.id FROM im_conversation_member cm 
        JOIN im_conversation c ON c.id = cm.conversation_id 
        WHERE cm.member_type = 'bot' AND c.type = 'dm' AND (c.title = '' OR c.title IS NULL)
    """)
    rows = cursor.fetchall()
    print(f'\nFound {len(rows)} empty DM conversations\n')
    
    deleted = 0
    for row in rows:
        conv_id = row[0]
        try:
            cursor.execute('BEGIN IMMEDIATE')
            cursor.execute('DELETE FROM im_reaction WHERE message_id IN (SELECT id FROM im_message WHERE conversation_id = ?)', (conv_id,))
            cursor.execute('DELETE FROM im_message WHERE conversation_id = ?', (conv_id,))
            cursor.execute('DELETE FROM im_conversation_member WHERE conversation_id = ?', (conv_id,))
            cursor.execute('DELETE FROM im_conversation_state WHERE conversation_id = ?', (conv_id,))
            cursor.execute("DELETE FROM im_event_outbox WHERE channel = 'conversation:' || ?", (conv_id,))
            cursor.execute('DELETE FROM im_conversation WHERE id = ?', (conv_id,))
            conn.commit()
            deleted += 1
            print(f'✅ Deleted: {conv_id}')
        except Exception as e:
            conn.rollback()
            print(f'❌ Failed: {conv_id} - {e}')
    
    print(f'\nTotal deleted: {deleted} / {len(rows)}')
    
    # Verify remaining
    cursor.execute("""
        SELECT c.id, c.type, c.title, c.latest_seq,
        (SELECT GROUP_CONCAT(cm.user_or_bot_id) FROM im_conversation_member cm WHERE cm.conversation_id = c.id AND cm.member_type = 'bot') as bots
        FROM im_conversation c
        WHERE c.id IN (SELECT conversation_id FROM im_conversation_member WHERE member_type = 'bot')
    """)
    remaining = cursor.fetchall()
    print('\n=== Remaining conversations with bots ===')
    for r in remaining:
        conv_type = 'Group' if r[1] == 'group' else 'DM'
        print(f'  {conv_type} "{r[2]}" | Bot: {r[4]} | Messages: {r[3]}')
    
    conn.close()
    print('\nDatabase closed')
    
except Exception as e:
    print(f'Error: {e}')
