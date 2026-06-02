# Railway 搬遷實作計劃

> 目標：把 Coupang LEGO 監控從「本機 + GitHub Actions 週末 cron」搬到 **Railway always-on 服務**，
> 加上 **Discord Bot 互動**（增減品項、設目標價、查價），並用 **PostgreSQL** 持久化。
>
> 已確認決策：
> - 持久化：**Railway PostgreSQL**（不佔 volume 配額、不影響 ArkRecord Sniff）
> - 自動掃描頻率：**每 4 小時**（一天 6 次）
> - 通知：警報續用 **Discord Webhook**；指令用新增的 **Discord Bot**

---

## 0. 目標架構

```
Railway Project
├── Service: lego-monitor   (always-on, Docker = Playwright image)
│   ├── src/bot/index.js     ← 進入點：啟動 Discord Bot + node-cron
│   ├── Discord Bot          ← 收 slash 指令（增減品項/設價/查價/手動掃描）
│   ├── node-cron            ← 每 4 小時呼叫 runScan()
│   ├── crawlers             ← PCHome / BigGo / BrickEconomy（Playwright）
│   └── notify (webhook)     ← 警報單向發送（沿用現有）
└── PostgreSQL (Railway 外掛)
    └── products / watchlist / price_history / pchome_prices / alerts_sent
```

**為何 always-on 內跑 node-cron，而不用 Railway cron？**
Railway 的 cron 機制會「重啟容器」來觸發排程；但 Bot 需要持續連線收指令，
一旦重啟就斷線。所以 Bot 與排程必須在同一個常駐 process 內，用 node-cron 自管時間。

---

## 1. 依賴變更

`package.json` 新增：

```jsonc
"dependencies": {
  "pg":          "^8.x",     // PostgreSQL client（取代 sql.js）
  "discord.js":  "^14.x",    // Discord Bot
  "node-cron":   "^3.x",     // 內建排程
  "dotenv":      "^16.4.5",
  "playwright":  "^1.44.0"
  // sql.js 移除
}
```

`scripts` 新增：

```jsonc
"start":          "node src/bot/index.js",     // Railway 啟動指令
"scan:once":      "node src/index.js",          // 手動跑一次（debug）
"db:migrate":     "node scripts/migrate.js",    // 建表
"db:seed":        "node scripts/seed-watchlist.js"  // 匯入 watchlist.json
```

---

## 2. 資料庫層改寫：`src/data/db.js`（sql.js → pg）

### 2.1 連線
- 用 `new Pool({ connectionString: process.env.DATABASE_URL })`
- 移除 `initSqlJs()`、`fs.readFileSync`、`db.export()`、`writeFileSync`、`save()` 全部存檔邏輯
  （Postgres 連線即持久，不需要手動存檔）
- 所有 query 函式改 **async**（pg 是 Promise 介面）→ 連帶 `index.js` 內呼叫處要 `await`

### 2.2 SQL 方言調整對照表

| sql.js（現在） | PostgreSQL（改後） |
|---|---|
| `INTEGER PRIMARY KEY AUTOINCREMENT` | `BIGSERIAL PRIMARY KEY` |
| `datetime('now')` | `now()` |
| `datetime('now', '-30 days')` | `now() - interval '30 days'` |
| `datetime('now', ? || ' hours')` 參數 `-24` | `now() - (($1 || ' hours')::interval)` 或直接 `now() - interval '24 hours'` |
| `db.exec(sql, params)` 回傳 `[{columns,values}]` | `pool.query(sql, params)` 回傳 `{rows}` → **直接是物件陣列，`toRows()` 可刪** |
| 參數佔位 `?` | `$1, $2, ...`（pg 用編號佔位） |
| `PRAGMA journal_mode = WAL` | 刪除（Postgres 不需要） |

> `ON CONFLICT ... DO UPDATE` 語法兩邊一致，可直接沿用。
> `COALESCE`、`MIN/MAX/AVG`、`COUNT` 都一致。

### 2.3 函式逐一確認（簽名不變，內部改 async + 方言）
`initDb`、`upsertProduct`、`getPchomePrice`、`getLastPchomeRecord`、`savePchomePrice`、
`updateSalePriceCache`、`savePrice`、`getLastPrice`、`getPriceStats`、
`getWeekAlertCount`、`wasAlertSentRecently`、`saveAlertSent`
— 全部保留同名，呼叫端只需加 `await`。

---

## 3. Watchlist 搬進 DB

### 3.1 新增資料表（在 `scripts/migrate.js` 一起建）

```sql
CREATE TABLE IF NOT EXISTS watchlist (
  set_number   TEXT PRIMARY KEY,
  note         TEXT,
  target_price INTEGER,            -- 對應「要特定價格」
  disabled     BOOLEAN DEFAULT false,
  added_at     TIMESTAMPTZ DEFAULT now(),
  updated_at   TIMESTAMPTZ DEFAULT now()
);
```

### 3.2 `db.js` 新增 watchlist CRUD（給 bot + index 用）
- `getWatchlist({ includeDisabled })` → 取代 `require('../config/watchlist.json')`
- `addWatchItem(setNumber, note)`
- `removeWatchItem(setNumber)`
- `setWatchDisabled(setNumber, bool)`
- `setTargetPrice(setNumber, price)`

### 3.3 `scripts/seed-watchlist.js`
讀現有 `config/watchlist.json`，`INSERT ... ON CONFLICT DO NOTHING` 匯入 17 筆。
→ `config/watchlist.json` 保留當「初始種子 / 備份」，不再是執行時來源。

### 3.4 `src/index.js` 改動
- `const watchlistConfig = require('../config/watchlist.json')` → `await db.getWatchlist()`
- `watchlistItems` 來源換成 DB；`w.target_price`、`w.note`、`w.disabled` 欄位語意不變

---

## 4. 抽出可重用的掃描函式

把 `src/index.js` 的 `main()` 重構為：

```js
// src/index.js
async function runScan({ dryRun = false } = {}) { /* 原 main() 內容 */ }
module.exports = { runScan };

if (require.main === module) {
  runScan({ dryRun: process.argv.includes('--dry-run') })
    .catch(err => { logger.error(...); process.exit(1); });
}
```

→ cron 與 `/scan` 指令都呼叫 `runScan()`，邏輯單一來源。

---

## 5. Discord Bot：`src/bot/index.js`（新檔）

### 5.1 啟動流程
1. `new Client({ intents: [Guilds] })`（slash 指令不需 MessageContent intent）
2. 啟動時註冊 slash 指令（對 `DISCORD_GUILD_ID` 註冊，秒生效；全域要等 ~1hr）
3. `client.on('interactionCreate')` 處理指令
4. `cron.schedule('0 */4 * * *', () => runScan(), { timezone: 'Asia/Taipei' })`
5. `client.login(DISCORD_BOT_TOKEN)`

### 5.2 指令設計

| 指令 | 參數 | 行為 |
|---|---|---|
| `/add` | `set`(必), `note`(選) | `db.addWatchItem` → 回覆「已加入追蹤」 |
| `/remove` | `set` | `db.removeWatchItem` → 回覆 |
| `/disable` `/enable` | `set` | `db.setWatchDisabled` |
| `/target` | `set`, `price` | `db.setTargetPrice` → 「目標價設為 NT$x」 |
| `/list` | — | `db.getWatchlist` 列表（含目標價、是否停用） |
| `/price` | `set` | `db.getPriceStats` 現價/歷史低/30天區間 |
| `/scan` | — | `await runScan()`（先 `deferReply()`，跑完 editReply） |

> 寫入類指令建議用 `ephemeral` 回覆（只有自己看得到），避免洗頻道。

### 5.3 與現有 webhook 的關係
- 警報仍由 `src/notify/discord.js` 的 **webhook** 發（不動）
- Bot token 只負責「收指令」與「指令回覆」
- 兩者各自獨立，互不依賴

---

## 6. 容器化：`Dockerfile`

```dockerfile
FROM mcr.microsoft.com/playwright:v1.44.0-jammy
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
ENV TZ=Asia/Taipei
CMD ["node", "src/bot/index.js"]
```

> 用 Playwright 官方 image 省去手動裝 Chromium 系統依賴（Nixpacks 容易缺庫）。
> 版本要對齊 `package.json` 的 playwright 版本。

`railway.json`（可選，固定建置方式）：

```json
{ "build": { "builder": "DOCKERFILE" }, "deploy": { "restartPolicyType": "ON_FAILURE" } }
```

---

## 7. 環境變數（Railway → Variables）

| 變數 | 來源 / 說明 |
|---|---|
| `DATABASE_URL` | Railway Postgres 自動注入（用 reference variable 連結） |
| `DISCORD_BOT_TOKEN` | Discord Developer Portal → Bot → Token |
| `DISCORD_APP_ID` | Developer Portal → Application ID（註冊指令用） |
| `DISCORD_GUILD_ID` | 你的 server ID（指令秒註冊用） |
| `DISCORD_WEBHOOK_URL` | 沿用現有警報 webhook |
| `TZ` | `Asia/Taipei` |
| `HEADLESS` | `true` |

---

## 8. Discord Bot 建立步驟（一次性手動）

1. https://discord.com/developers/applications → New Application
2. 左側 **Bot** → Reset Token → 複製成 `DISCORD_BOT_TOKEN`
3. **General Information** → 複製 Application ID 成 `DISCORD_APP_ID`
4. **OAuth2 → URL Generator** → 勾 `bot` + `applications.commands` →
   權限勾 `Send Messages` → 用產生的 URL 把 bot 邀進 server
5. Discord 開「開發者模式」→ 右鍵你的 server → 複製 Server ID 成 `DISCORD_GUILD_ID`

---

## 9. 部署步驟

1. 本機把 §1–§6 的 code 改完，`config/settings.json` 的 `schedule` 改成 cron（`0 */4 * * *`）
2. push 到 GitHub
3. Railway → New Project → Deploy from GitHub repo（選此 repo）
4. 加 **PostgreSQL**（New → Database → PostgreSQL）→ 在 service 把 `DATABASE_URL` 連結過去
5. 填上 §7 其餘環境變數
6. 首次部署後跑一次 `npm run db:migrate` 再 `npm run db:seed`
   （可在 Railway 的一次性 shell，或暫時把 CMD 改成 migrate 跑一次）
7. 確認 bot 上線（Discord 顯示綠點）→ 試 `/list`、`/scan`
8. 觀察第一個 4 小時排程是否觸發、警報是否進 webhook 頻道

---

## 10. 退場 / 備援

- GitHub Actions `weekend-monitor.yml`：搬遷穩定後可停用（留檔當備援，或刪）
- `config/watchlist.json`：降級為「種子 / 離線備份」，不再是執行來源
- `db/` 本機 SQLite 檔：搬遷後不再使用（可保留歷史備查）

---

## 11. 風險與注意

| 風險 | 對策 |
|---|---|
| 反爬：4 小時 × 多品項，請求變密 | 保留 BigGo 的 `request_delay_ms` jitter；必要時降回 6 小時 |
| Playwright 記憶體佔用（always-on） | Railway 監看記憶體；掃描完確保 `browser.close()` |
| Bot 與 cron 同時觸發 runScan 重疊 | 加一個「掃描中」鎖（module 級 boolean），重疊時跳過 |
| DB migration 破壞舊資料 | 全新 Postgres，無舊資料；種子用 `ON CONFLICT DO NOTHING` |
| 成本 | Hobby 約 $5/月起；always-on + Postgres 用量計費 |

---

## 12. 工作量估計（給實作排序）

1. `db.js` 改寫 pg（最大工項，~半天）
2. `migrate.js` + `seed-watchlist.js` + watchlist CRUD
3. `index.js` 抽 `runScan()` + 改讀 DB watchlist（async 化）
4. `bot/index.js` slash 指令
5. Dockerfile + railway.json + env
6. 部署、註冊指令、煙霧測試

> 建議實作順序：1 → 2 → 3（本機接 Postgres 跑通 `scan:once`）→ 4（本機跑通 bot）→ 5 → 6。
> 每步都能本機驗證，再上 Railway。
