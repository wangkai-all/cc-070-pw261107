/* 端到端工作流模拟：演示“模拟关账→正式关账→重开→跨期冲销+更正→再次关账”全流程 */
const C = require('../js/core.js');
const Seed = require('../js/seed.js');

const state = C.createState(Seed.accounts, Seed.vouchers);
Object.assign(state.periods, JSON.parse(JSON.stringify(Seed.initialPeriods)));
const findV = (no) => state.vouchers.find(v => v.voucherNo === no);
const line = (s) => console.log('\n=== ' + s + ' ===');

line('初始状态：08 已关账，09/10 开放');
console.log(state.periodKeys.map(p => `${p}:${state.periods[p].status}`).join('  '));

line('1) 09 月关账检查（干净）+ 模拟关账');
let r = C.validatePeriod(state, '2026-09');
console.log(`阻断 ${r.blockers.length} 条，警告 ${r.warnings.length} 条，借/贷 ${C.fmtYuan(r.totalDebit)}/${C.fmtYuan(r.totalCredit)}`);
r = C.closePeriod(state, '2026-09', true);
console.log('模拟关账:', r.ok, state.periods['2026-09'].status);

line('2) 模拟关账期间录入被阻止');
const blocked = C.postVoucher(state, {
  voucherNo: 'PZ-DURING-SIM', voucherDate: '2026-09-15', lines: [
    { accountCode: '1001', debit: 100, credit: 0 },
    { accountCode: '1002', debit: 0, credit: 100 }
  ]
});
console.log(blocked.errors[0].message);

line('3) 取消模拟 → 正式关账 09 月');
C.cancelSimulation(state, '2026-09');
r = C.closePeriod(state, '2026-09', false);
console.log('正式关账:', r.ok, state.periods['2026-09'].status);

line('4) 关账后尝试删除原凭证被拒');
const orig = findV('PZ-202609-006'); // 折旧 1000
console.log(C.deleteVoucher(state, orig.id).errors[0].message);

line('5) 重开 09 月（最后关账账期），原凭证仍锁定');
r = C.reopenPeriod(state, '2026-09');
console.log('重开:', r.ok, '| 状态:', state.periods['2026-09'].status, '| everClosed:', state.periods['2026-09'].everClosed);
console.log('凭证仍锁定:', C.isVoucherLocked(state, orig));

line('6) 对 09 月折旧凭证做跨期冲销到 10 月，并录入正确金额更正分录（800 而非 1000）');
r = C.reverseVoucher(state, orig.id, '2026-10', '2026-10-31');
console.log('冲销凭证:', r.voucher.voucherNo, '入账', r.voucher.postPeriod);
const corr = C.postCorrection(state, {
  voucherNo: 'PZ-202610-CORR-DEP', voucherDate: '2026-10-31', source: '手工更正',
  summary: '9 月折旧正确金额 800',
  lines: [
    { accountCode: '6602', debit: 800, credit: 0, summary: '更正后折旧' },
    { accountCode: '1602', debit: 0, credit: 800, summary: '更正后累计折旧' }
  ]
}, orig.id);
console.log('更正凭证:', corr.ok, corr.voucher.voucherNo);

line('7) 跨期更正影响（原账期 09 / 当前账期 10 / 两期净额）');
C.crossPeriodImpact(state).forEach(im => {
  console.log(`${im.original.voucherNo}: 原账期 ${im.originalPeriod} → 当前 ${im.currentPeriod}`);
  im.rows.forEach(x => console.log(`  ${x.accountCode} 原=${C.fmtYuan(x.originalNet)} 当前=${C.fmtYuan(x.currentNet)} 两期净额=${C.fmtYuan(x.bothPeriodNet)}`));
});

line('8) 09 月再次关账（冲销发生在 10 月，不影响 09 月检查）');
r = C.closePeriod(state, '2026-09', false);
console.log('再次关账:', r.ok, state.periods['2026-09'].status, '| 阻断:', r.blockers.length);

line('9) 10 月试算平衡表（含跨期冲销+更正）三栏平衡');
const tb = C.trialBalance(state, '2026-10');
console.log('平衡:', JSON.stringify(tb.balanced));
const dep = tb.groups.flatMap(g => g.rows).find(x => x.account.code === '6602');
console.log('6602 管理费用 10 月本期借/贷:', C.fmtYuan(dep.current.debit), '/', C.fmtYuan(dep.current.credit),
  '（含冲销 -1000 与更正 +800）');
const drill = C.drillEntries(state, '2026-10', '6602');
console.log('下钻分录数:', drill.length, '凭证:', [...new Set(drill.map(e => e.voucherNo))].join(', '));

line('10) 全账期试算平衡与全量借贷恒等');
state.periodKeys.forEach(p => {
  const t = C.trialBalance(state, p);
  if (!t.balanced.opening || !t.balanced.current || !t.balanced.closing) throw new Error(p + ' 试算不平衡');
});
const td = state.entries.reduce((a, e) => a + e.debit, 0);
const tc = state.entries.reduce((a, e) => a + e.credit, 0);
console.log('全量借/贷:', C.fmtYuan(td), '/', C.fmtYuan(tc), td === tc ? '恒等 ✓' : '不平 ✗');
console.log('\n✅ 端到端工作流全部通过');
