# Coupang LEGO 監控系統 — 專案記憶

## 更新 Watchlist（Railway 版：來源已改為 PostgreSQL）

> ⚠️ 搬到 Railway 後，**執行時的 watchlist 來源是 PostgreSQL 的 `watchlist` 表**，
> 不再是 `config/watchlist.json`。`watchlist.json` 降級為「初始種子 / 離線備份」。

### 主要方式：Discord Bot 指令（即時生效，免改 code）
- 新增：`/add 60404 城市系列`
- 移除：`/remove 60404`
- 暫停／恢復：`/disable 60404` / `/enable 60404`
- 目標價：`/target 10316 3500`（`price` 設 0 = 清除目標價）
- 查清單／查價：`/list`、`/price 10316`
- 手動掃描：`/scan`

### 次要方式：改 watchlist.json（僅在重建 DB 時生效）
編輯 `config/watchlist.json` 後，需執行 `npm run db:seed` 才會匯入 DB
（`ON CONFLICT DO NOTHING`，不覆蓋 bot 已改過的品項）。

---

## 架構快覽

| 檔案 | 說明 |
|------|------|
| `config/watchlist.json` | 追蹤清單**種子 / 備份**（執行來源已改 DB） |
| `config/settings.json` | 閾值、快取天數、排程（`schedule.cron`）設定 |
| `src/index.js` | 掃描流程，匯出 `runScan()`（PCHome → BigGo → 分析 → 通知） |
| `src/bot/index.js` | **Railway 啟動進入點**：Discord Bot + node-cron 排程 |
| `src/bot/commands.js` / `register.js` | Slash 指令定義 / 註冊 |
| `src/crawler/biggo.js` | BigGo 抓 Coupang 售價（Playwright） |
| `src/crawler/pchome.js` | PCHome 定價 & 特價（Playwright） |
| `src/crawler/brickeconomy.js` | 絕版品 MSRP 備援（Playwright） |
| `src/reporter/weekly.js` | 週報（週二發送） |
| `src/data/db.js` | **PostgreSQL（pg）** 價格歷史 + watchlist CRUD |
| `scripts/migrate.js` / `seed-watchlist.js` | 建表 / 匯入 watchlist |
| `src/notify/discord.js` | Discord Webhook 通知（發警報，**預設**） |
| `src/notify/telegram.js` | Telegram 通知（備用） |

> 部署細節見 [docs/RAILWAY_MIGRATION_PLAN.md](docs/RAILWAY_MIGRATION_PLAN.md)。
> 本機跑一次掃描：`npm run scan:once`（需 `DATABASE_URL`）；啟動 bot：`npm start`。

## 折扣門檻
- 一般品：6.4折（0.64）
- 絕版品：6.9折（0.69）
- PCHome 特價門檻各寬鬆 0.1折

## 雲端排程（週末用）
- GitHub: https://github.com/zzasqas/coupang-lego-monitor
- 週六、週日各跑一次（台灣時間 09:00）
- 雲端無 DB 歷史，只發即時警報，不發週報

## 待辦（未來）
- [ ] 開發多用戶友善版（設定向導、自訂 watchlist、自己的 Discord bot / webhook）

---

## Git 推送指令（更新後執行）
```bash
cd "C:/Users/zzasq/OneDrive/Documents/coupang-lego-monitor"
git add config/watchlist.json
git commit -m "watchlist: update"
git push
```
