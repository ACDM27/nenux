import sqlite3
import json
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')

try:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
    cursor = conn.cursor()
    
    # 列出所有表
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    tables = [r[0] for r in cursor.fetchall()]
    print("Tables:", tables)
    
    # 检查 app_meta 的所有 key
    print("\n=== app_meta keys ===")
    cursor.execute("SELECT key, length(value) FROM app_meta ORDER BY key")
    for key, length in cursor.fetchall():
        print(f"  {key}: {length} bytes")
    
    # 检查 session 相关表
    for table in ['session_cwd', 'session_scroll', 'session_screen']:
        if table in tables:
            cursor.execute(f"SELECT COUNT(*) FROM {table}")
            count = cursor.fetchone()[0]
            print(f"\n{table}: {count} rows")
    
    # 检查 im 相关表
    im_tables = [t for t in tables if t.startswith('im_')]
    print(f"\nIM tables: {im_tables}")
    
    # 读取 agents 配置
    print("\n=== agents config ===")
    cursor.execute("SELECT value FROM app_meta WHERE key = 'agents'")
    row = cursor.fetchone()
    if row:
        agents = json.loads(row[0])
        print(f"Total agents: {len(agents)}")
        for a in agents:
            print(f"  {a.get('id')}: {a.get('name')} (builtIn={a.get('builtIn')})")
    
    conn.close()
    
except Exception as e:
    print(f"[ERROR] {e}")
