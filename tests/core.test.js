const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../js/core.js');
const Seed = require('../js/seed.js');

function fresh() {
  const state = C.createState(Seed.accounts, Seed.vouchers);
  Object.assign(state.periods, JSON.parse(JSON.stringify(Seed.initialPeriods)));
  return state;
}
const findV = (state, no) => state.vouchers.find(v => v.voucherNo === no);
const bal = (lines) => ({
  d: lines.reduce((a, l) => a + C.toCents(l.debit), 0),
  c: lines.reduce((a, l) => a + C.toCents(l.credit), 0)
});

test('种子数据：所有凭证借贷平衡且全部入账', () => {
  const state = fresh();
  assert.equal(state.vouchers.length, Seed.vouchers.length);
  assert.equal(state.entries.length, Seed.vouchers.reduce((n, v) => n + v.lines.length, 0));
  state.vouchers.forEach(v => {
    const b = bal(v.lines);
    assert.equal(b.d, b.c, v.voucherNo + ' 应平衡');
    assert.ok(b.d > 0, v.voucherNo + ' 金额不能为 0');
  });
});

test('种子数据：跨期凭证 09-007 落在 10 月账期但凭证账期为 9 月', () => {
  const state = fresh();
  const v = findV(state, 'PZ-202609-007');
  assert.equal(v.voucherPeriod, '2026-09');
  assert.equal(v.postPeriod, '2026-10');
});

test('借贷不平的凭证被拒绝且完全不入账', () => {
  const state = fresh();
  const before = state.entries.length;
  const r = C.postVoucher(state, Seed.badSamples[0]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'IMBALANCE'));
  assert.equal(state.entries.length, before);
});

test('未映射科目被拒绝', () => {
  const state = fresh();
  const r = C.postVoucher(state, Seed.badSamples[1]);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'UNMAPPED'));
});

test('凭证缺行（仅一行/零行）被拒绝', () => {
  const state = fresh();
  const r1 = C.postVoucher(state, Seed.badSamples[2]);
  assert.equal(r1.ok, false);
  assert.ok(r1.errors.some(e => e.code === 'MISSING_LINES'));
  const r2 = C.postVoucher(state, { voucherNo: 'X-1', voucherDate: '2026-10-01', lines: [] });
  assert.ok(r2.errors.some(e => e.code === 'MISSING_LINES'));
});

test('重复导入同一凭证不重复入账（单张与批量）', () => {
  const state = fresh();
  const r = C.postVoucher(state, Seed.badSamples[3]); // 与 PZ-202610-001 同号
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'DUP_VOUCHER'));
  const before = state.vouchers.length;
  const results = C.importVouchers(state, [Seed.badSamples[3], {
    voucherNo: 'PZ-202610-900', voucherDate: '2026-10-25', source: '导入测试',
    summary: '正常新凭证',
    lines: [
      { accountCode: '1001', debit: 100, credit: 0, summary: '现金' },
      { accountCode: '1002', debit: 0, credit: 100, summary: '存款' }
    ]
  }]);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
  assert.equal(state.vouchers.length, before + 1);
});

test('关账校验：干净账期无阻断，跨期入账给出警告而非阻断', () => {
  const state = fresh();
  const r9 = C.validatePeriod(state, '2026-09');
  assert.equal(r9.blockers.length, 0);
  assert.equal(r9.totalDebit, r9.totalCredit);
  const r10 = C.validatePeriod(state, '2026-10');
  assert.equal(r10.blockers.length, 0);
  assert.ok(r10.warnings.some(w => w.code === 'CROSS_PERIOD'));
});

test('关账被阻断时列出全部原因（不平衡+未映射+空行）', () => {
  const state = fresh();
  // 绕过录入校验，直接构造已入库后“变脏”的数据：
  // 1) 科目映射被删除 → UNMAPPED；2) 分录金额被改坏 → IMBALANCE；3) 注入空行 → EMPTY_LINE
  const v = findV(state, 'PZ-202610-001');
  state.accounts = state.accounts.filter(a => a.code !== '1002');
  v.lines[0].debit = C.toCents(99999);
  state.entries.find(e => e.voucherId === v.id && e.lineIndex === 0).debit = C.toCents(99999);
  v.lines.push({ accountCode: '1001', debit: 0, credit: 0, summary: '注入空行' });
  const r = C.validatePeriod(state, '2026-10');
  const codes = r.blockers.map(b => b.code);
  assert.ok(codes.includes('UNMAPPED'));
  assert.ok(codes.includes('IMBALANCE'));
  assert.ok(codes.includes('EMPTY_LINE'));
  const close = C.closePeriod(state, '2026-10');
  assert.equal(close.ok, false);
  assert.equal(state.periods['2026-10'].status, 'open');
});

test('模拟关账：阻止录入，但可取消恢复开放', () => {
  const state = fresh();
  const r = C.closePeriod(state, '2026-09', true);
  assert.equal(r.ok, true);
  assert.equal(state.periods['2026-09'].status, 'simulated');
  const blocked = C.postVoucher(state, {
    voucherNo: 'PZ-X', voucherDate: '2026-09-15', lines: [
      { accountCode: '1001', debit: 100, credit: 0 },
      { accountCode: '1002', debit: 0, credit: 100 }
    ]
  });
  assert.equal(blocked.ok, false);
  assert.ok(blocked.errors.some(e => e.code === 'PERIOD_NOT_OPEN'));
  assert.equal(C.cancelSimulation(state, '2026-09').ok, true);
  assert.equal(state.periods['2026-09'].status, 'open');
});

test('正式关账后原凭证锁定：禁止改删，只能冲销', () => {
  const state = fresh();
  C.closePeriod(state, '2026-08');
  const v = findV(state, 'PZ-202608-001');
  assert.equal(C.isVoucherLocked(state, v), true);
  const del = C.deleteVoucher(state, v.id);
  assert.equal(del.ok, false);
  assert.ok(del.errors.some(e => e.code === 'LOCKED'));
  const rev = C.reverseVoucher(state, v.id, '2026-10', '2026-10-31');
  assert.equal(rev.ok, true);
  // 原记录未被修改
  const origAgain = findV(state, 'PZ-202608-001');
  assert.equal(origAgain.lines[0].debit, C.toCents(500000));
  assert.equal(state.entries.filter(e => e.voucherId === origAgain.id).length, 2);
  // 冲销分录方向相反
  const revEntry = state.entries.find(e => e.voucherId === rev.voucher.id && e.lineIndex === 0);
  assert.equal(revEntry.debit, 0);
  assert.equal(revEntry.credit, C.toCents(500000));
  assert.equal(revEntry.kind, 'reversal');
  assert.ok(revEntry.reversalOf);
  // 不能重复冲销
  assert.equal(C.reverseVoucher(state, v.id, '2026-10').ok, false);
});

test('冲销后录入更正凭证，链条可追溯', () => {
  const state = fresh();
  const orig = findV(state, 'PZ-202608-002'); // 60000 电脑
  C.reverseVoucher(state, orig.id, '2026-10');
  const r = C.postCorrection(state, {
    voucherNo: 'PZ-202610-CORR1', voucherDate: '2026-10-31', source: '手工更正',
    summary: '正确金额 58000 的更正分录',
    lines: [
      { accountCode: '1601', debit: 58000, credit: 0, summary: '更正后入账' },
      { accountCode: '1002', debit: 0, credit: 58000, summary: '更正后付款' }
    ]
  }, orig.id);
  assert.equal(r.ok, true);
  assert.equal(r.voucher.kind, 'correction');
  const chain = C.voucherChain(state, orig.id);
  assert.equal(chain.root.id, orig.id);
  assert.equal(chain.reversals.length, 1);
  assert.equal(chain.corrections.length, 1);
});

test('跨期更正影响同时显示原账期与当前账期，两期净额为更正后结果', () => {
  const state = fresh();
  const orig = findV(state, 'PZ-202608-002'); // 借 1601 60000 / 贷 1002 60000
  C.reverseVoucher(state, orig.id, '2026-10');
  C.postCorrection(state, {
    voucherNo: 'PZ-202610-CORR2', voucherDate: '2026-10-31', source: '手工更正',
    summary: '正确金额 58000',
    lines: [
      { accountCode: '1601', debit: 58000, credit: 0 },
      { accountCode: '1002', debit: 0, credit: 58000 }
    ]
  }, orig.id);
  const imp = C.crossPeriodImpact(state);
  const row = imp.find(x => x.original.id === orig.id);
  assert.ok(row);
  assert.equal(row.originalPeriod, '2026-08');
  assert.equal(row.currentPeriod, '2026-10');
  const f = row.rows.find(r => r.accountCode === '1601');
  assert.equal(f.originalNet, C.toCents(60000));   // 原账期影响
  assert.equal(f.currentNet, C.toCents(-60000 + 58000)); // 当前账期：冲销 + 更正
  assert.equal(f.bothPeriodNet, C.toCents(58000)); // 两期合计 = 更正后金额
});

test('重开：仅最后一个已关账账期可重开，且原记录仍锁定', () => {
  const state = fresh();
  C.closePeriod(state, '2026-09');
  // 08 前面关着、09 也关着：08 不能先重开
  assert.equal(C.reopenPeriod(state, '2026-08').ok, false);
  assert.equal(C.reopenPeriod(state, '2026-09').ok, true);
  assert.equal(state.periods['2026-09'].status, 'open');
  // everClosed 保留，原凭证依旧不能删除
  const v = findV(state, 'PZ-202609-001');
  assert.equal(C.isVoucherLocked(state, v), true);
  // 重开后可以再次正式关账
  assert.equal(C.closePeriod(state, '2026-09').ok, true);
  assert.equal(state.periods['2026-09'].status, 'closed');
});

test('试算平衡表：三栏各自借贷相等，且可下钻到组成分录', () => {
  const state = fresh();
  const tb = C.trialBalance(state, '2026-09');
  assert.equal(tb.balanced.opening, true);
  assert.equal(tb.balanced.current, true);
  assert.equal(tb.balanced.closing, true);
  // 1002 银行存款 9 月本期借方应包含 226000 回款
  const bank = tb.groups.flatMap(g => g.rows).find(r => r.account.code === '1002');
  assert.ok(bank.current.debit >= C.toCents(226000));
  const drill = C.drillEntries(state, '2026-09', '1002');
  assert.ok(drill.some(e => e.voucherNo === 'PZ-202609-001'));
  // 类别级下钻
  const assetDrill = C.drillEntries(state, '2026-09', null, 'asset');
  assert.ok(assetDrill.length > 0);
  assetDrill.forEach(e => {
    const a = state.accounts.find(x => x.code === e.accountCode);
    assert.equal(a.type, 'asset');
  });
  // 下钻分录的借贷合计 = 试算表本期发生额
  const sumD = drill.reduce((a, e) => a + e.debit, 0);
  assert.equal(sumD, bank.current.debit);
});

test('试算平衡表期初余额来自更早账期（8 月关账数据带入 9 月）', () => {
  const state = fresh();
  const tb = C.trialBalance(state, '2026-09');
  const cap = tb.groups.flatMap(g => g.rows).find(r => r.account.code === '4001');
  // 8 月实收资本贷方 500000 应体现为 9 月期初贷方余额
  assert.equal(cap.opening.credit, C.toCents(500000));
});

test('查询过滤：账期/科目/来源凭证/关键字', () => {
  const state = fresh();
  assert.ok(C.filterEntries(state, { period: '2026-08' }).every(e => e.postPeriod === '2026-08'));
  const byAcct = C.filterEntries(state, { accountCode: '1002' });
  assert.ok(byAcct.every(e => e.accountCode === '1002'));
  const byVoucher = C.filterEntries(state, { voucherNo: 'PZ-202608-001' });
  assert.equal(byVoucher.length, 2);
  const kw = C.filterEntries(state, { keyword: '折旧' });
  assert.ok(kw.length >= 2);
});

test('已关账账期禁止录入新凭证', () => {
  const state = fresh();
  const r = C.postVoucher(state, {
    voucherNo: 'PZ-LOCK', voucherDate: '2026-08-10', lines: [
      { accountCode: '1001', debit: 100, credit: 0 },
      { accountCode: '1002', debit: 0, credit: 100 }
    ]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.code === 'PERIOD_NOT_OPEN'));
});

test('金额以分存储，小数输入无浮点误差', () => {
  const state = fresh();
  const r = C.postVoucher(state, {
    voucherNo: 'PZ-CENT', voucherDate: '2026-10-28', source: '零钱测试',
    summary: '小数金额',
    lines: [
      { accountCode: '1001', debit: 0.1 + 0.2, credit: 0, summary: '0.30 元' },
      { accountCode: '1002', debit: 0, credit: 0.3, summary: '0.30 元' }
    ]
  });
  assert.equal(r.ok, true);
  assert.equal(r.entries[0].debit, 30);
});
