/**
 * =====================================================================
 *  แปลงข้อมูลรายชื่อผู้มีสิทธิ์เลือกตั้ง (CSV / วางจาก Excel) เป็นรายการ
 *  - รองรับตัวคั่น Tab (คัดลอกจาก Excel) / จุลภาค / อัฒภาค
 *  - มีแถวหัวตารางหรือไม่ก็ได้ (ถ้ามี จะจับคอลัมน์จากชื่อหัวตาราง)
 *  - ไม่มีหัวตาราง: คอลัมน์ที่เป็นตัวเลข 13 หลัก = เลขบัตร
 *    คอลัมน์ที่เหลือตามลำดับ = ชื่อ, นามสกุล, กลุ่ม/ชั้น/แผนก
 *  - ตรวจเลขบัตรประชาชนด้วยหลักตรวจสอบ (check digit)
 * =====================================================================
 */

// คำนำหน้าชื่อที่พบบ่อย (เรียงจากยาวไปสั้น เพื่อจับ "นางสาว" ก่อน "นาง")
const PREFIXES = [
  'ว่าที่ร้อยตรีหญิง', 'ว่าที่ร้อยตรี', 'เด็กหญิง', 'เด็กชาย', 'นางสาว', 'นาง', 'นาย',
  'ว่าที่ ร.ต.', 'ด.ญ.', 'ด.ช.', 'น.ส.', 'Miss', 'Mrs.', 'Mr.', 'Ms.',
];

// ตรวจหลักตรวจสอบของเลขประจำตัวประชาชนไทย 13 หลัก
function isValidCitizenId(id) {
  if (!/^\d{13}$/.test(id)) return false;
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += Number(id[i]) * (13 - i);
  return (11 - (sum % 11)) % 10 === Number(id[12]);
}

// ตัดขีด/ช่องว่างออกจากเลขบัตร (เช่น 1-2345-67890-12-3)
function normalizeCitizenId(value) {
  return String(value || '').replace(/[\s\-]/g, '');
}

function looksLikeCitizenId(value) {
  return /^\d{13}$/.test(normalizeCitizenId(value));
}

// แยกข้อความเป็นแถว/คอลัมน์ รองรับเครื่องหมายคำพูดแบบ CSV ("a,b" และ "" แทน ")
function parseDelimited(text) {
  const firstLine = text.split(/\r?\n/, 1)[0] || '';
  const delimiter = firstLine.includes('\t') ? '\t' : firstLine.includes(';') && !firstLine.includes(',') ? ';' : ',';

  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === delimiter) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }

  return rows
    .map((r) => r.map((c) => c.replace(/ /g, ' ').trim()))
    .filter((r) => r.some((c) => c !== ''));
}

// จับชนิดคอลัมน์จากข้อความหัวตาราง
function headerKind(label) {
  const s = String(label || '').toLowerCase().replace(/\s+/g, ' ').trim();
  if (!s) return null;
  if (/เลขประจำตัวประชาชน|เลขบัตร|บัตรประชาชน|citizen|national|^cid$|^id$|^id card/.test(s)) return 'cid';
  if (/คำนำหน้า|prefix|^title$/.test(s)) return 'prefix';
  if ((/ชื่อ/.test(s) && /สกุล/.test(s)) || /full ?name/.test(s)) return 'fullname';
  if (/นามสกุล|สกุล|last|surname|family/.test(s)) return 'last';
  if (/ชื่อ|first|^name$|given/.test(s)) return 'first';
  if (/กลุ่ม|ชั้น|แผนก|ห้อง|สาขา|หน่วย|ระดับ|group|class|dept|department|room|section/.test(s)) return 'group';
  return null;
}

// แยกคำนำหน้าออกจากชื่อ เช่น "นางสาวสมหญิง" → { prefix: "นางสาว", rest: "สมหญิง" }
function splitPrefix(name) {
  const trimmed = String(name || '').trim();
  for (const p of PREFIXES) {
    if (trimmed.startsWith(p) && trimmed.length > p.length) {
      return { prefix: p, rest: trimmed.slice(p.length).trim() };
    }
  }
  return { prefix: '', rest: trimmed };
}

// แยกชื่อเต็มเป็น คำนำหน้า / ชื่อ / นามสกุล (นามสกุล = คำสุดท้าย)
function splitFullName(full) {
  const { prefix, rest } = splitPrefix(full);
  const parts = rest.split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { prefix, first: parts[0] || '', last: '' };
  return { prefix, first: parts.slice(0, -1).join(' '), last: parts[parts.length - 1] };
}

/**
 * แปลงข้อความเป็นรายชื่อผู้มีสิทธิ์
 * คืนค่า { voters: [{citizen_id, prefix, first_name, last_name, group_name}], errors: [{line, message, raw}] }
 */
function parseVoterList(text) {
  const rows = parseDelimited(String(text || '').replace(/^﻿/, ''));
  const voters = [];
  const errors = [];
  const seen = new Set();

  if (rows.length === 0) return { voters, errors };

  // แถวแรกเป็นหัวตาราง ถ้าไม่มีช่องไหนเป็นเลขบัตรและจับชนิดคอลัมน์ได้อย่างน้อย 1 ช่อง
  let columns = null;
  let startIndex = 0;
  const first = rows[0];
  if (!first.some(looksLikeCitizenId)) {
    const kinds = first.map(headerKind);
    if (kinds.includes('cid')) {
      columns = kinds;
      startIndex = 1;
    } else if (kinds.some(Boolean)) {
      // มีหัวตารางแต่ไม่มีคอลัมน์เลขบัตรที่อ่านออก → ข้ามแถวหัวไป แล้วเดาคอลัมน์เอง
      startIndex = 1;
    }
  }

  for (let i = startIndex; i < rows.length; i++) {
    const cells = rows[i];
    const line = i + 1;
    const raw = cells.join(' | ');
    let rec = { cid: '', prefix: '', first: '', last: '', fullname: '', group: '' };

    if (columns) {
      columns.forEach((kind, idx) => {
        if (kind && cells[idx] !== undefined && !rec[kind]) rec[kind] = cells[idx];
      });
    } else {
      // ไม่มีหัวตาราง: หาช่องที่เป็นเลข 13 หลัก ช่องที่เหลือ (ยกเว้นเลขลำดับ) = ชื่อ, นามสกุล, กลุ่ม
      const cidIdx = cells.findIndex(looksLikeCitizenId);
      if (cidIdx >= 0) rec.cid = cells[cidIdx];
      const others = cells.filter((c, idx) => idx !== cidIdx && c !== '' && !/^\d{1,6}\.?$/.test(c));
      if (others[0] && /\s/.test(splitPrefix(others[0]).rest)) {
        // ชื่อจริงภาษาไทยไม่มีช่องว่าง — ช่องแรกที่มีช่องว่างคือ "ชื่อ นามสกุล" ในช่องเดียว
        [rec.fullname, rec.group] = [others[0], others[1] || ''];
      } else {
        [rec.first, rec.last, rec.group] = [others[0] || '', others[1] || '', others[2] || ''];
      }
    }

    const citizenId = normalizeCitizenId(rec.cid);
    if (!/^\d{13}$/.test(citizenId)) {
      errors.push({ line, message: 'ไม่พบเลขบัตรประชาชน 13 หลัก', raw });
      continue;
    }
    if (!isValidCitizenId(citizenId)) {
      errors.push({ line, message: `เลขบัตร ${citizenId} ไม่ถูกต้อง (หลักตรวจสอบไม่ตรง — อาจพิมพ์ผิด)`, raw });
      continue;
    }

    // ประกอบชื่อ: จากคอลัมน์ "ชื่อ-นามสกุล" หรือชื่อที่ไม่มีนามสกุลแยก → แยกคำสุดท้ายเป็นนามสกุล
    let prefix = rec.prefix.trim();
    let firstName = rec.first.trim();
    let lastName = rec.last.trim();
    if (rec.fullname && !firstName) {
      const s = splitFullName(rec.fullname);
      prefix = prefix || s.prefix;
      firstName = s.first;
      lastName = lastName || s.last;
    } else if (firstName && !lastName && /\s/.test(firstName)) {
      const s = splitFullName(firstName);
      prefix = prefix || s.prefix;
      firstName = s.first;
      lastName = s.last;
    } else if (!prefix && firstName) {
      const s = splitPrefix(firstName);
      prefix = s.prefix;
      firstName = s.rest;
    }

    if (!firstName) {
      errors.push({ line, message: 'ไม่มีชื่อผู้มีสิทธิ์', raw });
      continue;
    }
    if (seen.has(citizenId)) {
      errors.push({ line, message: `เลขบัตร ${citizenId} ซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน`, raw });
      continue;
    }
    seen.add(citizenId);

    voters.push({
      citizen_id: citizenId,
      prefix: prefix.slice(0, 50),
      first_name: firstName.slice(0, 150),
      last_name: lastName.slice(0, 150),
      group_name: rec.group.trim().slice(0, 150),
    });
  }

  return { voters, errors };
}

module.exports = { parseVoterList, isValidCitizenId, normalizeCitizenId, splitPrefix };
