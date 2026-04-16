/**
 * Telegram Bot 通知模組
 *
 * 設定步驟（5分鐘）：
 *  1. 在 Telegram 搜尋 @BotFather，輸入 /newbot
 *  2. 依提示設定 Bot 名稱，取得 BOT_TOKEN（格式：123456:ABC-xxx）
 *  3. 對你剛建立的 Bot 發任意一則訊息（先加好友再說話）
 *  4. 開啟瀏覽器：https://api.telegram.org/bot{你的BOT_TOKEN}/getUpdates
 *     → 在 JSON 裡找 "chat":{"id": 你的CHAT_ID}
 *  5. 把 BOT_TOKEN 和 CHAT_ID 填入 .env
 */

require('dotenv').config();
const https = require('https');
const logger = require('../utils/logger');

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID;

/**
 * 送出純文字訊息
 * @param {string} text
 */
function send(text) {
  return new Promise((resolve) => {
    if (!BOT_TOKEN || !CHAT_ID) {
      logger.warn('[Telegram] BOT_TOKEN 或 CHAT_ID 未設定，跳過通知');
      return resolve(false);
    }

    const body = JSON.stringify({
      chat_id:    CHAT_ID,
      text,
      parse_mode: 'HTML',
    });

    const options = {
      hostname: 'api.telegram.org',
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode === 200) {
          logger.info('[Telegram] 通知已發送 ✅');
          resolve(true);
        } else {
          logger.warn(`[Telegram] 發送失敗 HTTP ${res.statusCode}: ${data.slice(0, 100)}`);
          resolve(false);
        }
      });
    });

    req.on('error', (err) => {
      logger.error(`[Telegram] 錯誤：${err.message}`);
      resolve(false);
    });

    req.write(body);
    req.end();
  });
}

/**
 * 送出格式化的折扣警報（HTML 格式，Telegram 支援）
 */
async function sendAlert(item, analysis) {
  const eolTag   = item.isEol ? '【絕版品】' : '';
  const isPchome = item.source === 'pchome';

  const typeTag = isPchome ? '🏪 PCHome 特價' :
                  analysis.alertType === 'A' ? '🔔 關注品項' : '🔥 廣域掃描';

  const lines = [
    `${typeTag} ${eolTag}<b>折扣警報！</b>`,
    `─────────────────`,
    `🧱 ${item.name || item.coupangName || item.setNumber}`,
    item.setNumber ? `組號：<code>#${item.setNumber}</code>` : '',
    ``,
    isPchome
      ? `🏪 PCHome 特價：<b>NT$${item.coupangPrice?.toLocaleString()}</b>`
      : `🛒 Coupang 現售：<b>NT$${item.coupangPrice?.toLocaleString()}</b>`,
    `📋 PCHome 定價：NT$${item.pchomeOriginal?.toLocaleString()}`,
    `📉 折扣：<b>${analysis.discountStr}</b>（${analysis.reason}）`,
  ];

  // 次要統計資訊（30天區間、歷史低）
  if (item.stats) {
    const s = item.stats;
    const statParts = [];
    if (s.low30d != null && s.high30d != null) {
      const range = s.low30d === s.high30d
        ? `NT$${s.low30d.toLocaleString()}`
        : `NT$${s.low30d.toLocaleString()} ~ NT$${s.high30d.toLocaleString()}`;
      statParts.push(`30天區間 ${range}`);
    }
    if (s.allTimeLow != null) {
      const atlStr = `NT$${s.allTimeLow.toLocaleString()}` +
        (s.allTimeLowDate ? `（${s.allTimeLowDate}）` : '');
      statParts.push(`歷史低 ${atlStr}`);
    }
    if (statParts.length > 0) {
      lines.push(`<i>${statParts.join('  ·  ')}</i>`);
    }
  }

  lines.push(
    isPchome
      ? `🔗 <a href="https://24h.pchome.com.tw/search/?q=LEGO+${item.setNumber}">前往 PCHome</a>`
      : (item.coupangUrl ? `🔗 <a href="${item.coupangUrl}">前往 Coupang</a>` : ''),
  );

  return send(lines.filter(Boolean).join('\n'));
}

/**
 * 每日無警報摘要
 */
async function sendDailySummary(scannedCount, alertCount) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const msg = [
    `🧱 <b>樂高監控每日摘要</b>`,
    now,
    `─────────────────`,
    `掃描品項：${scannedCount} 個`,
    `發現優惠：${alertCount} 筆`,
    alertCount === 0 ? '目前無符合閾值的優惠。' : '詳情見上方通知。',
  ].join('\n');
  return send(msg);
}

module.exports = { send, sendAlert, sendDailySummary };

// 直接執行：測試發送
if (require.main === module) {
  send('🧱 <b>Telegram 測試訊息</b>\n樂高監控系統連線正常 ✅')
    .then((ok) => console.log(ok ? '成功！' : '失敗，確認 .env 的 TELEGRAM_BOT_TOKEN 和 TELEGRAM_CHAT_ID'));
}
