import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import os from 'node:os';

const dbPath = path.join(os.homedir(), '.termany', 'termany.db');
const db = new DatabaseSync(dbPath, { open: true, readonly: false });

// 先检查 WAL 状态
console.log('WAL 状态:', db.prepare('PRAGMA journal_mode').get());

// 找出所有 DM 类型且标题为空的会话
const emptyDms = db.prepare("SELECT id, created_at FROM im_conversation WHERE type = 'dm' AND (title = '' OR title IS NULL) ORDER BY created_at DESC").all();
console.log('找到的空 DM 会话:', emptyDms.length);

// 删除这些会话及相关数据
let deleted = 0;
for (const dm of emptyDms) {
  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('DELETE FROM im_message WHERE conversation_id = ?').run(dm.id);
    db.prepare('DELETE FROM im_conversation_member WHERE conversation_id = ?').run(dm.id);
    db.prepare('DELETE FROM im_conversation_state WHERE conversation_id = ?').run(dm.id);
    db.prepare('DELETE FROM im_event_outbox WHERE channel = ?').run('conversation:' + dm.id);
    db.prepare('DELETE FROM im_conversation WHERE id = ?').run(dm.id);
    db.exec('COMMIT');
    deleted++;
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('删除失败:', dm.id, e.message);
  }
}
console.log('\n成功删除', deleted, '个空 DM 会话');

// 验证
const remaining = db.prepare("SELECT COUNT(*) as cnt FROM im_conversation WHERE type = 'dm' AND (title = '' OR title IS NULL)").get();
console.log('剩余空 DM 会话:', remaining.cnt);
