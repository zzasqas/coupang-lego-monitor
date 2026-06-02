/**
 * Slash 指令定義：全部收進單一 /lego 命名空間（子指令），
 * 避免與伺服器內其他 bot（例如 ArkRecord Sniffer）的指令撞名。
 *
 * 用法範例：
 *   /lego list
 *   /lego add set:60404 note:城市系列
 *   /lego remove set:60404
 *   /lego target set:10316 price:3500     （price 設 0 = 清除目標價）
 *   /lego eol set:76417 enabled:True       （手動標註絕版；False = 取消）
 *   /lego price set:76452                  （立即現抓 Coupang 價）
 *   /lego scan
 *
 * Option type 對照：1=SUB_COMMAND, 3=STRING, 4=INTEGER, 5=BOOLEAN
 */

const setReq  = { type: 3, name: 'set',     description: '樂高組號，例如 60404', required: true };
const noteOpt = { type: 3, name: 'note',    description: '系列/備註（選填），例如 城市系列', required: false };
const priceReq = { type: 4, name: 'price',  description: '目標價 NT$（0 = 清除目標價）', required: true };
const eolReq  = { type: 5, name: 'enabled', description: 'True=標為絕版 / False=取消絕版', required: true };

module.exports = [
  {
    name: 'lego',
    description: '樂高 Coupang 價格監控',
    options: [
      { type: 1, name: 'list',    description: '列出目前追蹤清單' },
      { type: 1, name: 'add',     description: '新增追蹤品項（可附系列註記）', options: [setReq, noteOpt] },
      { type: 1, name: 'remove',  description: '永久移除追蹤品項', options: [setReq] },
      { type: 1, name: 'disable', description: '暫停追蹤（保留資料）', options: [setReq] },
      { type: 1, name: 'enable',  description: '恢復追蹤', options: [setReq] },
      { type: 1, name: 'target',  description: '設定目標價（0 = 清除）', options: [setReq, priceReq] },
      { type: 1, name: 'eol',     description: '手動標註 / 取消絕版品', options: [setReq, eolReq] },
      { type: 1, name: 'price',   description: '立即現抓某品項的 Coupang 售價', options: [setReq] },
      { type: 1, name: 'scan',    description: '立即手動觸發一次全品項掃描' },
    ],
  },
];
