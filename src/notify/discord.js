/**
 * Discord Webhook 通知模組
 *
 * 設定步驟（3 分鐘）：
 *  1. 在你的 Discord 伺服器 → 想要通知的「單一頻道」→ 設定（齒輪）
 *  2. 整合 → Webhook → 新增 Webhook
 *  3. 命名（例：LEGO 監控）→ 複製 Webhook URL
 *  4. 把 URL 填入 .env 的 DISCORD_WEBHOOK_URL=
 *
 * 限制一個頻道：Webhook URL 本身就綁定一個頻道，自然只會往該頻道發。
 */

require('dotenv').config();
const https  = require('https');
const { URL } = require('url');
const logger = require('../utils/logger');

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;

const DISCORD_LIMIT = 2000;   // Discord 單則訊息字元上限

// ── HTML → Discord Markdown 轉換 ──────────────────────────────────────────────
// weekly.js / telegram.js 沿用 HTML tag（<b><i><code><pre><a>），轉成 Discord MD

function htmlToMarkdown(html) {
  if (!html) return '';
  return String(html)
    // <a href="URL">text</a> → [text](URL)
    .replace(/<a\s+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)')
    // <pre>...</pre> → ```...```
    .replace(/<pre>([\s\S]*?)<\/pre>/gi, (_, body) => '```\n' + body + '\n```')
    // <code>...</code> → `...`
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    // <b>/<strong> → **
    .replace(/<\/?(?:b|strong)>/gi, '**')
    // <i>/<em> → *
    .replace(/<\/?(?:i|em)>/gi, '*')
    // 其他標籤直接去除
    .replace(/<[^>]+>/g, '')
    // HTML entity
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// ── 低階送出 ─────────────────────────────────────────────────────────────────

function postWebhook(content) {
  return new Promise((resolve) => {
    if (!WEBHOOK_URL) {
      logger.warn('[Discord] DISCORD_WEBHOOK_URL 未設定，跳過通知');
      return resolve(false);
    }

    let url;
    try { url = new URL(WEBHOOK_URL); }
    catch (e) {
      logger.error(`[Discord] WEBHOOK URL 格式錯誤：${e.message}`);
      return resolve(false);
    }

    const body = JSON.stringify({
      content,
      allowed_mentions: { parse: [] },   // 防止意外 @everyone / 角色 ping
    });

    const options = {
      hostname: url.hostname,
      path:     url.pathname + url.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        'User-Agent':     'coupang-lego-monitor',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          logger.info('[Discord] 通知已發送 ✅');
          resolve(true);
        } else {
          logger.warn(`[Discord] 發送失敗 HTTP ${res.statusCode}: ${data.slice(0, 200)}`);
          resolve(false);
        }
      });
    });
    req.on('error', (err) => {
      logger.error(`[Discord] 錯誤：${err.message}`);
      resolve(false);
    });
    req.write(body);
    req.end();
  });
}

// ── 訊息切割（含 code block 邊界處理） ──────────────────────────────────────
// Discord 單則 2000 字上限；切割時若在 ``` 區塊內，要把該塊收尾並在下一則開頭重開。

function splitForDiscord(text, limit = DISCORD_LIMIT - 50) {
  if (text.length <= limit) return [text];

  const chunks = [];
  const lines  = text.split('\n');
  let buf      = '';
  let inFence  = false;

  const flush = () => {
    if (!buf) return;
    chunks.push(inFence ? buf + '\n```' : buf);
    buf = inFence ? '```\n' : '';
  };

  for (const line of lines) {
    const candidate = buf ? buf + '\n' + line : line;
    if (candidate.length > limit) {
      flush();
      // 重新加入這一行（若仍超限，最壞情況硬切）
      const startLine = buf ? buf + '\n' + line : line;
      if (startLine.length > limit) {
        for (let i = 0; i < startLine.length; i += limit) {
          chunks.push(startLine.slice(i, i + limit));
        }
        buf = '';
      } else {
        buf = startLine;
      }
    } else {
      buf = candidate;
    }
    // 追蹤 code fence 狀態（``` 整行開頭）
    if (/^```/.test(line)) inFence = !inFence;
  }
  if (buf) chunks.push(buf);
  return chunks;
}

// ── 對外 API ─────────────────────────────────────────────────────────────────

/**
 * 送出純文字 / 含 HTML 標籤訊息（會自動轉換為 Discord Markdown 並分割）
 */
async function send(text) {
  const md = htmlToMarkdown(text);
  const parts = splitForDiscord(md);
  let ok = true;
  for (const part of parts) {
    const r = await postWebhook(part);
    if (!r) ok = false;
  }
  return ok;
}

/**
 * 折扣警報（與 telegram.js 同 API；輸出 Discord Markdown）
 */
async function sendAlert(item, analysis) {
  const eolTag   = item.isEol ? '【絕版品】' : '';
  const isPchome = item.source === 'pchome';

  const typeTag = isPchome ? '🏪 PCHome 特價' :
                  analysis.alertType === 'A' ? '🔔 關注品項' : '🔥 廣域掃描';

  const name = item.name || item.coupangName || item.setNumber;

  const lines = [
    `${typeTag} ${eolTag}**折扣警報！**`,
    `─────────────────`,
    `🧱 ${name}`,
    item.setNumber ? `組號：\`#${item.setNumber}\`` : '',
    ``,
    isPchome
      ? `🏪 PCHome 特價：**NT$${item.coupangPrice?.toLocaleString()}**`
      : `🛒 Coupang 現售：**NT$${item.coupangPrice?.toLocaleString()}**`,
    `📋 PCHome 定價：NT$${item.pchomeOriginal?.toLocaleString()}`,
    `📉 折扣：**${analysis.discountStr}**（${analysis.reason}）`,
  ];

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
      lines.push(`*${statParts.join('  ·  ')}*`);
    }
  }

  // Discord：用 <URL> 包起可避免自動展開預覽過多次；正常連結用 [text](url)
  if (isPchome) {
    const url = `https://24h.pchome.com.tw/search/?q=LEGO+${item.setNumber}`;
    lines.push(`🔗 [前往 PCHome](${url})`);
  } else if (item.coupangUrl) {
    lines.push(`🔗 [前往 Coupang](${item.coupangUrl})`);
  }

  const content = lines.filter(Boolean).join('\n');
  const parts   = splitForDiscord(content);
  let ok = true;
  for (const p of parts) {
    const r = await postWebhook(p);
    if (!r) ok = false;
  }
  return ok;
}

/**
 * 每日無警報摘要
 */
async function sendDailySummary(scannedCount, alertCount) {
  const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
  const msg = [
    `🧱 **樂高監控每日摘要**`,
    now,
    `─────────────────`,
    `掃描品項：${scannedCount} 個`,
    `發現優惠：${alertCount} 筆`,
    alertCount === 0 ? '目前無符合閾值的優惠。' : '詳情見上方通知。',
  ].join('\n');
  return postWebhook(msg);
}

module.exports = { send, sendAlert, sendDailySummary };

// 直接執行：測試發送
if (require.main === module) {
  send('🧱 **Discord 測試訊息**\n樂高監控系統連線正常 ✅')
    .then((ok) => console.log(ok ? '成功！' : '失敗，確認 .env 的 DISCORD_WEBHOOK_URL'));
}
