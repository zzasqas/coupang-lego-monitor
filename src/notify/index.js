/**
 * 通知模組統一入口
 * 依 .env 的 NOTIFY_CHANNEL 決定使用哪個服務
 *   telegram        → Telegram Bot（預設，推薦）
 *   line-messaging  → LINE Messaging API
 *   none / 不設定   → 只印 log，不發通知
 */

require('dotenv').config();
const logger = require('../utils/logger');

const CHANNEL = (process.env.NOTIFY_CHANNEL || 'telegram').toLowerCase();

let notifier;
if (CHANNEL === 'telegram') {
  notifier = require('./telegram');
} else if (CHANNEL === 'line-messaging' || CHANNEL === 'line') {
  notifier = require('./line-messaging');
} else {
  notifier = {
    send:             async (msg) => { logger.info('[Notify] 無通知頻道，訊息：' + msg.slice(0, 60)); return false; },
    sendAlert:        async () => false,
    sendDailySummary: async () => false,
  };
}

module.exports = notifier;
