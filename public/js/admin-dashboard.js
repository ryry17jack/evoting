/* =====================================================================
   ADMIN-DASHBOARD.JS — จัดการกิจกรรมเลือกตั้ง / ผู้สมัคร / บัญชีรายชื่อผู้มีสิทธิ์
   และดูผลคะแนน-ผู้มาใช้สิทธิ์ของกิจกรรมที่เลือก (โพลทุก 3 วินาที)
   ===================================================================== */

const METER_BLOCKS = 25; // จำนวนบล็อกในแถบมิเตอร์
const METER_COLORS = ['', 'meter-yellow', 'meter-green', 'meter-red'];
const NO_VOTE_NO = 99;

const STATUS_INFO = {
  draft: { label: '✎ เตรียมการ', cls: 'st-draft' },
  open: { label: '● เปิดลงคะแนน', cls: 'st-open' },
  closed: { label: '■ ปิดลงคะแนนแล้ว', cls: 'st-closed' },
};

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('th-TH');
}

// วันที่ YYYY-MM-DD → "29 ก.ย. 2569"
function thaiDate(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '—';
  return new Date(+m[1], +m[2] - 1, +m[3]).toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
}

// fetch + JSON + เด้งไปหน้า login เมื่อ session หมดอายุ
async function api(url, options) {
  const res = await fetch(url, options);
  if (res.status === 401) {
    location.href = '/admin/login';
    throw new Error('unauthorized');
  }
  const data = await res.json().catch(() => ({ ok: false, error: 'เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง' }));
  if (!res.ok && data.ok === undefined) data.ok = false;
  return data;
}

function postJson(url, body, method = 'POST') {
  return api(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
}

const DT_LANGUAGE = {
  search: 'ค้นหา:',
  searchPlaceholder: 'ชื่อ หรือ เลขบัตร',
  lengthMenu: 'แสดง _MENU_ รายการต่อหน้า',
  info: 'แสดง _START_ ถึง _END_ จากทั้งหมด _TOTAL_ รายการ',
  infoEmpty: 'ไม่มีรายการที่จะแสดง',
  infoFiltered: '(กรองจากทั้งหมด _MAX_ รายการ)',
  zeroRecords: '— ไม่พบรายการที่ค้นหา —',
  paginate: { first: '⏮ หน้าแรก', previous: '◄ ก่อนหน้า', next: 'ถัดไป ►', last: 'หน้าสุดท้าย ⏭' },
};

// "2026-09-29T08:30" → "29 ก.ย. 08:30"
function thaiDateTime(local) {
  const m = String(local || '').match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${thaiDate(m[1])} ${m[2]} น.` : '';
}

/* ------------------------------------------------------------------ */
/*  ผู้ใช้ที่ล็อกอินอยู่ — ผู้ดูแลระบบเห็นทุกส่วน เจ้าหน้าที่เห็นแบบอ่านอย่างเดียว   */
/*  (ซ่อนปุ่มฝั่งหน้าเว็บเพื่อความสะดวก — เซิร์ฟเวอร์ตรวจสิทธิ์ทุกคำขออยู่แล้ว)    */
/* ------------------------------------------------------------------ */
let me = null;
const isAdmin = () => Boolean(me && me.role === 'admin');

async function loadMe() {
  const data = await api('/admin/api/me');
  me = data.user;
  document.body.classList.toggle('role-officer', !isAdmin());
  document.getElementById('admin-username').textContent = me.display_name ? `${me.display_name} (${me.username})` : me.username;
  document.getElementById('admin-role').textContent = me.role_label;
  document.getElementById('weak-password-banner').style.display = data.weakPassword ? '' : 'none';
  document.getElementById('pin-status').textContent = me.has_pin ? '✔ ตั้ง PIN แล้ว' : 'ยังไม่ได้ตั้ง PIN';
}

/* ------------------------------------------------------------------ */
/*  กิจกรรมเลือกตั้ง                                                     */
/* ------------------------------------------------------------------ */
let elections = [];
let selectedId = null; // กิจกรรมที่กำลังจัดการ (จำไว้ใน localStorage)
let editingElectionId = null;

function currentElection() {
  return elections.find((e) => e.id === selectedId) || null;
}

function loadSavedSelection() {
  try {
    return parseInt(localStorage.getItem('adminElectionId'), 10) || null;
  } catch (e) {
    return null;
  }
}

function selectElection(id) {
  if (id === selectedId) return;
  selectedId = id;
  try {
    localStorage.setItem('adminElectionId', String(id));
  } catch (e) {
    /* ไม่มี localStorage ก็ไม่เป็นไร */
  }
  resetScopedState();
  renderElections();
  refreshAll();
}

async function loadElections() {
  const data = await api('/admin/api/elections');
  elections = data.elections || [];

  if (!elections.some((e) => e.id === selectedId)) {
    const saved = loadSavedSelection();
    const pick =
      elections.find((e) => e.id === saved) || elections.find((e) => e.status === 'open') || elections[0];
    selectedId = pick ? pick.id : null;
    resetScopedState();
  }
  renderElections();
}

function statusBadge(status) {
  const st = STATUS_INFO[status] || STATUS_INFO.draft;
  return `<span class="status-badge ${st.cls}">${st.label}</span>`;
}

function turnoutText(e) {
  const voted = fmt(e.voted_count);
  if (!e.eligible_count) return `${voted} / —`;
  return `${voted} / ${fmt(e.eligible_count)} (${((e.voted_count / e.eligible_count) * 100).toFixed(1)}%)`;
}

function renderElections() {
  const tbody = document.getElementById('elections-table-body');
  if (elections.length === 0) {
    tbody.innerHTML = '<tr><td colspan="5" class="text-center">— ยังไม่มีกิจกรรมเลือกตั้ง —</td></tr>';
  } else if (!pendingElectionDelete) {
    tbody.innerHTML = elections
      .map((e) => {
        const toggle =
          e.status === 'open'
            ? `<button class="btn btn-red btn-mini" data-act="close" data-id="${e.id}">■ ปิดลงคะแนน</button>`
            : `<button class="btn btn-green btn-mini" data-act="open" data-id="${e.id}">▶ เปิดลงคะแนน</button>`;
        const schedule = [
          e.scheduled_open_at ? `⏰ เปิด ${thaiDateTime(e.scheduled_open_at)}` : '',
          e.scheduled_close_at ? `⏰ ปิด ${thaiDateTime(e.scheduled_close_at)}` : '',
        ].filter(Boolean).join(' · ');
        return `
        <tr class="${e.id === selectedId ? 'row-selected' : ''}">
          <td>
            <div style="font-weight:bold;">${escapeHtml(e.title)}</div>
            <small>ผู้สมัคร ${fmt(e.candidate_count)} ราย · ${e.require_registration ? 'เฉพาะผู้มีรายชื่อ' : 'ทุกคนที่มีบัตรประชาชน'}
              ${e.hide_results ? ' · 🔒 ซ่อนผลจนปิดหีบ' : ''}</small>
            ${schedule ? `<div class="schedule-line">${schedule}</div>` : ''}
          </td>
          <td>${thaiDate(e.election_date)}</td>
          <td>${statusBadge(e.status)}</td>
          <td style="font-weight:bold;">${turnoutText(e)}</td>
          <td>
            <button class="btn btn-blue btn-mini" data-act="select" data-id="${e.id}" ${e.id === selectedId ? 'disabled' : ''}>☞ ${isAdmin() ? 'จัดการ' : 'ดู'}</button>
            ${isAdmin() ? `${toggle}
            <button class="btn btn-mini" data-act="edit" data-id="${e.id}">✏ แก้ไข</button>
            <button class="btn btn-mini" data-act="delete" data-id="${e.id}" ${e.status === 'open' ? 'disabled title="ปิดลงคะแนนก่อนจึงลบได้"' : ''}>🗑 ลบ</button>` : ''}
          </td>
        </tr>`;
      })
      .join('');
  }

  // แถบกิจกรรมที่กำลังจัดการ
  const select = document.getElementById('election-select');
  select.innerHTML = elections
    .map((e) => `<option value="${e.id}" ${e.id === selectedId ? 'selected' : ''}>${escapeHtml(e.title)} — ${thaiDate(e.election_date)}</option>`)
    .join('');

  const e = currentElection();
  document.getElementById('election-bar').style.display = e ? '' : 'none';
  document.getElementById('election-scope').style.display = e ? '' : 'none';
  document.getElementById('no-election-box').style.display = e ? 'none' : '';
  if (!e) return;

  const barStatus = document.getElementById('election-bar-status');
  const st = STATUS_INFO[e.status] || STATUS_INFO.draft;
  barStatus.className = `status-badge ${st.cls}`;
  barStatus.textContent = st.label;

  const toggleBtn = document.getElementById('bar-toggle-status');
  toggleBtn.textContent = e.status === 'open' ? '■ ปิดลงคะแนน' : '▶ เปิดลงคะแนน';
  toggleBtn.className = `btn admin-only ${e.status === 'open' ? 'btn-red' : 'btn-green'}`;

  document.getElementById('bar-report').href = `/admin/print/report?ids=${e.id}`;
  document.getElementById('print-announce').href = `/admin/print/voters?id=${e.id}&mode=announce`;
  document.getElementById('print-checklist').href = `/admin/print/voters?id=${e.id}&mode=checklist`;
  document.getElementById('export-voters').href = `/admin/api/elections/${e.id}/export/voters.csv`;
  document.getElementById('export-logs').href = `/admin/api/elections/${e.id}/export/logs.csv`;
  document.getElementById('export-results').href = `/admin/api/elections/${e.id}/export/results.csv`;

  document.getElementById('registry-mode-note').innerHTML = e.require_registration
    ? '✔ กิจกรรมนี้ลงคะแนนได้ <b>เฉพาะผู้ที่มีชื่อในบัญชีรายชื่อ</b> — ผู้ที่ไม่มีชื่อจะเห็นข้อความ "ไม่พบรายชื่อ" ที่คูหา'
    : 'ℹ กิจกรรมนี้ <b>ไม่บังคับบัญชีรายชื่อ</b> — ทุกคนที่เสียบบัตรประชาชนลงคะแนนได้ (บัญชีรายชื่อใช้สำหรับประกาศและติดตามผู้มาใช้สิทธิ์เท่านั้น)';

  // ตัวเลือกกิจกรรมต้นทางสำหรับคัดลอกรายชื่อ
  const copySelect = document.getElementById('copy-from-select');
  const others = elections.filter((x) => x.id !== selectedId && x.eligible_count > 0);
  copySelect.innerHTML = others.length
    ? others.map((x) => `<option value="${x.id}">${escapeHtml(x.title)} (${fmt(x.eligible_count)} คน)</option>`).join('')
    : '<option value="">— ไม่มีกิจกรรมอื่นที่มีบัญชีรายชื่อ —</option>';
}

async function setElectionStatus(id, status) {
  const e = elections.find((x) => x.id === id);
  if (status === 'close' || status === 'closed') {
    if (!confirm(`ปิดการลงคะแนนของ "${e ? e.title : ''}" ?\nหลังปิดแล้วคูหาจะไม่แสดงบัตรเลือกตั้งของกิจกรรมนี้`)) return;
    status = 'closed';
  }
  if (status === 'open' && e && e.status === 'closed' && !confirm(`เปิดลงคะแนน "${e.title}" อีกครั้ง?`)) return;
  const data = await postJson(`/admin/api/elections/${id}/status`, { status });
  if (!data.ok) alert(data.error || 'เปลี่ยนสถานะไม่สำเร็จ');
  await refreshAll();
}

// ลบกิจกรรมแบบยืนยัน 2 จังหวะ
let pendingElectionDelete = null;
let pendingElectionTimer = null;
async function deleteElection(id, btn) {
  if (pendingElectionDelete !== id) {
    clearTimeout(pendingElectionTimer);
    pendingElectionDelete = id;
    btn.textContent = '⚠ ยืนยันลบ?';
    btn.classList.add('btn-red');
    pendingElectionTimer = setTimeout(() => {
      pendingElectionDelete = null;
      renderElections();
    }, 4000);
    return;
  }
  clearTimeout(pendingElectionTimer);
  pendingElectionDelete = null;
  const data = await api(`/admin/api/elections/${id}`, { method: 'DELETE' });
  if (!data.ok) alert(data.error || 'ลบไม่สำเร็จ');
  await refreshAll();
}

document.getElementById('elections-table-body').addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const id = parseInt(btn.dataset.id, 10);
  const act = btn.dataset.act;
  if (act === 'select') selectElection(id);
  else if (act === 'open') setElectionStatus(id, 'open');
  else if (act === 'close') setElectionStatus(id, 'closed');
  else if (act === 'edit') openElectionForm(id);
  else if (act === 'delete') deleteElection(id, btn);
});

document.getElementById('election-select').addEventListener('change', (ev) => {
  selectElection(parseInt(ev.target.value, 10));
});

document.getElementById('bar-toggle-status').addEventListener('click', () => {
  const e = currentElection();
  if (e) setElectionStatus(e.id, e.status === 'open' ? 'closed' : 'open');
});

// ฟอร์มสร้าง/แก้ไขกิจกรรม
const electionFormBox = document.getElementById('election-form-box');
const electionFormError = document.getElementById('election-form-error');

function showElectionFormError(msg) {
  electionFormError.textContent = msg;
  electionFormError.style.display = msg ? 'block' : 'none';
}

function openElectionForm(id) {
  const e = id ? elections.find((x) => x.id === id) : null;
  editingElectionId = e ? e.id : null;
  document.getElementById('election-form-title').textContent = e ? `แก้ไขกิจกรรม: ${e.title}` : 'สร้างกิจกรรมเลือกตั้งใหม่';
  document.getElementById('election-title-input').value = e ? e.title : '';
  document.getElementById('election-date-input').value = e
    ? e.election_date || ''
    : new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD
  document.getElementById('election-desc-input').value = e ? e.description || '' : '';
  document.getElementById('election-reg-input').checked = e ? !!e.require_registration : true;
  document.getElementById('election-hide-input').checked = e ? !!e.hide_results : true;
  document.getElementById('election-open-at').value = e ? e.scheduled_open_at || '' : '';
  document.getElementById('election-close-at').value = e ? e.scheduled_close_at || '' : '';
  showElectionFormError('');
  electionFormBox.style.display = 'block';
  electionFormBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  document.getElementById('election-title-input').focus();
}

function closeElectionForm() {
  electionFormBox.style.display = 'none';
  editingElectionId = null;
}

document.getElementById('btn-add-election').addEventListener('click', () => openElectionForm(null));
document.getElementById('election-cancel-btn').addEventListener('click', closeElectionForm);
document.getElementById('election-form-close').addEventListener('click', closeElectionForm);

document.getElementById('election-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const saveBtn = document.getElementById('election-save-btn');
  saveBtn.disabled = true;
  showElectionFormError('');
  const body = {
    title: document.getElementById('election-title-input').value,
    election_date: document.getElementById('election-date-input').value,
    description: document.getElementById('election-desc-input').value,
    require_registration: document.getElementById('election-reg-input').checked,
    hide_results: document.getElementById('election-hide-input').checked,
    scheduled_open_at: document.getElementById('election-open-at').value,
    scheduled_close_at: document.getElementById('election-close-at').value,
  };
  const current = editingElectionId ? elections.find((x) => x.id === editingElectionId) : null;
  if (current && current.status === 'open' && current.hide_results && !body.hide_results &&
      !confirm('ยกเลิกการซ่อนผลคะแนนขณะที่ยังเปิดลงคะแนนอยู่?\nทุกคนที่เข้าแดชบอร์ดจะเห็นผลคะแนนระหว่างเลือกตั้ง และการเปลี่ยนนี้จะถูกบันทึกใน audit log')) {
    saveBtn.disabled = false;
    return;
  }
  try {
    const data = editingElectionId
      ? await postJson(`/admin/api/elections/${editingElectionId}`, body, 'PUT')
      : await postJson('/admin/api/elections', body);
    if (!data.ok) return showElectionFormError(data.error || 'บันทึกไม่สำเร็จ');
    closeElectionForm();
    if (data.id) {
      selectedId = null; // ให้ loadElections เลือกกิจกรรมใหม่
      try {
        localStorage.setItem('adminElectionId', String(data.id));
      } catch (e) {}
    }
    await refreshAll();
  } catch (err) {
    showElectionFormError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  } finally {
    saveBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/*  สถานะที่ผูกกับกิจกรรมที่เลือก — ล้างเมื่อเปลี่ยนกิจกรรม                    */
/* ------------------------------------------------------------------ */
let logsTable = null;
let votersTable = null;
let votersSignature = '';

function resetScopedState() {
  votersSignature = '';
  if (logsTable) logsTable.clear().draw();
  if (votersTable) votersTable.clear().draw();
  closeCandidateForm(false);
  document.querySelectorAll('#election-scope .subpanel').forEach((p) => (p.style.display = 'none'));
}

/* ------------------------------------------------------------------ */
/*  บันทึกผู้มาใช้สิทธิ์ (DataTables)                                    */
/*  ค้นหา / เรียงลำดับ / แบ่งหน้าได้ และคงสถานะไว้ระหว่างรีเฟรชทุก 3 วินาที */
/* ------------------------------------------------------------------ */

// แปลงวันที่รูปแบบ dd/mm/yyyy hh:mm:ss เป็นตัวเลขเพื่อให้ DataTables เรียงลำดับถูกต้อง
function thaiDateSortKey(str) {
  const m = String(str || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  return m ? Number(`${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}${m[6]}`) : 0;
}

const renderCid = (d, type) =>
  type === 'display' ? `<span class="mono">${escapeHtml(d)}</span>` : d;

function initLogsTable() {
  logsTable = new DataTable('#logs-table', {
    data: [],
    columns: [
      { data: 'seq', className: 'dt-center' },
      { data: 'citizen_id', className: 'dt-left', render: renderCid },
      { data: 'full_name', render: (d, type) => (type === 'display' ? escapeHtml(d) : d) },
      { data: 'group_name', render: (d, type) => (type === 'display' ? escapeHtml(d || '—') : d) },
      {
        data: 'in_registry',
        className: 'text-center',
        render: (d, type) =>
          type === 'display'
            ? d ? '<span class="sc-badge sc-ok">✔ มีชื่อ</span>' : '<span class="sc-badge sc-warn">ไม่มีชื่อ</span>'
            : d ? 'มีชื่อ' : 'ไม่มีชื่อ',
      },
      {
        data: 'entry_method',
        className: 'dt-left',
        render: (d, type, r) => {
          const text = d === 'manual' ? `เจ้าหน้าที่กรอก (${r.officer || '-'})` : 'บัตรประชาชน';
          if (type !== 'display') return text;
          return d === 'manual' ? `<span class="sc-badge sc-warn">🔑 ${escapeHtml(text)}</span>` : '💳 บัตร';
        },
      },
      {
        data: 'voted_at',
        className: 'dt-left',
        // เรียงตามเวลาจริง ไม่ใช่เรียงตามตัวอักษรของข้อความ
        render: (d, type) => (type === 'sort' || type === 'type' ? thaiDateSortKey(d) : escapeHtml(d)),
      },
    ],
    order: [[0, 'desc']],
    pageLength: 25,
    lengthMenu: [10, 25, 50, 100, 200],
    language: Object.assign({}, DT_LANGUAGE, { emptyTable: '— ยังไม่มีผู้มาใช้สิทธิ์ —' }),
  });
}

async function loadLogs() {
  const data = await api(`/admin/api/elections/${selectedId}/logs`);
  if (!data.logs) return;

  document.getElementById('stat-total-voters').textContent = fmt(data.total);
  document.getElementById('logs-total-badge').textContent = `รวม ${fmt(data.total)} คน`;
  const e = currentElection();
  document.getElementById('stat-turnout').textContent =
    e && e.eligible_count ? `— ${((data.total / e.eligible_count) * 100).toFixed(1)}%` : '';

  if (!logsTable) initLogsTable();

  // ใส่ลำดับให้แถวตามที่เซิร์ฟเวอร์เรียงมา (ใหม่สุดได้เลขมากสุด)
  const rows = data.logs.map((log, i) => Object.assign({ seq: data.total - i }, log));

  // draw(false) = คงหน้าที่เปิดอยู่และคำค้นหาเดิมไว้ ไม่กระโดดกลับหน้าแรก
  logsTable.clear().rows.add(rows).draw(false);
}

/* ------------------------------------------------------------------ */
/*  ผลคะแนนสด (ตาราง + Block Meters)                                    */
/* ------------------------------------------------------------------ */
async function loadResults() {
  const data = await api(`/admin/api/elections/${selectedId}/results`);
  if (!data.results) return;

  document.getElementById('stat-total-votes').textContent = fmt(data.totalVotes);
  document.getElementById('stat-eligible').textContent = data.election.eligible_count
    ? fmt(data.election.eligible_count)
    : '—';

  // ซ่อนผลระหว่างเปิดลงคะแนน — แสดงเฉพาะจำนวนบัตรรวม
  document.getElementById('results-hidden-note').style.display = data.hidden ? '' : 'none';
  document.getElementById('hidden-total-votes').textContent = fmt(data.totalVotes);
  document.getElementById('export-results').style.display = data.hidden ? 'none' : '';
  const tbody = document.getElementById('results-table-body');
  const meters = document.getElementById('results-meters');
  if (data.hidden) {
    tbody.innerHTML = data.results
      .map((r) => `
      <tr>
        <td class="text-center" style="font-size:1.3rem; font-weight:bold; background:#ffd500;">${r.candidate_no}</td>
        <td style="font-weight:bold;">${escapeHtml(r.candidate_name)}</td>
        <td class="text-center" style="font-size:1.3rem;">🔒</td>
        <td class="text-center">🔒</td>
      </tr>`)
      .join('');
    meters.innerHTML = '';
    return;
  }

  // ตารางสรุปคะแนน
  tbody.innerHTML = data.results.length
    ? data.results
        .map((r) => {
          const pct = data.totalVotes > 0 ? ((r.vote_count / data.totalVotes) * 100).toFixed(1) : '0.0';
          return `
      <tr>
        <td class="text-center" style="font-size:1.3rem; font-weight:bold; background:#ffd500;">${r.candidate_no}</td>
        <td style="font-weight:bold;">${escapeHtml(r.candidate_name)}</td>
        <td class="text-center" style="font-size:1.3rem; font-weight:bold;">${fmt(r.vote_count)}</td>
        <td class="text-center" style="font-weight:bold;">${pct}%</td>
      </tr>`;
        })
        .join('')
    : '<tr><td colspan="4" class="text-center">— ยังไม่มีผู้สมัคร —</td></tr>';

  // แถบมิเตอร์แบบบล็อก
  meters.innerHTML = data.results
    .map((r, idx) => {
      const ratio = data.totalVotes > 0 ? r.vote_count / data.totalVotes : 0;
      const onBlocks = r.vote_count > 0 ? Math.max(1, Math.round(ratio * METER_BLOCKS)) : 0;
      const colorClass = METER_COLORS[idx % METER_COLORS.length];

      let blocks = '';
      for (let i = 0; i < METER_BLOCKS; i++) {
        blocks += `<div class="blk${i < onBlocks ? ' on' : ''}"></div>`;
      }

      return `
      <div class="result-row">
        <div class="result-no">${r.candidate_no}</div>
        <div class="block-meter ${colorClass}">${blocks}</div>
        <div class="result-count">${fmt(r.vote_count)} เสียง</div>
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/*  จัดการผู้สมัคร (CRUD)                                                */
/* ------------------------------------------------------------------ */
const formBox = document.getElementById('candidate-form-box');
const formEl = document.getElementById('candidate-form');
const formTitle = document.getElementById('candidate-form-title');
const formError = document.getElementById('candidate-form-error');
const noInput = document.getElementById('candidate-no-input');
const nameInput = document.getElementById('candidate-name-input');
const descInput = document.getElementById('candidate-desc-input');
const photoInput = document.getElementById('candidate-photo-input');
const photoPreview = document.getElementById('candidate-photo-preview');

let editingNo = null;        // null = โหมดเพิ่มใหม่, ตัวเลข = โหมดแก้ไข
let candidatesCache = [];    // ข้อมูลล่าสุดจากเซิร์ฟเวอร์ (ใช้เติมฟอร์มตอนแก้ไข)
let croppedPhotoBlob = null; // รูปที่ครอบตัด/ย่อ-ขยายแล้ว รอส่งขึ้นเซิร์ฟเวอร์ (null = ไม่เปลี่ยนรูป)
let pendingDeleteNo = null;  // หมายเลขที่กำลังรอยืนยันลบ (กดซ้ำเพื่อยืนยัน)
let pendingDeleteTimer = null;

function isFormOpen() {
  return formBox.style.display !== 'none';
}

async function loadCandidates() {
  // ระหว่างเปิดฟอร์มหรือรอยืนยันลบ ไม่รีเฟรชตาราง เพื่อไม่ให้สถานะบนจอถูกล้าง
  if (isFormOpen() || pendingDeleteNo !== null) return;

  const data = await api(`/admin/api/elections/${selectedId}/candidates`);
  candidatesCache = data.candidates || [];

  const tbody = document.getElementById('candidates-table-body');
  if (candidatesCache.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" class="text-center">— ยังไม่มีผู้สมัคร กดปุ่ม "เพิ่มผู้สมัคร" เพื่อเริ่มต้น —</td></tr>';
    return;
  }

  tbody.innerHTML = candidatesCache
    .map(
      (c) => `
      <tr>
        <td class="text-center"><img src="${escapeHtml(c.photo_url || '/img/novote.svg')}" alt=""
            style="width:56px; height:56px; object-fit:cover; border:3px solid #000; background:#55ffff;"></td>
        <td class="text-center" style="font-size:1.3rem; font-weight:bold; background:#ffd500;">${c.candidate_no}</td>
        <td style="font-weight:bold;">${escapeHtml(c.candidate_name)}</td>
        <td style="font-size:0.95rem;">${escapeHtml(c.description || '—')}</td>
        <td class="text-center" style="font-weight:bold;">${c.vote_count === null ? '🔒' : fmt(c.vote_count)}</td>
        <td class="text-center admin-only">
          <button class="btn btn-blue btn-edit-candidate" data-no="${c.candidate_no}" style="font-size:0.9rem; padding:8px 14px;">✏ แก้ไข</button>
          <button class="btn btn-red btn-delete-candidate" data-no="${c.candidate_no}" style="font-size:0.9rem; padding:8px 14px;">🗑 ลบ</button>
        </td>
      </tr>`
    )
    .join('');

  tbody.querySelectorAll('.btn-edit-candidate').forEach((btn) => {
    btn.addEventListener('click', () => openEditForm(parseInt(btn.dataset.no, 10)));
  });
  tbody.querySelectorAll('.btn-delete-candidate').forEach((btn) => {
    btn.addEventListener('click', () => deleteCandidate(parseInt(btn.dataset.no, 10), btn));
  });
}

function showFormError(msg) {
  formError.textContent = msg;
  formError.style.display = msg ? 'block' : 'none';
}

function openAddForm() {
  editingNo = null;
  croppedPhotoBlob = null;
  formTitle.textContent = 'เพิ่มผู้สมัครใหม่';
  formEl.reset();
  noInput.disabled = false;
  photoPreview.src = '/img/novote.svg';
  showFormError('');
  formBox.style.display = 'block';
  formBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  noInput.focus();
}

function openEditForm(no) {
  const c = candidatesCache.find((x) => x.candidate_no === no);
  if (!c) return;
  editingNo = no;
  croppedPhotoBlob = null;
  formTitle.textContent = `แก้ไขผู้สมัครหมายเลข ${no}`;
  formEl.reset();
  noInput.value = c.candidate_no;
  noInput.disabled = true; // หมายเลขเป็นคีย์ของผู้สมัครในกิจกรรม — แก้ไม่ได้ (ลบแล้วเพิ่มใหม่แทน)
  nameInput.value = c.candidate_name;
  descInput.value = c.description || '';
  photoPreview.src = c.photo_url || '/img/novote.svg';
  showFormError('');
  formBox.style.display = 'block';
  formBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  nameInput.focus();
}

function closeCandidateForm(reload = true) {
  formBox.style.display = 'none';
  editingNo = null;
  if (reload) loadCandidates();
}

// เลือกรูป → เปิดหน้าต่างครอบตัด/ย่อ-ขยาย แล้วเก็บผลเป็น Blob รอส่งขึ้นเซิร์ฟเวอร์
photoInput.addEventListener('change', async () => {
  const file = photoInput.files && photoInput.files[0];
  // เคลียร์ค่า input ทันที เพื่อให้เลือกไฟล์เดิมซ้ำแล้วยัง trigger change ได้ (เราถือรูปไว้เองใน Blob)
  photoInput.value = '';
  if (!file) return;

  try {
    const blob = await openImageCropper(file);
    if (!blob) return; // ผู้ใช้กดยกเลิก — คงรูปเดิมไว้
    croppedPhotoBlob = blob;
    if (photoPreview.dataset.objUrl) URL.revokeObjectURL(photoPreview.dataset.objUrl);
    const objUrl = URL.createObjectURL(blob);
    photoPreview.dataset.objUrl = objUrl;
    photoPreview.src = objUrl;
  } catch (err) {
    showFormError('เปิดรูปภาพนี้ไม่ได้ — กรุณาเลือกไฟล์รูปอื่น (PNG / JPG / WebP)');
  }
});

formEl.addEventListener('submit', async (e) => {
  e.preventDefault();
  showFormError('');

  const saveBtn = document.getElementById('candidate-save-btn');
  saveBtn.disabled = true;

  const fd = new FormData();
  fd.append('candidate_no', noInput.value);
  fd.append('candidate_name', nameInput.value);
  fd.append('description', descInput.value);
  // ส่งเฉพาะรูปที่ครอบตัด/ย่อ-ขยายแล้ว (ถ้าไม่ได้เลือกรูปใหม่ จะไม่แนบ — ฝั่งแก้ไขจะคงรูปเดิม)
  if (croppedPhotoBlob) fd.append('photo', croppedPhotoBlob, 'candidate.jpg');

  try {
    const base = `/admin/api/elections/${selectedId}/candidates`;
    const url = editingNo === null ? base : `${base}/${editingNo}`;
    const data = await api(url, { method: editingNo === null ? 'POST' : 'PUT', body: fd });

    if (data.ok) {
      closeCandidateForm();
      await refreshAll();
    } else {
      showFormError(data.error || 'บันทึกไม่สำเร็จ');
    }
  } catch (err) {
    showFormError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  } finally {
    saveBtn.disabled = false;
  }
});

// ลบแบบยืนยัน 2 จังหวะ: กดครั้งแรกปุ่มเปลี่ยนเป็น "ยืนยันลบ?" กดซ้ำภายใน 4 วิ จึงลบจริง
async function deleteCandidate(no, btn) {
  if (pendingDeleteNo !== no) {
    clearTimeout(pendingDeleteTimer);
    pendingDeleteNo = no;
    btn.textContent = '⚠ ยืนยันลบ?';
    pendingDeleteTimer = setTimeout(() => {
      pendingDeleteNo = null;
      btn.textContent = '🗑 ลบ';
    }, 4000);
    return;
  }

  clearTimeout(pendingDeleteTimer);
  pendingDeleteNo = null;

  try {
    const data = await api(`/admin/api/elections/${selectedId}/candidates/${no}`, { method: 'DELETE' });
    if (!data.ok) alert(data.error || 'ลบไม่สำเร็จ');
  } catch (e) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  }
  await refreshAll();
}

document.getElementById('btn-add-candidate').addEventListener('click', openAddForm);
document.getElementById('candidate-cancel-btn').addEventListener('click', () => closeCandidateForm());
document.getElementById('candidate-form-close').addEventListener('click', () => closeCandidateForm());

/* ------------------------------------------------------------------ */
/*  บัญชีรายชื่อผู้มีสิทธิ์เลือกตั้ง                                        */
/* ------------------------------------------------------------------ */
function initVotersTable() {
  votersTable = new DataTable('#voters-table', {
    data: [],
    columns: [
      { data: 'seq', className: 'dt-center' },
      { data: 'citizen_id', className: 'dt-left', render: renderCid },
      {
        data: null,
        render: (d, type, r) => {
          const name = `${r.prefix}${r.first_name} ${r.last_name}`.trim();
          return type === 'display' ? escapeHtml(name) : name;
        },
      },
      { data: 'group_name', render: (d, type) => (type === 'display' ? escapeHtml(d || '—') : d) },
      {
        data: 'voted_at',
        className: 'dt-left',
        render: (d, type) => {
          if (type === 'sort' || type === 'type') return d ? thaiDateSortKey(d) : 0;
          if (type === 'filter') return d ? 'voted มาใช้สิทธิ์แล้ว' : 'not ยังไม่มาใช้สิทธิ์';
          return d
            ? `<span class="sc-badge sc-ok">✔ ใช้สิทธิ์แล้ว</span> <small>${escapeHtml(d.slice(11, 16))} น.</small>`
            : '<span class="sc-badge">ยังไม่มาใช้สิทธิ์</span>';
        },
      },
      {
        data: 'id',
        orderable: false,
        className: 'text-center',
        render: (d, type, r) =>
          type === 'display'
            ? r.voted_at || !isAdmin()
              ? '—'
              : `<button class="btn btn-mini btn-delete-voter" data-id="${d}" title="ลบออกจากบัญชีรายชื่อ">🗑</button>`
            : d,
      },
    ],
    order: [[0, 'asc']],
    pageLength: 25,
    lengthMenu: [10, 25, 50, 100, 500],
    language: Object.assign({}, DT_LANGUAGE, { emptyTable: '— ยังไม่มีบัญชีรายชื่อ กด "Import รายชื่อ" เพื่อเริ่มต้น —' }),
  });

  // กรองตามสถานะการใช้สิทธิ์
  document.getElementById('voters-filter').addEventListener('change', (ev) => {
    const v = ev.target.value;
    votersTable.column(4).search(v ? `^${v} ` : '', true, false).draw();
  });

  document.getElementById('voters-table').addEventListener('click', async (ev) => {
    const btn = ev.target.closest('.btn-delete-voter');
    if (!btn) return;
    const row = votersTable.row(btn.closest('tr')).data();
    if (!confirm(`ลบ ${row.prefix}${row.first_name} ${row.last_name} ออกจากบัญชีรายชื่อ?`)) return;
    const data = await api(`/admin/api/elections/${selectedId}/voters/${row.id}`, { method: 'DELETE' });
    if (!data.ok) alert(data.error || 'ลบไม่สำเร็จ');
    votersSignature = '';
    await refreshAll();
  });
}

async function loadVoters() {
  const data = await api(`/admin/api/elections/${selectedId}/voters`);
  if (!data.voters) return;
  const voters = data.voters;

  document.getElementById('voters-total-badge').textContent = `รวม ${fmt(voters.length)} คน`;

  // วาดตารางใหม่เฉพาะเมื่อข้อมูลเปลี่ยน (บัญชีอาจมีหลายพันแถว)
  const votedCount = voters.filter((v) => v.voted_at).length;
  const lastId = voters.length ? voters[voters.length - 1].id : 0;
  const signature = `${selectedId}:${voters.length}:${votedCount}:${lastId}`;
  if (!votersTable) initVotersTable();
  if (signature === votersSignature) return;
  votersSignature = signature;

  votersTable.clear().rows.add(voters.map((v, i) => Object.assign({ seq: i + 1 }, v))).draw(false);
}

// เปิด/ปิดกล่องย่อย (import / เพิ่มทีละคน / คัดลอก) — เปิดได้ทีละกล่อง
function toggleSubpanel(id) {
  document.querySelectorAll('#election-scope .subpanel').forEach((p) => {
    p.style.display = p.id === id && p.style.display === 'none' ? 'block' : 'none';
  });
}
document.getElementById('btn-open-import').addEventListener('click', () => toggleSubpanel('import-box'));
document.getElementById('btn-open-add-voter').addEventListener('click', () => toggleSubpanel('add-voter-box'));
document.getElementById('btn-open-copy').addEventListener('click', () => toggleSubpanel('copy-box'));
document.querySelectorAll('.subpanel-close').forEach((x) =>
  x.addEventListener('click', () => (x.closest('.subpanel').style.display = 'none'))
);

// อ่านไฟล์: ลอง UTF-8 ก่อน ถ้าไม่ใช่ (เช่น CSV จาก Excel ภาษาไทยรุ่นเก่า) ใช้ windows-874 (TIS-620)
document.getElementById('import-file-input').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  const buf = await file.arrayBuffer();
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch (e) {
    text = new TextDecoder('windows-874').decode(buf);
  }
  document.getElementById('import-text').value = text.replace(/^﻿/, '');
  document.getElementById('import-file-name').textContent = `${file.name} (${fmt(buf.byteLength)} ไบต์)`;
  resetImportPreview();
});

function importMode() {
  return document.querySelector('input[name="import-mode"]:checked').value;
}

function resetImportPreview() {
  document.getElementById('btn-import-confirm').style.display = 'none';
  document.getElementById('import-result').innerHTML = '';
}
document.getElementById('import-text').addEventListener('input', resetImportPreview);
document.querySelectorAll('input[name="import-mode"]').forEach((r) => r.addEventListener('change', resetImportPreview));

function renderImportErrors(errors, errorCount) {
  if (!errorCount) return '';
  return `
    <div class="import-errors">
      <b>⚠ ข้ามแถวที่ไม่ถูกต้อง ${fmt(errorCount)} แถว${errorCount > errors.length ? ` (แสดง ${errors.length} แถวแรก)` : ''}:</b>
      <ul>${errors.map((er) => `<li>แถวที่ ${er.line}: ${escapeHtml(er.message)} <small>— ${escapeHtml(er.raw)}</small></li>`).join('')}</ul>
    </div>`;
}

document.getElementById('btn-import-preview').addEventListener('click', async () => {
  const text = document.getElementById('import-text').value;
  const out = document.getElementById('import-result');
  if (!text.trim()) {
    out.innerHTML = '<div class="error-box">กรุณาวางข้อมูลหรือเลือกไฟล์ก่อน</div>';
    return;
  }
  const data = await postJson(`/admin/api/elections/${selectedId}/voters/import`, { text, mode: importMode(), dryRun: true });
  if (!data.ok) {
    out.innerHTML = `<div class="error-box">${escapeHtml(data.error || 'ตรวจสอบไม่สำเร็จ')}</div>`;
    return;
  }
  const sample = data.sample
    .map((v) => `<tr><td class="mono">${v.citizen_id}</td><td>${escapeHtml(v.prefix)}</td><td>${escapeHtml(v.first_name)}</td><td>${escapeHtml(v.last_name)}</td><td>${escapeHtml(v.group_name || '—')}</td></tr>`)
    .join('');
  const e = currentElection();
  out.innerHTML = `
    <div class="note-box">
      พบรายชื่อที่ถูกต้อง <b>${fmt(data.valid)}</b> คน
      ${importMode() === 'replace'
        ? `— จะ<b>ลบบัญชีเดิม ${fmt(e ? e.eligible_count : 0)} คน</b>แล้วแทนที่ด้วยรายชื่อนี้`
        : `— เพิ่มใหม่ ${fmt(data.valid - data.existing)} คน, อัปเดตรายชื่อเดิม ${fmt(data.existing)} คน`}
    </div>
    ${sample ? `<p style="font-weight:bold; margin:10px 0 6px;">ตัวอย่าง 5 แถวแรก (ตรวจว่าแยกคอลัมน์ถูกต้อง):</p>
    <table class="retro-table"><thead><tr><th>เลขบัตร</th><th>คำนำหน้า</th><th>ชื่อ</th><th>นามสกุล</th><th>กลุ่ม/ชั้น</th></tr></thead><tbody>${sample}</tbody></table>` : ''}
    ${renderImportErrors(data.errors, data.errorCount)}`;
  document.getElementById('btn-import-confirm').style.display = data.valid > 0 ? '' : 'none';
});

document.getElementById('btn-import-confirm').addEventListener('click', async () => {
  const btn = document.getElementById('btn-import-confirm');
  const out = document.getElementById('import-result');
  btn.disabled = true;
  try {
    const data = await postJson(`/admin/api/elections/${selectedId}/voters/import`, {
      text: document.getElementById('import-text').value,
      mode: importMode(),
    });
    if (!data.ok) {
      out.innerHTML = `<div class="error-box">${escapeHtml(data.error || 'Import ไม่สำเร็จ')}</div>`;
      return;
    }
    out.innerHTML = `
      <div class="note-box note-ok">✔ Import สำเร็จ — เพิ่มใหม่ ${fmt(data.added)} คน, อัปเดต ${fmt(data.updated)} คน
        (บัญชีรายชื่อรวม ${fmt(data.total)} คน)</div>
      ${renderImportErrors(data.errors, data.errorCount)}`;
    btn.style.display = 'none';
    document.getElementById('import-text').value = '';
    document.getElementById('import-file-name').textContent = '';
    votersSignature = '';
    await refreshAll();
  } finally {
    btn.disabled = false;
  }
});

// เพิ่มทีละคน
document.getElementById('btn-add-voter-save').addEventListener('click', async () => {
  const errBox = document.getElementById('add-voter-error');
  const body = {
    citizen_id: document.getElementById('av-cid').value,
    prefix: document.getElementById('av-prefix').value,
    first_name: document.getElementById('av-first').value,
    last_name: document.getElementById('av-last').value,
    group_name: document.getElementById('av-group').value,
  };
  const data = await postJson(`/admin/api/elections/${selectedId}/voters`, body);
  if (!data.ok) {
    errBox.textContent = data.error || 'เพิ่มไม่สำเร็จ';
    errBox.style.display = 'block';
    return;
  }
  errBox.style.display = 'none';
  document.getElementById('add-voter-form').reset();
  document.getElementById('av-cid').focus();
  votersSignature = '';
  await refreshAll();
});

// คัดลอกจากกิจกรรมอื่น
document.getElementById('btn-copy-voters').addEventListener('click', async () => {
  const from = parseInt(document.getElementById('copy-from-select').value, 10);
  const out = document.getElementById('copy-result');
  if (!from) return;
  const data = await postJson(`/admin/api/elections/${selectedId}/voters/copy`, { from_election_id: from });
  out.textContent = data.ok ? `✔ เพิ่มรายชื่อ ${fmt(data.added)} คน` : data.error || 'คัดลอกไม่สำเร็จ';
  votersSignature = '';
  await refreshAll();
});

/* ------------------------------------------------------------------ */
/*  ล้างข้อมูลของกิจกรรม (Danger Zone)                                    */
/*  กดครั้งแรกปุ่มเปลี่ยนเป็นยืนยัน ต้องกดซ้ำภายใน 5 วินาทีจึงล้างจริง       */
/* ------------------------------------------------------------------ */
const clearBtn = document.getElementById('btn-clear-data');
const clearResult = document.getElementById('clear-data-result');
const clearVotesCheck = document.getElementById('clear-votes-check');
const clearRegistryCheck = document.getElementById('clear-registry-check');
let clearArmed = false;
let clearArmTimer = null;

function disarmClearButton() {
  clearArmed = false;
  clearTimeout(clearArmTimer);
  clearBtn.textContent = '🧹 ล้างข้อมูลที่เลือก';
  clearBtn.classList.remove('blink');
}

function showClearResult(msg, isError) {
  clearResult.textContent = msg;
  clearResult.style.color = isError ? '#dd0000' : '#00aa00';
  setTimeout(() => { if (clearResult.textContent === msg) clearResult.textContent = ''; }, 8000);
}

// เปลี่ยนตัวเลือกระหว่างรอยืนยัน → ปลดการยืนยัน กันล้างผิดรายการ
[clearVotesCheck, clearRegistryCheck].forEach((cb) => cb.addEventListener('change', disarmClearButton));

clearBtn.addEventListener('click', async () => {
  const votes = clearVotesCheck.checked;
  const registry = clearRegistryCheck.checked;

  if (!votes && !registry) {
    showClearResult('กรุณาเลือกข้อมูลที่ต้องการล้างก่อน', true);
    return;
  }

  if (!clearArmed) {
    clearArmed = true;
    const e = currentElection();
    clearBtn.textContent = `⚠ กดอีกครั้งเพื่อยืนยันล้างข้อมูล "${e ? e.title : ''}"!`;
    clearBtn.classList.add('blink');
    clearArmTimer = setTimeout(disarmClearButton, 5000);
    return;
  }

  disarmClearButton();
  clearBtn.disabled = true;

  try {
    const data = await postJson(`/admin/api/elections/${selectedId}/clear-data`, { votes, registry });
    if (data.ok) {
      const parts = [];
      if (votes) parts.push(`ลบบันทึกผู้ใช้สิทธิ์ ${fmt(data.cleared.logs)} รายการและรีเซ็ตคะแนนเป็น 0`);
      if (registry) parts.push(`ลบบัญชีรายชื่อ ${fmt(data.cleared.registry)} คน`);
      showClearResult('✔ ล้างข้อมูลสำเร็จ — ' + parts.join(' และ '), false);
      clearVotesCheck.checked = false;
      clearRegistryCheck.checked = false;
      votersSignature = '';
      await refreshAll();
    } else {
      showClearResult(data.error || 'ล้างข้อมูลไม่สำเร็จ', true);
    }
  } catch (e) {
    showClearResult('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้', true);
  } finally {
    clearBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ */
/*  ตรวจสอบทรัพยากรที่ระบบต้องใช้                                        */
/*  เครื่องอ่านบัตร / ไลบรารีระบบปฏิบัติการ / เซิร์ฟเวอร์ ตรวจที่ฝั่งเซิร์ฟเวอร์ */
/*  ส่วนเบราว์เซอร์ตรวจจากหน้าเว็บนี้โดยตรง                                */
/* ------------------------------------------------------------------ */
const SYSCHECK_GROUPS = {
  reader: '💳 เครื่องอ่านบัตรประชาชน (CARD READER)',
  os: '🪟 ไลบรารีและทรัพยากรของระบบปฏิบัติการ (OS LIBRARIES)',
  server: '⚙ เซิร์ฟเวอร์และฐานข้อมูล (SERVER & DATABASE)',
  security: '🛡 ความปลอดภัยและการสำรองข้อมูล (SECURITY & BACKUP)',
  browser: '🌐 เบราว์เซอร์ที่ใช้งานอยู่ (BROWSER COMPATIBILITY)',
};

const SYSCHECK_STATUS = {
  ok: { label: '✔ ผ่าน', cls: 'sc-ok' },
  warn: { label: '⚠ ควรตรวจสอบ', cls: 'sc-warn' },
  fail: { label: '✖ ไม่ผ่าน', cls: 'sc-fail' },
};

// เบราว์เซอร์ขั้นต่ำที่ระบบรองรับ (เวอร์ชันหลัก)
const BROWSER_MIN_VERSION = { Chrome: 90, Edge: 90, Firefox: 90, Safari: 15, Opera: 76 };

function detectBrowser() {
  const ua = navigator.userAgent;
  const pick = (re) => {
    const m = ua.match(re);
    return m ? parseInt(m[1], 10) : null;
  };

  if (/Edg\//.test(ua)) return { name: 'Edge', version: pick(/Edg\/(\d+)/) };
  if (/OPR\//.test(ua)) return { name: 'Opera', version: pick(/OPR\/(\d+)/) };
  if (/Firefox\//.test(ua)) return { name: 'Firefox', version: pick(/Firefox\/(\d+)/) };
  if (/Chrome\//.test(ua)) return { name: 'Chrome', version: pick(/Chrome\/(\d+)/) };
  if (/Safari\//.test(ua) && /Version\//.test(ua)) return { name: 'Safari', version: pick(/Version\/(\d+)/) };
  if (/MSIE |Trident\//.test(ua)) return { name: 'Internet Explorer', version: pick(/(?:MSIE |rv:)(\d+)/) };
  return { name: 'ไม่ทราบชนิดเบราว์เซอร์', version: null };
}

// ตรวจความสามารถของเบราว์เซอร์ที่ระบบจำเป็นต้องใช้ (คืนอาร์เรย์รูปแบบเดียวกับฝั่งเซิร์ฟเวอร์)
function browserChecks() {
  const checks = [];
  const add = (name, status, value, hint) => checks.push({ group: 'browser', name, status, value, hint: hint || null });

  const b = detectBrowser();
  const min = BROWSER_MIN_VERSION[b.name];
  const versionText = b.version ? `เวอร์ชัน ${b.version}` : 'ไม่ทราบเวอร์ชัน';

  if (b.name === 'Internet Explorer') {
    add('ชนิดและเวอร์ชันเบราว์เซอร์', 'fail', `${b.name} ${versionText}`,
      'Internet Explorer ใช้กับระบบนี้ไม่ได้ — กรุณาใช้ Google Chrome หรือ Microsoft Edge');
  } else if (min && b.version && b.version >= min) {
    add('ชนิดและเวอร์ชันเบราว์เซอร์', 'ok', `${b.name} ${versionText} (รองรับตั้งแต่ ${min} ขึ้นไป)`);
  } else if (min && b.version) {
    add('ชนิดและเวอร์ชันเบราว์เซอร์', 'fail', `${b.name} ${versionText} — เก่ากว่าที่รองรับ`,
      `กรุณาอัปเดต ${b.name} เป็นเวอร์ชัน ${min} ขึ้นไป`);
  } else {
    add('ชนิดและเวอร์ชันเบราว์เซอร์', 'warn', `${b.name} ${versionText}`,
      'ระบบทดสอบกับ Chrome / Edge / Firefox / Safari รุ่นใหม่ — เบราว์เซอร์อื่นอาจแสดงผลไม่ครบ');
  }

  const features = [
    ['WebSocket (แจ้งเตือนสดจากเครื่องอ่านบัตร)', typeof WebSocket !== 'undefined', 'จำเป็นสำหรับส่งสถานะบัตรมายังหน้าคูหาแบบเรียลไทม์'],
    ['Fetch API (เรียกข้อมูลจากเซิร์ฟเวอร์)', typeof fetch === 'function', 'จำเป็นสำหรับโหลดผลคะแนนและรายชื่อผู้สมัคร'],
    ['Promise / async-await (JavaScript รุ่นใหม่)', typeof Promise === 'function', 'เบราว์เซอร์เก่าเกินไปสำหรับระบบนี้'],
    ['CSS Grid (การจัดวางหน้าจอ)', typeof CSS !== 'undefined' && CSS.supports && CSS.supports('display', 'grid'), 'หน้าจออาจแสดงผลผิดตำแหน่ง'],
    ['FileReader / Object URL (แสดงตัวอย่างรูปผู้สมัคร)', typeof FileReader === 'function' && typeof URL.createObjectURL === 'function', 'จะเลือกรูปผู้สมัครแล้วดูตัวอย่างไม่ได้'],
    ['Fullscreen API (โหมดคูหาเต็มจอ)', Boolean(document.documentElement.requestFullscreen), 'จะกดเต็มจอที่หน้าคูหาไม่ได้ (ใช้ปุ่ม F11 แทนได้)'],
  ];
  for (const [name, supported, hint] of features) {
    add(name, supported ? 'ok' : 'fail', supported ? 'รองรับ' : 'ไม่รองรับ', supported ? null : hint);
  }

  let storageOk = false;
  try {
    localStorage.setItem('__syscheck__', '1');
    localStorage.removeItem('__syscheck__');
    storageOk = true;
  } catch (e) {
    storageOk = false;
  }
  add('Local Storage (จำการตั้งค่าหน้าจอ)', storageOk ? 'ok' : 'warn',
    storageOk ? 'ใช้งานได้' : 'ถูกปิดกั้น',
    storageOk ? null : 'เบราว์เซอร์ปิดการเก็บข้อมูลในเครื่อง หรือกำลังใช้โหมดไม่ระบุตัวตน');

  const w = window.screen.width;
  const h = window.screen.height;
  const resOk = w >= 1024 && h >= 768;
  add('ความละเอียดหน้าจอ', resOk ? 'ok' : 'warn', `${w} × ${h} พิกเซล`,
    resOk ? null : 'แนะนำอย่างน้อย 1024 × 768 พิกเซลสำหรับหน้าคูหาลงคะแนน');

  add('การเชื่อมต่อกับเซิร์ฟเวอร์', navigator.onLine ? 'ok' : 'warn',
    navigator.onLine ? `ออนไลน์ — ${location.origin}` : 'เบราว์เซอร์รายงานว่าออฟไลน์');

  return checks;
}

function renderSystemCheck(checks) {
  const container = document.getElementById('syscheck-groups');
  const summaryEl = document.getElementById('syscheck-summary');

  const count = { ok: 0, warn: 0, fail: 0 };
  checks.forEach((c) => { count[c.status] = (count[c.status] || 0) + 1; });

  const verdict =
    count.fail > 0
      ? { text: '✖ ระบบยังไม่พร้อมใช้งาน — มีรายการที่ไม่ผ่าน', cls: 'sc-fail' }
      : count.warn > 0
      ? { text: '⚠ ระบบใช้งานได้ แต่มีรายการที่ควรตรวจสอบ', cls: 'sc-warn' }
      : { text: '✔ ระบบพร้อมใช้งานครบทุกรายการ', cls: 'sc-ok' };

  summaryEl.innerHTML = `
    <div class="syscheck-verdict ${verdict.cls}">${verdict.text}</div>
    <div class="syscheck-counts">
      <span class="sc-badge sc-ok">ผ่าน ${count.ok}</span>
      <span class="sc-badge sc-warn">ควรตรวจสอบ ${count.warn}</span>
      <span class="sc-badge sc-fail">ไม่ผ่าน ${count.fail}</span>
    </div>`;

  container.innerHTML = Object.keys(SYSCHECK_GROUPS)
    .map((key) => {
      const items = checks.filter((c) => c.group === key);
      if (items.length === 0) return '';

      const rows = items
        .map((c) => {
          const st = SYSCHECK_STATUS[c.status] || SYSCHECK_STATUS.warn;
          return `
          <tr>
            <td style="width:150px;" class="text-center"><span class="sc-badge ${st.cls}">${st.label}</span></td>
            <td style="font-weight:bold; width:32%;">${escapeHtml(c.name)}</td>
            <td>${escapeHtml(c.value)}${
              c.hint ? `<br><small style="font-weight:bold; color:#0000aa;">↳ ${escapeHtml(c.hint)}</small>` : ''
            }</td>
          </tr>`;
        })
        .join('');

      return `
      <div class="syscheck-group">
        <div class="syscheck-group-title">${SYSCHECK_GROUPS[key]}</div>
        <table class="retro-table"><tbody>${rows}</tbody></table>
      </div>`;
    })
    .join('');
}

async function loadSystemCheck() {
  const btn = document.getElementById('btn-system-check');
  btn.disabled = true;
  try {
    const res = await fetch('/admin/api/system-check');
    if (res.status === 401) return (location.href = '/admin/login');
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || 'ตรวจสอบระบบไม่สำเร็จ');

    renderSystemCheck(data.checks.concat(browserChecks()));
    document.getElementById('syscheck-updated').textContent = `ตรวจสอบเมื่อ: ${data.generatedAt}`;
  } catch (e) {
    // เซิร์ฟเวอร์ตอบไม่ได้ ก็ยังแสดงผลตรวจฝั่งเบราว์เซอร์ให้เห็นได้
    renderSystemCheck(
      [{ group: 'server', name: 'การตรวจสอบฝั่งเซิร์ฟเวอร์', status: 'fail', value: e.message, hint: 'ตรวจสอบว่าเซิร์ฟเวอร์ Node.js ยังทำงานอยู่' }]
        .concat(browserChecks())
    );
    document.getElementById('syscheck-updated').textContent = '';
  } finally {
    btn.disabled = false;
  }
}

document.getElementById('btn-system-check').addEventListener('click', loadSystemCheck);

/* ------------------------------------------------------------------ */
/*  รีเฟรชอัตโนมัติทุก 3 วินาที                                          */
/* ------------------------------------------------------------------ */
let refreshing = null; // Promise ของรอบที่กำลังโหลด
let refreshQueued = false;
async function refreshAll() {
  // มีรอบที่กำลังโหลดอยู่ → รอให้จบแล้วโหลดใหม่อีกครั้ง (ให้เห็นผลของการกดปุ่มทันที)
  if (refreshing) {
    refreshQueued = true;
    return refreshing;
  }
  refreshing = doRefresh();
  try {
    await refreshing;
  } finally {
    refreshing = null;
  }
  if (refreshQueued) {
    refreshQueued = false;
    await refreshAll();
  }
}

async function doRefresh() {
  try {
    await loadElections();
    if (selectedId) {
      await Promise.all([loadLogs(), loadResults(), loadCandidates(), loadVoters()]);
    }
    // แสดงเป็นเวลาไทยเสมอ ไม่ขึ้นกับเขตเวลาที่ตั้งไว้ในเครื่องที่เปิดหน้านี้
    document.getElementById('stat-updated').textContent =
      new Date().toLocaleTimeString('th-TH', { timeZone: 'Asia/Bangkok' });
  } catch (e) {
    console.error('รีเฟรชข้อมูลไม่สำเร็จ:', e);
  }
}

/* ------------------------------------------------------------------ */
/*  บัญชีของฉัน — เปลี่ยนรหัสผ่าน / ตั้ง PIN สำหรับกรอกเลขบัตรแทนที่คูหา       */
/* ------------------------------------------------------------------ */
const accountBox = document.getElementById('my-account-box');

function showFormMsg(el, msg, ok) {
  el.textContent = msg || '';
  el.className = `form-msg ${msg ? (ok ? 'form-msg-ok' : 'form-msg-err') : ''}`;
}

function openAccount() {
  accountBox.style.display = 'block';
  accountBox.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('pw-current').focus();
}
document.getElementById('btn-my-account').addEventListener('click', () =>
  accountBox.style.display === 'none' ? openAccount() : (accountBox.style.display = 'none')
);
document.getElementById('btn-fix-password').addEventListener('click', openAccount);
document.getElementById('my-account-close').addEventListener('click', () => (accountBox.style.display = 'none'));

document.getElementById('password-form').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = document.getElementById('password-msg');
  const next = document.getElementById('pw-new').value;
  if (next !== document.getElementById('pw-confirm').value) return showFormMsg(msg, 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน');
  const data = await postJson('/admin/api/me/password', { current: document.getElementById('pw-current').value, next });
  if (!data.ok) return showFormMsg(msg, data.error || 'เปลี่ยนรหัสผ่านไม่สำเร็จ');
  ev.target.reset();
  showFormMsg(msg, '✔ เปลี่ยนรหัสผ่านแล้ว (เครื่องอื่นที่ล็อกอินบัญชีนี้อยู่จะถูกออกจากระบบ)', true);
  await loadMe();
});

async function savePin(pin) {
  const msg = document.getElementById('pin-msg');
  const data = await postJson('/admin/api/me/pin', { pin, password: document.getElementById('pin-password').value });
  if (!data.ok) return showFormMsg(msg, data.error || 'บันทึก PIN ไม่สำเร็จ');
  document.getElementById('pin-form').reset();
  showFormMsg(msg, pin ? '✔ ตั้ง PIN แล้ว — ใช้ที่ปุ่ม "🔑 เจ้าหน้าที่" หน้าคูหา' : '✔ ยกเลิก PIN แล้ว', true);
  await loadMe();
}
document.getElementById('pin-form').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const pin = document.getElementById('pin-new').value;
  if (!/^\d{6}$/.test(pin)) return showFormMsg(document.getElementById('pin-msg'), 'PIN ต้องเป็นตัวเลข 6 หลัก');
  savePin(pin);
});
document.getElementById('btn-clear-pin').addEventListener('click', () => savePin(''));

/* ------------------------------------------------------------------ */
/*  บัญชีผู้ใช้ (เฉพาะผู้ดูแลระบบ)                                          */
/* ------------------------------------------------------------------ */
let usersCache = [];
let editingUserId = null;
const userFormBox = document.getElementById('user-form-box');
const userFormError = document.getElementById('user-form-error');

async function loadUsers() {
  const data = await api('/admin/api/users');
  usersCache = data.users || [];
  document.getElementById('users-table-body').innerHTML = usersCache
    .map((u) => `
      <tr>
        <td class="b">${escapeHtml(u.username)}${me && u.id === me.id ? ' <small>(คุณ)</small>' : ''}</td>
        <td>${escapeHtml(u.display_name || '—')}</td>
        <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : ''}">${u.role === 'admin' ? 'ผู้ดูแลระบบ' : 'เจ้าหน้าที่'}</span></td>
        <td class="text-center">${u.has_pin ? '✔' : '—'}</td>
        <td>${escapeHtml(u.last_login_at || 'ยังไม่เคย')}</td>
        <td>
          <button class="btn btn-mini" data-uact="edit" data-uid="${u.id}">✏ แก้ไข</button>
          ${me && u.id === me.id ? '' : `<button class="btn btn-mini btn-red" data-uact="delete" data-uid="${u.id}">🗑 ลบ</button>`}
        </td>
      </tr>`)
    .join('');
}

function openUserForm(user) {
  editingUserId = user ? user.id : null;
  document.getElementById('user-form-title').textContent = user ? `แก้ไขผู้ใช้: ${user.username}` : 'เพิ่มผู้ใช้';
  document.getElementById('uf-username').value = user ? user.username : '';
  document.getElementById('uf-username').disabled = Boolean(user);
  document.getElementById('uf-display').value = user ? user.display_name : '';
  document.getElementById('uf-role').value = user ? user.role : 'officer';
  document.getElementById('uf-password').value = '';
  document.getElementById('uf-password-label').textContent = user ? 'รีเซ็ตรหัสผ่าน (เว้นว่าง = ไม่เปลี่ยน)' : 'รหัสผ่าน (≥ 8 ตัว) *';
  document.getElementById('uf-clear-pin-row').style.display = user && user.has_pin ? '' : 'none';
  document.getElementById('uf-clear-pin').checked = false;
  userFormError.style.display = 'none';
  userFormBox.style.display = 'block';
}

document.getElementById('btn-add-user').addEventListener('click', () => openUserForm(null));
document.getElementById('user-form-close').addEventListener('click', () => (userFormBox.style.display = 'none'));
document.getElementById('users-table-body').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-uact]');
  if (!btn) return;
  const user = usersCache.find((u) => u.id === parseInt(btn.dataset.uid, 10));
  if (btn.dataset.uact === 'edit') return openUserForm(user);
  if (!confirm(`ลบบัญชีผู้ใช้ "${user.username}"?`)) return;
  const data = await api(`/admin/api/users/${user.id}`, { method: 'DELETE' });
  if (!data.ok) alert(data.error || 'ลบไม่สำเร็จ');
  await loadUsers();
});

document.getElementById('btn-save-user').addEventListener('click', async () => {
  const body = {
    username: document.getElementById('uf-username').value,
    display_name: document.getElementById('uf-display').value,
    role: document.getElementById('uf-role').value,
    password: document.getElementById('uf-password').value,
    clear_pin: document.getElementById('uf-clear-pin').checked,
  };
  const data = editingUserId
    ? await postJson(`/admin/api/users/${editingUserId}`, body, 'PUT')
    : await postJson('/admin/api/users', body);
  if (!data.ok) {
    userFormError.textContent = data.error || 'บันทึกไม่สำเร็จ';
    userFormError.style.display = 'block';
    return;
  }
  userFormBox.style.display = 'none';
  await Promise.all([loadUsers(), loadMe()]);
});

/* ------------------------------------------------------------------ */
/*  สำรอง / กู้คืนข้อมูล (เฉพาะผู้ดูแลระบบ)                                   */
/* ------------------------------------------------------------------ */
function fileSize(bytes) {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${(bytes / 1024).toFixed(1)} KB`;
}

function showBackupMsg(msg, ok) {
  const el = document.getElementById('backup-msg');
  el.textContent = msg;
  el.style.color = ok ? '#00aa00' : '#dd0000';
}

async function loadBackups() {
  const data = await api('/admin/api/backups');
  document.getElementById('backup-info').innerHTML =
    `${data.intervalHours > 0 ? `สำรองอัตโนมัติทุก <b>${data.intervalHours} ชั่วโมง</b>` : 'ปิดการสำรองตามรอบเวลา'}
     + ทุกครั้งที่ปิดลงคะแนน + ก่อนลบกิจกรรม/ล้างข้อมูล/กู้คืน — เก็บ ${data.keep} ไฟล์ล่าสุดที่ <code>${escapeHtml(data.dir)}</code><br>
     <b>แนะนำ:</b> ดาวน์โหลดไฟล์สำรองเก็บไว้นอกเซิร์ฟเวอร์ด้วย (เช่น หลังปิดลงคะแนนทุกครั้ง)
     ${data.lastError ? `<br><span style="color:#dd0000;">⚠ สำรองครั้งล่าสุดล้มเหลว: ${escapeHtml(data.lastError)}</span>` : ''}`;
  document.getElementById('backups-table-body').innerHTML = data.backups.length
    ? data.backups
        .map((b) => `
        <tr>
          <td class="mono" style="font-size:0.9rem;">${escapeHtml(b.name)}</td>
          <td>${fileSize(b.size)}</td>
          <td>${new Date(b.mtime).toLocaleString('th-TH')}</td>
          <td>
            <a class="btn btn-mini" href="/admin/api/backups/${encodeURIComponent(b.name)}">⬇ ดาวน์โหลด</a>
            <button class="btn btn-mini btn-red" data-restore="${escapeHtml(b.name)}">↺ กู้คืน</button>
          </td>
        </tr>`)
        .join('')
    : '<tr><td colspan="4" class="text-center">— ยังไม่มีไฟล์สำรอง —</td></tr>';
}

document.getElementById('btn-backup-now').addEventListener('click', async (ev) => {
  ev.target.disabled = true;
  showBackupMsg('กำลังสำรองข้อมูล...', true);
  const data = await postJson('/admin/api/backups', {});
  ev.target.disabled = false;
  showBackupMsg(data.ok ? `✔ สำรองแล้ว: ${data.name}` : data.error || 'สำรองไม่สำเร็จ', data.ok);
  await loadBackups();
});

document.getElementById('backups-table-body').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-restore]');
  if (!btn) return;
  const name = btn.dataset.restore;
  const typed = prompt(
    `กู้คืนข้อมูลจาก ${name}\n\nข้อมูลปัจจุบันทั้งหมด (กิจกรรม ผู้สมัคร บัญชีรายชื่อ ผลคะแนน ผู้ใช้) จะถูกแทนที่ด้วยข้อมูลในไฟล์นี้\n` +
      'ระบบจะสำรองข้อมูลปัจจุบันไว้ก่อนอัตโนมัติ\n\nพิมพ์ RESTORE เพื่อยืนยัน:'
  );
  if (typed === null) return;
  showBackupMsg('กำลังกู้คืน...', true);
  const data = await postJson(`/admin/api/backups/${encodeURIComponent(name)}/restore`, { confirm: typed.trim() });
  if (!data.ok) return showBackupMsg(data.error || 'กู้คืนไม่สำเร็จ', false);
  alert(`กู้คืนข้อมูลสำเร็จ\nข้อมูลก่อนกู้คืนถูกสำรองไว้ที่ ${data.safetyBackup}`);
  location.reload(); // บัญชีผู้ใช้อาจเปลี่ยนตามไฟล์สำรอง
});

document.getElementById('backup-upload-input').addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  ev.target.value = '';
  if (!file) return;
  showBackupMsg('กำลังอัปโหลด...', true);
  const data = await api('/admin/api/backups/upload', {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  });
  showBackupMsg(data.ok ? `✔ อัปโหลดแล้ว: ${data.name} — กด "กู้คืน" ที่ไฟล์นี้เพื่อใช้ข้อมูล` : data.error || 'อัปโหลดไม่สำเร็จ', data.ok);
  await loadBackups();
});

/* ------------------------------------------------------------------ */
/*  บันทึกการใช้งานระบบ (เฉพาะผู้ดูแลระบบ)                                   */
/* ------------------------------------------------------------------ */
const AUDIT_LABEL = {
  login: '🔓 เข้าสู่ระบบ',
  logout: 'ออกจากระบบ',
  'login-failed': '⚠ เข้าระบบไม่สำเร็จ',
  'login-locked': '⛔ ล็อกการเข้าระบบ',
  'password-change': '🔒 เปลี่ยนรหัสผ่าน',
  'pin-set': '🔑 ตั้ง PIN คูหา',
  'pin-clear': 'ยกเลิก PIN คูหา',
  'user-create': '👤 เพิ่มผู้ใช้',
  'user-update': '👤 แก้ไขผู้ใช้',
  'user-delete': '👤 ลบผู้ใช้',
  'election-create': '🗓 สร้างกิจกรรม',
  'election-update': '🗓 แก้ไขกิจกรรม',
  'election-status': '▶ เปลี่ยนสถานะกิจกรรม',
  'election-delete': '🗑 ลบกิจกรรม',
  'schedule-failed': '⚠ ตั้งเวลาเปิดไม่สำเร็จ',
  'schedule-skipped': '⚠ ข้ามการเปิดตามเวลา',
  'candidate-add': 'เพิ่มผู้สมัคร',
  'candidate-update': 'แก้ไขผู้สมัคร',
  'candidate-delete': 'ลบผู้สมัคร',
  'voters-import': '📥 Import รายชื่อ',
  'voters-copy': 'คัดลอกบัญชีรายชื่อ',
  'voter-add': 'เพิ่มผู้มีสิทธิ์',
  'voter-delete': 'ลบผู้มีสิทธิ์',
  'clear-data': '🧹 ล้างข้อมูล',
  export: '⬇ ดาวน์โหลดข้อมูล',
  'officer-entry': '🔑 กรอกเลขบัตรแทน',
  'officer-pin-failed': '⚠ PIN คูหาผิด',
  'backup-create': '💾 สำรองข้อมูล',
  'backup-failed': '⚠ สำรองข้อมูลล้มเหลว',
  'backup-download': '⬇ ดาวน์โหลดไฟล์สำรอง',
  'backup-upload': '📤 อัปโหลดไฟล์สำรอง',
  'backup-restore': '↺ กู้คืนข้อมูล',
  'backup-restore-failed': '⚠ กู้คืนไม่สำเร็จ',
};
const AUDIT_WARN = /failed|locked|delete|clear|restore|skipped/;
let auditTable = null;

async function loadAudit() {
  const data = await api('/admin/api/audit?limit=2000');
  const rows = data.logs || [];
  if (!auditTable) {
    auditTable = new DataTable('#audit-table', {
      data: [],
      columns: [
        {
          data: 'created_at',
          className: 'dt-left',
          render: (d, type) => (type === 'sort' || type === 'type' ? thaiDateSortKey(d) : escapeHtml(d)),
        },
        { data: 'username', render: (d, type) => (type === 'display' ? escapeHtml(d) : d) },
        {
          data: 'action',
          render: (d, type) => {
            const label = AUDIT_LABEL[d] || d;
            if (type !== 'display') return `${label} ${d}`;
            return AUDIT_WARN.test(d) ? `<span class="sc-badge sc-warn">${escapeHtml(label)}</span>` : escapeHtml(label);
          },
        },
        {
          data: 'detail',
          render: (d, type, r) => {
            // บอกกิจกรรมไว้หน้าข้อความ (ถ้ารายละเอียดยังไม่มีชื่อกิจกรรม / กิจกรรมถูกลบไปแล้วใช้ #id)
            const tag = r.election_title
              ? (d || '').includes(r.election_title) ? '' : `[${r.election_title}] `
              : r.election_id ? `[#${r.election_id}] ` : '';
            const text = `${tag}${d || ''}`;
            return type === 'display' ? escapeHtml(text) : text;
          },
        },
        { data: 'ip', render: (d, type) => (type === 'display' ? `<small class="mono">${escapeHtml(d)}</small>` : d) },
      ],
      order: [[0, 'desc']],
      pageLength: 25,
      lengthMenu: [25, 50, 100, 500],
      language: Object.assign({}, DT_LANGUAGE, { searchPlaceholder: 'ผู้ใช้ / การกระทำ / รายละเอียด', emptyTable: '— ยังไม่มีบันทึก —' }),
    });
  }
  auditTable.clear().rows.add(rows).draw(false);
}
document.getElementById('btn-reload-audit').addEventListener('click', loadAudit);

/* ------------------------------------------------------------------ */
/*  เริ่มต้น                                                             */
/* ------------------------------------------------------------------ */
(async () => {
  try {
    await loadMe();
  } catch (e) {
    return;
  }
  refreshAll();
  setInterval(refreshAll, 3000);

  if (isAdmin()) {
    loadUsers();
    loadBackups();
    loadAudit();
    // ตรวจทรัพยากรระบบครั้งแรกตอนเปิดหน้า (หลังจากนั้นกดปุ่มตรวจซ้ำเอง — ไม่รีเฟรชอัตโนมัติ)
    loadSystemCheck();
  }
})();
