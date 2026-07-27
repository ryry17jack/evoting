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
/*  ส่วนที่ 1: บันทึกกิจกรรมนักศึกษา (แสดงผลด้วย DataTables)              */
/*  ค้นหา / เรียงลำดับ / แบ่งหน้าได้ และคงสถานะไว้ระหว่างรีเฟรชทุก 3 วินาที */
/* ------------------------------------------------------------------ */
let logsTable = null;

// แปลงวันที่รูปแบบ dd/mm/yyyy hh:mm:ss เป็นตัวเลขเพื่อให้ DataTables เรียงลำดับถูกต้อง
function thaiDateSortKey(str) {
  const m = String(str || '').match(/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  return m ? Number(`${m[3]}${m[2]}${m[1]}${m[4]}${m[5]}${m[6]}`) : 0;
}

function initLogsTable() {
  logsTable = new DataTable('#logs-table', {
    data: [],
    columns: [
      { data: 'seq', className: 'text-center', width: '70px' },
      {
        data: 'citizen_id',
        width: '220px',
        render: (d, type) =>
          type === 'display'
            ? `<span style="font-family:monospace; font-size:1.05rem; font-weight:bold;">${escapeHtml(d)}</span>`
            : d,
      },
      { data: 'full_name', render: (d, type) => (type === 'display' ? escapeHtml(d) : d) },
      {
        data: 'voted_at',
        width: '220px',
        // เรียงตามเวลาจริง ไม่ใช่เรียงตามตัวอักษรของข้อความ
        render: (d, type) => (type === 'sort' || type === 'type' ? thaiDateSortKey(d) : escapeHtml(d)),
      },
    ],
    order: [[0, 'desc']],
    pageLength: 25,
    lengthMenu: [10, 25, 50, 100, 200],
    language: {
      search: 'ค้นหา:',
      searchPlaceholder: 'ชื่อ หรือ เลขบัตร',
      lengthMenu: 'แสดง _MENU_ รายการต่อหน้า',
      info: 'แสดง _START_ ถึง _END_ จากทั้งหมด _TOTAL_ รายการ',
      infoEmpty: 'ไม่มีรายการที่จะแสดง',
      infoFiltered: '(กรองจากทั้งหมด _MAX_ รายการ)',
      zeroRecords: '— ไม่พบรายการที่ค้นหา —',
      emptyTable: '— ยังไม่มีผู้มาใช้สิทธิ์ —',
      paginate: { first: '⏮ หน้าแรก', previous: '◄ ก่อนหน้า', next: 'ถัดไป ►', last: 'หน้าสุดท้าย ⏭' },
    },
  });
}

async function loadLogs() {
  const res = await fetch('/admin/api/logs');
  if (res.status === 401) return (location.href = '/admin/login');
  const data = await res.json();

  document.getElementById('admin-username').textContent = data.username || 'admin';
  document.getElementById('stat-total-voters').textContent = data.total.toLocaleString('th-TH');
  document.getElementById('logs-total-badge').textContent = `รวม ${data.total.toLocaleString('th-TH')} คน`;

  if (!logsTable) initLogsTable();

  // ใส่ลำดับให้แถวตามที่เซิร์ฟเวอร์เรียงมา (ใหม่สุดได้เลขมากสุด)
  const rows = data.logs.map((log, i) => Object.assign({ seq: data.total - i }, log));

  // draw(false) = คงหน้าที่เปิดอยู่และคำค้นหาเดิมไว้ ไม่กระโดดกลับหน้าแรก
  logsTable.clear().rows.add(rows).draw(false);
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
let croppedPhotoBlob = null; // รูปที่ครอบตัด/ย่อ-ขยายแล้ว รอส่งขึ้นเซิร์ฟเวอร์ (null = ไม่เปลี่ยนรูป)
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
/*  ส่วนที่ 5: ตรวจสอบทรัพยากรที่ระบบต้องใช้                              */
/*  เครื่องอ่านบัตร / ไลบรารีระบบปฏิบัติการ / เซิร์ฟเวอร์ ตรวจที่ฝั่งเซิร์ฟเวอร์ */
/*  ส่วนเบราว์เซอร์ตรวจจากหน้าเว็บนี้โดยตรง                                */
/* ------------------------------------------------------------------ */
const SYSCHECK_GROUPS = {
  reader: '💳 เครื่องอ่านบัตรประชาชน (CARD READER)',
  os: '🪟 ไลบรารีและทรัพยากรของระบบปฏิบัติการ (OS LIBRARIES)',
  server: '⚙ เซิร์ฟเวอร์และฐานข้อมูล (SERVER & DATABASE)',
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

// ตรวจทรัพยากรระบบครั้งแรกตอนเปิดหน้า (หลังจากนั้นกดปุ่มตรวจซ้ำเอง — ไม่รีเฟรชอัตโนมัติ)
loadSystemCheck();
