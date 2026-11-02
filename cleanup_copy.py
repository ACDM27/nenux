import sqlite3
import os
import shutil

# 使用临时副本
db_path = os.path.join(os.environ['TEMP'], 'termany_copy.db')
print(f"Working on: {db_path}")

conn = sqlite3.connect(db_path, timeout=10)
cursor = conn.cursor()

# 查找空 DM 会话
cursor.execute("""
    SELECT c.id FROM im_conversation_member cm 
    JOIN im_conversation c ON c.id = cm.conversation_id 
    WHERE cm.member_type = 'bot' AND c.type = 'dm' AND (c.title = '' OR c.title IS NULL)
""")
rows = cursor.fetchall()
print(f'Found {len(rows)} empty DM conversations\n')

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
        print(f'[OK] Deleted: {conv_id}')
    except Exception as e:
        conn.rollback()
        print(f'[FAIL] Failed: {conv_id} - {e}')

print(f'\nTotal deleted: {deleted} / {len(rows)}')

# 验证
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

# 复制回原位置
original_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')
print(f'\nCopying back to: {original_path}')
try:
    shutil.copy2(db_path, original_path)
    print('✅ Database updated successfully!')
except Exception as e:
    print(f'❌ Failed to copy back: {e}')
