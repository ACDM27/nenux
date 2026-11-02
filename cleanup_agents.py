import sqlite3
import json
import os

db_path = os.path.join(os.path.expanduser('~'), '.termany', 'termany.db')
print(f"Database: {db_path}")

try:
    conn = sqlite3.connect(db_path, isolation_level=None, timeout=30)
    cursor = conn.cursor()
    
    # 读取 workspace 数据
    cursor.execute("SELECT id, pos, data FROM workspace ORDER BY pos")
    workspaces = cursor.fetchall()
    
    for ws_id, pos, data_json in workspaces:
        print(f"\n=== Workspace {ws_id} ===")
        data = json.loads(data_json)
        
        # 查找 agentConversations
        if 'agentConversations' in data:
            agents = data['agentConversations']
            print(f"Found {len(agents)} agent conversations")
            
            # 显示所有 agent 对话
            for i, agent in enumerate(agents):
                title = agent.get('title', 'NO TITLE')
                agent_id = agent.get('id', 'NO ID')
                print(f"  [{i}] {agent_id}: '{title}'")
            
            # 过滤掉"新建 Bot"的对话
            original_count = len(agents)
            filtered_agents = [
                agent for agent in agents 
                if agent.get('title') not in ['New agent', 'New conversation', 'New bot']
            ]
            removed_count = original_count - len(filtered_agents)
            
            if removed_count > 0:
                print(f"\nRemoving {removed_count} 'New bot' conversations...")
                data['agentConversations'] = filtered_agents
                
                # 更新数据库
                new_data_json = json.dumps(data, ensure_ascii=False)
                cursor.execute(
                    "UPDATE workspace SET data = ? WHERE id = ?",
                    (new_data_json, ws_id)
                )
                print(f"[OK] Updated workspace {ws_id}")
                print(f"   Before: {original_count} agents")
                print(f"   After: {len(filtered_agents)} agents")
            else:
                print("\nNo 'New bot' conversations found")
        
        conn.close()
        print("\n[OK] Done")
        
except Exception as e:
    print(f"[ERROR] {e}")
    import traceback
    traceback.print_exc()
