/* =====================================================================
   PRINT-COMMON.JS — ตัวช่วยร่วมของหน้าพิมพ์เอกสาร
   ===================================================================== */

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

function fmt(n) {
  return Number(n || 0).toLocaleString('th-TH');
}

function pct(part, whole) {
  return whole > 0 ? ((part / whole) * 100).toFixed(2) : '0.00';
}

// วันที่ YYYY-MM-DD → "วันอังคารที่ 29 กันยายน พ.ศ. 2569"
function thaiDateLong(ymd) {
  const m = String(ymd || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return '';
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  const weekday = d.toLocaleDateString('th-TH', { weekday: 'long' });
  const month = d.toLocaleDateString('th-TH', { month: 'long' });
  return `${weekday}ที่ ${d.getDate()} ${month} พ.ศ. ${d.getFullYear() + 543}`;
}

async function fetchJson(url) {
  const res = await fetch(url);
  if (res.status === 401) {
    location.href = '/admin/login';
    throw new Error('unauthorized');
  }
  const data = await res.json();
  if (data.ok === false) throw new Error(data.error || 'โหลดข้อมูลไม่สำเร็จ');
  return data;
}

// จำค่าตัวเลือกบนแถบเครื่องมือไว้ในเบราว์เซอร์ (เช่น ชื่อหน่วยงาน) — ใช้ไม่ได้ก็ไม่เป็นไร
function bindOption(id, key, onChange) {
  const el = document.getElementById(id);
  const prop = el.type === 'checkbox' ? 'checked' : 'value';
  try {
    const saved = localStorage.getItem(key);
    if (saved !== null) el[prop] = el.type === 'checkbox' ? saved === '1' : saved;
  } catch (e) {
    /* ignore */
  }
  el.addEventListener(el.type === 'text' ? 'input' : 'change', () => {
    try {
      localStorage.setItem(key, el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value);
    } catch (e) {
      /* ignore */
    }
    onChange();
  });
  return () => el[prop];
}

function showDocError(message) {
  document.getElementById('doc').innerHTML = `<div class="loading">⚠ ${escapeHtml(message)}</div>`;
}

document.getElementById('btn-print').addEventListener('click', () => window.print());
