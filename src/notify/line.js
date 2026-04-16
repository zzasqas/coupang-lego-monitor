/**
 * LINE Notify 通知模組
 *
 * 設定方式：
 *  1. 前往 https://notify-bot.line.me/my/ 登入
 *  2. 點「發行權杖」→ 選一個聊天室（自己傳給自己 = 選「透過1對1聊天接收LINE Notify的通知」）
 *  3. 複製 Token 貼到 .env 的 LINE_NOTIFY_TOKEN=
 *
 * 使用方式：
 *   const line = require('./notify/line');
 *   await line.send('訊息內容');
 *   await line.sendAlert({ item, analysis });
 */

require('dotenv').config();
const https = require('https');
const { formatDiscount } = require('../analyzer/discount');
const logger = require('../utils/logger');

const TOKEN = process.env.LINE_NOTIFY_TOKEN;

/**
 * 送出一則純文字訊息
 * @param {string} message
 */
function send(message) {
  return new Promise((resolve, reject) => {
    if (!TOKEN) {
      logger.warn('[LINE] LINE_NOTIFY_TOKEN 未設定，跳過通知');
      return resolve(false);
    }

    const body = 'message=' + encodeURIComponent(message);
    const options = {
      hostname: 'notify-api.line.me',
      path: '/api/notify',
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
        Authorization: `Bearer ${TOKEN}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          logger.info('[LINE] 通知已發送 ✅');
          resolve(true);
        } else {
          logger.warn(`[LINE] 發送失敗 HTTP ${res.statusCode}: ${data}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      logger.error(`[LINE] 發送錯誤：${err.message}`);
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 送出格式化的折扣警報
 * @param {object} item      商品資訊
 * @param {object} analysis  折扣分析結果
 */
async function sendAlert(item, analysis) {
  const eolTag  = item.isEol ? '【絕版品】' : '';
  const typeTag = analysis.alertType === 'A' ? '🔔 關注品項' : '🔥 廣域掃描';

  const lines = [
    '',   // LINE Notify 訊息第一行會當 title，空行讓格式好看
    `${typeTag} ${eolTag}折扣警報！`,
    `───────────────`,
    `🧱 ${item.coupangName || item.setNumber}`,
    item.setNumber ? `組號：#${item.setNumber}` : '',
    ``,
    `💰 現價：NT$${item.coupangPrice?.toLocaleString()}`,
    `📋 定價：NT$${item.pchomeOriginal?.toLocaleString()}（PCHome）`,
    `📉 折扣：${analysis.discountStr}（${analysis.reason}）`,
    ``,
    item.coupangUrl ? `🔗 ${item.coupangUrl}` : '',
  ].filter(Boolean).join('\n');

  return send(lines);
}

/**
 * 送出每日摘要（無警報時）
 */
async function sendDailySummary(scannedCount, alertCount) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const msg = `\n🧱 樂高監控每日摘要\n${now}\n───────────────\n掃描品項：${scannedCount} 個\n發現優惠：${alertCount} 筆\n${alertCount === 0 ? '目前無符合閾值的優惠。' : '詳情見上方通知。'}`;
  return send(msg);
}

module.exports = { send, sendAlert, sendDailySummary };

// 直接執行：發送測試訊息
if (require.main === module) {
  send('\n🧱 LINE Notify 測試訊息\n樂高監控系統連線正常 ✅')
    .then((ok) => console.log(ok ? '成功' : '失敗（確認 .env 的 LINE_NOTIFY_TOKEN）'));
}
