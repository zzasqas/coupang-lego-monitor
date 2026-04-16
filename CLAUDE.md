# Coupang LEGO 監控系統 — 專案記憶

## 快速更新 Watchlist（省 Token 流程）

### 新增品項
直接說：「新增 XXXXX（說明）到 watchlist」

Claude 會：
1. 編輯 `config/watchlist.json`，在 watchlist 陣列最後加上
   ```json
   { "set_number": "XXXXX", "note": "說明" }
   ```
2. `git add config/watchlist.json && git commit -m "watchlist: add XXXXX" && git push`

### 停用品項（暫停追蹤）
說：「停用 XXXXX」→ 加上 `"disabled": true`

### 永久移除品項
說：「移除 XXXXX」→ 刪掉那筆物件

### 自訂目標價
說：「XXXXX 目標價 NT$3500」→ 加上 `"target_price": 3500`

---

## 架構快覽

| 檔案 | 說明 |
|------|------|
| `config/watchlist.json` | 追蹤清單（**唯一需要常更新的檔案**） |
| `config/settings.json` | 閾值、快取天數、排程設定 |
| `src/index.js` | 主流程（PCHome → BigGo → 分析 → 通知） |
| `src/crawler/biggo.js` | BigGo 抓 Coupang 售價（Playwright） |
| `src/crawler/pchome.js` | PCHome 定價 & 特價（Playwright） |
| `src/crawler/brickeconomy.js` | 絕版品 MSRP 備援（Playwright） |
| `src/reporter/weekly.js` | 週報（週二發送） |
| `src/data/db.js` | SQLite（sql.js WASM）價格歷史 |
| `src/notify/telegram.js` | Telegram 通知 |

## 折扣門檻
- 一般品：6.4折（0.64）
- 絕版品：6.9折（0.69）
- PCHome 特價門檻各寬鬆 0.1折

## 雲端排程（週末用）
- GitHub: https://github.com/zzasqas/coupang-lego-monitor
- 週六、週日各跑一次（台灣時間 09:00）
- 雲端無 DB 歷史，只發即時警報，不發週報

## 待辦（未來）
- [ ] 開發多用戶友善版（設定向導、自訂 watchlist、自己的 Telegram bot）

---

## Git 推送指令（更新後執行）
```bash
cd "C:/Users/zzasq/OneDrive/Documents/coupang-lego-monitor"
git add config/watchlist.json
git commit -m "watchlist: update"
git push
```
