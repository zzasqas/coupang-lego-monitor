/**
 * 週報產生與發送模組（重新設計版）
 *
 * 格式：
 *  1. !折扣快報! — 低於警報線的品項（附連結）
 *  2. 追蹤清單   — 所有有 Coupang 價格的品項，一表格，依組號升序
 *     欄位：編號 | Coupang現價(折) | PCHome特價 | 定價 | 30天區間
 *  3. 絕版品項   — 無 Coupang 上架的絕版品
 *  4. 未上架     — 非絕版但 Coupang 找不到的品項
 */

const notify   = require('../notify/index');
const settings = require('../../config/settings.json');
const logger   = require('../utils/logger');

const MSG_LIMIT = 3800;

// ── 輔助 ──────────────────────────────────────────────────────────────────────

function esc(t) {
  if (t == null) return '';
  return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtD(ratio) {
  if (ratio == null) return '  — ';
  return `${(ratio * 10).toFixed(1)}折`;
}

function ratio(price, ref) {
  if (!price || !ref) return null;
  return price / ref;
}

/** 右補空格 */
function r(s, n) { return String(s ?? '').padEnd(n, ' '); }
/** 左補空格（數字對齊） */
function l(s, n) { return String(s ?? '').padStart(n, ' '); }

// ── !折扣快報! 區塊 ──────────────────────────────────────────────────────────

function buildAlertBlock(w, pInfo, cItem, stats) {
  const sn    = w.set_number;
  const name  = esc(w.note || cItem?.name || sn);
  const price = cItem?.price ?? stats.currentPrice;
  const ref   = pInfo?.originalPrice;
  const disc  = fmtD(ratio(price, ref));
  const url   = cItem?.coupangUrl || stats.currentUrl || '';
  const eol   = pInfo?.isEol ? ' <i>(絕版)</i>' : '';

  const lines = [`🔴 <b>${sn} ${name}</b>${eol}`];
  lines.push(`  <b>${disc}</b> · NT$${price?.toLocaleString()}` +
    (ref ? `  <i>定價 NT$${ref.toLocaleString()}</i>` : ''));

  const extras = [];
  if (stats.low30d && stats.low30d !== price)
    extras.push(`30天低 NT$${stats.low30d.toLocaleString()}`);
  if (stats.allTimeLow && stats.allTimeLow !== stats.low30d)
    extras.push(`歷史低 NT$${stats.allTimeLow.toLocaleString()}`);
  if (extras.length) lines.push(`  <i>${extras.join(' · ')}</i>`);
  if (url) lines.push(`  🔗 ${url}`);

  return lines.join('\n');
}

// ── 追蹤清單表格 ──────────────────────────────────────────────────────────────
//
// 欄位（單位 NT$，省略符號）：
//
//  編號   Coupang(折)  PCH特價  定價   30天區間
//  71848  4,899(7.0)   4,899  6,999  4,899~4,899
//  76450  2,481(6.6)★  2,549  3,749  2,481~2,481
//
// ★ = 接近警報線（折扣 < 門檻+5%）
// 絕版品項以 [絕] 標示

function buildTable(rows) {
  // 表頭（flag 欄置於組號與 Coupang 價格之間，標示絕版）
  const H = [
    r('編號',  5),
    r('',      4),            // flag 欄（空白標題）
    r('Coupang(折)', 12),
    r('PCH特價', 8),
    r('定價',    7),
    '30天區間',
  ].join('  ');

  const SEP = '─'.repeat(H.length + 2);

  const lines = [H, SEP];

  for (const row of rows) {
    const { sn, price, ref, disc, below, isEol, pchSale, low30d, high30d } = row;

    // 絕版旗標欄（固定 4 字元）
    const flagCol  = r(isEol ? '[絕]' : '', 4);

    // Coupang + 折扣（★ 標示已低於警報線）
    const priceStr  = price != null ? price.toLocaleString() : '—';
    const discStr   = disc  != null ? fmtD(disc)             : '—';
    const belowMark = below ? '★' : ' ';
    const couCol    = r(`${priceStr}(${discStr})${belowMark}`, 12);

    // PCHome 特價
    const pchCol   = l(pchSale != null ? pchSale.toLocaleString() : '—', 7);

    // 定價
    const refCol   = l(ref     != null ? ref.toLocaleString()     : '—', 6);

    // 30天區間
    let rangeCol = '—';
    if (low30d != null && high30d != null) {
      rangeCol = low30d === high30d
        ? low30d.toLocaleString()
        : `${low30d.toLocaleString()}~${high30d.toLocaleString()}`;
    }

    lines.push(
      `${r(sn, 5)}  ${flagCol}  ${couCol}  ${pchCol}  ${refCol}  ${rangeCol}`
    );
  }

  return `<pre>${lines.join('\n')}</pre>`;
}

// ── 絕版品項（無 Coupang 上架） ──────────────────────────────────────────────

function buildEolSection(items) {
  return items.map(({ w, pInfo }) => {
    const sn  = w.set_number;
    const nm  = esc(w.note || sn);
    const ref = pInfo?.originalPrice;
    const src = pInfo?.priceSource === 'brickeconomy' ? '(BrickEconomy)'
              : pInfo?.priceSource === 'pchome_last'  ? '(PCHome舊紀錄)'
              : '';
    const refStr = ref
      ? `NT$${ref.toLocaleString()} <i>${src}</i>`
      : '<i>無定價</i>';
    return `${sn} ${nm}  參考 ${refStr}  <i>Coupang 未上架</i>`;
  }).join('\n');
}

// ── 主函式 ────────────────────────────────────────────────────────────────────

async function sendWeeklyReport(watchlistItems, pchomePrices, coupangWatchlist, dbModule) {
  logger.info('[週報] 開始產生週報...');

  const now     = new Date();
  const dateStr = now.toLocaleDateString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  }).replace(/\//g, '/');
  const wdays = ['週日','週一','週二','週三','週四','週五','週六'];

  let weekAlerts = 0;
  try { weekAlerts = (await dbModule.getWeekAlertCount?.()) ?? 0; } catch (_) {}

  const DIV    = '━━━━━━━━━━━━━━━';
  const header = `📊 <b>LEGO 監控週報</b> | ${dateStr} (${wdays[now.getDay()]})\n追蹤 ${watchlistItems.length} 項 · 本週警報 ${weekAlerts} 次`;

  // ── 分類品項 ──────────────────────────────────────────────────────────────

  const alertItems  = [];   // 低於警報線
  const tableRows   = [];   // 有 Coupang 價格（含絕版有上架）
  const eolNoPrice  = [];   // 絕版且 Coupang 未上架
  const notFoundSns = [];   // 非絕版，Coupang 未上架

  // 依組號數字排序
  const sorted = [...watchlistItems].sort(
    (a, b) => parseInt(a.set_number) - parseInt(b.set_number)
  );

  for (const w of sorted) {
    const sn        = w.set_number;
    const pInfo     = pchomePrices[sn] || {};
    const cItem     = coupangWatchlist[sn] || null;
    const stats     = await dbModule.getPriceStats(sn);
    const threshold = pInfo.isEol
      ? settings.thresholds.eol_item
      : settings.thresholds.normal_item;

    const price = cItem?.price ?? stats.currentPrice ?? null;
    const ref   = pInfo.originalPrice ?? null;
    const disc  = ratio(price, ref);
    const below = disc != null && disc <= threshold;

    if (below) {
      alertItems.push({ w, pInfo, cItem, stats, threshold });
    }

    if (price != null) {
      // 有 Coupang 售價 → 進表格（含已觸發警報的也要顯示，標 🔴）
      tableRows.push({
        sn,
        price,
        ref,
        disc,
        below,
        isEol:   pInfo.isEol,
        pchSale: pInfo.salePrice && pInfo.salePrice < (pInfo.originalPrice ?? Infinity)
                   ? pInfo.salePrice : null,
        low30d:  stats.low30d,
        high30d: stats.high30d,
        below,
      });
    } else if (pInfo.isEol) {
      eolNoPrice.push({ w, pInfo });
    } else {
      notFoundSns.push(sn);
    }
  }

  // ── 組裝段落 ──────────────────────────────────────────────────────────────

  const segments = [];

  // 1. !折扣快報!
  if (alertItems.length > 0) {
    segments.push(
      `${DIV}\n🚨 <b>!折扣快報!</b>\n${DIV}\n` +
      alertItems.map(({ w, pInfo, cItem, stats }) =>
        buildAlertBlock(w, pInfo, cItem, stats)
      ).join('\n\n')
    );
  }

  // 2. 追蹤清單（表格）
  if (tableRows.length > 0) {
    let sec = `${DIV}\n📋 <b>追蹤清單</b>  <i>(NT$，依組號排序)</i>\n${DIV}\n`;
    sec += buildTable(tableRows);
    const notes = [];
    if (tableRows.some(r => r.below)) notes.push('★ 低於警報線');
    if (tableRows.some(r => r.isEol)) notes.push('[絕] 絕版品');
    if (notes.length) sec += `\n<i>${notes.join('  ')}</i>`;
    segments.push(sec);
  }

  // 3. 絕版無上架
  if (eolNoPrice.length > 0) {
    segments.push(
      `${DIV}\n📦 <b>絕版未上架</b>\n${DIV}\n` +
      buildEolSection(eolNoPrice)
    );
  }

  // 4. 未上架
  if (notFoundSns.length > 0) {
    segments.push(
      `${DIV}\n⚫ <b>Coupang 未上架</b>\n${DIV}\n` +
      `<i>${notFoundSns.join(' · ')}</i>`
    );
  }

  // ── 切割 + 發送 ───────────────────────────────────────────────────────────

  const messages = [];
  let cur = header;

  for (const seg of segments) {
    const candidate = cur + '\n\n' + seg;
    if (candidate.length > MSG_LIMIT && cur !== header) {
      messages.push(cur);
      cur = header + '\n\n' + seg;
    } else {
      cur = candidate;
    }
  }
  if (cur.trim()) messages.push(cur);
  if (!messages.length) messages.push(header + '\n\n（暫無追蹤資料）');

  logger.info(`[週報] 共 ${messages.length} 則，開始發送...`);
  for (let i = 0; i < messages.length; i++) {
    logger.info(`[週報] 第 ${i+1}/${messages.length} 則（${messages[i].length} 字元）`);
    await notify.send(messages[i]);
  }
  logger.info('[週報] 發送完畢');
}

module.exports = { sendWeeklyReport };
