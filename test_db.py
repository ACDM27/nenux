import sqlite3
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')
print(f"Database: {db_path}")

# 尝试直接连接并写入
try:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
    print("[OK] Connected")
    
    # 测试写入
    cursor = conn.cursor()
    
    # 查找 workspace 表中的 Agent 对话
    cursor.execute("SELECT id, pos, length(data) FROM workspace ORDER BY pos")
    workspaces = cursor.fetchall()
    print(f"Found {len(workspaces)} workspaces")
    
    for ws_id, pos, data_len in workspaces:
        print(f"  Workspace {ws_id}: pos={pos}, data_len={data_len}")
    
    conn.close()
    print("[OK] Done")
    
except Exception as e:
    print(f"[ERROR] {e}")
