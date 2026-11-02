import sqlite3
import json
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')

try:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
    cursor = conn.cursor()
    
    # 读取 agentConversations
    cursor.execute("SELECT value FROM app_meta WHERE key = 'agentConversations'")
    row = cursor.fetchone()
    
    if not row:
        print("No agentConversations found")
        conn.close()
        exit()
    
    conversations = json.loads(row[0])
    print(f"Total agent conversations: {len(conversations)}")
    
    # 统计
    new_bot_count = 0
    other_count = 0
    
    for conv in conversations:
        title = conv.get('title', '')
        if title in ['New agent', 'New conversation', 'New bot']:
            new_bot_count += 1
        else:
            other_count += 1
    
    print(f"  'New bot' conversations: {new_bot_count}")
    print(f"  Other conversations: {other_count}")
    
    if new_bot_count > 0:
        # 过滤掉"新建 Bot"对话
        filtered = [
            conv for conv in conversations
            if conv.get('title') not in ['New agent', 'New conversation', 'New bot']
        ]
        
        # 更新数据库
        new_json = json.dumps(filtered, ensure_ascii=False)
        cursor.execute(
            "UPDATE app_meta SET value = ? WHERE key = 'agentConversations'",
            (new_json,)
        )
        
        print(f"\n[OK] Removed {new_bot_count} 'New bot' conversations")
        print(f"     Remaining: {len(filtered)} conversations")
    else:
        print("\nNo 'New bot' conversations to remove")
    
    conn.close()
    
except Exception as e:
    print(f"[ERROR] {e}")
    import traceback
    traceback.print_exc()
