// 清理 Termany "新建 Bot" 对话
// 使用方法：在普通终端中运行
//   node cleanup_bots.mjs

import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), '.termany', 'termany.db');
const db = new DatabaseSync(dbPath, { open: true, readonly: false });

// Checkpoint WAL
try {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  console.log('[OK] WAL checkpoint');
} catch (e) {
  console.log('[WARN] WAL checkpoint:', e.message);
}

const row = db.prepare("SELECT value FROM app_meta WHERE key = 'agentConversations'").get();
if (!row) {
  console.log('No data found');
  db.close();
  process.exit();
}

const conversations = JSON.parse(row.value);
console.log(`Total: ${conversations.length}`);

const filtered = conversations.filter(c => 
  !['New agent', 'New conversation', 'New bot'].includes(c?.title)
);

const removed = conversations.length - filtered.length;
console.log(`Removing ${removed} "New bot" conversations...`);

db.prepare("UPDATE app_meta SET value = ? WHERE key = 'agentConversations'")
  .run(JSON.stringify(filtered, null, 2));

console.log(`[OK] Done! ${conversations.length} -> ${filtered.length}`);
db.close();
