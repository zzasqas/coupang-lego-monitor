/**
 * Discord Bot + 排程進入點（Railway always-on service 的啟動指令）
 *
 * 職責：
 *  1. 連線 Discord，註冊並處理 slash 指令（增減品項 / 設目標價 / 查價 / 手動掃描）
 *  2. 用 node-cron 依 settings.schedule.cron 定期執行 runScan()
 *
 * 警報仍由 src/notify/discord.js 的 Webhook 發送（與本 bot 互動分離）。
 *
 * 需要環境變數：
 *   DATABASE_URL, DISCORD_BOT_TOKEN, DISCORD_APP_ID, DISCORD_GUILD_ID(選), DISCORD_WEBHOOK_URL
 */

require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const cron   = require('node-cron');

const logger   = require('../utils/logger');
const db       = require('../data/db');
const settings = require('../../config/settings.json');
const { runScan }          = require('../index');
const { registerCommands } = require('./register');

const CRON_EXPR = settings.schedule?.cron || '0 */4 * * *';   // 預設每 4 小時
const TZ        = process.env.TZ || 'Asia/Taipei';

// ── 掃描鎖：避免 cron 與 /scan 重疊執行 ───────────────────────────────────────
let scanning = false;

async function safeScan(trigger = 'cron') {
  if (scanning) {
    logger.warn(`[Scan] 已有掃描進行中，略過本次（${trigger}）`);
    return { skipped: true };
  }
  scanning = true;
  const t0 = Date.now();
  try {
    logger.info(`[Scan] 開始（觸發：${trigger}）`);
    const result = await runScan();
    logger.info(`[Scan] 完成（${((Date.now() - t0) / 1000).toFixed(0)}s）`);
    return result || {};
  } finally {
    scanning = false;
  }
}

// ── 指令回覆輔助 ───────────────────────────────────────────────────────────────
const isValidSet = (s) => /^\d{4,6}$/.test(s);

// ── Slash 指令處理 ─────────────────────────────────────────────────────────────
async function handleCommand(interaction) {
  const { commandName: cmd } = interaction;
  const get = (n) => interaction.options.get(n)?.value;

  switch (cmd) {
    case 'add': {
      const set  = String(get('set')).trim();
      const note = (get('note') || '').toString().trim();
      if (!isValidSet(set)) return interaction.reply({ content: '⚠️ 組號格式不對（4–6 位數字）', ephemeral: true });
      await db.addWatchItem(set, note);
      return interaction.reply({ content: `✅ 已加入追蹤：**${set}**${note ? `（${note}）` : ''}`, ephemeral: true });
    }

    case 'remove': {
      const set = String(get('set')).trim();
      const ok  = await db.removeWatchItem(set);
      return interaction.reply({ content: ok ? `🗑️ 已移除：**${set}**` : `找不到 **${set}**`, ephemeral: true });
    }

    case 'disable': {
      const set = String(get('set')).trim();
      const ok  = await db.setWatchDisabled(set, true);
      return interaction.reply({ content: ok ? `⏸️ 已暫停追蹤：**${set}**` : `找不到 **${set}**`, ephemeral: true });
    }

    case 'enable': {
      const set = String(get('set')).trim();
      const ok  = await db.setWatchDisabled(set, false);
      return interaction.reply({ content: ok ? `▶️ 已恢復追蹤：**${set}**` : `找不到 **${set}**`, ephemeral: true });
    }

    case 'target': {
      const set   = String(get('set')).trim();
      const price = Number(get('price'));
      const item  = await db.getWatchItem(set);
      if (!item) return interaction.reply({ content: `找不到 **${set}**，請先 /add`, ephemeral: true });
      if (price <= 0) {
        await db.setTargetPrice(set, null);
        return interaction.reply({ content: `🎯 已清除 **${set}** 的目標價（改用全域閾值）`, ephemeral: true });
      }
      await db.setTargetPrice(set, price);
      return interaction.reply({ content: `🎯 **${set}** 目標價設為 **NT$${price.toLocaleString()}**`, ephemeral: true });
    }

    case 'list': {
      const items = await db.getWatchlist({ includeDisabled: true });
      if (items.length === 0) return interaction.reply({ content: '清單是空的，用 /add 新增', ephemeral: true });
      const lines = items.map((w) => {
        const tags = [];
        if (w.target_price) tags.push(`🎯NT$${w.target_price.toLocaleString()}`);
        if (w.disabled)     tags.push('⏸️停用');
        return `\`${w.set_number}\` ${w.note || ''}${tags.length ? '  ' + tags.join(' ') : ''}`.trimEnd();
      });
      const body = `📋 **追蹤清單（${items.length}）**\n` + lines.join('\n');
      return interaction.reply({ content: body.slice(0, 1900), ephemeral: true });
    }

    case 'price': {
      const set = String(get('set')).trim();
      await interaction.deferReply({ ephemeral: true });
      const item  = await db.getWatchItem(set);
      const stats = await db.getPriceStats(set);
      if (!stats.dataPoints) {
        return interaction.editReply(`**${set}** 尚無價格紀錄${item ? '' : '（也不在追蹤清單）'}`);
      }
      const lines = [
        `🧱 **${set}**${item?.note ? ` ${item.note}` : ''}`,
        stats.currentPrice  != null ? `現價：NT$${stats.currentPrice.toLocaleString()}` : '',
        stats.allTimeLow    != null ? `歷史低：NT$${stats.allTimeLow.toLocaleString()}${stats.allTimeLowDate ? `（${stats.allTimeLowDate}）` : ''}` : '',
        (stats.low30d != null && stats.high30d != null)
          ? `30天區間：NT$${stats.low30d.toLocaleString()} ~ NT$${stats.high30d.toLocaleString()}` : '',
        item?.target_price  ? `🎯 目標價：NT$${item.target_price.toLocaleString()}` : '',
        stats.currentUrl    ? `🔗 ${stats.currentUrl}` : '',
        `_資料點：${stats.dataPoints}_`,
      ].filter(Boolean);
      return interaction.editReply(lines.join('\n'));
    }

    case 'scan': {
      if (scanning) return interaction.reply({ content: '⏳ 已有掃描進行中，請稍候', ephemeral: true });
      await interaction.deferReply({ ephemeral: true });
      try {
        const r = await safeScan('discord /scan');
        return interaction.editReply(`✅ 掃描完成：掃描 ${r.scanned ?? '?'} 項，發現 ${r.alertCount ?? 0} 筆優惠`);
      } catch (err) {
        logger.error(`[Scan] /scan 失敗：${err.message}`);
        return interaction.editReply(`❌ 掃描失敗：${err.message}`);
      }
    }

    default:
      return interaction.reply({ content: '未知指令', ephemeral: true });
  }
}

// ── 啟動 ───────────────────────────────────────────────────────────────────────
async function main() {
  await db.initDb();
  logger.info('[Bot] DB 連線成功');

  // 註冊指令（失敗不阻擋啟動）
  try {
    const r = await registerCommands({ silent: false });
    logger.info(`[Bot] 指令註冊完成（全域：${r.globalOk ? 'OK' : 'X'}，伺服器：${r.guildOk ? 'OK' : 'X'}）`);
  } catch (err) {
    logger.error(`[Bot] 指令註冊失敗：${err.message}`);
  }

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once(Events.ClientReady, (c) => {
    logger.info(`[Bot] 已上線：${c.user.tag}`);
    // 排程
    if (!cron.validate(CRON_EXPR)) {
      logger.error(`[Bot] cron 表達式無效：${CRON_EXPR}`);
    } else {
      cron.schedule(CRON_EXPR, () => {
        safeScan('cron').catch((err) => logger.error(`[Scan] cron 失敗：${err.message}`));
      }, { timezone: TZ });
      logger.info(`[Bot] 排程已設定：${CRON_EXPR}（${TZ}）`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    try {
      await handleCommand(interaction);
    } catch (err) {
      logger.error(`[Bot] 指令 ${interaction.commandName} 錯誤：${err.message}`);
      const msg = { content: `❌ 發生錯誤：${err.message}`, ephemeral: true };
      if (interaction.deferred || interaction.replied) interaction.editReply(msg).catch(() => {});
      else interaction.reply(msg).catch(() => {});
    }
  });

  await client.login(process.env.DISCORD_BOT_TOKEN);
}

main().catch((err) => {
  logger.error(`[Bot] 啟動失敗：${err.message}`);
  if (err?.stack) logger.error(err.stack);
  process.exit(1);
});
