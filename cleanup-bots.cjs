const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');
const db = new DatabaseSync(path.join(os.homedir(), '.termany', 'termany.db'));

// 找出所有空标题 DM 会话（有 bot 成员的）
const rows = db.prepare(
  "SELECT c.id FROM im_conversation_member cm " +
  "JOIN im_conversation c ON c.id = cm.conversation_id " +
  "WHERE cm.member_type = 'bot' AND c.type = 'dm' AND (c.title = '' OR c.title IS NULL)"
).all();

console.log('找到', rows.length, '个空 DM 会话（含 bot 成员）\n');

let deleted = 0;
for (const row of rows) {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM im_reaction WHERE message_id IN (SELECT id FROM im_message WHERE conversation_id = ?)').run(row.id);
    db.prepare('DELETE FROM im_message WHERE conversation_id = ?').run(row.id);
    db.prepare('DELETE FROM im_conversation_member WHERE conversation_id = ?').run(row.id);
    db.prepare('DELETE FROM im_conversation_state WHERE conversation_id = ?').run(row.id);
    db.prepare("DELETE FROM im_event_outbox WHERE channel = 'conversation:' || ?").run(row.id);
    db.prepare('DELETE FROM im_conversation WHERE id = ?').run(row.id);
    db.exec('COMMIT');
    deleted++;
    console.log('  已删除:', row.id);
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('  删除失败:', row.id, '-', e.message);
  }
}

console.log('\n共删除', deleted, '/', rows.length, '个会话');

// 验证：检查剩余会话
const remaining = db.prepare(
  "SELECT c.id, c.type, c.title, c.latest_seq, " +
  "(SELECT GROUP_CONCAT(cm.user_or_bot_id) FROM im_conversation_member cm WHERE cm.conversation_id = c.id AND cm.member_type = 'bot') as bots " +
  "FROM im_conversation c " +
  "WHERE c.id IN (SELECT conversation_id FROM im_conversation_member WHERE member_type = 'bot')"
).all();

console.log('\n=== 剩余含 Bot 的会话 ===');
remaining.forEach(r => {
  console.log(`  ${r.type === 'group' ? '群组' : 'DM'} "${r.title}" | Bot: ${r.bots} | 消息: ${r.latest_seq}`);
});
