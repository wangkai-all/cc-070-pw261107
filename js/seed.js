/*
 * 种子数据 —— 全部为虚构账簿数据（虚构公司：星辉科技有限公司）
 * UMD 模块，浏览器与 Node 均可加载。金额单位：元（两位小数）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SeedData = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // 科目表：code / name / type（asset|liability|equity|income|cost）
  const accounts = [
    { code: '1001', name: '库存现金', type: 'asset' },
    { code: '1002', name: '银行存款', type: 'asset' },
    { code: '1122', name: '应收账款', type: 'asset' },
    { code: '1403', name: '原材料', type: 'asset' },
    { code: '1601', name: '固定资产', type: 'asset' },
    { code: '1602', name: '累计折旧', type: 'asset' },
    { code: '2202', name: '应付账款', type: 'liability' },
    { code: '2211', name: '应付职工薪酬', type: 'liability' },
    { code: '2221', name: '应交税费', type: 'liability' },
    { code: '4001', name: '实收资本', type: 'equity' },
    { code: '4103', name: '本年利润', type: 'equity' },
    { code: '6001', name: '主营业务收入', type: 'income' },
    { code: '6401', name: '主营业务成本', type: 'cost' },
    { code: '6601', name: '销售费用', type: 'cost' },
    { code: '6602', name: '管理费用', type: 'cost' }
  ];

  const V = (voucherNo, voucherDate, source, summary, lines, postPeriod) =>
    ({ voucherNo, voucherDate, source, summary, lines, ...(postPeriod ? { postPeriod } : {}) });
  const L = (accountCode, debit, credit, summary) =>
    ({ accountCode, debit: debit || 0, credit: credit || 0, summary: summary || '' });

  // 2026-08（已关账账期）
  const aug = [
    V('PZ-202608-001', '2026-08-03', '银行回单', '股东投资款到账', [
      L('1002', 500000, 0, '收到投资款'),
      L('4001', 0, 500000, '股东张三出资')
    ]),
    V('PZ-202608-002', '2026-08-08', '采购发票', '采购办公电脑', [
      L('1601', 60000, 0, '办公电脑 10 台'),
      L('1002', 0, 60000, '银行转账支付')
    ]),
    V('PZ-202608-003', '2026-08-15', '工资表', '发放 8 月工资', [
      L('6602', 80000, 0, '管理人员工资'),
      L('6601', 20000, 0, '销售人员工资'),
      L('1002', 0, 100000, '银行代发工资')
    ]),
    V('PZ-202608-004', '2026-08-20', '销售发票', '确认 8 月销售收入', [
      L('1122', 226000, 0, '应收星河贸易货款'),
      L('6001', 0, 200000, '技术服务收入'),
      L('2221', 0, 26000, '销项税额')
    ]),
    V('PZ-202608-005', '2026-08-25', '成本结转单', '结转 8 月销售成本', [
      L('6401', 120000, 0, '技术服务成本'),
      L('1403', 0, 120000, '领用原材料')
    ]),
    V('PZ-202608-006', '2026-08-31', '折旧表', '计提 8 月固定资产折旧', [
      L('6602', 1000, 0, '办公设备折旧'),
      L('1602', 0, 1000, '累计折旧')
    ])
  ];

  // 2026-09（开放账期，可走“检查→模拟关账→正式关账”全流程）
  const sep = [
    V('PZ-202609-001', '2026-09-05', '银行回单', '收回星河贸易货款', [
      L('1002', 226000, 0, '收到回款'),
      L('1122', 0, 226000, '冲减应收账款')
    ]),
    V('PZ-202609-002', '2026-09-10', '采购发票', '采购原材料', [
      L('1403', 80000, 0, '电子元器件一批'),
      L('2221', 10400, 0, '进项税额'),
      L('2202', 0, 90400, '应付云海电子货款')
    ]),
    V('PZ-202609-003', '2026-09-15', '工资表', '发放 9 月工资', [
      L('6602', 85000, 0, '管理人员工资'),
      L('6601', 22000, 0, '销售人员工资'),
      L('1002', 0, 107000, '银行代发工资')
    ]),
    V('PZ-202609-004', '2026-09-22', '销售发票', '确认 9 月销售收入', [
      L('1122', 339000, 0, '应收北辰科技货款'),
      L('6001', 0, 300000, '技术服务收入'),
      L('2221', 0, 39000, '销项税额')
    ]),
    V('PZ-202609-005', '2026-09-28', '成本结转单', '结转 9 月销售成本', [
      L('6401', 170000, 0, '技术服务成本'),
      L('1403', 0, 170000, '领用原材料')
    ]),
    V('PZ-202609-006', '2026-09-30', '折旧表', '计提 9 月固定资产折旧', [
      L('6602', 1000, 0, '办公设备折旧'),
      L('1602', 0, 1000, '累计折旧')
    ]),
    // 跨期入账：9 月末的凭证，10 月初才补录入账（voucherPeriod 2026-09 → postPeriod 2026-10）
    V('PZ-202609-007', '2026-09-30', '费用报销单', '9 月差旅费报销（10 月补录）', [
      L('6601', 3500, 0, '销售人员差旅费'),
      L('1002', 0, 3500, '银行转账报销')
    ], '2026-10')
  ];

  // 2026-10（开放账期）
  const oct = [
    V('PZ-202610-001', '2026-10-12', '银行回单', '支付云海电子货款', [
      L('2202', 90400, 0, '支付采购款'),
      L('1002', 0, 90400, '银行转账')
    ]),
    V('PZ-202610-002', '2026-10-15', '工资表', '发放 10 月工资', [
      L('6602', 88000, 0, '管理人员工资'),
      L('6601', 21000, 0, '销售人员工资'),
      L('1002', 0, 109000, '银行代发工资')
    ]),
    V('PZ-202610-003', '2026-10-20', '销售发票', '确认 10 月销售收入', [
      L('1122', 113000, 0, '应收星河贸易货款'),
      L('6001', 0, 100000, '技术服务收入'),
      L('2221', 0, 13000, '销项税额')
    ])
  ];

  // 初始账期状态：2026-08 已正式关账
  const periods = {
    '2026-08': { status: 'closed', closedAt: '2026-09-02T10:00:00.000Z', everClosed: true }
  };

  // 导入测试用的坏凭证样本（页面上可一键载入导入框演示拦截）
  const badSamples = [
    {
      voucherNo: 'PZ-BAD-001', voucherDate: '2026-10-08', source: '测试-借贷不平',
      summary: '借方 5000 / 贷方 4000',
      lines: [
        { accountCode: '1001', debit: 5000, credit: 0, summary: '现金' },
        { accountCode: '6001', debit: 0, credit: 4000, summary: '收入' }
      ]
    },
    {
      voucherNo: 'PZ-BAD-002', voucherDate: '2026-10-09', source: '测试-未映射科目',
      summary: '使用了科目表中不存在的 9999',
      lines: [
        { accountCode: '1001', debit: 2000, credit: 0, summary: '现金' },
        { accountCode: '9999', debit: 0, credit: 2000, summary: '未知科目' }
      ]
    },
    {
      voucherNo: 'PZ-BAD-003', voucherDate: '2026-10-10', source: '测试-凭证缺行',
      summary: '只有一行的凭证',
      lines: [
        { accountCode: '1001', debit: 1000, credit: 0, summary: '只有一行' }
      ]
    },
    // 与种子凭证同号 —— 演示重复导入去重
    {
      voucherNo: 'PZ-202610-001', voucherDate: '2026-10-12', source: '测试-重复导入',
      summary: '凭证号已存在',
      lines: [
        { accountCode: '2202', debit: 90400, credit: 0, summary: '重复' },
        { accountCode: '1002', debit: 0, credit: 90400, summary: '重复' }
      ]
    }
  ];

  return {
    company: '星辉科技有限公司（虚构账簿）',
    accounts,
    vouchers: [].concat(aug, sep, oct),
    initialPeriods: periods,
    badSamples
  };
});
