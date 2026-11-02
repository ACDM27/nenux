const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.termany', 'termany.db');
console.log(`Database: ${dbPath}`);

try {
  // 以读写模式打开
  const db = new DatabaseSync(dbPath, { open: true, readonly: false });
  
  // 尝试关闭 WAL 模式
  try {
    db.exec('PRAGMA journal_mode = DELETE');
    console.log('[OK] Switched to DELETE journal mode');
  } catch (e) {
    console.log(`[WARN] Could not switch journal mode: ${e.message}`);
  }
  
  // 读取
  const row = db.prepare("SELECT value FROM app_meta WHERE key = 'agentConversations'").get();
  if (!row) {
    console.log('No agentConversations found');
    db.close();
    process.exit();
  }
  
  const conversations = JSON.parse(row.value);
  console.log(`Total: ${conversations.length}`);
  
  // 过滤
  const filtered = conversations.filter(conv => 
    !['New agent', 'New conversation', 'New bot'].includes(conv?.title)
  );
  
  const removed = conversations.length - filtered.length;
  console.log(`Removing ${removed} conversations...`);
  
  // 写入
  db.prepare("UPDATE app_meta SET value = ? WHERE key = 'agentConversations'")
    .run(JSON.stringify(filtered, null, 2));
  
  console.log(`[OK] Removed ${removed} conversations (${conversations.length} -> ${filtered.length})`);
  
  db.close();
  
} catch (e) {
  console.error(`[ERROR] ${e.message}`);
}
