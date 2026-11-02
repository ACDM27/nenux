import sqlite3
import json
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')

try:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
    cursor = conn.cursor()
    
    # 尝试切换日志模式
    print("Current journal mode:")
    cursor.execute("PRAGMA journal_mode")
    print(f"  {cursor.fetchone()[0]}")
    
    # 尝试切换到 DELETE 模式（非 WAL）
    print("\nSwitching to DELETE mode...")
    cursor.execute("PRAGMA journal_mode = DELETE")
    result = cursor.fetchone()[0]
    print(f"  New mode: {result}")
    
    # 现在尝试写入
    cursor.execute("SELECT value FROM app_meta WHERE key = 'agentConversations'")
    row = cursor.fetchone()
    conversations = json.loads(row[0])
    
    filtered = [
        conv for conv in conversations
        if conv.get('title') not in ['New agent', 'New conversation', 'New bot']
    ]
    
    print(f"\nFiltering: {len(conversations)} -> {len(filtered)} conversations")
    
    new_json = json.dumps(filtered, ensure_ascii=False)
    cursor.execute(
        "UPDATE app_meta SET value = ? WHERE key = 'agentConversations'",
        (new_json,)
    )
    
    print("[OK] Updated successfully!")
    
    # 切换回 WAL 模式
    cursor.execute("PRAGMA journal_mode = WAL")
    print(f"Switched back to WAL mode: {cursor.fetchone()[0]}")
    
    conn.close()
    
except Exception as e:
    print(f"[ERROR] {e}")
    import traceback
    traceback.print_exc()
