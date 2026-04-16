const fs   = require('fs');
const path = require('path');

// Log 檔放在 OneDrive 以外，避免同步時鎖檔衝突
// 優先：%LOCALAPPDATA%\coupang-lego-monitor\logs（本機快取，不同步）
// 備援：專案內 logs\（原路徑）
const LOCAL_LOG_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(require('os').homedir(), 'AppData', 'Local'),
  'coupang-lego-monitor',
  'logs'
);

let logDir;
try {
  if (!fs.existsSync(LOCAL_LOG_DIR)) fs.mkdirSync(LOCAL_LOG_DIR, { recursive: true });
  // 測試是否可寫入
  fs.accessSync(LOCAL_LOG_DIR, fs.constants.W_OK);
  logDir = LOCAL_LOG_DIR;
} catch (_) {
  // fallback 到專案內
  logDir = path.join(__dirname, '../../logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
}

const logFile = path.join(logDir, 'run.log');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

/** appendFileSync with EBUSY retry（OneDrive 偶爾鎖檔時重試最多 3 次） */
function appendWithRetry(line, retries = 3, delayMs = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.appendFileSync(logFile, line + '\n');
      return;
    } catch (err) {
      if (err.code === 'EBUSY' && i < retries - 1) {
        // 同步 sleep（logger 必須同步）
        const end = Date.now() + delayMs;
        while (Date.now() < end) { /* busy wait */ }
      }
      // 最後一次或非 EBUSY 錯誤：靜默失敗，console 還是有輸出
    }
  }
}

function write(level, msg) {
  const line = `[${timestamp()}] [${level}] ${msg}`;
  console.log(line);
  appendWithRetry(line);
}

const logger = {
  info:  (msg) => write('INFO ', msg),
  warn:  (msg) => write('WARN ', msg),
  error: (msg) => write('ERROR', msg),
  debug: (msg) => {
    if (process.argv.includes('--debug')) write('DEBUG', msg);
  },
  /** log 檔實際路徑（供啟動時顯示） */
  logFile,
};

module.exports = logger;
