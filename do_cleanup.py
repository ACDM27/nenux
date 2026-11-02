import sqlite3
import json
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')
print(f"Database: {db_path}")

try:
    conn = sqlite3.connect(db_path, timeout=30)
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
    
    # 过滤
    filtered = [
        conv for conv in conversations
        if conv.get('title') not in ['New agent', 'New conversation', 'New bot']
    ]
    
    removed = len(conversations) - len(filtered)
    print(f"Removing {removed} 'New bot' conversations...")
    
    # 更新数据库
    new_json = json.dumps(filtered, ensure_ascii=False)
    cursor.execute(
        "UPDATE app_meta SET value = ? WHERE key = 'agentConversations'",
        (new_json,)
    )
    conn.commit()
    
    print(f"[OK] Removed {removed} conversations ({len(conversations)} -> {len(filtered)})")
    
    conn.close()
    
except Exception as e:
    print(f"[ERROR] {e}")
