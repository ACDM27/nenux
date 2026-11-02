import sqlite3
import json
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')

try:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
    cursor = conn.cursor()
    
    cursor.execute("SELECT id, data FROM workspace")
    ws_id, data_json = cursor.fetchone()
    
    data = json.loads(data_json)
    print("Workspace structure:")
    print(json.dumps(data, indent=2, ensure_ascii=False))
    
    conn.close()
    
except Exception as e:
    print(f"[ERROR] {e}")
