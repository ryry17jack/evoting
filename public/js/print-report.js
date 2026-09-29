/* =====================================================================
   PRINT-REPORT.JS — รายงานผลการเลือกตั้ง (พิมพ์ / บันทึกเป็น PDF)
   ?ids=1 หรือ ?ids=1,2,3 — เลือก "ทุกกิจกรรมในวันเดียวกัน" ได้จากแถบเครื่องมือ
   ===================================================================== */

const params = new URLSearchParams(location.search);
const requestedIds = String(params.get('ids') || '')
  .split(',')
  .map((x) => parseInt(x, 10))
  .filter(Boolean);
let reports = [];

const opt = {
  scope: bindOption('opt-scope', 'printReportScope', load),
  groups: bindOption('opt-groups', 'printReportGroups', render),
  hourly: bindOption('opt-hourly', 'printReportHourly', render),
  org: bindOption('opt-org', 'printOrg', render),
};

function candidateLabel(c, noVoteNo) {
  return c.candidate_no === noVoteNo ? 'ไม่ประสงค์ลงคะแนน' : c.candidate_name;
}

// สรุปผู้ได้คะแนนสูงสุด (ไม่นับช่อง "ไม่ประสงค์ลงคะแนน")
function winnerText(r) {
  const contenders = r.candidates.filter((c) => c.candidate_no !== r.noVoteNo);
  if (r.totalVotes === 0) return 'ยังไม่มีการลงคะแนน';
  if (contenders.length === 0) return '';
  const top = Math.max(...contenders.map((c) => c.vote_count));
  const leaders = contenders.filter((c) => c.vote_count === top);
  let text =
    leaders.length === 1
      ? `ผู้ได้รับคะแนนสูงสุด ได้แก่ หมายเลข ${leaders[0].candidate_no} ${escapeHtml(leaders[0].candidate_name)} ได้ ${fmt(top)} คะแนน (ร้อยละ ${pct(top, r.totalVotes)})`
      : `มีผู้ได้รับคะแนนสูงสุดเท่ากัน ${leaders.length} ราย (${fmt(top)} คะแนน): ` +
        leaders.map((c) => `หมายเลข ${c.candidate_no} ${escapeHtml(c.candidate_name)}`).join(', ');
  if (r.noVote > top) {
    text += `<br>หมายเหตุ: คะแนน "ไม่ประสงค์ลงคะแนน" (${fmt(r.noVote)}) มากกว่าคะแนนของผู้สมัครที่ได้คะแนนสูงสุด`;
  }
  return text;
}

function renderOne(r, index) {
  const e = r.election;
  const org = opt.org().trim();
  const hasRegistry = r.eligible > 0;
  const notVoted = r.eligible - r.votedRegistered;

  const statusNote =
    e.status === 'open'
      ? 'ผลอย่างไม่เป็นทางการ — ขณะพิมพ์รายงานยังเปิดลงคะแนนอยู่'
      : e.status === 'closed'
      ? `ปิดการลงคะแนนเมื่อ ${escapeHtml(e.closed_at || '')} น.`
      : 'ยังไม่เปิดลงคะแนน (สถานะเตรียมการ)';

  // ตรวจสอบความถูกต้อง: บัตรที่นับได้ต้องเท่ากับจำนวนผู้มาใช้สิทธิ์ (บันทึกคู่กันใน transaction เดียว)
  const diff = r.totalVotes - r.voted;
  const integrity =
    diff === 0
      ? '<span class="check-ok">✔ ถูกต้อง — จำนวนบัตรที่นับได้เท่ากับจำนวนผู้มาใช้สิทธิ์</span>'
      : `<span class="check-bad">⚠ ไม่ตรงกัน (ต่างกัน ${fmt(Math.abs(diff))}) — อาจเป็นข้อมูลที่บันทึกก่อนปรับปรุงระบบ หรือมีการแก้ไขข้อมูลโดยตรง</span>`;

  const ranked = r.candidates
    .slice()
    .sort((a, b) => (a.candidate_no === r.noVoteNo) - (b.candidate_no === r.noVoteNo) || b.vote_count - a.vote_count || a.candidate_no - b.candidate_no);
  const contenders = ranked.filter((c) => c.candidate_no !== r.noVoteNo);
  const topVotes = contenders.length ? contenders[0].vote_count : 0;
  let rank = 0;
  let prevVotes = null;

  const resultRows = ranked
    .map((c, i) => {
      const isNoVote = c.candidate_no === r.noVoteNo;
      if (!isNoVote && c.vote_count !== prevVotes) rank = i + 1;
      prevVotes = c.vote_count;
      const share = r.totalVotes ? (c.vote_count / r.totalVotes) * 100 : 0;
      const isWinner = !isNoVote && r.totalVotes > 0 && c.vote_count === topVotes;
      return `
        <tr class="${isWinner ? 'winner-row' : ''}">
          <td class="c">${isNoVote ? '—' : rank}</td>
          <td class="c b">${c.candidate_no}</td>
          <td>${escapeHtml(candidateLabel(c, r.noVoteNo))}</td>
          <td class="r b">${fmt(c.vote_count)}</td>
          <td class="r">${share.toFixed(2)}</td>
          <td><div class="bar"><span style="width:${share.toFixed(2)}%"></span></div></td>
        </tr>`;
    })
    .join('');

  const groupRows = r.byGroup
    .map(
      (g) => `
        <tr>
          <td>${escapeHtml(g.group_name || 'ไม่ระบุกลุ่ม')}</td>
          <td class="r">${fmt(g.eligible)}</td>
          <td class="r">${fmt(g.voted)}</td>
          <td class="r">${fmt(g.eligible - g.voted)}</td>
          <td class="r">${pct(g.voted, g.eligible)}</td>
        </tr>`
    )
    .join('');

  const hourlyRows = r.hourly
    .map((h) => `<tr><td class="c">${escapeHtml(h.hour.slice(11))} - ${escapeHtml(h.hour.slice(11, 13))}:59 น.</td><td class="r">${fmt(h.count)}</td></tr>`)
    .join('');

  return `
  <section class="doc-section${index > 0 ? ' page-break' : ''}">
    <div class="doc-header">
      ${org ? `<div class="doc-org">${escapeHtml(org)}</div>` : ''}
      <div class="doc-title">รายงานผลการเลือกตั้ง</div>
      <div class="doc-subtitle">${escapeHtml(e.title)}</div>
      <div class="doc-meta">${e.election_date ? thaiDateLong(e.election_date) : ''}</div>
      ${e.description ? `<div class="doc-meta muted">${escapeHtml(e.description)}</div>` : ''}
    </div>
    <div class="doc-note">${statusNote}</div>

    <div class="group-title">1. ข้อมูลการใช้สิทธิ์เลือกตั้ง</div>
    <table class="doc-table">
      <tbody>
        <tr><td style="width:55%;">ผู้มีสิทธิ์เลือกตั้งตามบัญชีรายชื่อ</td>
            <td class="r b">${hasRegistry ? fmt(r.eligible) + ' คน' : 'ไม่ได้ใช้บัญชีรายชื่อ'}</td></tr>
        <tr><td>ผู้มาใช้สิทธิ์เลือกตั้ง</td>
            <td class="r b">${fmt(r.voted)} คน${hasRegistry ? ` (ร้อยละ ${pct(r.votedRegistered, r.eligible)} ของผู้มีสิทธิ์)` : ''}</td></tr>
        ${hasRegistry && r.votedUnregistered > 0
          ? `<tr><td>&nbsp;&nbsp;— ในจำนวนนี้ไม่มีชื่อในบัญชีรายชื่อ</td><td class="r">${fmt(r.votedUnregistered)} คน</td></tr>`
          : ''}
        ${hasRegistry ? `<tr><td>ผู้ไม่มาใช้สิทธิ์</td><td class="r b">${fmt(notVoted)} คน (ร้อยละ ${pct(notVoted, r.eligible)})</td></tr>` : ''}
        ${r.manualEntries > 0
          ? `<tr><td>&nbsp;&nbsp;— ยืนยันตัวตนโดยเจ้าหน้าที่กรอกเลขบัตร (อ่านบัตรไม่ได้)</td><td class="r">${fmt(r.manualEntries)} คน</td></tr>`
          : ''}
        <tr><td>จำนวนบัตรที่นับได้ทั้งหมด</td><td class="r b">${fmt(r.totalVotes)} ใบ</td></tr>
        ${r.hidden ? '' : `
        <tr><td>&nbsp;&nbsp;— บัตรที่เลือกผู้สมัคร</td><td class="r">${fmt(r.totalVotes - r.noVote)} ใบ (ร้อยละ ${pct(r.totalVotes - r.noVote, r.totalVotes)})</td></tr>
        <tr><td>&nbsp;&nbsp;— บัตรไม่ประสงค์ลงคะแนน</td><td class="r">${fmt(r.noVote)} ใบ (ร้อยละ ${pct(r.noVote, r.totalVotes)})</td></tr>`}
        <tr><td>ช่วงเวลาที่มีการลงคะแนน</td>
            <td class="r">${r.firstVoteAt ? `${escapeHtml(r.firstVoteAt)} ถึง ${escapeHtml(r.lastVoteAt.slice(11))} น.` : '—'}</td></tr>
        <tr><td>การตรวจสอบความถูกต้องของข้อมูล</td><td class="r">${integrity}</td></tr>
      </tbody>
    </table>

    <div class="group-title">2. ผลคะแนน</div>
    ${r.hidden ? `<div class="doc-note">🔒 ผลคะแนนรายผู้สมัครถูกซ่อนไว้จนกว่าจะปิดการลงคะแนน</div>` : `
    <table class="doc-table">
      <thead>
        <tr><th style="width:50px;">อันดับ</th><th style="width:70px;">หมายเลข</th><th>ชื่อผู้สมัคร</th>
            <th style="width:80px;">คะแนน</th><th style="width:70px;">ร้อยละ</th><th style="width:150px;"></th></tr>
      </thead>
      <tbody>${resultRows || '<tr><td colspan="6" class="c">— ไม่มีผู้สมัคร —</td></tr>'}</tbody>
    </table>
    <p class="doc-summary">${winnerText(r)}</p>`}

    ${opt.groups() && r.byGroup.length > 0 ? `
    <div class="group-title">3. ผู้มาใช้สิทธิ์แยกตามกลุ่ม/ชั้น</div>
    <table class="doc-table">
      <thead><tr><th>กลุ่ม/ชั้น</th><th style="width:90px;">ผู้มีสิทธิ์</th><th style="width:90px;">มาใช้สิทธิ์</th>
        <th style="width:90px;">ไม่มา</th><th style="width:80px;">ร้อยละ</th></tr></thead>
      <tbody>${groupRows}</tbody>
    </table>` : ''}

    ${opt.hourly() && r.hourly.length > 0 ? `
    <div class="group-title">${opt.groups() && r.byGroup.length > 0 ? 4 : 3}. ผู้มาใช้สิทธิ์รายชั่วโมง</div>
    <table class="doc-table" style="width:50%;">
      <thead><tr><th>ช่วงเวลา</th><th style="width:110px;">จำนวน (คน)</th></tr></thead>
      <tbody>${hourlyRows}</tbody>
    </table>` : ''}

    <p style="margin-top:18px;">คณะกรรมการได้ตรวจสอบผลการนับคะแนนข้างต้นแล้ว ขอรับรองว่าถูกต้อง</p>
    <div class="signatures">
      ${['ประธานกรรมการ', 'กรรมการ', 'กรรมการและเลขานุการ']
        .map((role) => `
        <div>
          <div class="line">ลงชื่อ .........................................</div>
          <div>(.........................................)</div>
          <div>${role}</div>
        </div>`)
        .join('')}
    </div>
    <div class="doc-footer">ข้อมูล ณ ${escapeHtml(r.generatedAt)} — ระบบเลือกตั้งอิเล็กทรอนิกส์ (E-Voting)</div>
  </section>`;
}

function render() {
  if (reports.length === 0) return;
  const doc = document.getElementById('doc');
  doc.className = '';
  doc.innerHTML = reports.map(renderOne).join('');
  document.title =
    reports.length === 1 ? `รายงานผลการเลือกตั้ง - ${reports[0].election.title}` : `รายงานผลการเลือกตั้ง (${reports.length} กิจกรรม)`;
}

async function load() {
  if (requestedIds.length === 0) return showDocError('ไม่ได้ระบุกิจกรรมเลือกตั้ง');
  try {
    let ids = requestedIds;
    if (opt.scope() === 'day' && requestedIds.length === 1) {
      const { elections } = await fetchJson('/admin/api/elections');
      const base = elections.find((e) => e.id === requestedIds[0]);
      if (base) {
        ids = elections
          .filter((e) => e.election_date === base.election_date)
          .sort((a, b) => a.id - b.id)
          .map((e) => e.id);
      }
    }
    reports = await Promise.all(ids.map((id) => fetchJson(`/admin/api/elections/${id}/report`)));
    render();
  } catch (e) {
    showDocError(e.message);
  }
}

load();
