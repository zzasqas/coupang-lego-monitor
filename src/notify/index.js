/**
 * 通知模組統一入口
 * 依 .env 的 NOTIFY_CHANNEL 決定使用哪個服務
 *   discord (預設)        → Discord Webhook（推薦，限定單一頻道）
 *   telegram              → Telegram Bot
 *   line-messaging        → LINE Messaging API
 *   none / 不設定         → 只印 log，不發通知
 */

require('dotenv').config();
const logger = require('../utils/logger');

const CHANNEL = (process.env.NOTIFY_CHANNEL || 'discord').toLowerCase();

let notifier;
if (CHANNEL === 'discord') {
  notifier = require('./discord');
} else if (CHANNEL === 'telegram') {
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
