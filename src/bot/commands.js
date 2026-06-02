/**
 * Slash 指令定義（給 src/bot/register.js 註冊、src/bot/index.js 處理）
 *
 * 共用同一份定義，避免註冊與處理不一致。
 */

const SET_OPTION = {
  type: 3,              // STRING
  name: 'set',
  description: '樂高組號，例如 60404',
  required: true,
};

module.exports = [
  {
    name: 'add',
    description: '新增追蹤品項',
    options: [
      SET_OPTION,
      { type: 3, name: 'note', description: '備註（選填）', required: false },
    ],
  },
  {
    name: 'remove',
    description: '永久移除追蹤品項',
    options: [SET_OPTION],
  },
  {
    name: 'disable',
    description: '暫停追蹤（保留資料）',
    options: [SET_OPTION],
  },
  {
    name: 'enable',
    description: '恢復追蹤',
    options: [SET_OPTION],
  },
  {
    name: 'target',
    description: '設定目標價（達到才警報）；price 設 0 表示清除',
    options: [
      SET_OPTION,
      { type: 4, name: 'price', description: '目標價 NT$（0 = 清除）', required: true }, // INTEGER
    ],
  },
  {
    name: 'list',
    description: '列出目前追蹤清單',
  },
  {
    name: 'price',
    description: '查詢某品項的現價與歷史低點',
    options: [SET_OPTION],
  },
  {
    name: 'scan',
    description: '立即手動觸發一次掃描',
  },
];
