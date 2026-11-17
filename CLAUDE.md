# Coupang LEGO 監控系統 — 專案記憶

## 現在怎麼跑
- 沒有資料庫：watchlist 讀 `config/watchlist.json`，不存價格歷史、警報不去重、沒有週報
- 進入點：`node src/index.js`（`npm start`；`npm run scan:dry` 不通知）
- 通知：Discord Webhook（`.env` 的 `NOTIFY_CHANNEL` / `DISCORD_WEBHOOK_URL`；GitHub 用 repo secret）

## 更新 Watchlist
編輯 `config/watchlist.json`：
- 新增：加一筆 `{ "set_number": "60404", "note": "城市系列" }`
- 暫停：加 `"disabled": true`；恢復：刪掉該欄位
- 目標價：`"target_price": 460`（設了就取代全域折扣門檻）

改完 commit + push，GitHub Actions 下一輪就生效；本機下次排程直接讀檔。

## 排程
- GitHub: https://github.com/zzasqas/coupang-lego-monitor（只有 `main` 分支；schedule 只跑 main）
- GitHub Actions 每天 08:00、21:00（台灣時間），`.github/workflows/weekend-monitor.yml`，runner 固定 `ubuntu-24.04`
- 本機工作排程器 `LegoMonitor-Morning` 每天 11:35 → `scripts/run.bat`（寫 `logs/run.log`）；重建用 `scripts/setup-scheduler.bat`（系統管理員）

## 架構快覽

| 檔案 | 說明 |
|------|------|
| `config/watchlist.json` | 追蹤清單（執行來源） |
| `config/settings.json` | 閾值、快取天數 |
| `src/index.js` | 掃描流程（PCHome → BigGo → 分析 → 通知） |
| `src/crawler/biggo.js` | BigGo 抓 Coupang 售價（Playwright） |
| `src/crawler/pchome.js` | PCHome 定價 & 特價 |
| `src/crawler/brickeconomy.js` | 絕版品 MSRP 備援（Playwright） |
| `src/notify/discord.js` | Discord Webhook 通知（預設）；`telegram.js` 備用 |

Railway / PostgreSQL / Discord Bot 版已於 2026-11-17 移除，要找回看 commit `39b57e2` 之前的歷史。

## 折扣門檻
- 一般品：6.4折（0.64）
- 絕版品：6.9折（0.69）
- PCHome 特價門檻各寬鬆 0.1折

## 已知問題
- 77257 BigGo 價格曾解析成 NT$4,571,109（`src/crawler/biggo.js` 價格解析）

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
