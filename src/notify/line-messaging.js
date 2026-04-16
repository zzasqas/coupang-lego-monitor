/**
 * LINE Messaging API 通知模組（取代已停止的 LINE Notify）
 *
 * 設定步驟：
 *  1. 前往 https://developers.line.biz/ 登入
 *  2. 建立 Provider → 建立 Messaging API Channel
 *  3. 到 Channel 的「Messaging API」頁面，複製「Channel access token」
 *     → 填入 .env 的 LINE_CHANNEL_TOKEN=
 *
 *  4. 取得自己的 User ID（只需做一次）：
 *     a. 掃描 Channel 的 QR Code，加 Bot 好友
 *     b. 對 Bot 發任意一則訊息
 *     c. 執行：node src/notify/line-messaging.js --get-id
 *        → 會印出你的 User ID
 *     d. 把 User ID 填入 .env 的 LINE_USER_ID=
 *
 *  5. 測試：node src/notify/line-messaging.js
 *
 * 注意：Messaging API 免費版每月 200 則 Push Message
 */

require('dotenv').config();
const https = require('https');
const logger = require('../utils/logger');

const CHANNEL_TOKEN = process.env.LINE_CHANNEL_TOKEN;
const USER_ID       = process.env.LINE_USER_ID;

/** POST to LINE API */
function linePost(path, body) {
  return new Promise((resolve) => {
    const bodyStr = JSON.stringify(body);
    const options = {
      hostname: 'api.line.me',
      path,
      method:  'POST',
      headers: {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(bodyStr),
        Authorization:    `Bearer ${CHANNEL_TOKEN}`,
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.write(bodyStr);
    req.end();
  });
}

/** GET from LINE API */
function lineGet(path) {
  return new Promise((resolve) => {
    const options = {
      hostname: 'api.line.me',
      path,
      method:  'GET',
      headers: { Authorization: `Bearer ${CHANNEL_TOKEN}` },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', (err) => resolve({ status: 0, body: err.message }));
    req.end();
  });
}

/**
 * 送出文字訊息給指定 userId
 */
async function send(text) {
  if (!CHANNEL_TOKEN || !USER_ID) {
    logger.warn('[LINE] LINE_CHANNEL_TOKEN 或 LINE_USER_ID 未設定，跳過通知');
    return false;
  }

  const res = await linePost('/v2/bot/message/push', {
    to: USER_ID,
    messages: [{ type: 'text', text }],
  });

  if (res.status === 200) {
    logger.info('[LINE] 通知已發送 ✅');
    return true;
  }
  logger.warn(`[LINE] 發送失敗 HTTP ${res.status}: ${res.body.slice(0, 100)}`);
  return false;
}

/**
 * 送出格式化折扣警報
 */
async function sendAlert(item, analysis) {
  const eolTag  = item.isEol ? '【絕版品】' : '';
  const typeTag = analysis.alertType === 'A' ? '🔔 關注品項' : '🔥 廣域掃描';

  const text = [
    `${typeTag} ${eolTag}折扣警報！`,
    `─────────────────`,
    `🧱 ${item.coupangName || item.setNumber}`,
    item.setNumber ? `組號：#${item.setNumber}` : '',
    ``,
    `💰 現價：NT$${item.coupangPrice?.toLocaleString()}`,
    `📋 定價：NT$${item.pchomeOriginal?.toLocaleString()}（PCHome）`,
    `📉 折扣：${analysis.discountStr}（${analysis.reason}）`,
    item.coupangUrl ? `🔗 ${item.coupangUrl}` : '',
  ].filter(Boolean).join('\n');

  return send(text);
}

/**
 * 每日摘要
 */
async function sendDailySummary(scannedCount, alertCount) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  return send([
    `🧱 樂高監控每日摘要`,
    now,
    `─────────────────`,
    `掃描品項：${scannedCount} 個`,
    `發現優惠：${alertCount} 筆`,
    alertCount === 0 ? '目前無符合閾值的優惠。' : '詳情見上方通知。',
  ].join('\n'));
}

/**
 * 取得最近傳訊給 Bot 的使用者 userId（用來設定 LINE_USER_ID）
 */
async function getMyUserId() {
  if (!CHANNEL_TOKEN) {
    console.log('❌ 請先在 .env 設定 LINE_CHANNEL_TOKEN');
    return;
  }
  const res = await lineGet('/v2/bot/followers/ids?limit=10');
  if (res.status !== 200) {
    console.log('無法取得 follower list（需要先對 Bot 發訊息）');
    console.log('HTTP', res.status, res.body);
    return;
  }
  const data = JSON.parse(res.body);
  console.log('有傳訊給 Bot 的使用者 ID：');
  (data.userIds || []).forEach((id) => console.log(' ', id));
  if ((data.userIds || []).length === 0) {
    console.log('目前沒有。請先掃 QR Code 加 Bot 好友，然後對 Bot 傳任意一則訊息後再執行。');
  }
}

module.exports = { send, sendAlert, sendDailySummary };

// 直接執行
if (require.main === module) {
  if (process.argv.includes('--get-id')) {
    getMyUserId();
  } else {
    send('🧱 LINE Messaging API 測試訊息\n樂高監控系統連線正常 ✅')
      .then((ok) => console.log(ok ? '成功！' : '失敗，確認 .env 的設定'));
  }
}
