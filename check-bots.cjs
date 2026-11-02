const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const dbPath = path.join(os.homedir(), '.termany', 'termany.db');
const db = new DatabaseSync(dbPath);

console.log('=== IM Bot Members with Conversations ===\n');
const rows = db.prepare(
  "SELECT cm.conversation_id, cm.user_or_bot_id, cm.member_type, cm.role, " +
  "c.type, c.title, c.latest_seq, c.created_at " +
  "FROM im_conversation_member cm " +
  "JOIN im_conversation c ON c.id = cm.conversation_id " +
  "WHERE cm.member_type = 'bot' " +
  "ORDER BY c.created_at DESC"
).all();

for (const r of rows) {
  console.log(`Bot: ${r.user_or_bot_id} | Role: ${r.role} | Conv: ${r.conversation_id} | Type: ${r.type} | Title: "${r.title}" | Messages: ${r.latest_seq} | Created: ${new Date(r.created_at).toLocaleString('zh-CN')}`);
}

console.log('\n=== Conversations with bot members ===');
const convs = db.prepare(
  "SELECT DISTINCT c.id, c.type, c.title, c.latest_seq, c.created_at, " +
  "(SELECT GROUP_CONCAT(cm.user_or_bot_id) FROM im_conversation_member cm WHERE cm.conversation_id = c.id AND cm.member_type = 'bot') as bots " +
  "FROM im_conversation_member cm " +
  "JOIN im_conversation c ON c.id = cm.conversation_id " +
  "WHERE cm.member_type = 'bot' " +
  "ORDER BY c.created_at DESC"
).all();

for (const c of convs) {
  console.log(`Conv: ${c.id} | Bots: ${c.bots} | Type: ${c.type} | Title: "${c.title}" | Msgs: ${c.latest_seq} | Created: ${new Date(c.created_at).toLocaleString('zh-CN')}`);
}
