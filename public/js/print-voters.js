/* =====================================================================
   PRINT-VOTERS.JS — ประกาศรายชื่อผู้มีสิทธิ์เลือกตั้ง / บัญชีลงลายมือชื่อ
   - announce: สำหรับติดประกาศ (ค่าเริ่มต้นปิดเลขบัตรบางส่วน เพื่อคุ้มครองข้อมูลส่วนบุคคล)
   - checklist: สำหรับเจ้าหน้าที่ แสดงสถานะการมาใช้สิทธิ์จากระบบ + ช่องลงลายมือชื่อ
   ===================================================================== */

const params = new URLSearchParams(location.search);
const electionId = parseInt(params.get('id'), 10);
let payload = null;

const opt = {
  mode: bindOption('opt-mode', 'printVotersMode', render),
  cid: bindOption('opt-cid', 'printVotersCid', render),
  sort: bindOption('opt-sort', 'printVotersSort', render),
  group: bindOption('opt-group', 'printVotersGroup', render),
  pageBreak: bindOption('opt-pagebreak', 'printVotersPageBreak', render),
  org: bindOption('opt-org', 'printOrg', render),
};
// โหมดจาก URL (ปุ่มในแดชบอร์ด) มีผลเหนือค่าที่จำไว้
if (params.get('mode')) document.getElementById('opt-mode').value = params.get('mode');

function formatCid(cid, how) {
  if (how === 'full') return `${cid[0]}-${cid.slice(1, 5)}-${cid.slice(5, 10)}-${cid.slice(10, 12)}-${cid[12]}`;
  return `x-xxxx-xxxxx-${cid.slice(10, 12)}-${cid[12]}`;
}

function fullName(v) {
  return `${v.prefix}${v.first_name} ${v.last_name}`.trim();
}

function render() {
  if (!payload) return;
  const e = payload.election;
  const mode = opt.mode();
  const cidMode = opt.cid();
  const byGroup = opt.group();
  const checklist = mode === 'checklist';

  let voters = payload.voters.slice();
  if (opt.sort() === 'name') {
    voters.sort((a, b) => `${a.first_name} ${a.last_name}`.localeCompare(`${b.first_name} ${b.last_name}`, 'th'));
  }

  // แบ่งกลุ่ม (คงลำดับกลุ่มตามที่พบครั้งแรก หรือเรียงชื่อกลุ่มเมื่อเรียงตามชื่อ)
  const groups = new Map();
  for (const v of voters) {
    const key = byGroup ? v.group_name || 'ไม่ระบุกลุ่ม' : '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  let groupKeys = [...groups.keys()];
  if (byGroup && opt.sort() === 'name') groupKeys.sort((a, b) => a.localeCompare(b, 'th', { numeric: true }));

  const showCid = cidMode !== 'none';
  const showGroupCol = !byGroup && voters.some((v) => v.group_name);

  const head = `
    <tr>
      <th style="width:52px;">ลำดับ</th>
      <th>ชื่อ - นามสกุล</th>
      ${showCid ? '<th style="width:150px;">เลขประจำตัวประชาชน</th>' : ''}
      ${showGroupCol ? '<th style="width:110px;">กลุ่ม/ชั้น</th>' : ''}
      ${checklist ? '<th style="width:120px;">มาใช้สิทธิ์ (ระบบ)</th><th style="width:130px;">ลายมือชื่อ</th>' : '<th style="width:110px;">หมายเหตุ</th>'}
    </tr>`;

  const org = opt.org().trim();
  const header = `
    <div class="doc-header">
      ${org ? `<div class="doc-org">${escapeHtml(org)}</div>` : ''}
      <div class="doc-title">${checklist ? 'บัญชีรายชื่อผู้มีสิทธิ์เลือกตั้ง (สำหรับเจ้าหน้าที่)' : 'ประกาศรายชื่อผู้มีสิทธิ์เลือกตั้ง'}</div>
      <div class="doc-subtitle">${escapeHtml(e.title)}</div>
      <div class="doc-meta">${e.election_date ? thaiDateLong(e.election_date) : ''}</div>
    </div>
    ${checklist ? '' : `<div class="doc-note">ผู้มีสิทธิ์โปรดตรวจสอบรายชื่อ หากไม่พบรายชื่อหรือข้อมูลไม่ถูกต้อง กรุณาติดต่อเจ้าหน้าที่ก่อนวันเลือกตั้ง</div>`}`;

  let html = header;
  groupKeys.forEach((key, gi) => {
    const list = groups.get(key);
    const breakClass = byGroup && opt.pageBreak() && gi > 0 ? ' page-break' : '';
    if (byGroup) {
      html += `<div class="${breakClass.trim()}">${breakClass ? header : ''}
        <div class="group-title">กลุ่ม/ชั้น: ${escapeHtml(key)} — ${fmt(list.length)} คน</div>`;
    } else {
      html += '<div>';
    }
    html += `<table class="doc-table"><thead>${head}</thead><tbody>`;
    list.forEach((v, i) => {
      html += `
        <tr>
          <td class="c">${i + 1}</td>
          <td>${escapeHtml(fullName(v))}</td>
          ${showCid ? `<td class="c mono nowrap">${formatCid(v.citizen_id, cidMode)}</td>` : ''}
          ${showGroupCol ? `<td>${escapeHtml(v.group_name)}</td>` : ''}
          ${checklist
            ? `<td class="c nowrap">${v.voted_at ? '✔ ' + escapeHtml(v.voted_at.slice(11, 16)) + ' น.' : ''}</td><td></td>`
            : '<td></td>'}
        </tr>`;
    });
    html += '</tbody></table></div>';
  });

  const voted = payload.voters.filter((v) => v.voted_at).length;
  html += `
    <div class="doc-summary">
      รวมผู้มีสิทธิ์เลือกตั้งทั้งสิ้น ${fmt(payload.voters.length)} คน
      ${checklist ? ` — มาใช้สิทธิ์แล้ว ${fmt(voted)} คน (ร้อยละ ${pct(voted, payload.voters.length)}) ข้อมูล ณ เวลาที่พิมพ์` : ''}
    </div>
    <div class="signatures" style="grid-template-columns:1fr 1fr;">
      <div></div>
      <div>
        <div class="line">ลงชื่อ ....................................................</div>
        <div>(....................................................)</div>
        <div>${checklist ? 'เจ้าหน้าที่ประจำหน่วยเลือกตั้ง' : 'ประธานคณะกรรมการการเลือกตั้ง'}</div>
      </div>
    </div>
    <div class="doc-footer">พิมพ์เมื่อ ${new Date().toLocaleString('th-TH')}</div>`;

  document.getElementById('doc').className = '';
  document.getElementById('doc').innerHTML = html;
  document.title = `${checklist ? 'บัญชีรายชื่อ' : 'ประกาศรายชื่อผู้มีสิทธิ์'} - ${e.title}`;
}

(async () => {
  if (!electionId) return showDocError('ไม่ได้ระบุกิจกรรมเลือกตั้ง');
  try {
    payload = await fetchJson(`/admin/api/elections/${electionId}/voters`);
    if (payload.voters.length === 0) return showDocError('กิจกรรมนี้ยังไม่มีบัญชีรายชื่อผู้มีสิทธิ์ — import รายชื่อที่แดชบอร์ดก่อน');
    render();
  } catch (e) {
    showDocError(e.message);
  }
})();
