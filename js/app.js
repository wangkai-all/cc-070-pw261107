/* 本地会计分录关账台 —— UI 层（依赖 core.js / seed.js 的全局 LedgerCore / SeedData） */
(function () {
  'use strict';
  const C = window.LedgerCore;
  const STORE_KEY = 'local-close-desk:v1';

  // ---------------- 状态 ----------------
  let state = loadState();
  let filter = { period: '', accountCode: '', voucherNo: '', kind: '', keyword: '' };
  let selectedPeriod = null;
  let tbPeriod = null;
  let editCtx = null;   // {mode:'new'|'correction', originalVoucherId?}
  let editLines = [];

  // ---------------- 小工具 ----------------
  const $ = (sel) => document.querySelector(sel);
  const esc = (s) => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const yuan = (cents) => C.fmtYuan(cents);
  const acctName = (code) => {
    const a = state.accounts.find(x => x.code === code);
    return a ? a.name : '⚠ 未映射科目';
  };
  const periodRec = (p) => state.periods[p] || { status: 'open' };
  const STATUS_LABEL = { open: '开放', simulated: '模拟关账', closed: '已关账' };
  const KIND_LABEL = { original: '原始', reversal: '冲销', correction: '更正' };

  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast ' + (type || 'info');
    el.textContent = msg;
    $('#toast-wrap').appendChild(el);
    setTimeout(() => el.remove(), 3800);
  }

  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(state));
    } catch (e) {
      toast('本地存储失败：' + e.message, 'err');
    }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        const s = JSON.parse(raw);
        if (s && Array.isArray(s.accounts) && Array.isArray(s.vouchers)) return s;
      }
    } catch (e) { /* 损坏则回落到种子数据 */ }
    const s = C.createState(SeedData.accounts, SeedData.vouchers);
    Object.assign(s.periods, JSON.parse(JSON.stringify(SeedData.initialPeriods)));
    return s;
  }

  function resetState() {
    state = C.createState(SeedData.accounts, SeedData.vouchers);
    Object.assign(state.periods, JSON.parse(JSON.stringify(SeedData.initialPeriods)));
    save();
    selectedPeriod = null;
    tbPeriod = null;
    renderAll();
  }

  function fillPeriods(selectEl, allowAll, allLabel) {
    const cur = selectEl.value;
    selectEl.innerHTML = '';
    if (allowAll) {
      const opt = document.createElement('option');
      opt.value = ''; opt.textContent = allLabel || '全部账期';
      selectEl.appendChild(opt);
    }
    state.periodKeys.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p;
      opt.textContent = `${p}（${STATUS_LABEL[periodRec(p).status]}）`;
      selectEl.appendChild(opt);
    });
    if ([...selectEl.options].some(o => o.value === cur)) selectEl.value = cur;
  }

  function fillAccounts(selectEl) {
    const cur = selectEl.value;
    selectEl.innerHTML = '<option value="">全部科目</option>';
    state.accounts.forEach(a => {
      const opt = document.createElement('option');
      opt.value = a.code;
      opt.textContent = `${a.code} ${a.name}`;
      selectEl.appendChild(opt);
    });
    if (cur) selectEl.value = cur;
  }

  function fillVoucherSelect() {
    const sel = $('#f-voucher');
    const cur = sel.value;
    sel.innerHTML = '<option value="">全部凭证</option>';
    state.vouchers.slice().sort((a, b) => b.voucherNo.localeCompare(a.voucherNo)).forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.voucherNo;
      opt.textContent = `${v.voucherNo}（${v.voucherPeriod}）`;
      sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
  }

  // ---------------- 页签切换 ----------------
  document.querySelectorAll('nav.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b === btn));
      document.querySelectorAll('.tabview').forEach(t => t.classList.remove('active'));
      $('#tab-' + btn.dataset.tab).classList.add('active');
      if (btn.dataset.tab === 'close') renderClose();
      if (btn.dataset.tab === 'tb') renderTB();
      if (btn.dataset.tab === 'correct') renderCorrect();
    });
  });

  // ---------------- 页签 1：分录 ----------------
  function renderEntries() {
    fillPeriods($('#f-period'), true);
    $('#f-period').value = filter.period || '';
    fillAccounts($('#f-account'));
    $('#f-account').value = filter.accountCode || '';
    fillVoucherSelect();
    $('#f-voucher').value = filter.voucherNo || '';
    $('#f-kind').value = filter.kind || '';
    $('#f-keyword').value = filter.keyword || '';

    const rows = C.filterEntries(state, filter);
    const tbody = $('#entries-table tbody');
    tbody.innerHTML = '';
    rows.forEach(e => {
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      const cross = e.voucherPeriod !== e.postPeriod;
      tr.innerHTML = `
        <td class="mono">${esc(e.postPeriod)}</td>
        <td class="mono">${esc(e.voucherPeriod)}${cross ? ' <span class="badge warn" title="凭证账期与入账账期不同">跨期</span>' : ''}</td>
        <td class="mono">${esc(e.voucherNo)}</td>
        <td>${e.lineIndex + 1}</td>
        <td class="mono">${esc(e.accountCode)}</td>
        <td>${esc(acctName(e.accountCode))}</td>
        <td>${esc(e.summary)}</td>
        <td><span class="badge kind-${e.kind}">${KIND_LABEL[e.kind]}</span></td>
        <td class="num dr">${e.debit ? yuan(e.debit) : ''}</td>
        <td class="num cr">${e.credit ? yuan(e.credit) : ''}</td>`;
      tr.addEventListener('click', () => openVoucherModal(e.voucherId));
      tbody.appendChild(tr);
    });
    $('#entries-empty').hidden = rows.length > 0;

    const td = rows.reduce((a, e) => a + e.debit, 0);
    const tc = rows.reduce((a, e) => a + e.credit, 0);
    $('#entries-kpi').innerHTML = `
      <div class="kpi"><div class="k-label">分录条数</div><div class="k-val">${rows.length}</div></div>
      <div class="kpi"><div class="k-label">借方合计(元)</div><div class="k-val">${yuan(td)}</div></div>
      <div class="kpi"><div class="k-label">贷方合计(元)</div><div class="k-val">${yuan(tc)}</div></div>
      <div class="kpi"><div class="k-label">借贷差额(元)</div><div class="k-val ${td === tc ? 'good' : 'bad'}">${yuan(td - tc)}</div></div>`;
  }

  ['f-period', 'f-account', 'f-voucher', 'f-kind'].forEach(id =>
    $('#' + id).addEventListener('change', (ev) => {
      const key = id === 'f-account' ? 'accountCode' : id === 'f-voucher' ? 'voucherNo' : id.slice(2).replace(/^./, c => c.toLowerCase());
      filter[key === 'period' ? 'period' : key] = ev.target.value;
      renderEntries();
    }));
  $('#f-keyword').addEventListener('input', (ev) => {
    filter.keyword = ev.target.value;
    renderEntries();
  });
  $('#btn-clear-filter').addEventListener('click', () => {
    filter = { period: '', accountCode: '', voucherNo: '', kind: '', keyword: '' };
    renderEntries();
  });

  // ---------------- 凭证弹窗 ----------------
  function voucherTableHtml(v) {
    const td = v.lines.reduce((a, l) => a + l.debit, 0);
    const tc = v.lines.reduce((a, l) => a + l.credit, 0);
    const rows = v.lines.map((l, i) => `
      <tr>
        <td>${i + 1}</td>
        <td class="mono">${esc(l.accountCode)}</td>
        <td>${esc(acctName(l.accountCode))}</td>
        <td>${esc(l.summary)}</td>
        <td class="num dr">${l.debit ? yuan(l.debit) : ''}</td>
        <td class="num cr">${l.credit ? yuan(l.credit) : ''}</td>
      </tr>`).join('');
    return `
      <div class="row" style="margin-bottom:10px;">
        <div><span class="muted">凭证号：</span><b class="mono">${esc(v.voucherNo)}</b></div>
        <div><span class="muted">凭证日期：</span>${esc(v.voucherDate)}</div>
        <div><span class="muted">凭证账期：</span class="mono">${esc(v.voucherPeriod)}</div>
        <div><span class="muted">入账账期：</span><span class="mono">${esc(v.postPeriod)}</span>
          ${v.voucherPeriod !== v.postPeriod ? '<span class="badge warn">跨期入账</span>' : ''}</div>
        <div><span class="muted">来源：</span>${esc(v.source)}</div>
        <div><span class="badge kind-${v.kind}">${KIND_LABEL[v.kind]}凭证</span></div>
      </div>
      <div style="margin-bottom:10px;"><span class="muted">摘要：</span>${esc(v.summary)}</div>
      <table>
        <thead><tr><th>行</th><th>科目代码</th><th>科目名称</th><th>摘要</th><th class="num">借方(元)</th><th class="num">贷方(元)</th></tr></thead>
        <tbody>${rows}
          <tr class="totals"><td colspan="4">合计</td><td class="num dr">${yuan(td)}</td><td class="num cr">${yuan(tc)}</td></tr>
        </tbody>
      </table>
      <p class="small-note">借贷${td === tc ? '<span class="badge ok">平衡</span>' : '<span class="badge block">不平衡，差额 ' + esc(yuan(td - tc)) + ' 元</span>'}</p>`;
  }

  function openVoucherModal(voucherId) {
    const v = state.vouchers.find(x => x.id === voucherId);
    if (!v) return;
    $('#v-title').textContent = '凭证详情 · ' + v.voucherNo;
    $('#v-body').innerHTML = voucherTableHtml(v) + chainHtml(v);
    const footer = $('#v-footer');
    footer.innerHTML = '';
    const locked = C.isVoucherLocked(state, v);
    if (locked) {
      const note = document.createElement('span');
      note.className = 'small-note';
      note.style.marginRight = 'auto';
      note.textContent = '该凭证所属账期已关账，原记录禁止直接修改/删除，只能冲销后做更正分录。';
      footer.appendChild(note);
      if (v.kind === 'original' && !state.vouchers.some(x => x.reversesVoucherId === v.id)) {
        const btn = document.createElement('button');
        btn.className = 'btn danger';
        btn.textContent = '冲销此凭证';
        btn.addEventListener('click', () => { closeModal('#modal-voucher'); openReverseModal(v.id); });
        footer.appendChild(btn);
      }
    } else if (v.kind === 'original') {
      const del = document.createElement('button');
      del.className = 'btn danger';
      del.textContent = '删除凭证';
      del.addEventListener('click', () => {
        if (!confirm('确认删除该凭证及其全部分录？')) return;
        const r = C.deleteVoucher(state, v.id);
        if (!r.ok) { toast(r.errors[0].message, 'err'); return; }
        save(); closeModal('#modal-voucher'); renderAll(); toast('凭证已删除', 'ok');
      });
      footer.appendChild(del);
    }
    const close = document.createElement('button');
    close.className = 'btn ghost';
    close.textContent = '关闭';
    close.addEventListener('click', () => closeModal('#modal-voucher'));
    footer.appendChild(close);
    openModal('#modal-voucher');
  }

  function chainHtml(v) {
    const chain = C.voucherChain(state, v.id);
    if (!chain || (chain.reversals.length === 0 && chain.corrections.length === 0 && chain.root.id === v.id)) return '';
    const item = (x, label) => `
      <div><span class="badge kind-${x.kind}">${label}</span>
        <button class="btn linkish" data-vid="${x.id}">${esc(x.voucherNo)}</button>
        <span class="muted mono">（入账 ${esc(x.postPeriod)}）</span> ${esc(x.summary)}
      </div>`;
    let html = '<div class="chain-box" style="margin-top:14px;"><div class="chain-title">🔗 更正链条</div>';
    html += item(chain.root, '原始');
    chain.reversals.forEach(x => { html += item(x, '冲销'); });
    chain.corrections.forEach(x => { html += item(x, '更正'); });
    html += '</div>';
    // 延迟绑定
    setTimeout(() => {
      $('#v-body').querySelectorAll('[data-vid]').forEach(b =>
        b.addEventListener('click', () => openVoucherModal(b.dataset.vid)));
    }, 0);
    return html;
  }

  // ---------------- 凭证编辑弹窗（新录入 / 更正） ----------------
  function accountOptions(selected) {
    return state.accounts.map(a =>
      `<option value="${esc(a.code)}" ${a.code === selected ? 'selected' : ''}>${esc(a.code)} ${esc(a.name)}</option>`).join('');
  }

  function openEditModal(mode, originalVoucherId) {
    editCtx = { mode, originalVoucherId: originalVoucherId || null };
    editLines = [
      { accountCode: state.accounts[0].code, summary: '', debit: '', credit: '' },
      { accountCode: state.accounts[1] ? state.accounts[1].code : state.accounts[0].code, summary: '', debit: '', credit: '' }
    ];
    $('#edit-title').textContent = mode === 'correction' ? '录入更正凭证（新分录）' : '录入凭证';
    $('#e-no').value = mode === 'correction' ? 'CORR-' + Date.now().toString(36).toUpperCase() : 'PZ-' + new Date().toISOString().slice(0, 7) + '-' + Date.now().toString(36).slice(-4).toUpperCase();
    $('#e-date').value = new Date().toISOString().slice(0, 10);
    $('#e-source').value = mode === 'correction' ? '手工更正' : '手工录入';
    $('#e-summary').value = '';
    fillPeriods($('#e-period'), false, '');
    const openPs = C.openPeriods(state);
    if (openPs.length) $('#e-period').value = openPs[openPs.length - 1];
    $('#e-correct-note').hidden = mode !== 'correction';
    if (mode === 'correction') {
      const orig = state.vouchers.find(v => v.id === originalVoucherId);
      $('#e-correct-note').textContent =
        `本更正凭证将与原凭证 ${orig.voucherNo}（${orig.voucherPeriod}）建立链条；冲销凭证已在 ${C.openPeriods(state).slice(-1)[0] || '开放账期'} 生成，此处录入更正后的正确分录。`;
    }
    renderEditLines();
    openModal('#modal-edit');
  }

  function renderEditLines() {
    const tbody = $('#e-lines');
    tbody.innerHTML = '';
    editLines.forEach((ln, i) => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><select data-f="accountCode">${accountOptions(ln.accountCode)}</select></td>
        <td><input type="text" data-f="summary" value="${esc(ln.summary)}" placeholder="行摘要"></td>
        <td><input type="number" step="0.01" min="0" data-f="debit" value="${esc(ln.debit)}" placeholder="0.00"></td>
        <td><input type="number" step="0.01" min="0" data-f="credit" value="${esc(ln.credit)}" placeholder="0.00"></td>
        <td><button class="btn linkish danger del-line" title="删除此行">✕</button></td>`;
      tr.querySelectorAll('[data-f]').forEach(inp => {
        inp.addEventListener('input', () => {
          editLines[i][inp.dataset.f] = inp.value;
          updateBalanceBadge();
        });
      });
      tr.querySelector('.del-line').addEventListener('click', () => {
        editLines.splice(i, 1);
        renderEditLines();
      });
      tbody.appendChild(tr);
    });
    updateBalanceBadge();
  }

  function updateBalanceBadge() {
    const td = editLines.reduce((a, l) => a + C.toCents(l.debit), 0);
    const tc = editLines.reduce((a, l) => a + C.toCents(l.credit), 0);
    const badge = $('#e-balance');
    badge.textContent = `借 ${yuan(td)} / 贷 ${yuan(tc)} / 差 ${yuan(td - tc)}`;
    badge.className = 'badge ' + (td === tc && td > 0 ? 'ok' : 'block');
  }

  $('#btn-add-line').addEventListener('click', () => {
    editLines.push({ accountCode: state.accounts[0].code, summary: '', debit: '', credit: '' });
    renderEditLines();
  });

  $('#btn-new-voucher').addEventListener('click', () => openEditModal('new'));

  $('#btn-save-voucher').addEventListener('click', () => {
    const payload = {
      voucherNo: $('#e-no').value.trim(),
      voucherDate: $('#e-date').value,
      source: $('#e-source').value.trim() || '手工录入',
      summary: $('#e-summary').value.trim(),
      lines: editLines.map(l => ({
        accountCode: l.accountCode,
        debit: l.debit === '' ? 0 : Number(l.debit),
        credit: l.credit === '' ? 0 : Number(l.credit),
        summary: l.summary
      }))
    };
    const postPeriod = $('#e-period').value;
    const r = editCtx.mode === 'correction'
      ? C.postCorrection(state, { ...payload, postPeriod }, editCtx.originalVoucherId)
      : C.postVoucher(state, payload, { postPeriod });
    if (!r.ok) {
      toast('凭证未入账：' + r.errors.map(e => e.message).join('；'), 'err');
      return;
    }
    save();
    closeModal('#modal-edit');
    renderAll();
    toast(`凭证 ${r.voucher.voucherNo} 已入账（${r.entries.length} 条分录，入账账期 ${r.voucher.postPeriod}）`, 'ok');
  });

  // ---------------- 冲销弹窗 ----------------
  function openReverseModal(originalVoucherId) {
    const orig = state.vouchers.find(v => v.id === originalVoucherId);
    const openPs = C.openPeriods(state);
    if (!openPs.length) { toast('没有开放账期，无法冲销；请先重开一个账期', 'err'); return; }
    const target = openPs[openPs.length - 1];
    const html = `
      <div class="chain-box">
        <div class="chain-title">原凭证（只读，不会被修改）</div>
        ${voucherTableHtml(orig)}
      </div>
      <div class="row">
        <div class="field">
          <label>冲销入账账期（当前开放账期）</label>
          <select id="rv-period">${openPs.map(p => `<option ${p === target ? 'selected' : ''}>${esc(p)}</option>`).join('')}</select>
        </div>
        <div class="field">
          <label>冲销凭证日期</label>
          <input type="date" id="rv-date" value="${C.lastDayOfPeriod(target)}">
        </div>
      </div>
      <p class="small-note">系统将生成借贷方向相反、凭证号 RV- 开头的冲销凭证；${orig.voucherPeriod !== target ? '本次为<b>跨期冲销</b>，冲销后可在“冲销与跨期更正”页查看两个账期的影响。' : ''}</p>`;
    $('#v-title').textContent = '冲销凭证 · ' + orig.voucherNo;
    $('#v-body').innerHTML = html;
    $('#v-footer').innerHTML = '';
    const cancel = document.createElement('button');
    cancel.className = 'btn ghost'; cancel.textContent = '取消';
    cancel.addEventListener('click', () => closeModal('#modal-voucher'));
    const ok = document.createElement('button');
    ok.className = 'btn danger'; ok.textContent = '确认冲销';
    ok.addEventListener('click', () => {
      const r = C.reverseVoucher(state, orig.id, $('#rv-period').value, $('#rv-date').value);
      if (!r.ok) { toast(r.errors[0].message, 'err'); return; }
      save();
      closeModal('#modal-voucher');
      renderAll();
      toast(`冲销凭证 ${r.voucher.voucherNo} 已生成于账期 ${r.voucher.postPeriod}，原凭证保持不变`, 'ok');
      // 引导继续录入更正凭证
      if (confirm('冲销完成。是否立即录入更正后的新分录？')) {
        openEditModal('correction', orig.id);
      }
    });
    $('#v-footer').append(cancel, ok);
    openModal('#modal-voucher');
  }

  // ---------------- 页签 2：关账 ----------------
  function renderClose() {
    const grid = $('#period-grid');
    grid.innerHTML = '';
    state.periodKeys.forEach(p => {
      const rec = periodRec(p);
      const v = C.validatePeriod(state, p);
      const card = document.createElement('div');
      card.className = 'period-card' + (selectedPeriod === p ? ' selected' : '');
      card.innerHTML = `
        <div class="p-period">${esc(p)}</div>
        <div class="p-meta">
          <span class="badge ${rec.status}">${STATUS_LABEL[rec.status]}</span>
          · ${v.voucherCount} 张凭证 · 借/贷 ${yuan(v.totalDebit)} / ${yuan(v.totalCredit)}
          ${rec.everClosed && rec.status === 'open' ? '<br><span class="badge warn">曾关账，原凭证仍锁定</span>' : ''}
        </div>
        <div class="p-actions">
          <button class="btn ghost small" data-act="check">检查</button>
          ${rec.status === 'open' ? '<button class="btn ghost small" data-act="sim">模拟关账</button>' : ''}
          ${rec.status === 'simulated' ? '<button class="btn primary small" data-act="close">正式关账</button><button class="btn ghost small" data-act="unsim">取消模拟</button>' : ''}
          ${rec.status === 'closed' ? '<button class="btn danger small" data-act="reopen">重开</button>' : ''}
        </div>`;
      card.querySelector('[data-act="check"]').addEventListener('click', (ev) => {
        ev.stopPropagation();
        selectedPeriod = p; renderClose();
      });
      card.addEventListener('click', () => { selectedPeriod = p; renderClose(); });
      const act = (sel, fn) => {
        const b = card.querySelector(`[data-act="${sel}"]`);
        if (b) b.addEventListener('click', (ev) => { ev.stopPropagation(); fn(); });
      };
      act('sim', () => doClose(p, true));
      act('close', () => doClose(p, false));
      act('unsim', () => {
        const r = C.cancelSimulation(state, p);
        if (!r.ok) toast(r.errors[0].message, 'err'); else { save(); toast(`已取消 ${p} 的模拟关账`, 'ok'); renderAll(); }
      });
      act('reopen', () => {
        if (!confirm(`确认重开账期 ${p}？注意：该账期原凭证仍保持锁定，更正只能通过冲销。`)) return;
        const r = C.reopenPeriod(state, p);
        if (!r.ok) { toast(r.errors[0].message, 'err'); return; }
        save(); toast(`账期 ${p} 已重开（原凭证仍锁定）`, 'ok'); renderAll();
      });
      grid.appendChild(card);
    });
    if (!selectedPeriod && state.periodKeys.length) selectedPeriod = state.periodKeys[0];
    renderCheckPanel();
  }

  function doClose(period, simulate) {
    const r = C.closePeriod(state, period, simulate);
    if (!r.ok) {
      selectedPeriod = period;
      renderClose();
      const msgs = (r.errors || []).concat(r.blockers || []).map(e => e.message).join('；');
      toast('无法关账：' + msgs, 'err');
      return;
    }
    save();
    toast(simulate ? `账期 ${period} 已模拟关账（可取消）` : `账期 ${period} 已正式关账，原记录已锁定`, simulate ? 'info' : 'ok');
    renderAll();
  }

  function renderCheckPanel() {
    const panel = $('#check-panel');
    if (!selectedPeriod) { panel.hidden = true; return; }
    panel.hidden = false;
    const p = selectedPeriod;
    const rec = periodRec(p);
    const r = C.validatePeriod(state, p);
    $('#check-period').textContent = p;
    $('#check-status').innerHTML = `<span class="badge ${rec.status}">${STATUS_LABEL[rec.status]}</span>`;

    $('#check-kpi').innerHTML = `
      <div class="kpi"><div class="k-label">凭证数</div><div class="k-val">${r.voucherCount}</div></div>
      <div class="kpi"><div class="k-label">借方合计(元)</div><div class="k-val">${yuan(r.totalDebit)}</div></div>
      <div class="kpi"><div class="k-label">贷方合计(元)</div><div class="k-val">${yuan(r.totalCredit)}</div></div>
      <div class="kpi"><div class="k-label">阻断项 / 警告项</div>
        <div class="k-val ${r.blockers.length ? 'bad' : 'good'}">${r.blockers.length} / ${r.warnings.length}</div></div>`;

    const bl = $('#blocker-list');
    bl.innerHTML = '';
    if (!r.blockers.length) {
      bl.innerHTML = '<li class="clean">✔ 无阻断原因，满足关账条件</li>';
    } else {
      r.blockers.forEach(b => {
        const li = document.createElement('li');
        li.className = 'blocker';
        li.innerHTML = `<span class="badge block">${esc(b.code)}</span><span>${esc(b.message)}</span>`;
        bl.appendChild(li);
      });
    }
    const wl = $('#warning-list');
    wl.innerHTML = '';
    if (!r.warnings.length) {
      wl.innerHTML = '<li class="clean">✔ 无警告</li>';
    } else {
      r.warnings.forEach(w => {
        const li = document.createElement('li');
        li.className = 'warning';
        li.innerHTML = `<span class="badge warn">${esc(w.code)}</span><span>${esc(w.message)}</span>`;
        wl.appendChild(li);
      });
    }
    $('#btn-simulate').disabled = rec.status !== 'open' || r.blockers.length > 0;
    $('#btn-close').disabled = rec.status === 'closed' || r.blockers.length > 0;
    $('#btn-cancel-sim').disabled = rec.status !== 'simulated';
    $('#btn-reopen').disabled = rec.status !== 'closed';
  }

  $('#btn-simulate').addEventListener('click', () => doClose(selectedPeriod, true));
  $('#btn-close').addEventListener('click', () => {
    if (!confirm(`确认正式关账 ${selectedPeriod}？关账后该账期原凭证将不可直接修改或删除。`)) return;
    doClose(selectedPeriod, false);
  });
  $('#btn-cancel-sim').addEventListener('click', () => {
    const r = C.cancelSimulation(state, selectedPeriod);
    if (!r.ok) toast(r.errors[0].message, 'err'); else { save(); renderAll(); toast('已取消模拟关账', 'ok'); }
  });
  $('#btn-reopen').addEventListener('click', () => {
    if (!confirm(`确认重开 ${selectedPeriod}？原凭证仍保持锁定。`)) return;
    const r = C.reopenPeriod(state, selectedPeriod);
    if (!r.ok) { toast(r.errors[0].message, 'err'); return; }
    save(); renderAll(); toast('账期已重开', 'ok');
  });

  // ---------------- 页签 3：试算平衡表 ----------------
  function renderTB() {
    fillPeriods($('#tb-period'), false);
    if (!tbPeriod || !state.periodKeys.includes(tbPeriod)) tbPeriod = state.periodKeys[0];
    $('#tb-period').value = tbPeriod;
    const tb = C.trialBalance(state, tbPeriod);
    const tbody = $('#tb-table tbody');
    tbody.innerHTML = '';
    tb.groups.forEach(g => {
      const gtr = document.createElement('tr');
      gtr.className = 'group-head clickable';
      gtr.innerHTML = `<td colspan="2">▸ ${esc(g.label)}（点击下钻本类全部分录）</td>
        <td class="num">${yuan(g.agg.openD)}</td><td class="num">${yuan(g.agg.openC)}</td>
        <td class="num">${yuan(g.agg.curD)}</td><td class="num">${yuan(g.agg.curC)}</td>
        <td class="num">${yuan(g.agg.closeD)}</td><td class="num">${yuan(g.agg.closeC)}</td>`;
      gtr.addEventListener('click', () => openDrill(`【${g.label}】全部科目 · ${tbPeriod}`, null, g.type));
      tbody.appendChild(gtr);
      g.rows.forEach(r => {
        const tr = document.createElement('tr');
        tr.className = 'clickable';
        tr.innerHTML = `
          <td class="mono">${esc(r.account.code)}</td>
          <td>${esc(r.account.name)}</td>
          <td class="num">${r.opening.debit ? yuan(r.opening.debit) : ''}</td>
          <td class="num">${r.opening.credit ? yuan(r.opening.credit) : ''}</td>
          <td class="num dr">${r.current.debit ? yuan(r.current.debit) : ''}</td>
          <td class="num cr">${r.current.credit ? yuan(r.current.credit) : ''}</td>
          <td class="num">${r.closing.debit ? yuan(r.closing.debit) : ''}</td>
          <td class="num">${r.closing.credit ? yuan(r.closing.credit) : ''}</td>`;
        tr.addEventListener('click', () => openDrill(`${r.account.code} ${r.account.name} · ${tbPeriod}`, r.account.code, null));
        tbody.appendChild(tr);
      });
    });
    const ttr = document.createElement('tr');
    ttr.className = 'totals';
    ttr.innerHTML = `<td colspan="2">合计</td>
      <td class="num">${yuan(tb.totals.openD)}</td><td class="num">${yuan(tb.totals.openC)}</td>
      <td class="num">${yuan(tb.totals.curD)}</td><td class="num">${yuan(tb.totals.curC)}</td>
      <td class="num">${yuan(tb.totals.closeD)}</td><td class="num">${yuan(tb.totals.closeC)}</td>`;
    tbody.appendChild(ttr);

    const badge = (ok, label) =>
      `<span class="badge ${ok ? 'ok' : 'block'}">${label} ${ok ? '平衡 ✓' : '不平衡 ✗'}</span>`;
    $('#tb-balance-badges').innerHTML =
      badge(tb.balanced.opening, '期初') + ' ' +
      badge(tb.balanced.current, '本期') + ' ' +
      badge(tb.balanced.closing, '期末');
  }

  $('#tb-period').addEventListener('change', (ev) => { tbPeriod = ev.target.value; renderTB(); });
  $('#btn-tb-refresh').addEventListener('click', renderTB);

  function openDrill(title, accountCode, type) {
    $('#drill-title').textContent = '组成分录 · ' + title;
    const rows = C.drillEntries(state, tbPeriod, accountCode, type);
    const tbody = $('#drill-table tbody');
    tbody.innerHTML = '';
    let td = 0, tc = 0;
    rows.forEach(e => {
      td += e.debit; tc += e.credit;
      const tr = document.createElement('tr');
      tr.className = 'clickable';
      tr.innerHTML = `
        <td class="mono">${esc(e.voucherNo)}</td><td>${e.lineIndex + 1}</td>
        <td class="mono">${esc(e.accountCode)} ${esc(acctName(e.accountCode))}</td>
        <td>${esc(e.summary)}</td>
        <td class="num dr">${e.debit ? yuan(e.debit) : ''}</td>
        <td class="num cr">${e.credit ? yuan(e.credit) : ''}</td>`;
      tr.addEventListener('click', () => { closeModal('#modal-drill'); openVoucherModal(e.voucherId); });
      tbody.appendChild(tr);
    });
    const total = document.createElement('tr');
    total.className = 'totals';
    total.innerHTML = `<td colspan="4">合计（${rows.length} 条分录）</td><td class="num">${yuan(td)}</td><td class="num">${yuan(tc)}</td>`;
    tbody.appendChild(total);
    openModal('#modal-drill');
  }

  // ---------------- 页签 4：冲销与跨期更正 ----------------
  function renderCorrect() {
    // 跨期影响
    const impacts = C.crossPeriodImpact(state);
    const box = $('#impact-list');
    if (!impacts.length) {
      box.innerHTML = '<div class="empty">暂无跨期更正。演示：到“账期关账”重开一个账期后，对 2026-08 的已关账凭证发起冲销，冲销到 2026-10 即可在此看到两期影响。</div>';
    } else {
      box.innerHTML = '';
      impacts.forEach(im => {
        const wrap = document.createElement('div');
        wrap.className = 'chain-box';
        const rows = im.rows.map(r => `
          <tr>
            <td class="mono">${esc(r.accountCode)}</td><td>${esc(acctName(r.accountCode))}</td>
            <td class="num ${r.originalNet >= 0 ? 'dr' : 'cr'}">${yuan(Math.abs(r.originalNet))} ${r.originalNet >= 0 ? '借' : '贷'}</td>
            <td class="num ${r.currentNet >= 0 ? 'dr' : 'cr'}">${yuan(Math.abs(r.currentNet))} ${r.currentNet >= 0 ? '借' : '贷'}</td>
            <td class="num ${r.bothPeriodNet >= 0 ? 'dr' : 'cr'}"><b>${yuan(Math.abs(r.bothPeriodNet))} ${r.bothPeriodNet >= 0 ? '借' : '贷'}</b></td>
          </tr>`).join('');
        wrap.innerHTML = `
          <div class="chain-title">
            原凭证 <button class="btn linkish" data-open="${im.original.id}">${esc(im.original.voucherNo)}</button>
            → 冲销凭证 <button class="btn linkish" data-open="${im.reversal.id}">${esc(im.reversal.voucherNo)}</button>
            ${im.corrections.length ? '→ 更正 ' + im.corrections.map(c => `<button class="btn linkish" data-open="${c.id}">${esc(c.voucherNo)}</button>`).join(' ') : '（尚未录入更正分录）'}
          </div>
          <div class="impact-periods">
            <div class="impact-col orig"><h4>原账期 ${esc(im.originalPeriod)}（已关账，原记录不变）</h4>
              <p class="small-note" style="margin:0;">原分录仍保留在该账期，体现更正前的历史影响。</p></div>
            <div class="impact-col cur"><h4>当前账期 ${esc(im.currentPeriod)}（冲销 + 更正）</h4>
              <p class="small-note" style="margin:0;">冲销分录抵消原影响，更正分录体现正确金额。</p></div>
          </div>
          <table>
            <thead><tr><th>科目</th><th>名称</th><th class="num">原账期影响(净借+)</th><th class="num">当前账期影响</th><th class="num">两期净额(=更正后结果)</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`;
        wrap.querySelectorAll('[data-open]').forEach(b =>
          b.addEventListener('click', () => openVoucherModal(b.dataset.open)));
        box.appendChild(wrap);
      });
    }

    // 更正链条（所有含链条的原始凭证）
    const roots = state.vouchers.filter(v =>
      v.kind === 'original' && state.vouchers.some(x => x.reversesVoucherId === v.id || x.correctsVoucherId === v.id));
    const cl = $('#chain-list');
    if (!roots.length) {
      cl.innerHTML = '<div class="empty">暂无更正链条。</div>';
    } else {
      cl.innerHTML = '';
      roots.forEach(v => {
        const chain = C.voucherChain(state, v.id);
        const div = document.createElement('div');
        div.className = 'chain-box';
        div.innerHTML = `<div class="chain-title">链条：${esc(v.voucherNo)}（${esc(v.voucherPeriod)}）</div>` +
          [['原始', chain.root], ...chain.reversals.map(x => ['冲销', x]), ...chain.corrections.map(x => ['更正', x])]
            .map(([label, x]) => `<div style="margin:4px 0;"><span class="badge kind-${x.kind}">${label}</span>
              <button class="btn linkish" data-open="${x.id}">${esc(x.voucherNo)}</button>
              <span class="muted mono">入账 ${esc(x.postPeriod)}</span> — ${esc(x.summary)}</div>`).join('');
        div.querySelectorAll('[data-open]').forEach(b =>
          b.addEventListener('click', () => openVoucherModal(b.dataset.open)));
        cl.appendChild(div);
      });
    }

    // 已关账（锁定）凭证
    const locked = state.vouchers.filter(v => C.isVoucherLocked(state, v) && v.kind === 'original');
    const tbody = $('#locked-table tbody');
    tbody.innerHTML = '';
    locked.forEach(v => {
      const reversed = state.vouchers.some(x => x.reversesVoucherId === v.id);
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td class="mono">${esc(v.voucherNo)}</td><td>${esc(v.voucherDate)}</td>
        <td class="mono">${esc(v.postPeriod)}</td><td>${esc(v.source)}</td><td>${esc(v.summary)}</td>
        <td>${reversed ? '<span class="badge kind-reversal">已冲销</span>' : '<span class="badge closed">锁定中</span>'}</td>
        <td>${reversed ? '' : '<button class="btn danger small" data-rev="' + v.id + '">冲销</button>'}</td>`;
      const btn = tr.querySelector('[data-rev]');
      if (btn) btn.addEventListener('click', () => openReverseModal(v.id));
      tbody.appendChild(tr);
    });
  }

  // ---------------- 导入 / 导出 / 重置 ----------------
  $('#btn-import-vouchers').addEventListener('click', () => {
    $('#import-text').value = '';
    $('#import-result').innerHTML = '';
    openModal('#modal-import');
  });

  $('#btn-load-bad-samples').addEventListener('click', () => {
    $('#import-text').value = JSON.stringify(SeedData.badSamples, null, 2);
  });

  $('#btn-do-import').addEventListener('click', () => {
    let list;
    try {
      list = JSON.parse($('#import-text').value);
      if (!Array.isArray(list)) throw new Error('顶层必须是凭证数组');
    } catch (e) {
      toast('JSON 解析失败：' + e.message, 'err');
      return;
    }
    const results = C.importVouchers(state, list);
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    $('#import-result').innerHTML = results.map(r => r.ok
      ? `<li class="clean" style="list-style:none;padding:6px 10px;border-radius:8px;margin-bottom:4px;background:var(--green-soft);color:var(--green);">✔ ${esc(r.voucherNo)}：${esc(r.message)}</li>`
      : `<li style="list-style:none;padding:6px 10px;border-radius:8px;margin-bottom:4px;background:var(--red-soft);color:var(--red);">✖ ${esc(r.voucherNo)}：${esc(r.errors.map(e => e.message).join('；'))}</li>`
    ).join('');
    if (okCount) { save(); renderAll(); }
    toast(`导入完成：成功 ${okCount} 张，拒绝 ${failCount} 张（拒绝凭证未入账）`, failCount ? 'info' : 'ok');
  });

  $('#btn-export').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ledger-close-desk-' + new Date().toISOString().slice(0, 10) + '.json';
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $('#btn-import-file').addEventListener('click', () => $('#import-file').click());
  $('#import-file').addEventListener('change', (ev) => {
    const file = ev.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const s = JSON.parse(reader.result);
        if (!s.accounts || !s.vouchers || !s.entries) throw new Error('文件结构不完整');
        state = s;
        save();
        renderAll();
        toast('数据文件已载入', 'ok');
      } catch (e) {
        toast('载入失败：' + e.message, 'err');
      }
    };
    reader.readAsText(file);
    ev.target.value = '';
  });

  $('#btn-reset').addEventListener('click', () => {
    if (!confirm('确认清空当前全部本地数据并恢复为演示账簿？此操作不可撤销。')) return;
    resetState();
    toast('已重置为演示数据', 'ok');
  });

  // ---------------- 弹窗通用 ----------------
  function openModal(sel) { $(sel).classList.add('show'); }
  function closeModal(sel) { $(sel).classList.remove('show'); }
  document.querySelectorAll('.modal-mask').forEach(mask => {
    mask.addEventListener('click', (ev) => { if (ev.target === mask) mask.classList.remove('show'); });
    mask.querySelectorAll('[data-close]').forEach(b =>
      b.addEventListener('click', () => mask.classList.remove('show')));
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') document.querySelectorAll('.modal-mask.show').forEach(m => m.classList.remove('show'));
  });

  // ---------------- 首屏 ----------------
  function renderAll() {
    $('#company-name').textContent = SeedData.company;
    renderEntries();
    if ($('#tab-close').classList.contains('active')) renderClose();
    else { fillPeriods($('#f-period'), true); }
    if ($('#tab-tb').classList.contains('active')) renderTB();
    if ($('#tab-correct').classList.contains('active')) renderCorrect();
  }
  renderAll();
  save(); // 首次打开即把演示账簿落到本机 localStorage
})();
