# Termany "新建 Bot" 清理脚本
# 使用方法：在普通 PowerShell 窗口中运行此脚本
#   powershell -ExecutionPolicy Bypass -File cleanup_termany_bots.ps1

$dbPath = Join-Path $env:USERPROFILE ".termany\termany.db"

if (-not (Test-Path $dbPath)) {
    Write-Host "[ERROR] Database not found: $dbPath" -ForegroundColor Red
    exit 1
}

Write-Host "Database: $dbPath" -ForegroundColor Cyan

try {
    # 使用 .NET SQLite
    Add-Type -Path (Join-Path $env:USERPROFILE ".termany\System.Data.SQLite.dll") -ErrorAction SilentlyContinue
    
    # 如果上面的失败了，用 node 方式
    $nodeScript = @'
const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const os = require('os');

const dbPath = path.join(os.homedir(), '.termany', 'termany.db');
const db = new DatabaseSync(dbPath, { open: true, readonly: false });

try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    console.log('[OK] WAL checkpoint done');
} catch (e) {
    console.log('[WARN] WAL checkpoint:', e.message);
}

const row = db.prepare("SELECT value FROM app_meta WHERE key = 'agentConversations'").get();
if (!row) {
    console.log('No agentConversations found');
    db.close();
    process.exit();
}

const conversations = JSON.parse(row.value);
console.log('Total:', conversations.length);

const filtered = conversations.filter(conv => 
    !['New agent', 'New conversation', 'New bot'].includes(conv?.title)
);

const removed = conversations.length - filtered.length;
console.log('Removing', removed, 'conversations...');

db.prepare("UPDATE app_meta SET value = ? WHERE key = 'agentConversations'")
    .run(JSON.stringify(filtered, null, 2));

console.log('[OK] Removed', removed, 'conversations (' + conversations.length + ' -> ' + filtered.length + ')');
db.close();
'@
    
    # 用 node 执行清理
    $tempFile = [System.IO.Path]::GetTempFileName()
    $nodeScript | Out-File -FilePath $tempFile -Encoding UTF8
    $tempFile = $tempFile -replace '\.tmp$', '.mjs'
    
    node $tempFile
    
    Remove-Item $tempFile -ErrorAction SilentlyContinue
    
} catch {
    Write-Host "[ERROR] $($_.Exception.Message)" -ForegroundColor Red
}

Write-Host "`nDone! Please restart Termany." -ForegroundColor Green
