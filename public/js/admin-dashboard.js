/* =====================================================================
   ADMIN-DASHBOARD.JS — ดึงข้อมูลบันทึกกิจกรรมและผลคะแนนสด (โพลทุก 3 วินาที)
   ===================================================================== */

const METER_BLOCKS = 25; // จำนวนบล็อกในแถบมิเตอร์
const METER_COLORS = ['', 'meter-yellow', 'meter-green', 'meter-red'];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

/* ------------------------------------------------------------------ */
/*  ส่วนที่ 1: บันทึกกิจกรรมนักศึกษา                                      */
/* ------------------------------------------------------------------ */
async function loadLogs() {
  const res = await fetch('/admin/api/logs');
  if (res.status === 401) return (location.href = '/admin/login');
  const data = await res.json();

  document.getElementById('admin-username').textContent = data.username || 'admin';
  document.getElementById('stat-total-voters').textContent = data.total.toLocaleString('th-TH');
  document.getElementById('logs-total-badge').textContent = `รวม ${data.total.toLocaleString('th-TH')} คน`;

  const tbody = document.getElementById('logs-table-body');
  if (data.logs.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" class="text-center">— ยังไม่มีผู้มาใช้สิทธิ์ —</td></tr>';
    return;
  }

  tbody.innerHTML = data.logs
    .map(
      (log, i) => `
      <tr>
        <td class="text-center">${data.total - i}</td>
        <td style="font-family:monospace; font-size:1.05rem; font-weight:bold;">${escapeHtml(log.citizen_id)}</td>
        <td>${escapeHtml(log.full_name)}</td>
        <td>${escapeHtml(log.voted_at)}</td>
      </tr>`
    )
    .join('');
}

/* ------------------------------------------------------------------ */
/*  ส่วนที่ 2: ผลคะแนนสด (ตาราง + Block Meters)                          */
/* ------------------------------------------------------------------ */
async function loadResults() {
  const res = await fetch('/admin/api/results');
  if (res.status === 401) return (location.href = '/admin/login');
  const data = await res.json();

  document.getElementById('stat-total-votes').textContent = data.totalVotes.toLocaleString('th-TH');

  // ตารางสรุปคะแนน
  const tbody = document.getElementById('results-table-body');
  tbody.innerHTML = data.results
    .map((r) => {
      const pct = data.totalVotes > 0 ? ((r.vote_count / data.totalVotes) * 100).toFixed(1) : '0.0';
      return `
      <tr>
        <td class="text-center" style="font-size:1.3rem; font-weight:bold; background:#ffd500;">${r.candidate_no}</td>
        <td style="font-weight:bold;">${escapeHtml(r.candidate_name)}</td>
        <td class="text-center" style="font-size:1.3rem; font-weight:bold;">${r.vote_count.toLocaleString('th-TH')}</td>
        <td class="text-center" style="font-weight:bold;">${pct}%</td>
      </tr>`;
    })
    .join('');

  // แถบมิเตอร์แบบบล็อก
  const meters = document.getElementById('results-meters');
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
        <div class="result-count">${r.vote_count.toLocaleString('th-TH')} เสียง</div>
      </div>`;
    })
    .join('');
}

/* ------------------------------------------------------------------ */
/*  ส่วนที่ 3: จัดการผู้สมัคร (CRUD)                                      */
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
let pendingDeleteNo = null;  // หมายเลขที่กำลังรอยืนยันลบ (กดซ้ำเพื่อยืนยัน)
let pendingDeleteTimer = null;

function isFormOpen() {
  return formBox.style.display !== 'none';
}

async function loadCandidates() {
  // ระหว่างเปิดฟอร์มหรือรอยืนยันลบ ไม่รีเฟรชตาราง เพื่อไม่ให้สถานะบนจอถูกล้าง
  if (isFormOpen() || pendingDeleteNo !== null) return;

  const res = await fetch('/admin/api/candidates');
  if (res.status === 401) return (location.href = '/admin/login');
  const data = await res.json();
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
        <td class="text-center" style="font-weight:bold;">${c.vote_count.toLocaleString('th-TH')}</td>
        <td class="text-center">
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
  formTitle.textContent = `แก้ไขผู้สมัครหมายเลข ${no}`;
  formEl.reset();
  noInput.value = c.candidate_no;
  noInput.disabled = true; // หมายเลขเป็น Primary Key — แก้ไม่ได้ (ลบแล้วเพิ่มใหม่แทน)
  nameInput.value = c.candidate_name;
  descInput.value = c.description || '';
  photoPreview.src = c.photo_url || '/img/novote.svg';
  showFormError('');
  formBox.style.display = 'block';
  formBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  nameInput.focus();
}

function closeForm() {
  formBox.style.display = 'none';
  editingNo = null;
  loadCandidates();
}

// แสดงตัวอย่างรูปที่เลือกทันที
photoInput.addEventListener('change', () => {
  const file = photoInput.files && photoInput.files[0];
  if (file) photoPreview.src = URL.createObjectURL(file);
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
  if (photoInput.files && photoInput.files[0]) fd.append('photo', photoInput.files[0]);

  try {
    const url = editingNo === null ? '/admin/api/candidates' : `/admin/api/candidates/${editingNo}`;
    const res = await fetch(url, { method: editingNo === null ? 'POST' : 'PUT', body: fd });
    if (res.status === 401) return (location.href = '/admin/login');
    const data = await res.json();

    if (data.ok) {
      closeForm();
      await Promise.all([loadCandidates(), loadResults()]);
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
    const res = await fetch(`/admin/api/candidates/${no}`, { method: 'DELETE' });
    if (res.status === 401) return (location.href = '/admin/login');
    const data = await res.json();
    if (!data.ok) alert(data.error || 'ลบไม่สำเร็จ');
  } catch (e) {
    alert('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้');
  }
  await Promise.all([loadCandidates(), loadResults()]);
}

document.getElementById('btn-add-candidate').addEventListener('click', openAddForm);
document.getElementById('candidate-cancel-btn').addEventListener('click', closeForm);
document.getElementById('candidate-form-close').addEventListener('click', closeForm);

/* ------------------------------------------------------------------ */
/*  ส่วนที่ 4: ล้างข้อมูลการเลือกตั้ง (Danger Zone)                        */
/*  กดครั้งแรกปุ่มเปลี่ยนเป็นยืนยัน ต้องกดซ้ำภายใน 5 วินาทีจึงล้างจริง       */
/* ------------------------------------------------------------------ */
const clearBtn = document.getElementById('btn-clear-data');
const clearResult = document.getElementById('clear-data-result');
const clearLogsCheck = document.getElementById('clear-logs-check');
const clearVotesCheck = document.getElementById('clear-votes-check');
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
[clearLogsCheck, clearVotesCheck].forEach((cb) => cb.addEventListener('change', disarmClearButton));

clearBtn.addEventListener('click', async () => {
  const logs = clearLogsCheck.checked;
  const votes = clearVotesCheck.checked;

  if (!logs && !votes) {
    showClearResult('กรุณาเลือกข้อมูลที่ต้องการล้างก่อน', true);
    return;
  }

  if (!clearArmed) {
    clearArmed = true;
    clearBtn.textContent = '⚠ กดอีกครั้งเพื่อยืนยันการล้างข้อมูล!';
    clearBtn.classList.add('blink');
    clearArmTimer = setTimeout(disarmClearButton, 5000);
    return;
  }

  disarmClearButton();
  clearBtn.disabled = true;

  try {
    const res = await fetch('/admin/api/clear-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ logs, votes }),
    });
    if (res.status === 401) return (location.href = '/admin/login');
    const data = await res.json();

    if (data.ok) {
      const parts = [];
      if (logs) parts.push(`ลบบันทึกผู้ใช้สิทธิ์ ${data.cleared.logs.toLocaleString('th-TH')} รายการ`);
      if (votes) parts.push('รีเซ็ตคะแนนทั้งหมดเป็น 0');
      showClearResult('✔ ล้างข้อมูลสำเร็จ — ' + parts.join(' และ '), false);
      clearLogsCheck.checked = false;
      clearVotesCheck.checked = false;
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
/*  รีเฟรชอัตโนมัติทุก 3 วินาที                                          */
/* ------------------------------------------------------------------ */
async function refreshAll() {
  try {
    await Promise.all([loadLogs(), loadResults(), loadCandidates()]);
    document.getElementById('stat-updated').textContent = new Date().toLocaleTimeString('th-TH');
  } catch (e) {
    console.error('รีเฟรชข้อมูลไม่สำเร็จ:', e);
  }
}

refreshAll();
setInterval(refreshAll, 3000);
