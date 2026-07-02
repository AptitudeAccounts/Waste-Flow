/**
 * WasteFlow admin dashboard.
 * Structure: log in -> fetch role-scoped entries + lookups once -> render
 * every page (Overview/Records/Reports/Users/Settings) from that in-memory
 * state, re-filtering client-side. Only mutations (submit/edit/delete/user
 * management) hit the network again.
 */
(() => {
  const $ = id => document.getElementById(id);
  let session = null;
  let lookups = null;
  let allEntries = [];   // everything the backend returned for this role
  let charts = {};       // Chart.js instances, keyed by canvas id, destroyed/recreated on re-render
  const CHART_COLORS = ['--chart-1','--chart-2','--chart-3','--chart-4','--chart-5','--chart-6','--chart-7','--chart-8']
    .map(v => getComputedStyle(document.documentElement).getPropertyValue(v).trim());

  const fmtMoney = n => 'AED ' + (Number(n) || 0).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const fmtNum = n => (Number(n) || 0).toLocaleString('en-AE', { maximumFractionDigits: 1 });

  /* =========================================================================
     LOGIN
  ========================================================================= */
  async function handleLogin(e) {
    e.preventDefault();
    const btn = $('loginBtn');
    btn.disabled = true; btn.textContent = 'Signing in…';
    $('loginErr').style.display = 'none';
    try {
      const res = await WasteFlowAPI.call('login', { username: $('lUsername').value.trim(), password: $('lPassword').value });
      if (!res.ok) throw new Error(res.error || 'Invalid login');
      session = res;
      Session.set(session);
      await boot();
    } catch (err) {
      $('loginErr').textContent = err.message === 'CONFIG_MISSING'
        ? 'The dashboard is not connected to a backend yet — set API_URL in assets/config.js.'
        : (err.message || 'Something went wrong.');
      $('loginErr').style.display = 'block';
    } finally {
      btn.disabled = false; btn.textContent = 'Sign in';
    }
  }

  function showLogin() {
    $('loginScreen').style.display = 'flex';
    $('app').classList.remove('show');
  }

  function logout() {
    if (session) WasteFlowAPI.call('logout', { token: session.token }).catch(() => {});
    Session.clear();
    session = null;
    showLogin();
  }

  /* =========================================================================
     BOOT — after successful login (or restored session)
  ========================================================================= */
  async function boot() {
    $('loginScreen').style.display = 'none';
    $('app').classList.add('show');
    $('sideWhoName').textContent = session.fullName || session.username;
    $('sideWhoRole').textContent = session.role + (session.outlet && session.outlet !== 'All' ? ' · ' + session.outlet : '');

    const isAdmin = session.role === 'Admin';
    $('navUsers').style.display = isAdmin ? '' : 'none';
    $('navSettings').style.display = isAdmin ? '' : 'none';

    const [lookupsRes, entriesRes] = await Promise.all([
      WasteFlowAPI.call('lookups', {}),
      WasteFlowAPI.call('entries', { token: session.token, filters: {} })
    ]);

    if (!entriesRes.ok) { showToast(entriesRes.error || 'Session expired', 'error'); logout(); return; }
    lookups = lookupsRes;
    allEntries = entriesRes.entries.map(e => ({ ...e, Quantity: Number(e.Quantity) || 0, EstimatedCost: Number(e.EstimatedCost) || 0 }));

    if (lookups.settings && lookups.settings.CompanyName) {
      document.title = `${lookups.settings.CompanyName} — WasteFlow`;
    }
    if (WASTEFLOW_CONFIG.SHEET_URL && WASTEFLOW_CONFIG.SHEET_URL.indexOf('PASTE_YOUR') !== 0) {
      $('openSheetLink').href = WASTEFLOW_CONFIG.SHEET_URL;
    }

    buildFilterBar('overviewFilters', renderOverview);
    buildFilterBar('recordsFilters', renderRecords);
    populateReportSelectors();

    renderOverview();
    renderRecords();
    if (isAdmin) { renderUsers(); renderSettingsLookups(); }
  }

  /* =========================================================================
     FILTER BAR (shared component, used on Overview + Records)
  ========================================================================= */
  const filterState = {}; // { barId: {dateFrom,dateTo,outlet,department,category,item,staff} }

  function buildFilterBar(containerId, onApply) {
    const el = $(containerId);
    filterState[containerId] = {};
    const staffNames = Array.from(new Set(allEntries.map(e => e.StaffName))).filter(Boolean).sort();

    el.innerHTML = `
      <div class="field"><label>From</label><input class="input" type="date" data-f="dateFrom"></div>
      <div class="field"><label>To</label><input class="input" type="date" data-f="dateTo"></div>
      <div class="field"><label>Outlet</label><select class="select" data-f="outlet"><option value="">All outlets</option>${opts(lookups.outlets)}</select></div>
      <div class="field"><label>Department</label><select class="select" data-f="department"><option value="">All departments</option>${opts(lookups.departments)}</select></div>
      <div class="field"><label>Category</label><select class="select" data-f="category"><option value="">All categories</option>${opts(lookups.categories)}</select></div>
      <div class="field"><label>Staff</label><select class="select" data-f="staff"><option value="">All staff</option>${opts(staffNames)}</select></div>
      <div class="filter-actions"><button class="btn btn-ghost" data-clear>Clear</button></div>
    `;
    el.querySelectorAll('[data-f]').forEach(input => {
      input.addEventListener('change', () => {
        filterState[containerId][input.dataset.f] = input.value;
        onApply();
      });
    });
    el.querySelector('[data-clear]').addEventListener('click', () => {
      el.querySelectorAll('[data-f]').forEach(i => i.value = '');
      filterState[containerId] = {};
      onApply();
    });
  }

  function opts(arr) { return arr.map(v => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join(''); }
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  function applyFilters(entries, f) {
    return entries.filter(e =>
      (!f.dateFrom || String(e.Date) >= f.dateFrom) &&
      (!f.dateTo || String(e.Date) <= f.dateTo) &&
      (!f.outlet || e.Outlet === f.outlet) &&
      (!f.department || e.Department === f.department) &&
      (!f.category || e.Category === f.category) &&
      (!f.staff || e.StaffName === f.staff)
    );
  }

  /* =========================================================================
     OVERVIEW: KPIs, leaderboard, charts, insights
  ========================================================================= */
  function renderOverview() {
    const entries = applyFilters(allEntries, filterState.overviewFilters || {});
    renderKpis(entries);
    renderLeaderboard(entries);
    renderCharts(entries);
    renderInsights(entries);
  }

  function renderKpis(entries) {
    const totalCost = entries.reduce((s, e) => s + e.EstimatedCost, 0);
    const totalQty = entries.reduce((s, e) => s + e.Quantity, 0);
    const byOutlet = groupSum(entries, 'Outlet', 'EstimatedCost');
    const byItem = groupSum(entries, 'ItemName', 'EstimatedCost');
    const byCat = groupSum(entries, 'Category', 'EstimatedCost');
    const topOutlet = topKey(byOutlet), topItem = topKey(byItem), topCat = topKey(byCat);

    const cards = [
      ['Total waste cost', fmtMoney(totalCost), entries.length + ' entries'],
      ['Total waste quantity', fmtNum(totalQty) + ' units', 'mixed Kg / Pieces / Liters'],
      ['Number of entries', entries.length.toLocaleString(), 'in selected range'],
      ['Highest waste outlet', topOutlet || '—', topOutlet ? fmtMoney(byOutlet[topOutlet]) : ''],
      ['Highest waste item', topItem || '—', topItem ? fmtMoney(byItem[topItem]) : ''],
      ['Highest waste category', topCat || '—', topCat ? fmtMoney(byCat[topCat]) : '']
    ];
    $('kpiGrid').innerHTML = cards.map(([label, value, sub]) => `
      <div class="card kpi-card"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div></div>
    `).join('');
  }

  function groupSum(entries, key, valueKey) {
    const out = {};
    entries.forEach(e => { out[e[key]] = (out[e[key]] || 0) + e[valueKey]; });
    return out;
  }
  function groupCount(entries, key) {
    const out = {};
    entries.forEach(e => { out[e[key]] = (out[e[key]] || 0) + 1; });
    return out;
  }
  function topKey(obj) {
    const keys = Object.keys(obj);
    if (keys.length === 0) return null;
    return keys.reduce((a, b) => obj[a] >= obj[b] ? a : b);
  }

  function renderLeaderboard(entries) {
    const byOutlet = groupSum(entries, 'Outlet', 'EstimatedCost');
    const ranked = Object.keys(byOutlet).sort((a, b) => byOutlet[b] - byOutlet[a]);
    const max = ranked.length ? byOutlet[ranked[0]] : 0;
    if (ranked.length === 0) { $('leaderboardBody').innerHTML = '<p class="text-soft">No data for this selection.</p>'; return; }
    $('leaderboardBody').innerHTML = ranked.map((o, i) => `
      <div class="lb-row">
        <div class="lb-rank ${i === 0 ? 'r1' : ''}">${String(i + 1).padStart(2, '0')}</div>
        <div class="lb-body">
          <div class="lb-top"><span class="name">${escapeHtml(o)}</span><span class="val">${fmtMoney(byOutlet[o])}</span></div>
          <div class="lb-bar-track"><div class="lb-bar-fill" style="width:${max ? (byOutlet[o] / max * 100) : 0}%"></div></div>
        </div>
      </div>
    `).join('');
  }

  function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }

  function renderCharts(entries) {
    const textColor = getComputedStyle(document.documentElement).getPropertyValue('--text').trim();
    const gridColor = getComputedStyle(document.documentElement).getPropertyValue('--border').trim();
    Chart.defaults.color = textColor;
    Chart.defaults.font.family = "'IBM Plex Sans', sans-serif";
    Chart.defaults.borderColor = gridColor;

    // Waste cost by outlet
    const byOutlet = groupSum(entries, 'Outlet', 'EstimatedCost');
    makeBar('chartOutletCost', Object.keys(byOutlet), [Object.values(byOutlet)], ['Cost (AED)']);

    // Category pie
    const byCat = groupSum(entries, 'Category', 'EstimatedCost');
    makePie('chartCategoryPie', Object.keys(byCat), Object.values(byCat));

    // Category bar (same data, bar view for exact comparison)
    makeBar('chartCategoryBar', Object.keys(byCat), [Object.values(byCat)], ['Cost (AED)'], true);

    // Daily trend
    const byDate = groupSum(entries, 'Date', 'EstimatedCost');
    const sortedDates = Object.keys(byDate).sort();
    makeLine('chartDailyTrend', sortedDates, sortedDates.map(d => byDate[d]), 'Cost (AED)');

    // Monthly trend
    const byMonth = {};
    entries.forEach(e => { const m = String(e.Date).slice(0, 7); byMonth[m] = (byMonth[m] || 0) + e.EstimatedCost; });
    const sortedMonths = Object.keys(byMonth).sort();
    makeBar('chartMonthlyTrend', sortedMonths, [sortedMonths.map(m => byMonth[m])], ['Cost (AED)']);

    // Top 10 items by cost
    const byItem = groupSum(entries, 'ItemName', 'EstimatedCost');
    const topItems = Object.keys(byItem).sort((a, b) => byItem[b] - byItem[a]).slice(0, 10);
    makeBar('chartTopItems', topItems, [topItems.map(i => byItem[i])], ['Cost (AED)'], true);

    // Department comparison
    const byDept = groupSum(entries, 'Department', 'EstimatedCost');
    makeBar('chartDeptComparison', Object.keys(byDept), [Object.values(byDept)], ['Cost (AED)']);

    // Quantity vs cost scatter
    destroyChart('chartQtyVsCost');
    charts.chartQtyVsCost = new Chart($('chartQtyVsCost'), {
      type: 'scatter',
      data: { datasets: [{ label: 'Entries', data: entries.map(e => ({ x: e.Quantity, y: e.EstimatedCost })), backgroundColor: CHART_COLORS[0] }] },
      options: baseOpts({ x: { title: { display: true, text: 'Quantity' } }, y: { title: { display: true, text: 'Cost (AED)' } } })
    });
  }

  function baseOpts(scalesExtra) {
    return {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: Object.assign({ x: { grid: { display: false } }, y: { beginAtZero: true } }, scalesExtra || {})
    };
  }

  function makeBar(id, labels, datasets, dsLabels, horizontal) {
    destroyChart(id);
    charts[id] = new Chart($(id), {
      type: 'bar',
      data: { labels, datasets: datasets.map((d, i) => ({ label: dsLabels[i], data: d, backgroundColor: CHART_COLORS[i % CHART_COLORS.length], borderRadius: 5 })) },
      options: Object.assign(baseOpts(), horizontal ? { indexAxis: 'y' } : {})
    });
  }

  function makeLine(id, labels, data, label) {
    destroyChart(id);
    charts[id] = new Chart($(id), {
      type: 'line',
      data: { labels, datasets: [{ label, data, borderColor: CHART_COLORS[0], backgroundColor: CHART_COLORS[0] + '33', fill: true, tension: 0.3 }] },
      options: baseOpts()
    });
  }

  function makePie(id, labels, data) {
    destroyChart(id);
    charts[id] = new Chart($(id), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: CHART_COLORS }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom', labels: { boxWidth: 10, font: { size: 11 } } } } }
    });
  }

  /** Lightweight anomaly detection: flag items priced far above their category's norm. */
  function findAnomalies(entries) {
    const byCat = {};
    entries.forEach(e => { (byCat[e.Category] = byCat[e.Category] || []).push(e.EstimatedCost); });
    const stats = {};
    Object.keys(byCat).forEach(c => {
      const vals = byCat[c];
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
      const variance = vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length;
      stats[c] = { mean, sd: Math.sqrt(variance) };
    });
    return entries.filter(e => {
      const s = stats[e.Category];
      return s && s.sd > 0 && e.EstimatedCost > s.mean + 2 * s.sd && e.EstimatedCost > 50;
    });
  }

  function renderInsights(entries) {
    if (entries.length === 0) { $('insightsBody').innerHTML = 'No data for this selection yet.'; return; }
    const anomalies = findAnomalies(entries);
    const byOutlet = groupSum(entries, 'Outlet', 'EstimatedCost');
    const ranked = Object.keys(byOutlet).sort((a, b) => byOutlet[b] - byOutlet[a]);

    // Week-over-week trend if enough date spread exists
    const dates = entries.map(e => e.Date).sort();
    let trendLine = '';
    if (dates.length > 1) {
      const mid = new Date((new Date(dates[0]).getTime() + new Date(dates[dates.length - 1]).getTime()) / 2);
      const midStr = mid.toISOString().slice(0, 10);
      const firstHalf = entries.filter(e => e.Date < midStr).reduce((s, e) => s + e.EstimatedCost, 0);
      const secondHalf = entries.filter(e => e.Date >= midStr).reduce((s, e) => s + e.EstimatedCost, 0);
      if (firstHalf > 0) {
        const pct = ((secondHalf - firstHalf) / firstHalf * 100).toFixed(0);
        trendLine = `<p>Waste cost in the second half of the selected period is <strong>${pct > 0 ? '+' : ''}${pct}%</strong> vs. the first half.</p>`;
      }
    }

    let html = '';
    if (ranked.length) html += `<p><strong>${escapeHtml(ranked[0])}</strong> is currently the highest-cost outlet at ${fmtMoney(byOutlet[ranked[0]])}.</p>`;
    html += trendLine;
    if (anomalies.length) {
      html += `<p><strong>${anomalies.length} unusual entr${anomalies.length === 1 ? 'y' : 'ies'}</strong> flagged — cost well above the typical range for their category. See the highlighted rows on the Records page.</p>`;
    } else {
      html += `<p>No unusually high-cost entries detected in this selection.</p>`;
    }
    $('insightsBody').innerHTML = html;
  }

  /* =========================================================================
     RECORDS PAGE: sortable / searchable / paginated table + secondary tables
  ========================================================================= */
  const recordsState = { sortKey: 'Date', sortDir: 'desc', page: 1, pageSize: 25, search: '' };

  function currentRecordsEntries() {
    let entries = applyFilters(allEntries, filterState.recordsFilters || {});
    if (recordsState.search) {
      const q = recordsState.search.toLowerCase();
      entries = entries.filter(e => [e.ItemName, e.StaffName, e.Outlet, e.Remarks, e.Reason].join(' ').toLowerCase().includes(q));
    }
    entries = [...entries].sort((a, b) => {
      const va = a[recordsState.sortKey], vb = b[recordsState.sortKey];
      const cmp = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
      return recordsState.sortDir === 'asc' ? cmp : -cmp;
    });
    return entries;
  }

  const RECORD_COLUMNS = [
    ['Date', 'Date'], ['Outlet', 'Outlet'], ['Department', 'Department'], ['Category', 'Category'],
    ['ItemName', 'Item'], ['Quantity', 'Qty'], ['Unit', 'Unit'], ['EstimatedCost', 'Cost (AED)'],
    ['Reason', 'Reason'], ['StaffName', 'Staff'], ['Remarks', 'Remarks']
  ];

  function renderRecords() {
    renderMainTable();
    const entries = applyFilters(allEntries, filterState.recordsFilters || {});
    renderHighCostTable(entries);
    renderFreqItemsTable(entries);
    renderOutletPerfTable(entries);
    renderStaffTable(entries);
  }

  function canEdit(entry) {
    if (session.role === 'Admin') return true;
    if (session.role === 'Outlet Manager') {
      const today = new Date().toISOString().slice(0, 10);
      return entry.Outlet === session.outlet && String(entry.Date) === today;
    }
    return false;
  }

  function renderMainTable() {
    const all = currentRecordsEntries();
    const anomalies = new Set(findAnomalies(all).map(e => e.EntryID));
    const totalPages = Math.max(1, Math.ceil(all.length / recordsState.pageSize));
    recordsState.page = Math.min(recordsState.page, totalPages);
    const pageEntries = all.slice((recordsState.page - 1) * recordsState.pageSize, recordsState.page * recordsState.pageSize);

    const thead = $('recordsTable').querySelector('thead');
    thead.innerHTML = '<tr>' + RECORD_COLUMNS.map(([key, label]) =>
      `<th data-sort="${key}">${label}${recordsState.sortKey === key ? (recordsState.sortDir === 'asc' ? ' ▲' : ' ▼') : ''}</th>`
    ).join('') + '<th>Actions</th></tr>';
    thead.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
      const key = th.dataset.sort;
      if (recordsState.sortKey === key) recordsState.sortDir = recordsState.sortDir === 'asc' ? 'desc' : 'asc';
      else { recordsState.sortKey = key; recordsState.sortDir = 'asc'; }
      renderMainTable();
    }));

    const tbody = $('recordsTable').querySelector('tbody');
    if (pageEntries.length === 0) {
      tbody.innerHTML = `<tr><td colspan="${RECORD_COLUMNS.length + 1}" class="table-empty">No records match your filters.</td></tr>`;
    } else {
      tbody.innerHTML = pageEntries.map(e => `
        <tr class="${anomalies.has(e.EntryID) ? 'anomaly' : ''}">
          <td>${e.Date}</td><td>${escapeHtml(e.Outlet)}</td><td>${escapeHtml(e.Department)}</td>
          <td>${escapeHtml(e.Category)}</td><td class="wrap-cell">${escapeHtml(e.ItemName)}</td>
          <td class="num">${fmtNum(e.Quantity)}</td><td>${escapeHtml(e.Unit)}</td>
          <td class="num">${fmtMoney(e.EstimatedCost)}</td><td>${escapeHtml(e.Reason)}</td>
          <td>${escapeHtml(e.StaffName)}</td><td class="wrap-cell">${escapeHtml(e.Remarks || '')}</td>
          <td class="row-actions">${canEdit(e) ? `<button class="btn btn-ghost" data-edit="${e.EntryID}">Edit</button><button class="btn btn-danger" data-del="${e.EntryID}">Del</button>` : ''}</td>
        </tr>
      `).join('');
      tbody.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openEditModal(b.dataset.edit)));
      tbody.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteEntry(b.dataset.del)));
    }

    $('recordsPager').innerHTML = `
      <span>${all.length} record${all.length === 1 ? '' : 's'}</span><div class="spacer"></div>
      <button class="btn btn-ghost" ${recordsState.page <= 1 ? 'disabled' : ''} id="pagerPrev">← Prev</button>
      <span>Page ${recordsState.page} of ${totalPages}</span>
      <button class="btn btn-ghost" ${recordsState.page >= totalPages ? 'disabled' : ''} id="pagerNext">Next →</button>
    `;
    const prev = $('pagerPrev'), next = $('pagerNext');
    if (prev) prev.addEventListener('click', () => { recordsState.page--; renderMainTable(); });
    if (next) next.addEventListener('click', () => { recordsState.page++; renderMainTable(); });
  }

  function simpleTable(elId, headers, rows) {
    const el = $(elId);
    el.querySelector('thead').innerHTML = '<tr>' + headers.map(h => `<th>${h}</th>`).join('') + '</tr>';
    el.querySelector('tbody').innerHTML = rows.length
      ? rows.map(r => '<tr>' + r.map((c, i) => `<td class="${i > 0 ? 'num' : ''}">${c}</td>`).join('') + '</tr>').join('')
      : `<tr><td colspan="${headers.length}" class="table-empty">No data.</td></tr>`;
  }

  function renderHighCostTable(entries) {
    const rows = [...entries].sort((a, b) => b.EstimatedCost - a.EstimatedCost).slice(0, 10)
      .map(e => [escapeHtml(e.ItemName), fmtMoney(e.EstimatedCost), escapeHtml(e.Outlet), e.Date]);
    simpleTable('highCostTable', ['Item', 'Cost', 'Outlet', 'Date'], rows);
  }

  function renderFreqItemsTable(entries) {
    const counts = groupCount(entries, 'ItemName');
    const rows = Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 10)
      .map(item => [escapeHtml(item), counts[item], fmtMoney(entries.filter(e => e.ItemName === item).reduce((s, e) => s + e.EstimatedCost, 0))]);
    simpleTable('freqItemsTable', ['Item', 'Times logged', 'Total cost'], rows);
  }

  function renderOutletPerfTable(entries) {
    const outlets = Array.from(new Set(entries.map(e => e.Outlet)));
    const rows = outlets.map(o => {
      const sub = entries.filter(e => e.Outlet === o);
      const cost = sub.reduce((s, e) => s + e.EstimatedCost, 0);
      return [escapeHtml(o), sub.length, fmtMoney(cost), fmtMoney(sub.length ? cost / sub.length : 0)];
    }).sort((a, b) => parseFloat(b[2].replace(/[^\d.]/g, '')) - parseFloat(a[2].replace(/[^\d.]/g, '')));
    simpleTable('outletPerfTable', ['Outlet', 'Entries', 'Total cost', 'Avg / entry'], rows);
  }

  function renderStaffTable(entries) {
    const staff = Array.from(new Set(entries.map(e => e.StaffName))).filter(Boolean);
    const rows = staff.map(s => {
      const sub = entries.filter(e => e.StaffName === s);
      return [escapeHtml(s), sub.length, fmtMoney(sub.reduce((a, e) => a + e.EstimatedCost, 0))];
    }).sort((a, b) => b[1] - a[1]);
    simpleTable('staffTable', ['Staff', 'Entries', 'Total cost'], rows);
  }

  /* ---------- Edit / delete ---------- */
  function openEditModal(entryId) {
    const entry = allEntries.find(e => e.EntryID === entryId);
    if (!entry) return;
    $('editEntryId').value = entryId;
    $('editQuantity').value = entry.Quantity;
    $('editCost').value = entry.EstimatedCost;
    $('editReason').innerHTML = opts(lookups.reasons);
    $('editReason').value = entry.Reason;
    $('editRemarks').value = entry.Remarks || '';
    $('editModal').classList.add('show');
  }

  async function saveEdit(e) {
    e.preventDefault();
    const entryId = $('editEntryId').value;
    const res = await WasteFlowAPI.call('updateEntry', {
      token: session.token, entryId,
      quantity: Number($('editQuantity').value), estimatedCost: Number($('editCost').value),
      reason: $('editReason').value, remarks: $('editRemarks').value
    });
    if (!res.ok) { showToast(res.error || 'Could not save changes', 'error'); return; }
    const entry = allEntries.find(x => x.EntryID === entryId);
    Object.assign(entry, { Quantity: Number($('editQuantity').value), EstimatedCost: Number($('editCost').value), Reason: $('editReason').value, Remarks: $('editRemarks').value });
    $('editModal').classList.remove('show');
    showToast('Entry updated', 'success');
    renderRecords(); renderOverview();
  }

  async function deleteEntry(entryId) {
    if (!confirm('Delete this entry? This cannot be undone from the dashboard.')) return;
    const res = await WasteFlowAPI.call('deleteEntry', { token: session.token, entryId });
    if (!res.ok) { showToast(res.error || 'Could not delete entry', 'error'); return; }
    allEntries = allEntries.filter(e => e.EntryID !== entryId);
    showToast('Entry deleted', 'success');
    renderRecords(); renderOverview();
  }

  /* ---------- Export ---------- */
  function exportRows() {
    return currentRecordsEntries().map(e => ({
      Date: e.Date, Outlet: e.Outlet, Department: e.Department, Category: e.Category, Item: e.ItemName,
      Quantity: e.Quantity, Unit: e.Unit, 'Cost (AED)': e.EstimatedCost, Reason: e.Reason, Staff: e.StaffName, Remarks: e.Remarks || ''
    }));
  }

  function exportCsv() {
    const rows = exportRows();
    if (!rows.length) return showToast('Nothing to export', 'error');
    const headers = Object.keys(rows[0]);
    const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => `"${String(r[h]).replace(/"/g, '""')}"`).join(','))).join('\n');
    downloadBlob(csv, 'wasteflow-records.csv', 'text/csv');
  }

  function exportXlsx() {
    const rows = exportRows();
    if (!rows.length) return showToast('Nothing to export', 'error');
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'WasteLog');
    XLSX.writeFile(wb, 'wasteflow-records.xlsx');
  }

  function exportPdf() {
    const rows = exportRows();
    if (!rows.length) return showToast('Nothing to export', 'error');
    const doc = new jspdf.jsPDF({ orientation: 'landscape' });
    doc.setFontSize(14); doc.text('WasteFlow — Waste Records', 14, 16);
    doc.autoTable({
      startY: 22, styles: { fontSize: 8 },
      head: [Object.keys(rows[0])], body: rows.map(r => Object.values(r))
    });
    doc.save('wasteflow-records.pdf');
  }

  function downloadBlob(content, filename, mime) {
    const blob = new Blob([content], { type: mime });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = filename; a.click();
    URL.revokeObjectURL(a.href);
  }

  /* =========================================================================
     REPORTS
  ========================================================================= */
  function populateReportSelectors() {
    $('reportOutletSel').innerHTML = '<option value="">All outlets</option>' + opts(lookups.outlets);
    $('reportDeptSel').innerHTML = '<option value="">All departments</option>' + opts(lookups.departments);
    $('reportDate').value = new Date().toISOString().slice(0, 10);
  }

  function generateReport() {
    const type = $('reportType').value;
    const date = $('reportDate').value;
    const outlet = $('reportOutletSel').value;
    const dept = $('reportDeptSel').value;
    let from, to, title;
    const d = new Date(date);

    if (type === 'daily') { from = to = date; title = `Daily Report — ${date}`; }
    else if (type === 'weekly') {
      const day = d.getDay();
      const monday = new Date(d); monday.setDate(d.getDate() - ((day + 6) % 7));
      const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
      from = monday.toISOString().slice(0, 10); to = sunday.toISOString().slice(0, 10);
      title = `Weekly Report — ${from} to ${to}`;
    } else if (type === 'monthly') {
      from = date.slice(0, 8) + '01';
      to = new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
      title = `Monthly Report — ${date.slice(0, 7)}`;
    } else if (type === 'outlet') {
      from = '0000-01-01'; to = '9999-12-31'; title = `Outlet Report — ${outlet || 'All outlets'}`;
    } else {
      from = '0000-01-01'; to = '9999-12-31'; title = `Department Report — ${dept || 'All departments'}`;
    }

    let entries = allEntries.filter(e => String(e.Date) >= from && String(e.Date) <= to);
    if (outlet) entries = entries.filter(e => e.Outlet === outlet);
    if (dept) entries = entries.filter(e => e.Department === dept);

    const totalCost = entries.reduce((s, e) => s + e.EstimatedCost, 0);
    const totalQty = entries.reduce((s, e) => s + e.Quantity, 0);
    const byOutlet = groupSum(entries, 'Outlet', 'EstimatedCost');
    const byCat = groupSum(entries, 'Category', 'EstimatedCost');
    const topItems = Object.entries(groupSum(entries, 'ItemName', 'EstimatedCost')).sort((a, b) => b[1] - a[1]).slice(0, 10);

    const company = (lookups.settings && lookups.settings.CompanyName) || WASTEFLOW_CONFIG.COMPANY_NAME;

    $('reportOutput').innerHTML = `
      <div class="report-head">
        <div><h2>${company}</h2><div class="text-soft" style="font-size:13px;">${title}</div></div>
        <div class="meta">Generated ${new Date().toLocaleString()}<br>By ${escapeHtml(session.fullName || session.username)}</div>
      </div>
      <div class="report-kpis">
        <div><strong>${fmtMoney(totalCost)}</strong><span>Total waste cost</span></div>
        <div><strong>${fmtNum(totalQty)}</strong><span>Total quantity</span></div>
        <div><strong>${entries.length}</strong><span>Entries</span></div>
      </div>
      <h4 style="margin-bottom:10px;">Cost by outlet</h4>
      <table class="data-table" style="margin-bottom:22px; width:100%;"><thead><tr><th>Outlet</th><th>Cost</th></tr></thead>
        <tbody>${Object.entries(byOutlet).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${fmtMoney(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="table-empty">No data</td></tr>'}</tbody></table>
      <h4 style="margin-bottom:10px;">Cost by category</h4>
      <table class="data-table" style="margin-bottom:22px; width:100%;"><thead><tr><th>Category</th><th>Cost</th></tr></thead>
        <tbody>${Object.entries(byCat).sort((a,b)=>b[1]-a[1]).map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${fmtMoney(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="table-empty">No data</td></tr>'}</tbody></table>
      <h4 style="margin-bottom:10px;">Top 10 items</h4>
      <table class="data-table" style="width:100%;"><thead><tr><th>Item</th><th>Cost</th></tr></thead>
        <tbody>${topItems.map(([k,v]) => `<tr><td>${escapeHtml(k)}</td><td class="num">${fmtMoney(v)}</td></tr>`).join('') || '<tr><td colspan="2" class="table-empty">No data</td></tr>'}</tbody></table>
    `;
  }

  /* =========================================================================
     USERS (Admin only)
  ========================================================================= */
  async function renderUsers() {
    $('nuOutlet').innerHTML = '<option value="All">All outlets</option>' + opts(lookups.outlets);
    const res = await WasteFlowAPI.call('listUsers', { token: session.token });
    if (!res.ok) return;
    simpleTable('usersTable', ['Full name', 'Username', 'Role', 'Outlet', 'Email', 'Status', 'Actions'],
      res.users.map(u => [escapeHtml(u.fullName), escapeHtml(u.username), u.role, escapeHtml(u.outlet), escapeHtml(u.email || ''),
        `<button class="btn ${u.active === 'Yes' ? 'btn-danger' : 'btn-primary'}" data-toggle="${u.username}" data-active="${u.active}">${u.active === 'Yes' ? 'Disable' : 'Enable'}</button>`,
        `<button class="btn btn-ghost" data-edit-user="${u.username}">Edit</button>`
      ])
    );
    document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const active = b.dataset.active !== 'Yes';
      await WasteFlowAPI.call('setUserActive', { token: session.token, username: b.dataset.toggle, active });
      showToast('User updated', 'success');
      renderUsers();
    }));
    document.querySelectorAll('[data-edit-user]').forEach(b => b.addEventListener('click', () => {
      const u = res.users.find(x => x.username === b.dataset.editUser);
      if (u) openEditUserModal(u);
    }));
  }

  function openEditUserModal(u) {
    $('euUsername').value = u.username;
    $('euUsernameDisplay').value = u.username;
    $('euFullName').value = u.fullName || '';
    $('euEmail').value = u.email || '';
    $('euRole').value = u.role;
    $('euOutlet').innerHTML = '<option value="All">All outlets</option>' + opts(lookups.outlets);
    $('euOutlet').value = u.outlet;
    $('euNewPassword').value = '';
    $('editUserModal').classList.add('show');
  }

  async function saveEditUser(e) {
    e.preventDefault();
    const res = await WasteFlowAPI.call('updateUser', {
      token: session.token,
      username: $('euUsername').value,
      fullName: $('euFullName').value,
      email: $('euEmail').value,
      role: $('euRole').value,
      outlet: $('euOutlet').value,
      newPassword: $('euNewPassword').value || undefined
    });
    if (!res.ok) return showToast(res.error || 'Could not update user', 'error');
    $('editUserModal').classList.remove('show');
    showToast('User updated', 'success');
    renderUsers();
  }
  async function renderUsers() {
    $('nuOutlet').innerHTML = '<option value="All">All outlets</option>' + opts(lookups.outlets);
    const res = await WasteFlowAPI.call('listUsers', { token: session.token });
    if (!res.ok) return;
    simpleTable('usersTable', ['Full name', 'Username', 'Role', 'Outlet', 'Email', 'Status'],
      res.users.map(u => [escapeHtml(u.fullName), escapeHtml(u.username), u.role, escapeHtml(u.outlet), escapeHtml(u.email || ''),
        `<button class="btn ${u.active === 'Yes' ? 'btn-danger' : 'btn-primary'}" data-toggle="${u.username}" data-active="${u.active}">${u.active === 'Yes' ? 'Disable' : 'Enable'}</button>`
      ])
    );
    document.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const active = b.dataset.active !== 'Yes';
      await WasteFlowAPI.call('setUserActive', { token: session.token, username: b.dataset.toggle, active });
      showToast('User updated', 'success');
      renderUsers();
    }));
  }

  async function addUser(e) {
    e.preventDefault();
    const res = await WasteFlowAPI.call('addUser', {
      token: session.token, fullName: $('nuFullName').value, username: $('nuUsername').value,
      password: $('nuPassword').value, email: $('nuEmail').value, role: $('nuRole').value, outlet: $('nuOutlet').value
    });
    if (!res.ok) return showToast(res.error || 'Could not add user', 'error');
    showToast('User added', 'success');
    $('addUserForm').reset();
    renderUsers();
  }

  /* =========================================================================
     SETTINGS (Admin only) — grow outlets/departments/reasons
  ========================================================================= */
  function renderSettingsLookups() {
    $('outletTags').innerHTML = lookups.outlets.map(o => `<span class="tag">${escapeHtml(o)}</span>`).join('');
    $('deptTags').innerHTML = lookups.departments.map(d => `<span class="tag">${escapeHtml(d)}</span>`).join('');
    $('reasonTags').innerHTML = lookups.reasons.map(r => `<span class="tag">${escapeHtml(r)}</span>`).join('');
  }

  async function addLookup(type, inputId) {
    const value = $(inputId).value.trim();
    if (!value) return;
    const res = await WasteFlowAPI.call('addLookup', { token: session.token, lookupType: type, value });
    if (!res.ok) return showToast(res.error || 'Could not add', 'error');
    lookups[type === 'outlet' ? 'outlets' : type === 'department' ? 'departments' : 'reasons'].push(value);
    $(inputId).value = '';
    renderSettingsLookups();
    showToast('Added', 'success');
  }

  /* =========================================================================
     NAVIGATION
  ========================================================================= */
  function showPage(name) {
    document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
    $('page-' + name).classList.remove('hidden');
    document.querySelectorAll('.navlink[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
    $('sidebar').classList.remove('open');
  }

  /* =========================================================================
     INIT
  ========================================================================= */
  async function init() {
    document.getElementById('loginForm').addEventListener('submit', handleLogin);
    $('logoutBtn').addEventListener('click', logout);
    $('menuToggle').addEventListener('click', () => $('sidebar').classList.toggle('open'));
    document.querySelectorAll('.navlink[data-page]').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));

    $('recordsSearch').addEventListener('input', e => { recordsState.search = e.target.value; recordsState.page = 1; renderMainTable(); });
    $('exportCsv').addEventListener('click', exportCsv);
    $('exportXlsx').addEventListener('click', exportXlsx);
    $('exportPdf').addEventListener('click', exportPdf);

    $('editForm').addEventListener('submit', saveEdit);
    $('editCancelBtn').addEventListener('click', () => $('editModal').classList.remove('show'));

    $('generateReportBtn').addEventListener('click', generateReport);
    $('printReportBtn').addEventListener('click', () => window.print());

    $('addUserForm').addEventListener('submit', addUser);
    $('editUserForm').addEventListener('submit', saveEditUser);
    $('editUserCancelBtn').addEventListener('click', () => $('editUserModal').classList.remove('show'));
    $('addOutletBtn').addEventListener('click', () => addLookup('outlet', 'newOutletInput'));
    $('addDeptBtn').addEventListener('click', () => addLookup('department', 'newDeptInput'));
    $('addReasonBtn').addEventListener('click', () => addLookup('reason', 'newReasonInput'));

    const existing = Session.get();
    if (existing && existing.token) {
      session = existing;
      try { await boot(); } catch (e) { showLogin(); }
    } else {
      showLogin();
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
