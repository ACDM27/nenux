const Database = require('better-sqlite3');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.termany', 'termany.db');
const db = new Database(dbPath);

// Get current agents config
const row = db.prepare("SELECT value FROM app_meta WHERE key='agents'").get();
const agents = JSON.parse(row.value);

// Find and update Codex agent
const codexIndex = agents.findIndex(a => a.id === 'codex');
if (codexIndex >= 0) {
  agents[codexIndex] = {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    args: '--dangerously-bypass-approvals-and-sandbox',
    enabled: true,
    builtIn: true,
    runtime: {
      protocol: 'chatgpt-oauth',
      model: 'gpt-5.6-sol'
    },
    runtimeRevision: 7
  };

  db.prepare("UPDATE app_meta SET value=? WHERE key='agents'").run(JSON.stringify(agents));
  console.log('✅ Codex agent updated to use chatgpt-oauth runtime');
  console.log('New config:', JSON.stringify(agents[codexIndex], null, 2));
} else {
  console.log('❌ Codex agent not found');
}

db.close();
