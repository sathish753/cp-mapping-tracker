const FIELDS = [
  { key: 'employeeName', label: 'Employee Name' },
  { key: 'employeeId', label: 'Employee ID' },
  { key: 'block', label: 'Block' },
  { key: 'workstation', label: 'Workstation Number' },
  { key: 'shift', label: 'Shift' },
  { key: 'cpName', label: 'CP Name' },
  { key: 'processName', label: 'Process Name' },
  { key: 'clientName', label: 'Client Name' },
  { key: 'tlName', label: 'TL Name' },
  { key: 'omName', label: 'OM Name' }
];

let currentUser = null;
let editableFields = [];
let records = [];
let editingRecordId = null; // null => creating new

// ---------------- helpers ----------------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Something went wrong');
  return data;
}

function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast' + (isError ? ' error' : '');
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 3200);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { day: '2-digit', month: 'short' }) + ' ' +
         d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

// ---------------- boot ----------------
window.addEventListener('DOMContentLoaded', async () => {
  bindStaticEvents();
  try {
    const { user } = await api('/session');
    if (user) enterApp(user);
    else showLogin();
  } catch {
    showLogin();
  }
});

function showLogin() {
  document.getElementById('loginView').classList.remove('hidden');
  document.getElementById('appView').classList.add('hidden');
}

function enterApp(user) {
  currentUser = user;
  document.body.className = 'role-' + user.role;
  document.getElementById('loginView').classList.add('hidden');
  document.getElementById('appView').classList.remove('hidden');
  document.getElementById('whoName').textContent = user.displayName || user.username;
  document.getElementById('whoRole').textContent = user.role.toUpperCase();
  switchView('records');
  loadRecords();
}

// ---------------- static bindings ----------------
function bindStaticEvents() {
  document.getElementById('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value.trim();
    const password = document.getElementById('loginPassword').value;
    const errEl = document.getElementById('loginError');
    errEl.textContent = '';
    try {
      const { user } = await api('/login', { method: 'POST', body: JSON.stringify({ username, password }) });
      enterApp(user);
    } catch (err) {
      errEl.textContent = err.message;
    }
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await api('/logout', { method: 'POST' });
    location.reload();
  });

  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  document.getElementById('recordSearch').addEventListener('input', renderRecordsTable);
  document.getElementById('shiftFilter').addEventListener('change', renderRecordsTable);

  document.getElementById('addRecordBtn').addEventListener('click', () => openRecordModal(null));
  document.getElementById('modalCancel').addEventListener('click', closeRecordModal);
  document.getElementById('recordForm').addEventListener('submit', saveRecord);

  document.getElementById('employeeHistoryForm').addEventListener('submit', searchEmployeeHistory);

  document.getElementById('quickViewBtn').addEventListener('click', openQuickView);
  document.getElementById('quickViewClose').addEventListener('click', closeQuickView);
  document.getElementById('quickViewModal').addEventListener('click', e => {
    if (e.target.id === 'quickViewModal') closeQuickView();
  });

  document.getElementById('omDateFilterApply').addEventListener('click', () => {
    if (currentOmForMapping) loadOmMapping(currentOmForMapping);
  });
  document.getElementById('omDateFilterClear').addEventListener('click', () => {
    document.getElementById('omDateFrom').value = '';
    document.getElementById('omDateTo').value = '';
    if (currentOmForMapping) loadOmMapping(currentOmForMapping);
  });

  document.getElementById('dashDateApply').addEventListener('click', loadDashboard);
  document.getElementById('dashDateClear').addEventListener('click', () => {
    document.getElementById('dashDateFrom').value = '';
    document.getElementById('dashDateTo').value = '';
    loadDashboard();
  });

  initMappingSearchDropdowns();

  document.getElementById('userForm').addEventListener('submit', createUser);
}

function switchView(view) {
  if (view === 'dashboard' && currentUser.role !== 'admin') view = 'records';
  if (view === 'users' && currentUser.role !== 'admin') view = 'records';
  if (view === 'myalloc' && currentUser.role === 'admin') view = 'dashboard';
  if (view !== 'dashboard') closeQuickView(); // stop the live-refresh poll once we navigate away
  document.querySelectorAll('.nav-btn').forEach(b => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view').forEach(v => v.classList.add('hidden'));
  document.getElementById('view-' + view).classList.remove('hidden');
  if (view === 'dashboard') loadDashboard();
  if (view === 'users') loadUsers();
  if (view === 'myalloc') loadMyAllocations();
}

// ---- mild, per-Shift row colour ----
// deterministic pastel colour per Shift value, based on the text itself
// (not creation order), so a given shift always gets the same colour even as
// records are added, removed, or reloaded on a different day.
const SHIFT_ROW_PALETTE = [
  '#FFF3B0', '#FFD8A8', '#FFC9DE', '#E5C9FF', '#C9D9FF',
  '#B8F2E6', '#C8F4C8', '#FFE3E3', '#D0F0FD', '#FDE2CE',
  '#E8D5B7', '#D5E8D4', '#F5D5E0', '#D4E8F5', '#F0E5D5', '#E0D5F5'
];
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}
function shiftRowColor(shift) {
  const s = (shift || '').trim();
  if (!s) return '';
  return SHIFT_ROW_PALETTE[hashString(s.toLowerCase()) % SHIFT_ROW_PALETTE.length];
}

// ==================== RECORDS ====================
async function loadRecords() {
  try {
    const data = await api('/records');
    records = data.records;
    editableFields = data.editableFields;
    populateShiftFilter();
    renderRecordsTable();
  } catch (err) {
    toast(err.message, true);
  }
}

// keeps the shift dropdown in sync with whatever shift values actually exist
// right now, so "Morning" / "Night" (or whatever names are used) show up
// automatically without any manual setup
function populateShiftFilter() {
  const select = document.getElementById('shiftFilter');
  const prev = select.value;
  const shifts = [...new Set(records.map(r => (r.shift || '').trim()).filter(Boolean))]
    .sort((a, b) => naturalCompare(a, b));
  select.innerHTML = '<option value="">All shifts</option>' +
    shifts.map(s => `<option value="${escapeHtml(s)}">${escapeHtml(s)}</option>`).join('');
  if (prev && shifts.includes(prev)) select.value = prev;
}

// natural/alphanumeric compare so blocks order as A, A1, A2, A3, B, B1, B2…
// and workstation numbers order numerically (2 before 10), not as plain text
function naturalCompare(a, b) {
  return String(a || '').localeCompare(String(b || ''), undefined, { numeric: true, sensitivity: 'base' });
}

function renderRecordsTable() {
  const q = document.getElementById('recordSearch').value.trim().toLowerCase();
  const shiftFilter = document.getElementById('shiftFilter').value;
  const body = document.getElementById('recordsBody');

  let filtered = !q ? records : records.filter(r =>
    FIELDS.some(f => (r[f.key] || '').toLowerCase().includes(q)) || String(r.sno).includes(q)
  );
  if (shiftFilter) {
    filtered = filtered.filter(r => (r.shift || '').trim().toLowerCase() === shiftFilter.toLowerCase());
  }

  body.innerHTML = '';
  document.getElementById('recordsEmpty').classList.toggle('hidden', filtered.length !== 0);

  filtered.slice().sort((a, b) => {
    const blockCmp = naturalCompare(a.block, b.block);
    if (blockCmp !== 0) return blockCmp;
    return naturalCompare(a.workstation, b.workstation);
  }).forEach(r => {
    const tr = document.createElement('tr');
    const rowColor = shiftRowColor(r.shift);
    if (rowColor) tr.style.background = rowColor;
    tr.innerHTML = `
      <td>${escapeHtml(r.employeeName)}</td>
      <td>${escapeHtml(r.employeeId)}</td>
      <td>${escapeHtml(r.block)}</td>
      <td>${escapeHtml(r.workstation)}</td>
      <td>${escapeHtml(r.shift)}</td>
      <td>${escapeHtml(r.cpName)}</td>
      <td>${escapeHtml(r.processName)}</td>
      <td>${escapeHtml(r.clientName)}</td>
      <td>${escapeHtml(r.tlName)}</td>
      <td>${escapeHtml(r.omName)}</td>
      <td>${r.moveCount || 0}</td>
      <td class="row-actions">
        ${isOwnerRecord(r) ? `<button class="btn btn-small" data-edit="${r.id}">Edit</button>` : '<span class="muted">—</span>'}
        <button class="btn btn-small btn-danger admin-only" data-del="${r.id}">Delete</button>
      </td>
    `;
    body.appendChild(tr);
  });

  body.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openRecordModal(b.dataset.edit)));
  body.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteRecord(b.dataset.del)));
}

// mirrors server-side isOwner(): a login only "owns" a record when its
// Display Name matches the OM Name (om role) or TL Name (tl role) on that
// record. Admins own everything.
function isOwnerRecord(r) {
  if (currentUser.role === 'admin') return true;
  const mine = (currentUser.displayName || '').trim().toLowerCase();
  if (!mine) return false;
  if (currentUser.role === 'om') return (r.omName || '').trim().toLowerCase() === mine;
  if (currentUser.role === 'tl') return (r.tlName || '').trim().toLowerCase() === mine;
  return false;
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function openRecordModal(id) {
  editingRecordId = id;
  const record = id ? records.find(r => r.id === id) : null;
  document.getElementById('modalTitle').textContent = id ? `Edit record #${record.sno}` : 'New record';
  document.getElementById('modalError').textContent = '';

  const form = document.getElementById('recordForm');
  form.innerHTML = '';
  const owns = !record || isOwnerRecord(record);
  FIELDS.forEach(f => {
    const isEditable = !id || (owns && (editableFields.includes(f.key) || currentUser.role === 'admin'));
    // when creating new record only admins reach here (button is admin-only), so all fields editable
    const div = document.createElement('label');
    div.innerHTML = `${f.label}${isEditable ? '' : ' <span class="muted">(locked for your role)</span>'}<input type="text" name="${f.key}" value="${record ? escapeHtml(record[f.key]) : ''}" ${isEditable ? '' : 'disabled'}>`;
    form.appendChild(div);
  });

  document.getElementById('recordModal').classList.remove('hidden');
}

function closeRecordModal() {
  document.getElementById('recordModal').classList.add('hidden');
  editingRecordId = null;
}

async function saveRecord(e) {
  e.preventDefault();
  const form = document.getElementById('recordForm');
  const payload = {};
  FIELDS.forEach(f => {
    const input = form.querySelector(`[name="${f.key}"]`);
    if (input && !input.disabled) payload[f.key] = input.value;
  });

  try {
    if (editingRecordId) {
      const { changed } = await api(`/records/${editingRecordId}`, { method: 'PUT', body: JSON.stringify(payload) });
      if (changed) {
        toast('Record updated');
      } else {
        toast("No changes were saved — those field(s) aren't editable by your role, or the values were already the same.", true);
      }
    } else {
      await api('/records', { method: 'POST', body: JSON.stringify(payload) });
      toast('Record created');
    }
    closeRecordModal();
    loadRecords();
  } catch (err) {
    document.getElementById('modalError').textContent = err.message;
  }
}

async function deleteRecord(id) {
  if (!confirm('Delete this record? This cannot be undone.')) return;
  try {
    await api(`/records/${id}`, { method: 'DELETE' });
    toast('Record deleted');
    loadRecords();
  } catch (err) {
    toast(err.message, true);
  }
}

// ==================== MY ALLOCATIONS (om / tl personal dashboard) ====================
async function loadMyAllocations() {
  try {
    const { scopeName, records: mine, summary } = await api('/my-allocations');
    document.getElementById('myallocSubtitle').textContent = scopeName
      ? `Workstations currently allocated to ${scopeName}.`
      : 'Workstations currently allocated to you.';

    document.getElementById('myallocTotal').textContent = summary.total;
    document.getElementById('myallocMapped').textContent = summary.mapped;
    document.getElementById('myallocUnmapped').textContent = summary.unmapped;

    const maxShift = Math.max(1, ...summary.byShift.map(s => s.count));
    document.getElementById('myallocShiftBars').innerHTML = summary.byShift.length
      ? summary.byShift.map(s => `
        <div class="bar-row">
          <span>${escapeHtml(s.shift)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(s.count / maxShift) * 100}%"></span></span>
          <span>${s.count}</span>
        </div>`).join('')
      : '<span class="muted">No allocations yet.</span>';

    const maxBlock = Math.max(1, ...summary.byBlock.map(b => b.count));
    document.getElementById('myallocBlockBars').innerHTML = summary.byBlock.length
      ? summary.byBlock.map(b => `
        <div class="bar-row">
          <span>${escapeHtml(b.block)}</span>
          <span class="bar-track"><span class="bar-fill" style="width:${(b.count / maxBlock) * 100}%"></span></span>
          <span>${b.count}</span>
        </div>`).join('')
      : '<span class="muted">No allocations yet.</span>';

    const body = document.getElementById('myallocBody');
    document.getElementById('myallocEmpty').classList.toggle('hidden', mine.length !== 0);
    body.innerHTML = mine.slice().sort((a, b) => {
      const blockCmp = naturalCompare(a.block, b.block);
      if (blockCmp !== 0) return blockCmp;
      return naturalCompare(a.workstation, b.workstation);
    }).map(r => `
      <tr>
        <td>${r.sno}</td>
        <td>${escapeHtml(r.employeeName)}</td>
        <td>${escapeHtml(r.employeeId)}</td>
        <td>${escapeHtml(r.block)}</td>
        <td>${escapeHtml(r.workstation)}</td>
        <td>${escapeHtml(r.shift)}</td>
        <td>${escapeHtml(r.cpName)}</td>
        <td>${escapeHtml(r.processName)}</td>
        <td>${escapeHtml(r.clientName)}</td>
        <td>${escapeHtml(r.tlName)}</td>
        <td>${escapeHtml(r.omName)}</td>
      </tr>`).join('');
  } catch (err) {
    toast(err.message, true);
  }
}

// ==================== DASHBOARD ====================
// converts a <input type="datetime-local"> value (interpreted by the
// browser as local time) into a proper ISO instant for the API; returns ''
// if blank/invalid
function datetimeLocalToIso(value) {
  if (!value) return '';
  const d = new Date(value);
  return isNaN(d.getTime()) ? '' : d.toISOString();
}
// human-friendly label for a datetime-local value, e.g. "23 Aug, 5:30 PM"
function fmtRangeLabel(value) {
  if (!value) return null;
  const d = new Date(value);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleString(undefined, { day: '2-digit', month: 'short', hour: 'numeric', minute: '2-digit' });
}

async function loadDashboard() {
  try {
    const fromRaw = document.getElementById('dashDateFrom').value;
    const toRaw = document.getElementById('dashDateTo').value;
    const from = datetimeLocalToIso(fromRaw);
    const to = datetimeLocalToIso(toRaw);
    let url = '/dashboard/summary';
    const qs = [];
    if (from) qs.push('from=' + encodeURIComponent(from));
    if (to) qs.push('to=' + encodeURIComponent(to));
    if (qs.length) url += '?' + qs.join('&');
    const summary = await api(url);
    document.getElementById('statTotalRecords').textContent = summary.totalRecords;
    document.getElementById('statTrackedChanges').textContent = summary.trackedChanges;
    document.getElementById('statChangesToday').textContent = summary.changesToday;
    document.getElementById('statTotalChanges').textContent = summary.totalChanges;

    const rangeNote = document.getElementById('dashRangeNote');
    if (summary.rangeActive) {
      const fromLabel = fmtRangeLabel(fromRaw) || 'the start';
      const toLabel = fmtRangeLabel(toRaw) || 'now';
      rangeNote.textContent = `Showing "Tracked interchanges" and "Interchanges by field" for ${fromLabel} → ${toLabel}. "Changes today" and "All changes logged" always show live totals.`;
    } else {
      rangeNote.textContent = 'Pick an exact date & time range above (e.g. 23 Aug 5:30 PM to 24 Aug 5:30 AM) to scope "Tracked interchanges" and "Interchanges by field" to that window.';
    }

    const max = Math.max(1, ...Object.values(summary.countsByField));
    const labels = { cpName: 'CP Name', employeeName: 'Employee Name', employeeId: 'Employee ID', seat: 'Block / Workstation' };
    const barsEl = document.getElementById('fieldBars');
    barsEl.innerHTML = '';
    Object.entries(summary.countsByField).forEach(([key, count]) => {
      const row = document.createElement('div');
      row.className = 'bar-row';
      row.innerHTML = `<span>${labels[key]}</span>
        <span class="bar-track"><span class="bar-fill" style="width:${(count / max) * 100}%"></span></span>
        <span>${count}</span>`;
      barsEl.appendChild(row);
    });

    const chipsEl = document.getElementById('topOMs');
    chipsEl.innerHTML = summary.topOMs.length
      ? summary.topOMs.map(o => `<span class="chip">${escapeHtml(o.omName)} · ${o.count} CP${o.count > 1 ? 's' : ''}</span>`).join('')
      : '<span class="muted">No OM mappings recorded yet.</span>';
  } catch (err) {
    toast(err.message, true);
  }
  loadAudit();
  loadMappingOverview();
}

async function loadAudit() {
  try {
    const { logs } = await api('/audit?field=seat');
    const body = document.getElementById('auditBody');
    body.innerHTML = '';
    document.getElementById('auditEmpty').classList.toggle('hidden', logs.length !== 0);
    logs.forEach(l => {
      const s = l.snapshot || {};
      const empName = l.employeeName || s.employeeName || '';
      const empId = l.employeeId || s.employeeId || '';
      const empLabel = empName && empId ? `${empName} - ${empId}` : (empName || empId || '—');
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${l.sno}</td>
        <td>${escapeHtml(empLabel)}</td>
        <td class="diff-old">${escapeHtml(l.oldValue) || '—'}</td>
        <td class="diff-arrow">→</td>
        <td class="diff-new">${escapeHtml(l.newValue) || '—'}</td>
        <td>${escapeHtml(l.changedBy)} <span class="muted">(${l.changedByRole})</span></td>
        <td>${fmtDate(l.timestamp)}</td>
      `;
      body.appendChild(tr);
    });
  } catch (err) {
    toast(err.message, true);
  }
}

// ==================== MAPPED / UNMAPPED PIE CHARTS ====================
function drawPieChart(canvasId, legendId, segments) {
  const canvas = document.getElementById(canvasId);
  const legend = document.getElementById(legendId);
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const total = segments.reduce((s, seg) => s + seg.value, 0);
  const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 6;

  if (total === 0) {
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = '#ece9e0';
    ctx.fill();
    legend.innerHTML = '<span class="muted">No data yet.</span>';
    return;
  }

  let start = -Math.PI / 2;
  segments.forEach(seg => {
    const angle = (seg.value / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, r, start, start + angle);
    ctx.closePath();
    ctx.fillStyle = seg.color;
    ctx.fill();
    start += angle;
  });

  legend.innerHTML = segments.map(seg => `
    <div class="pie-legend-row">
      <span class="pie-swatch" style="background:${seg.color}"></span>
      ${escapeHtml(seg.label)}: <strong>${seg.value}</strong>
      <span class="muted">(${Math.round((seg.value / total) * 100)}%)</span>
    </div>
  `).join('');
}

// stable colour per TL name so the same TL always gets the same colour
// across the legend, stacked bars and table for a given OM's breakdown
const TL_COLOR_PALETTE = [
  '#2f7d5c', '#b3432f', '#3568b3', '#b38a2f', '#7d4fb3',
  '#2f9db3', '#b32f6e', '#5c8a2f', '#b36b2f', '#2f4fb3',
  '#8a2fb3', '#2fb38a', '#b32f2f', '#4f6e2f', '#6e2fb3'
];
function tlColorMap(tlNames) {
  const map = {};
  tlNames.forEach((tl, i) => {
    map[tl] = tl === 'Unassigned' ? '#9a9488' : TL_COLOR_PALETTE[i % TL_COLOR_PALETTE.length];
  });
  return map;
}

// renders the "date-wise mapping count, by TL" stacked bars + table for the
// currently selected OM. dateWiseTl is newest-first: [{date, total, tls:[{tlName,count}]}]
function renderOmDateTlBreakdown(dateWiseTl, tlNames) {
  const legendEl = document.getElementById('omTlLegend');
  const chartEl = document.getElementById('omDateTlChart');
  const bodyEl = document.getElementById('omDateTlBody');
  const colors = tlColorMap(tlNames);

  if (!dateWiseTl.length) {
    legendEl.innerHTML = '<span class="muted">No mapped records yet.</span>';
    chartEl.innerHTML = '';
    bodyEl.innerHTML = '<tr><td colspan="3" class="muted">None</td></tr>';
    return;
  }

  legendEl.innerHTML = tlNames.map(tl => `
    <div class="pie-legend-row">
      <span class="pie-swatch" style="background:${colors[tl]}"></span>${escapeHtml(tl)}
    </div>
  `).join('');

  const maxTotal = Math.max(...dateWiseTl.map(d => d.total), 1);
  chartEl.innerHTML = dateWiseTl.map(d => `
    <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
      <span class="muted" style="width:96px; flex:none; font-size:12px;">${escapeHtml(fmtDateOnly(d.date))}</span>
      <div style="flex:1; display:flex; height:20px; border-radius:4px; overflow:hidden; background:var(--paper-alt,#ece9e0);">
        ${d.tls.map(t => `<div title="${escapeHtml(t.tlName)}: ${t.count}" style="width:${(t.count / maxTotal) * 100}%; background:${colors[t.tlName]};"></div>`).join('')}
      </div>
      <span style="width:28px; flex:none; text-align:right; font-size:12px;"><strong>${d.total}</strong></span>
    </div>
  `).join('');

  bodyEl.innerHTML = dateWiseTl.flatMap(d => d.tls.map(t => `
    <tr>
      <td>${escapeHtml(fmtDateOnly(d.date))}</td>
      <td><span class="pie-swatch" style="background:${colors[t.tlName]}; display:inline-block; margin-right:6px;"></span>${escapeHtml(t.tlName)}</td>
      <td>${t.count}</td>
    </tr>
  `)).join('');
}

function fmtDateOnly(d) {
  if (!d || d === 'Unknown') return 'Unknown';
  const dt = new Date(d + 'T00:00:00');
  if (isNaN(dt)) return d;
  return dt.toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
}

// ==================== QUICK VIEW (read-only OM/TL/Block snapshot) ====================
let quickViewTimer = null;

function openQuickView() {
  document.getElementById('quickViewModal').classList.remove('hidden');
  loadQuickView();
  if (quickViewTimer) clearInterval(quickViewTimer);
  quickViewTimer = setInterval(loadQuickView, 10000); // keep it live while open
}

function closeQuickView() {
  document.getElementById('quickViewModal').classList.add('hidden');
  if (quickViewTimer) { clearInterval(quickViewTimer); quickViewTimer = null; }
}

async function loadQuickView() {
  const body = document.getElementById('quickViewBody');
  try {
    const { oms, generatedAt } = await api('/dashboard/quick-view');
    body.innerHTML = renderQuickViewRows(oms);
    document.getElementById('quickViewUpdated').textContent = 'Last updated: ' + fmtDate(generatedAt);
  } catch (err) {
    body.innerHTML = `<tr><td colspan="4" class="muted">${escapeHtml(err.message)}</td></tr>`;
  }
}

// builds the merged-cell table body: one <tr> per Block, with OM Name and
// TL Name cells spanning every block row underneath them (rowSpan), exactly
// like a paper mapping sheet. Purely display — no inputs, nothing editable.
function renderQuickViewRows(oms) {
  if (!oms || !oms.length) {
    return '<tr><td colspan="4" class="muted">No records yet.</td></tr>';
  }
  let rows = '';
  oms.forEach(om => {
    const omRowCount = om.tls.reduce((s, tl) => s + Math.max(tl.blocks.length, 1), 0);
    let omPrinted = false;
    om.tls.forEach(tl => {
      const blocks = tl.blocks.length ? tl.blocks : [{ block: '—', mapped: 0, notMapped: 0 }];
      let tlPrinted = false;
      blocks.forEach(b => {
        rows += '<tr>';
        if (!omPrinted) {
          rows += `<td class="qv-om" rowspan="${omRowCount}">${escapeHtml(om.omName)}</td>`;
          omPrinted = true;
        }
        if (!tlPrinted) {
          rows += `<td class="qv-tl" rowspan="${blocks.length}">${escapeHtml(tl.tlName)}</td>`;
          tlPrinted = true;
        }
        rows += `<td>${escapeHtml(b.block)}-${b.mapped}</td>`;
        rows += `<td>${escapeHtml(b.block)}-${b.notMapped}</td>`;
        rows += '</tr>';
      });
    });
  });
  return rows;
}

let allOmNames = [];
let allTlNames = [];
let allEmployees = [];
let selectedOm = '';
let selectedTl = '';
let selectedEmployeeId = '';

// generic live-search dropdown: shows a filtered suggestion list under the
// input as the user types, no <select> element involved. Clicking a
// suggestion fires onPick(item) and closes the list.
function createSearchDropdown(inputId, listId, getItems, matchFn, renderLabel, onPick) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(listId);
  let currentFiltered = [];

  function render() {
    const f = input.value.trim().toLowerCase();
    const items = getItems();
    currentFiltered = f ? items.filter(it => matchFn(it, f)) : items;
    if (!currentFiltered.length) {
      list.innerHTML = `<div class="search-suggestion-empty muted">No matches</div>`;
    } else {
      list.innerHTML = currentFiltered.slice(0, 50).map((it, idx) =>
        `<div class="search-suggestion-item" data-idx="${idx}">${renderLabel(it)}</div>`
      ).join('');
    }
    list.classList.remove('hidden');
  }

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  list.addEventListener('mousedown', e => {
    const row = e.target.closest('.search-suggestion-item');
    if (!row) return;
    const item = currentFiltered[Number(row.dataset.idx)];
    onPick(item);
    list.classList.add('hidden');
  });
  document.addEventListener('click', e => {
    if (e.target !== input && !list.contains(e.target)) list.classList.add('hidden');
  });
}

function initMappingSearchDropdowns() {
  createSearchDropdown(
    'omMappingSearch', 'omMappingSuggestions',
    () => allOmNames,
    (om, f) => om.toLowerCase().includes(f),
    om => escapeHtml(om),
    om => {
      selectedOm = om;
      document.getElementById('omMappingSearch').value = om;
      loadOmMapping(om);
    }
  );
  createSearchDropdown(
    'tlMappingSearch', 'tlMappingSuggestions',
    () => allTlNames,
    (tl, f) => tl.toLowerCase().includes(f),
    tl => escapeHtml(tl),
    tl => {
      selectedTl = tl;
      document.getElementById('tlMappingSearch').value = tl;
      loadTlMapping(tl);
    }
  );
  createSearchDropdown(
    'employeeMappingSearch', 'employeeMappingSuggestions',
    () => allEmployees,
    (e, f) => e.employeeName.toLowerCase().includes(f) || e.employeeId.toLowerCase().includes(f),
    e => `${escapeHtml(e.employeeName)} (${escapeHtml(e.employeeId)})`,
    e => {
      selectedEmployeeId = e.employeeId;
      document.getElementById('employeeMappingSearch').value = `${e.employeeName} (${e.employeeId})`;
      loadEmployeeMapping(e.employeeId);
    }
  );
}

async function loadMappingOverview() {
  try {
    const { overall, omNames, tlNames, employees } = await api('/dashboard/mapping');
    drawPieChart('mappingPieChart', 'mappingPieLegend', [
      { label: 'Mapped', value: overall.mapped, color: '#2f7d5c' },
      { label: 'Unmapped', value: overall.unmapped, color: '#b3432f' }
    ]);

    allOmNames = omNames;
    if (selectedOm && omNames.includes(selectedOm)) {
      loadOmMapping(selectedOm);
    } else {
      selectedOm = '';
      drawPieChart('omPieChart', 'omPieLegend', [
        { label: 'Mapped', value: 0, color: '#2f7d5c' },
        { label: 'Unmapped', value: 0, color: '#b3432f' }
      ]);
    }

    allTlNames = tlNames;
    if (selectedTl && tlNames.includes(selectedTl)) {
      loadTlMapping(selectedTl);
    } else {
      selectedTl = '';
      drawPieChart('tlPieChart', 'tlPieLegend', [
        { label: 'Mapped', value: 0, color: '#2f7d5c' },
        { label: 'Unmapped', value: 0, color: '#b3432f' }
      ]);
    }

    allEmployees = employees;
    if (selectedEmployeeId && employees.some(e => e.employeeId === selectedEmployeeId)) {
      loadEmployeeMapping(selectedEmployeeId);
    }
  } catch (err) {
    toast(err.message, true);
  }
}

function mappingRowHtml(r) {
  const v = x => escapeHtml(x) || '—';
  return `<tr><td>${r.sno}</td><td>${v(r.employeeName)}</td><td>${v(r.employeeId)}</td><td>${v(r.block)}</td><td>${v(r.workstation)}</td><td>${v(r.cpName)}</td></tr>`;
}

let currentOmForMapping = null;

async function loadOmMapping(om) {
  const detailsPanel = document.getElementById('omMappingDetailsPanel');

  if (!om) {
    currentOmForMapping = null;
    drawPieChart('omPieChart', 'omPieLegend', [
      { label: 'Mapped', value: 0, color: '#2f7d5c' },
      { label: 'Unmapped', value: 0, color: '#b3432f' }
    ]);
    detailsPanel.style.display = 'none';
    return;
  }
  currentOmForMapping = om;

  try {
    const from = datetimeLocalToIso(document.getElementById('omDateFrom').value);
    const to = datetimeLocalToIso(document.getElementById('omDateTo').value);
    let url = '/dashboard/om-mapping?om=' + encodeURIComponent(om);
    if (from) url += '&from=' + encodeURIComponent(from);
    if (to) url += '&to=' + encodeURIComponent(to);
    const data = await api(url);
    drawPieChart('omPieChart', 'omPieLegend', [
      { label: 'Mapped', value: data.mapped, color: '#2f7d5c' },
      { label: 'Unmapped', value: data.unmapped, color: '#b3432f' }
    ]);

    document.getElementById('omMappingDetailsTitle').textContent = `OM mapping details — ${om}`;
    document.getElementById('omTotalThisMonth').textContent = data.totals.thisMonth;
    document.getElementById('omTotalAllTime').textContent = data.totals.allTime;
    document.getElementById('omEmployeeCountsMonth').innerHTML = data.employeeCounts.length
      ? data.employeeCounts.map(e => `<span class="chip">${escapeHtml(e.employeeName)}-${e.countThisMonth}</span>`).join('')
      : '<span class="muted">No mapped employees under this OM yet.</span>';
    document.getElementById('omEmployeeCounts').innerHTML = data.employeeCounts.length
      ? data.employeeCounts.map(e => `<span class="chip">${escapeHtml(e.employeeName)}-${e.countAllTime}</span>`).join('')
      : '<span class="muted">No mapped employees under this OM yet.</span>';
    document.getElementById('omMappedBody').innerHTML = data.mappedRecords.length
      ? data.mappedRecords.map(mappingRowHtml).join('')
      : '<tr><td colspan="6" class="muted">None</td></tr>';
    document.getElementById('omUnmappedBody').innerHTML = data.unmappedRecords.length
      ? data.unmappedRecords.map(mappingRowHtml).join('')
      : '<tr><td colspan="6" class="muted">None</td></tr>';
    renderOmDateTlBreakdown(data.dateWiseTl || [], data.tlNames || []);

    detailsPanel.style.display = 'block';
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadTlMapping(tl) {
  const detailsPanel = document.getElementById('tlMappingDetailsPanel');

  if (!tl) {
    drawPieChart('tlPieChart', 'tlPieLegend', [
      { label: 'Mapped', value: 0, color: '#2f7d5c' },
      { label: 'Unmapped', value: 0, color: '#b3432f' }
    ]);
    detailsPanel.style.display = 'none';
    return;
  }

  try {
    const data = await api('/dashboard/tl-mapping?tl=' + encodeURIComponent(tl));
    drawPieChart('tlPieChart', 'tlPieLegend', [
      { label: 'Mapped', value: data.mapped, color: '#2f7d5c' },
      { label: 'Unmapped', value: data.unmapped, color: '#b3432f' }
    ]);

    document.getElementById('tlMappingDetailsTitle').textContent = `TL mapping details — ${tl}`;
    document.getElementById('tlTotalThisMonth').textContent = data.totals.thisMonth;
    document.getElementById('tlTotalAllTime').textContent = data.totals.allTime;
    document.getElementById('tlEmployeeCountsMonth').innerHTML = data.employeeCounts.length
      ? data.employeeCounts.map(e => `<span class="chip">${escapeHtml(e.employeeName)}-${e.countThisMonth}</span>`).join('')
      : '<span class="muted">No mapped employees under this TL yet.</span>';
    document.getElementById('tlEmployeeCounts').innerHTML = data.employeeCounts.length
      ? data.employeeCounts.map(e => `<span class="chip">${escapeHtml(e.employeeName)}-${e.countAllTime}</span>`).join('')
      : '<span class="muted">No mapped employees under this TL yet.</span>';
    document.getElementById('tlMappedBody').innerHTML = data.mappedRecords.length
      ? data.mappedRecords.map(mappingRowHtml).join('')
      : '<tr><td colspan="6" class="muted">None</td></tr>';
    document.getElementById('tlUnmappedBody').innerHTML = data.unmappedRecords.length
      ? data.unmappedRecords.map(mappingRowHtml).join('')
      : '<tr><td colspan="6" class="muted">None</td></tr>';
    detailsPanel.style.display = 'block';
  } catch (err) {
    toast(err.message, true);
  }
}

async function loadEmployeeMapping(employeeId) {
  const resultEl = document.getElementById('employeeMappingResult');
  if (!employeeId) {
    resultEl.innerHTML = '';
    return;
  }
  resultEl.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await api('/dashboard/employee-mapping?employeeId=' + encodeURIComponent(employeeId));
    if (!data.employeeName) {
      resultEl.innerHTML = '<p class="muted">No mapping history found for this user.</p>';
      return;
    }
    const historyRows = data.history.map(h => `
      <tr>
        <td>${h.sno}</td>
        <td class="diff-old">${escapeHtml(h.oldValue) || '—'}</td>
        <td class="diff-arrow">→</td>
        <td class="diff-new">${escapeHtml(h.newValue) || '—'}</td>
        <td>${escapeHtml(h.changedBy)} <span class="muted">(${h.changedByRole})</span></td>
        <td>${fmtDate(h.timestamp)}</td>
      </tr>`).join('');
    resultEl.innerHTML = `
      <div style="margin-bottom:14px;">
        <span class="chip" style="font-size:14px; padding:8px 14px;">${escapeHtml(data.employeeName)}-${data.count}</span>
        <span class="muted" style="margin-left:8px;">moved ${data.count} time${data.count === 1 ? '' : 's'} in total</span>
      </div>
      <div class="table-wrap">
        <table class="audit-table">
          <thead><tr><th>S.No</th><th>Previous location (Block / WS)</th><th></th><th>New location (Block / WS)</th><th>Changed by</th><th>When</th></tr></thead>
          <tbody>${historyRows || '<tr><td colspan="6" class="muted">No moves yet.</td></tr>'}</tbody>
        </table>
      </div>
    `;
  } catch (err) {
    toast(err.message, true);
  }
}

// ==================== EMPLOYEE CP SWAP HISTORY ====================
async function searchEmployeeHistory(e) {
  e.preventDefault();
  const query = document.getElementById('employeeHistoryQuery').value.trim();
  const resultsEl = document.getElementById('employeeHistoryResults');
  if (!query) {
    resultsEl.innerHTML = '<p class="employee-history-empty">Type an employee name or employee ID to search.</p>';
    return;
  }
  resultsEl.innerHTML = '<p class="employee-history-empty">Searching…</p>';
  try {
    const { matches } = await api('/audit/employee?query=' + encodeURIComponent(query));
    renderEmployeeHistory(matches, query);
  } catch (err) {
    resultsEl.innerHTML = `<p class="employee-history-empty">${escapeHtml(err.message)}</p>`;
  }
}

function renderEmployeeHistory(matches, query) {
  const resultsEl = document.getElementById('employeeHistoryResults');
  if (!matches.length) {
    resultsEl.innerHTML = `<p class="employee-history-empty">No employee matching "${escapeHtml(query)}" was found in current or past records.</p>`;
    return;
  }

  resultsEl.innerHTML = '';
  matches.forEach(m => {
    const nameSource = m.currentRecord ||
      (m.fullHistory.length ? m.fullHistory[m.fullHistory.length - 1].snapshot : null) || {};
    const displayName = nameSource.employeeName || '(unknown name)';
    const displayId = nameSource.employeeId || '—';

    const card = document.createElement('div');
    card.className = 'eh-card';

    // --- head ---
    const head = document.createElement('div');
    head.className = 'eh-card-head';
    head.innerHTML = `
      <div>
        <h4>${escapeHtml(displayName)} <span class="muted">(${escapeHtml(displayId)})</span></h4>
        <span class="muted">S.No ${m.sno ?? '—'}</span>
      </div>
      <span class="eh-badge ${m.deleted ? 'deleted' : ''}">${m.deleted ? 'Record deleted' : 'Active record'}</span>
    `;
    card.appendChild(head);

    // --- current full 10-field row ---
    if (m.currentRecord) {
      const row = document.createElement('div');
      row.className = 'eh-current-row';
      row.innerHTML = `
        <table>
          <thead><tr>${FIELDS.map(f => `<th>${f.label}</th>`).join('')}</tr></thead>
          <tbody><tr>${FIELDS.map(f => `<td>${escapeHtml(m.currentRecord[f.key])}</td>`).join('')}</tr></tbody>
        </table>
      `;
      card.appendChild(row);
    }

    // --- CP swap history ---
    const label = document.createElement('div');
    label.className = 'eh-section-label';
    label.textContent = 'CP swap history (chronological, with full record context at each swap)';
    card.appendChild(label);

    if (!m.cpHistory.length) {
      const none = document.createElement('p');
      none.className = 'eh-no-swaps';
      none.textContent = 'No CP interchange recorded yet for this employee.';
      card.appendChild(none);
    } else {
      const wrap = document.createElement('div');
      wrap.className = 'eh-swap-table-wrap';
      const table = document.createElement('table');
      table.className = 'eh-swap-table';
      table.innerHTML = `
        <thead>
          <tr>
            <th>When</th>
            <th>Previous CP</th>
            <th></th>
            <th>New CP</th>
            <th>Employee Name</th>
            <th>Employee ID</th>
            <th>Block</th>
            <th>Workstation</th>
            <th>Shift</th>
            <th>Process</th>
            <th>Client</th>
            <th>TL Name</th>
            <th>OM Name</th>
            <th>Changed by</th>
          </tr>
        </thead>
        <tbody>
          ${m.cpHistory.map(h => {
            const s = h.snapshot || {};
            return `<tr>
              <td>${fmtDate(h.timestamp)}</td>
              <td class="diff-old">${escapeHtml(h.oldValue) || '—'}</td>
              <td class="diff-arrow">→</td>
              <td class="diff-new">${escapeHtml(h.newValue) || '—'}</td>
              <td>${escapeHtml(s.employeeName)}</td>
              <td>${escapeHtml(s.employeeId)}</td>
              <td>${escapeHtml(s.block)}</td>
              <td>${escapeHtml(s.workstation)}</td>
              <td>${escapeHtml(s.shift)}</td>
              <td>${escapeHtml(s.processName)}</td>
              <td>${escapeHtml(s.clientName)}</td>
              <td>${escapeHtml(s.tlName)}</td>
              <td>${escapeHtml(s.omName)}</td>
              <td>${escapeHtml(h.changedBy)} <span class="muted">(${h.changedByRole})</span></td>
            </tr>`;
          }).join('')}
        </tbody>
      `;
      wrap.appendChild(table);
      card.appendChild(wrap);
    }

    resultsEl.appendChild(card);
  });
}

// ==================== USERS ====================
async function loadUsers() {
  if (currentUser.role !== 'admin') return;
  try {
    const { users } = await api('/users');
    const body = document.getElementById('usersBody');
    body.innerHTML = '';
    users.forEach(u => {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${escapeHtml(u.username)}</td>
        <td>${escapeHtml(u.displayName)}</td>
        <td><span class="field-tag">${u.role.toUpperCase()}</span></td>
        <td><button class="btn btn-small btn-danger" data-deluser="${u.id}">Remove</button></td>
      `;
      body.appendChild(tr);
    });
    body.querySelectorAll('[data-deluser]').forEach(b => b.addEventListener('click', () => deleteUser(b.dataset.deluser)));
  } catch (err) {
    toast(err.message, true);
  }
}

async function createUser(e) {
  e.preventDefault();
  const username = document.getElementById('newUsername').value.trim();
  const displayName = document.getElementById('newDisplayName').value.trim();
  const password = document.getElementById('newPassword').value;
  const role = document.getElementById('newRole').value;
  try {
    await api('/users', { method: 'POST', body: JSON.stringify({ username, displayName, password, role }) });
    toast('Login created');
    document.getElementById('userForm').reset();
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}

async function deleteUser(id) {
  if (!confirm('Remove this login?')) return;
  try {
    await api(`/users/${id}`, { method: 'DELETE' });
    toast('Login removed');
    loadUsers();
  } catch (err) {
    toast(err.message, true);
  }
}
