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
const { createContext, searchBySetNumber } = require('../crawler/biggo');
const { analyze, formatDiscount }           = require('../analyzer/discount');

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
// 公開回覆（會留存，方便查看與測試；如要改回私密，加上 ephemeral: true）
const ephem = (content) => ({ content });

/** 把 runScan() 的結果整理成 Discord /lego scan 的回覆文字 */
function formatScanResult(r) {
  const alerts  = r.alerts || [];
  const scanned = r.scanned ?? '?';

  if (alerts.length === 0) {
    return `✅ 掃描完成：${scanned} 項，目前沒有達標優惠 🙁`;
  }

  // 分組：清單命中（A=Coupang 清單 / P=PCHome 特價）vs 廣域掃描（B，非清單，僅供參考）
  const watch = alerts.filter((a) => a.alertType === 'A' || a.alertType === 'P');
  const broad = alerts.filter((a) => a.alertType === 'B');

  const fmt = (a) => {
    const srcTag = a.source === 'pchome' ? '🏪PCHome' : '🛒Coupang';
    const eol    = a.isEol ? '🏷️' : '';
    const name   = a.name && a.name !== a.setNumber ? ` ${a.name}` : '';
    const ref    = a.ref ? `／定價NT$${a.ref.toLocaleString()}` : '';
    const price  = a.price != null ? `NT$${a.price.toLocaleString()}` : 'NT$?';
    // 連結：Coupang 用實際商品頁；PCHome 用搜尋頁（方便直接點擊購買）
    const url    = a.source === 'pchome'
      ? `https://24h.pchome.com.tw/search/?q=LEGO+${a.setNumber || ''}`
      : a.url || null;
    const link   = url ? `　[🔗前往](${url})` : '';
    return `• \`${a.setNumber || '?'}\`${eol}${name} — ${srcTag} ${price}${ref}  **${a.discountStr || ''}**${link}`;
  };

  const parts = [
    `✅ 掃描完成：${scanned} 項，發現 ${alerts.length} 筆優惠` +
      `（🎯清單 ${watch.length} 筆／🔥廣域 ${broad.length} 筆）`,
  ];

  if (watch.length) {
    parts.push('', '__🎯 追蹤清單命中__', ...watch.map(fmt));
  }
  if (broad.length) {
    parts.push('', '__🔥 廣域掃描（非你的清單，比對 Coupang 自家原價，僅供參考）__');
    parts.push(...broad.slice(0, 8).map(fmt));
    if (broad.length > 8) parts.push(`…還有 ${broad.length - 8} 筆`);
  }
  parts.push('', '_完整警報（含連結）已發到通知頻道_');

  return parts.join('\n').slice(0, 1950);
}

/** 立即現抓某一顆的 Coupang 售價（開一個瀏覽器查 BigGo） */
async function liveCheckSet(sn) {
  const { browser, context } = await createContext();
  const page = await context.newPage();
  try {
    return await searchBySetNumber(page, sn);
  } finally {
    await browser.close().catch(() => {});
  }
}

// ── Slash 指令處理（全部在 /lego 底下） ────────────────────────────────────────
async function handleCommand(interaction) {
  if (interaction.commandName !== 'lego') {
    return interaction.reply(ephem('未知指令'));
  }
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'help': {
      const cronExpr = settings.schedule?.cron || '0 */4 * * *';
      const help = [
        '🧱 **LEGO Monitor 指令說明**',
        '─────────────────',
        '**查詢**',
        '`/lego list` — 列出追蹤清單（含最近掃描的 Coupang 價/折扣/目標價/絕版標記）',
        '`/lego price set:76452` — 立即現抓 Coupang 價 + 折扣 + 歷史低',
        '`/lego scan` — 立刻手動掃描全部品項',
        '',
        '**維護清單**',
        '`/lego add set:60404 note:城市系列` — 新增（note 可填系列/備註）',
        '`/lego remove set:60404` — 永久移除',
        '`/lego disable set:60404` / `/lego enable set:60404` — 暫停 / 恢復',
        '',
        '**價格與絕版**',
        '`/lego target set:10316 price:3500` — 設目標價（price:0 = 清除）',
        '`/lego eol set:76417 enabled:True` — 標註絕版（False = 取消）',
        '`/lego resetcache` — 清除 PCHome 定價快取，下次掃描重抓（原價顯示錯誤時用）',
        '',
        '─────────────────',
        `🔔 警報門檻：一般 ${(settings.thresholds?.normal_item * 10).toFixed(1)} 折／絕版 ${(settings.thresholds?.eol_item * 10).toFixed(1)} 折（有設目標價則以目標價為準）`,
        `⏰ 自動掃描排程：\`${cronExpr}\`（${process.env.TZ || 'Asia/Taipei'}）`,
        '📢 達標警報會發到通知頻道（Webhook）',
      ].join('\n');
      return interaction.reply(ephem(help));
    }

    case 'add': {
      const set  = (interaction.options.getString('set')  || '').trim();
      const note = (interaction.options.getString('note') || '').trim();
      if (!isValidSet(set)) return interaction.reply(ephem('⚠️ 組號格式不對（4–6 位數字）'));
      await db.addWatchItem(set, note);
      return interaction.reply(ephem(`✅ 已加入追蹤：**${set}**${note ? `（${note}）` : ''}`));
    }

    case 'remove': {
      const set = (interaction.options.getString('set') || '').trim();
      const ok  = await db.removeWatchItem(set);
      return interaction.reply(ephem(ok ? `🗑️ 已移除：**${set}**` : `找不到 **${set}**`));
    }

    case 'disable': {
      const set = (interaction.options.getString('set') || '').trim();
      const ok  = await db.setWatchDisabled(set, true);
      return interaction.reply(ephem(ok ? `⏸️ 已暫停追蹤：**${set}**` : `找不到 **${set}**`));
    }

    case 'enable': {
      const set = (interaction.options.getString('set') || '').trim();
      const ok  = await db.setWatchDisabled(set, false);
      return interaction.reply(ephem(ok ? `▶️ 已恢復追蹤：**${set}**` : `找不到 **${set}**`));
    }

    case 'target': {
      const set   = (interaction.options.getString('set') || '').trim();
      const price = interaction.options.getInteger('price');
      const item  = await db.getWatchItem(set);
      if (!item) return interaction.reply(ephem(`找不到 **${set}**，請先 /lego add`));
      if (!price || price <= 0) {
        await db.setTargetPrice(set, null);
        return interaction.reply(ephem(`🎯 已清除 **${set}** 的目標價（改用全域閾值）`));
      }
      await db.setTargetPrice(set, price);
      return interaction.reply(ephem(`🎯 **${set}** 目標價設為 **NT$${price.toLocaleString()}**`));
    }

    case 'eol': {
      const set     = (interaction.options.getString('set') || '').trim();
      const enabled = interaction.options.getBoolean('enabled');
      const item    = await db.getWatchItem(set);
      if (!item) return interaction.reply(ephem(`找不到 **${set}**，請先 /lego add`));
      await db.setEol(set, enabled);
      return interaction.reply(ephem(
        enabled
          ? `🏷️ 已標註 **${set}** 為絕版品（閾值放寬到 ${(settings.thresholds?.eol_item * 10 || 6.9).toFixed(1)} 折）`
          : `🏷️ 已取消 **${set}** 的絕版標註（恢復自動判斷）`
      ));
    }

    case 'list': {
      await interaction.deferReply();
      const items = await db.getWatchlist({ includeDisabled: true });
      if (items.length === 0) return interaction.editReply('清單是空的，用 `/lego add` 新增');

      const sets = items.map((w) => w.set_number);
      const [priceMap, refMap] = await Promise.all([
        db.getLatestPrices(sets),
        db.getPchomeRefs(sets),
      ]);

      // 手機友善版：兩行式，價格縮寫（去掉 NT$，用 $ 代替）
      const $ = (n) => n != null ? `$${Number(n).toLocaleString()}` : null;

      const lines = [];
      for (const w of items) {
        const sn      = w.set_number;
        const live    = priceMap[sn];
        const ref     = refMap[sn]?.originalPrice || null;
        const pchSale = refMap[sn]?.salePrice && refMap[sn].salePrice < ref
          ? refMap[sn].salePrice : null;

        // 標記
        const tags = [
          w.is_eol       ? '🏷️絕版'  : '',
          w.target_price ? `🎯${$(w.target_price)}` : '',
          w.disabled     ? '⏸️停用' : '',
        ].filter(Boolean).join(' ');

        // 第一行：組號 + 備註 + 標記
        const note = w.note ? ` ${w.note}` : '';
        lines.push(`\`${sn}\`${note}${tags ? '  ' + tags : ''}`);

        // 第二行：定價 → PChome現售 → Coupang價(折扣)，只顯示有的欄位
        const parts = [];
        if (ref) {
          parts.push(pchSale ? `定${$(ref)}→🏪${$(pchSale)}` : `定${$(ref)}`);
        }
        if (live?.price) {
          const disc = ref ? `(${formatDiscount(live.price / ref)})` : '';
          parts.push(`🛒${$(live.price)}${disc}`);
        } else {
          parts.push('🛒—');
        }
        lines.push(`  ${parts.join('  ')}`);
      }

      const header = `📋 **追蹤清單（${items.length}）** 定=PCHome定價 🏪=現售 🛒=Coupang`;
      return interaction.editReply((header + '\n' + lines.join('\n')).slice(0, 1950));
    }

    case 'price': {
      const set = (interaction.options.getString('set') || '').trim();
      if (!isValidSet(set)) return interaction.reply(ephem('⚠️ 組號格式不對（4–6 位數字）'));
      await interaction.deferReply();

      const [item, stats, pch, live] = await Promise.all([
        db.getWatchItem(set),
        db.getPriceStats(set),
        db.getLastPchomeRecord(set),
        liveCheckSet(set).catch((e) => { logger.warn(`[price] live 失敗：${e.message}`); return null; }),
      ]);

      const ref       = pch?.original_price || live?.originalPrice || null;
      const pchSale   = pch?.sale_price && pch.sale_price < ref ? pch.sale_price : null;
      const isEol     = !!(item?.is_eol || pch?.is_eol);

      const lines = [`🧱 **${set}**${item?.note ? ` ${item.note}` : ''}${isEol ? ' 🏷️絕版' : ''}`];

      if (live?.price) {
        lines.push(`🛒 Coupang 現價：**NT$${live.price.toLocaleString()}**（即時）`);
        if (ref) {
          const a = analyze({ coupangPrice: live.price, pchomeOriginal: ref, pchomeSale: pchSale, isEol, isWatchlist: true, targetPrice: item?.target_price || null });
          lines.push(`📋 參考定價：NT$${ref.toLocaleString()}　📉 ${a.discountStr}`);
          if (pchSale) lines.push(`🏪 PCHome 現售：NT$${pchSale.toLocaleString()}`);
          lines.push(a.shouldAlert ? `🔥 **達標！** ${a.reason}` : `🟢 未達標（${a.reason}）`);
        }
        if (live.coupangUrl) lines.push(`🔗 ${live.coupangUrl}`);
      } else {
        lines.push('🛒 Coupang 即時查詢：目前找不到上架（或暫時抓取失敗）');
      }

      if (item?.target_price) lines.push(`🎯 目標價：NT$${item.target_price.toLocaleString()}`);
      if (stats.dataPoints) {
        if (stats.allTimeLow != null)
          lines.push(`📈 歷史低：NT$${stats.allTimeLow.toLocaleString()}${stats.allTimeLowDate ? `（${stats.allTimeLowDate}）` : ''}`);
        if (stats.low30d != null && stats.high30d != null)
          lines.push(`📊 30天區間：NT$${stats.low30d.toLocaleString()} ~ NT$${stats.high30d.toLocaleString()}`);
        lines.push(`_歷史資料點：${stats.dataPoints}_`);
      } else {
        lines.push('_尚無歷史資料（跑過 /lego scan 後會累積）_');
      }
      return interaction.editReply(lines.join('\n'));
    }

    case 'scan': {
      if (scanning) return interaction.reply(ephem('⏳ 已有掃描進行中，請稍候'));
      await interaction.deferReply();
      try {
        const r = await safeScan('discord /lego scan');
        if (r.skipped) return interaction.editReply('⏳ 已有掃描進行中，請稍候再試');
        return interaction.editReply(formatScanResult(r));
      } catch (err) {
        logger.error(`[Scan] /lego scan 失敗：${err.message}`);
        return interaction.editReply(`❌ 掃描失敗：${err.message}`);
      }
    }

    case 'resetcache': {
      await interaction.deferReply();
      const n = await db.expirePchomeCache();
      return interaction.editReply(
        `🔄 已清除 ${n} 筆 PCHome 定價快取（包含錯誤的絕版標記）\n` +
        `下次 /lego scan 時會重新爬取所有品項的最新定價。\n` +
        `建議清除後立刻執行 /lego scan。`
      );
    }

    default:
      return interaction.reply(ephem('未知子指令'));
  }
}

// ── 啟動 ───────────────────────────────────────────────────────────────────────
async function main() {
  await db.initDb();
  logger.info('[Bot] DB 連線成功');

  // 用 watchlist.json 回填「空白 note」（只補空的，不覆蓋 bot 改過的）
  try {
    const seed = require('../../config/watchlist.json');
    let filled = 0;
    for (const w of (seed.watchlist || [])) {
      if (w?.set_number && w?.note && await db.backfillEmptyNote(String(w.set_number), w.note)) filled++;
    }
    if (filled) logger.info(`[Bot] 已用種子檔回填 ${filled} 筆空白備註`);
  } catch (e) {
    logger.warn(`[Bot] note 回填略過：${e.message}`);
  }

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
      const msg = { content: `❌ 發生錯誤：${err.message}` };
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
