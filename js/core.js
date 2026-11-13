/*
 * LedgerCore —— 本地会计分录关账台核心逻辑（无 DOM 依赖，UMD）
 * 金额内部一律以“分”存储（整数），避免浮点误差。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LedgerCore = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  // ---------------- 基础工具 ----------------
  let _seq = 0;
  function uid(prefix) {
    return prefix + '_' + Date.now().toString(36) + (_seq++).toString(36) +
      Math.random().toString(36).slice(2, 6);
  }
  const toCents = (v) => {
    if (v === null || v === undefined || v === '') return 0;
    return Math.round(Number(v) * 100);
  };
  const fmtYuan = (c) => {
    const neg = c < 0;
    const s = Math.abs(c / 100).toLocaleString('zh-CN', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
    return (neg ? '-' : '') + s;
  };
  const periodOf = (dateStr) => String(dateStr).slice(0, 7);
  const lastDayOfPeriod = (period) => {
    const [y, m] = period.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 0));
    return d.toISOString().slice(0, 10);
  };
  const sum = (arr, f) => arr.reduce((a, x) => a + f(x), 0);
  const PERIOD_RE = /^\d{4}-\d{2}$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  const TYPE_LABEL = {
    asset: '资产类',
    liability: '负债类',
    equity: '权益类',
    income: '收入类',
    cost: '成本费用类'
  };
  const TYPE_ORDER = ['asset', 'liability', 'equity', 'income', 'cost'];
  // 借方余额为正常方向的科目类别
  const DEBIT_NORMAL = new Set(['asset', 'cost']);

  function acctMap(state) {
    const m = {};
    state.accounts.forEach(a => { m[a.code] = a; });
    return m;
  }

  function addPeriod(state, period) {
    if (!PERIOD_RE.test(period)) return;
    if (!state.periods[period]) state.periods[period] = { status: 'open', closedAt: null, everClosed: false };
    if (!state.periodKeys.includes(period)) {
      state.periodKeys.push(period);
      state.periodKeys.sort();
    }
  }

  // ---------------- 初始化 ----------------
  function createState(accounts, vouchers) {
    const state = {
      accounts: accounts.map(a => ({ ...a })),
      vouchers: [],
      entries: [],
      periods: {},
      periodKeys: []
    };
    const failed = [];
    (vouchers || []).forEach(v => {
      const r = postVoucher(state, v);
      if (!r.ok) failed.push({ voucherNo: v.voucherNo, errors: r.errors });
    });
    if (failed.length) {
      throw new Error('种子数据存在非法凭证: ' + JSON.stringify(failed, null, 2));
    }
    return state;
  }

  // ---------------- 凭证录入 / 导入 ----------------
  /**
   * 录入一张凭证并生成分录。返回 {ok, errors} 或 {ok, voucher, entries}。
   * 不合法凭证完全不入账（vouchers/entries 均不追加）。
   */
  function postVoucher(state, input, meta) {
    meta = meta || {};
    const errors = [];
    const voucherNo = String(input.voucherNo || '').trim();
    if (!voucherNo) errors.push({ code: 'NO_VOUCHER_NO', message: '凭证号缺失' });
    if (voucherNo && state.vouchers.some(v => v.voucherNo === voucherNo)) {
      errors.push({ code: 'DUP_VOUCHER', message: `凭证号 ${voucherNo} 已入账，重复导入不会重复入账` });
    }
    const voucherDate = input.voucherDate;
    if (!DATE_RE.test(voucherDate || '')) {
      errors.push({ code: 'BAD_DATE', message: '凭证日期格式应为 YYYY-MM-DD' });
    }

    const rawLines = Array.isArray(input.lines) ? input.lines : [];
    if (rawLines.length < 2) {
      errors.push({ code: 'MISSING_LINES', message: `凭证仅 ${rawLines.length} 行，至少需要借贷两行（凭证缺行）` });
    }
    const map = acctMap(state);
    const lines = rawLines.map((ln, i) => {
      const accountCode = String(ln.accountCode || '').trim();
      const debit = toCents(ln.debit);
      const credit = toCents(ln.credit);
      if (!accountCode) errors.push({ code: 'EMPTY_LINE', voucherNo, message: `第 ${i + 1} 行缺少科目（空行）` });
      else if (!map[accountCode]) errors.push({ code: 'UNMAPPED', voucherNo, message: `第 ${i + 1} 行科目 “${accountCode}” 未在科目表中映射` });
      if (debit === 0 && credit === 0) errors.push({ code: 'EMPTY_LINE', voucherNo, message: `第 ${i + 1} 行借贷金额均为 0（空行）` });
      if (debit < 0 || credit < 0) errors.push({ code: 'NEG_AMOUNT', voucherNo, message: `第 ${i + 1} 行金额不能为负` });
      if (debit > 0 && credit > 0) errors.push({ code: 'BOTH_SIDE', voucherNo, message: `第 ${i + 1} 行不能同时填写借方和贷方` });
      return { accountCode, debit, credit, summary: ln.summary || '' };
    });

    const td = sum(lines, l => l.debit);
    const tc = sum(lines, l => l.credit);
    if (lines.length >= 2 && (td !== tc || td === 0)) {
      errors.push({
        code: 'IMBALANCE', voucherNo,
        message: `借贷不平衡：借方合计 ${fmtYuan(td)} 元，贷方合计 ${fmtYuan(tc)} 元，差额 ${fmtYuan(Math.abs(td - tc))} 元`
      });
    }
    if (errors.length) return { ok: false, errors };

    const voucherPeriod = periodOf(voucherDate);
    const postPeriod = meta.postPeriod || input.postPeriod || voucherPeriod;
    if (!PERIOD_RE.test(postPeriod)) {
      return { ok: false, errors: [{ code: 'BAD_PERIOD', message: '入账账期格式应为 YYYY-MM' }] };
    }
    const prec = state.periods[postPeriod];
    if (prec && prec.status !== 'open') {
      return {
        ok: false,
        errors: [{ code: 'PERIOD_NOT_OPEN', message: `账期 ${postPeriod} 已${prec.status === 'closed' ? '关账' : '模拟关账'}，不能再录入凭证；如需更正请使用冲销` }]
      };
    }

    const kind = meta.kind || 'original';
    const voucher = {
      id: uid('v'),
      voucherNo,
      source: input.source || (kind === 'original' ? '手工录入' : '系统更正'),
      summary: input.summary || '',
      voucherDate,
      voucherPeriod,
      postPeriod,
      lines,
      kind,
      reversesVoucherId: meta.reversesVoucherId || null,
      correctsVoucherId: meta.correctsVoucherId || null,
      createdAt: new Date().toISOString()
    };
    state.vouchers.push(voucher);
    const entries = lines.map((ln, i) => ({
      id: uid('e'),
      voucherId: voucher.id,
      voucherNo,
      lineIndex: i,
      accountCode: ln.accountCode,
      debit: ln.debit,
      credit: ln.credit,
      summary: ln.summary || voucher.summary,
      voucherPeriod,
      postPeriod,
      kind,
      reversalOf: null,
      correctionOf: voucher.correctsVoucherId,
      createdAt: voucher.createdAt
    }));
    state.entries.push(...entries);
    addPeriod(state, postPeriod);
    addPeriod(state, voucherPeriod);
    return { ok: true, voucher, entries };
  }

  /** 批量导入：逐张校验，重复凭证号等原因拒绝，返回每张凭证的处理结果 */
  function importVouchers(state, list) {
    const results = [];
    const batchNos = new Set();
    list.forEach((v, idx) => {
      const no = String(v.voucherNo || `第${idx + 1}张`);
      if (batchNos.has(v.voucherNo)) {
        results.push({ voucherNo: no, ok: false, errors: [{ code: 'DUP_VOUCHER', message: '本批次内凭证号重复' }] });
        return;
      }
      batchNos.add(v.voucherNo);
      const r = postVoucher(state, v);
      if (r.ok) results.push({ voucherNo: no, ok: true, message: `已入账（账期 ${r.voucher.postPeriod}，${r.entries.length} 条分录）` });
      else results.push({ voucherNo: no, ok: false, errors: r.errors });
    });
    return results;
  }

  // ---------------- 关账校验 ----------------
  function validatePeriod(state, period) {
    const blockers = [];
    const warnings = [];
    const map = acctMap(state);
    const vids = new Set(
      state.entries.filter(e => e.postPeriod === period).map(e => e.voucherId)
    );
    let totalD = 0, totalC = 0;
    state.vouchers.filter(v => vids.has(v.id)).forEach(v => {
      if (v.lines.length < 2) {
        blockers.push({ code: 'MISSING_LINES', voucherNo: v.voucherNo, message: `凭证 ${v.voucherNo} 仅 ${v.lines.length} 行（凭证缺行）` });
      }
      v.lines.forEach((ln, i) => {
        if (!map[ln.accountCode]) {
          blockers.push({ code: 'UNMAPPED', voucherNo: v.voucherNo, message: `凭证 ${v.voucherNo} 第 ${i + 1} 行科目 “${ln.accountCode}” 未映射` });
        }
        if (ln.debit === 0 && ln.credit === 0) {
          blockers.push({ code: 'EMPTY_LINE', voucherNo: v.voucherNo, message: `凭证 ${v.voucherNo} 第 ${i + 1} 行为空行` });
        }
      });
      const td = sum(v.lines, l => l.debit);
      const tc = sum(v.lines, l => l.credit);
      if (td !== tc || td === 0) {
        blockers.push({
          code: 'IMBALANCE', voucherNo: v.voucherNo,
          message: `凭证 ${v.voucherNo} 借贷不平：借 ${fmtYuan(td)} / 贷 ${fmtYuan(tc)}，差额 ${fmtYuan(Math.abs(td - tc))}`
        });
      }
      if (v.voucherPeriod !== period) {
        warnings.push({
          code: 'CROSS_PERIOD', voucherNo: v.voucherNo,
          message: `凭证 ${v.voucherNo} 为跨期入账：凭证账期 ${v.voucherPeriod}，入账账期 ${period}`
        });
      }
      totalD += td;
      totalC += tc;
    });
    if (totalD !== totalC) {
      blockers.push({ code: 'PERIOD_IMBALANCE', message: `账期 ${period} 合计借贷不平：借 ${fmtYuan(totalD)} / 贷 ${fmtYuan(totalC)}` });
    }
    if (vids.size === 0) {
      warnings.push({ code: 'EMPTY_PERIOD', message: `账期 ${period} 没有任何分录` });
    }
    return {
      period, blockers, warnings,
      totalDebit: totalD, totalCredit: totalC,
      voucherCount: vids.size
    };
  }

  function closePeriod(state, period, simulate) {
    const r = validatePeriod(state, period);
    if (r.blockers.length) return { ok: false, ...r };
    const prev = state.periods[period] || {};
    if (prev.status === 'closed') {
      return { ok: false, blockers: [], warnings: r.warnings, errors: [{ code: 'ALREADY_CLOSED', message: `账期 ${period} 已关账` }] };
    }
    state.periods[period] = {
      status: simulate ? 'simulated' : 'closed',
      closedAt: new Date().toISOString(),
      everClosed: prev.everClosed || !simulate
    };
    addPeriod(state, period);
    return { ok: true, ...r };
  }

  /** 重开：仅允许重开最后一个已正式关账的账期；曾经关账的凭证保持锁定（只能冲销更正） */
  function reopenPeriod(state, period) {
    const rec = state.periods[period];
    if (!rec || rec.status !== 'closed') {
      return { ok: false, errors: [{ code: 'NOT_CLOSED', message: `账期 ${period} 不是已关账状态` }] };
    }
    const idx = state.periodKeys.indexOf(period);
    const laterClosed = state.periodKeys.slice(idx + 1)
      .some(p => state.periods[p] && state.periods[p].status === 'closed');
    if (laterClosed) {
      return { ok: false, errors: [{ code: 'LATER_CLOSED', message: '存在更晚的已关账账期，请先重开后续账期' }] };
    }
    rec.status = 'open';
    rec.closedAt = null;
    // everClosed 保留：原记录依旧不可直接修改
    return { ok: true };
  }

  function cancelSimulation(state, period) {
    const rec = state.periods[period];
    if (!rec || rec.status !== 'simulated') {
      return { ok: false, errors: [{ code: 'NOT_SIMULATED', message: `账期 ${period} 未处于模拟关账状态` }] };
    }
    rec.status = 'open';
    rec.closedAt = null;
    return { ok: true };
  }

  // ---------------- 锁定 / 冲销 / 更正 ----------------
  /** 凭证是否被锁定：任一分录所在账期曾正式关账，或当前处于关账/模拟关账状态 */
  function isVoucherLocked(state, voucher) {
    return state.entries
      .filter(e => e.voucherId === voucher.id)
      .some(e => {
        const rec = state.periods[e.postPeriod];
        return rec && (rec.everClosed || rec.status === 'simulated');
      });
  }

  function deleteVoucher(state, voucherId) {
    const v = state.vouchers.find(x => x.id === voucherId);
    if (!v) return { ok: false, errors: [{ code: 'NOT_FOUND', message: '凭证不存在' }] };
    if (isVoucherLocked(state, v)) {
      return { ok: false, errors: [{ code: 'LOCKED', message: '该凭证所属账期已关账，原记录禁止删除，只能通过冲销更正' }] };
    }
    state.entries = state.entries.filter(e => e.voucherId !== voucherId);
    state.vouchers = state.vouchers.filter(x => x.id !== voucherId);
    return { ok: true };
  }

  /**
   * 冲销已关账凭证：在目标（当前开放）账期生成借贷方向相反的冲销凭证与分录，
   * 原凭证及其分录保持不变。
   */
  function reverseVoucher(state, voucherId, targetPeriod, dateStr) {
    const orig = state.vouchers.find(v => v.id === voucherId);
    if (!orig) return { ok: false, errors: [{ code: 'NOT_FOUND', message: '原凭证不存在' }] };
    if (!isVoucherLocked(state, orig)) {
      return { ok: false, errors: [{ code: 'NOT_LOCKED', message: '原凭证所在账期尚未关账，可直接修改或删除，无需冲销' }] };
    }
    if (state.vouchers.some(v => v.reversesVoucherId === orig.id)) {
      return { ok: false, errors: [{ code: 'ALREADY_REVERSED', message: '该凭证已生成冲销凭证，不能重复冲销' }] };
    }
    if (!PERIOD_RE.test(targetPeriod)) {
      return { ok: false, errors: [{ code: 'BAD_PERIOD', message: '目标账期格式应为 YYYY-MM' }] };
    }
    const trec = state.periods[targetPeriod];
    if (trec && trec.status !== 'open') {
      return { ok: false, errors: [{ code: 'PERIOD_NOT_OPEN', message: `目标账期 ${targetPeriod} 未处于开放状态` }] };
    }
    const voucherDate = dateStr || lastDayOfPeriod(targetPeriod);
    let no = 'RV-' + orig.voucherNo;
    let n = 2;
    while (state.vouchers.some(v => v.voucherNo === no)) no = 'RV-' + orig.voucherNo + '-' + n++;

    const origEntries = state.entries.filter(e => e.voucherId === orig.id)
      .sort((a, b) => a.lineIndex - b.lineIndex);
    const lines = orig.lines.map(ln => ({
      accountCode: ln.accountCode,
      debit: ln.credit,          // 借贷对调
      credit: ln.debit,
      summary: '冲销：' + (ln.summary || orig.summary)
    }));
    const voucher = {
      id: uid('v'),
      voucherNo: no,
      source: '系统冲销',
      summary: '冲销凭证 ' + orig.voucherNo + '：' + orig.summary,
      voucherDate,
      voucherPeriod: periodOf(voucherDate),
      postPeriod: targetPeriod,
      lines,
      kind: 'reversal',
      reversesVoucherId: orig.id,
      correctsVoucherId: null,
      createdAt: new Date().toISOString()
    };
    state.vouchers.push(voucher);
    const entries = lines.map((ln, i) => ({
      id: uid('e'),
      voucherId: voucher.id,
      voucherNo: no,
      lineIndex: i,
      accountCode: ln.accountCode,
      debit: ln.debit,
      credit: ln.credit,
      summary: ln.summary,
      voucherPeriod: voucher.voucherPeriod,
      postPeriod: targetPeriod,
      kind: 'reversal',
      reversalOf: origEntries[i] ? origEntries[i].id : null,
      correctionOf: null,
      createdAt: voucher.createdAt
    }));
    state.entries.push(...entries);
    addPeriod(state, targetPeriod);
    addPeriod(state, voucher.voucherPeriod);
    return { ok: true, voucher, entries };
  }

  /** 录入更正凭证（冲销之后的新分录），与原凭证建立链条 */
  function postCorrection(state, input, originalVoucherId) {
    const orig = state.vouchers.find(v => v.id === originalVoucherId);
    if (!orig) return { ok: false, errors: [{ code: 'NOT_FOUND', message: '原凭证不存在' }] };
    return postVoucher(state, input, { kind: 'correction', correctsVoucherId: orig.id });
  }

  function voucherChain(state, voucherId) {
    const v = state.vouchers.find(x => x.id === voucherId);
    if (!v) return null;
    const root = v.reversesVoucherId
      ? state.vouchers.find(x => x.id === v.reversesVoucherId)
      : (v.correctsVoucherId ? state.vouchers.find(x => x.id === v.correctsVoucherId) : v);
    const reversals = state.vouchers.filter(x => x.reversesVoucherId === root.id);
    const corrections = state.vouchers.filter(x => x.correctsVoucherId === root.id);
    return { root, reversals, corrections };
  }

  /**
   * 跨期更正影响：对每张被冲销且冲销发生在不同账期的原凭证，
   * 同时给出原账期与当前账期（冲销+更正）的科目级影响及两期净额。
   */
  function crossPeriodImpact(state) {
    const out = [];
    state.vouchers.filter(v => v.kind === 'reversal').forEach(rv => {
      const orig = state.vouchers.find(v => v.id === rv.reversesVoucherId);
      if (!orig || rv.postPeriod === orig.voucherPeriod) return;
      const corrections = state.vouchers.filter(v => v.correctsVoucherId === orig.id);
      const codes = new Set();
      orig.lines.forEach(l => codes.add(l.accountCode));
      rv.lines.forEach(l => codes.add(l.accountCode));
      corrections.forEach(c => c.lines.forEach(l => codes.add(l.accountCode)));
      const rows = [...codes].sort().map(code => {
        const ol = orig.lines.filter(l => l.accountCode === code);
        const rl = rv.lines.filter(l => l.accountCode === code);
        const cl = corrections.flatMap(c => c.lines).filter(l => l.accountCode === code);
        const oNet = sum(ol, l => l.debit - l.credit);
        const rNet = sum(rl, l => l.debit - l.credit);
        const cNet = sum(cl, l => l.debit - l.credit);
        return {
          accountCode: code,
          originalNet: oNet,
          reversalNet: rNet,
          correctionNet: cNet,
          currentNet: rNet + cNet,
          bothPeriodNet: oNet + rNet + cNet
        };
      });
      out.push({
        original: orig,
        reversal: rv,
        corrections,
        originalPeriod: orig.voucherPeriod,
        currentPeriod: rv.postPeriod,
        rows
      });
    });
    return out;
  }

  // ---------------- 试算平衡表 ----------------
  function trialBalance(state, period) {
    const byAccount = {};
    state.accounts.forEach(a => {
      byAccount[a.code] = { open: 0, curD: 0, curC: 0 };
    });
    state.entries.forEach(e => {
      if (!byAccount[e.accountCode]) return; // 未映射科目在关账校验中拦截
      const b = byAccount[e.accountCode];
      const net = e.debit - e.credit;
      if (e.postPeriod < period) b.open += net;
      else if (e.postPeriod === period) { b.curD += e.debit; b.curC += e.credit; }
    });
    const split = (net) => net >= 0 ? { debit: net, credit: 0 } : { debit: 0, credit: -net };

    const groups = TYPE_ORDER.map(type => {
      const rows = state.accounts.filter(a => a.type === type).map(a => {
        const b = byAccount[a.code];
        const closeNet = b.open + b.curD - b.curC;
        return {
          account: a,
          opening: split(b.open),
          current: { debit: b.curD, credit: b.curC },
          closing: split(closeNet),
          closeNet
        };
      });
      const agg = rows.reduce((acc, r) => ({
        openD: acc.openD + r.opening.debit,
        openC: acc.openC + r.opening.credit,
        curD: acc.curD + r.current.debit,
        curC: acc.curC + r.current.credit,
        closeD: acc.closeD + r.closing.debit,
        closeC: acc.closeC + r.closing.credit
      }), { openD: 0, openC: 0, curD: 0, curC: 0, closeD: 0, closeC: 0 });
      return { type, label: TYPE_LABEL[type], rows, agg };
    });
    const totals = groups.reduce((acc, g) => ({
      openD: acc.openD + g.agg.openD, openC: acc.openC + g.agg.openC,
      curD: acc.curD + g.agg.curD, curC: acc.curC + g.agg.curC,
      closeD: acc.closeD + g.agg.closeD, closeC: acc.closeC + g.agg.closeC
    }), { openD: 0, openC: 0, curD: 0, curC: 0, closeD: 0, closeC: 0 });

    return {
      period,
      groups,
      totals,
      balanced: {
        opening: totals.openD === totals.openC,
        current: totals.curD === totals.curC,
        closing: totals.closeD === totals.closeC
      }
    };
  }

  /** 试算平衡表行下钻：返回组成该科目（或该类别全部科目）在指定账期的分录 */
  function drillEntries(state, period, accountCode, type) {
    return state.entries.filter(e => {
      if (e.postPeriod !== period) return false;
      if (accountCode) return e.accountCode === accountCode;
      if (type) {
        const a = state.accounts.find(x => x.code === e.accountCode);
        return a && a.type === type;
      }
      return true;
    }).sort((a, b) => a.voucherNo.localeCompare(b.voucherNo) || a.lineIndex - b.lineIndex);
  }

  // ---------------- 查询 ----------------
  function filterEntries(state, f) {
    f = f || {};
    const kw = (f.keyword || '').trim().toLowerCase();
    return state.entries.filter(e => {
      if (f.period && e.postPeriod !== f.period) return false;
      if (f.voucherPeriod && e.voucherPeriod !== f.voucherPeriod) return false;
      if (f.accountCode && e.accountCode !== f.accountCode) return false;
      if (f.kind && e.kind !== f.kind) return false;
      if (f.voucherNo && e.voucherNo !== f.voucherNo) return false;
      if (kw) {
        const hay = (e.voucherNo + ' ' + e.summary + ' ' + e.accountCode).toLowerCase();
        if (!hay.includes(kw)) return false;
      }
      return true;
    }).sort((a, b) =>
      a.postPeriod.localeCompare(b.postPeriod) ||
      a.voucherNo.localeCompare(b.voucherNo) ||
      a.lineIndex - b.lineIndex
    );
  }

  function openPeriods(state) {
    return state.periodKeys.filter(p => !state.periods[p] || state.periods[p].status === 'open');
  }

  return {
    // utils
    uid, toCents, fmtYuan, periodOf, lastDayOfPeriod,
    TYPE_LABEL, TYPE_ORDER, DEBIT_NORMAL,
    // lifecycle
    createState, postVoucher, importVouchers, deleteVoucher,
    // close
    validatePeriod, closePeriod, reopenPeriod, cancelSimulation,
    // corrections
    isVoucherLocked, reverseVoucher, postCorrection, voucherChain, crossPeriodImpact,
    // reports / query
    trialBalance, drillEntries, filterEntries, openPeriods
  };
});
