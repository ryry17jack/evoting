/* =====================================================================
   KIOSK.JS — ควบคุมสถานะหน้าจอคูหาลงคะแนน (State Machine)
   State 1: welcome → (เสียบบัตร) → reading
   → ไม่มีชื่อในบัญชีผู้มีสิทธิ์: noteligible (5 วินาที) → welcome
   → ลงคะแนนครบทุกกิจกรรมแล้ว: warning (4 วินาที) → welcome
   → ยังไม่ครบ: ballot (ทีละกิจกรรม) → (กดเลือก → ยืนยัน) → ใบถัดไป / thanks → welcome
   การเสียบบัตรไม่ถือว่าใช้สิทธิ์ — ระบบบันทึกเมื่อยืนยันลงคะแนนสำเร็จเท่านั้น
   ===================================================================== */

const socket = io();

const SCREENS = ['welcome', 'reading', 'warning', 'noteligible', 'error', 'ballot', 'thanks'];
const BALLOT_TIMEOUT_SEC = 120; // ไม่ลงคะแนนภายในเวลานี้ → กลับหน้าแรก (สิทธิ์ยังอยู่ เสียบบัตรใหม่ได้)
const NO_VOTE_NO = 99;

let currentScreen = 'welcome';
let voteToken = null;   // token สิทธิ์ลงคะแนน (ใช้ได้ครั้งเดียวต่อกิจกรรม)
let voterName = '';
let ballots = [];       // บัตรเลือกตั้งของกิจกรรมที่ยังไม่ได้ลงคะแนน
let ballotIndex = 0;
let votedCount = 0;
let pendingChoice = null; // ผู้สมัครที่กดเลือก รอยืนยัน
let voteLocked = false;   // กันการกดปุ่มรัว ๆ
let resetTimer = null;
let countdownTimer = null;
let secondsLeft = 0;

function showScreen(name) {
  currentScreen = name;
  SCREENS.forEach((s) => {
    document.getElementById('screen-' + s).classList.toggle('active', s === name);
  });
  if (name !== 'ballot') {
    stopCountdown();
    hideConfirm();
  }
}

function resetToWelcome() {
  clearTimeout(resetTimer);
  voteToken = null;
  ballots = [];
  voteLocked = false;
  showScreen('welcome');
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

/* ------------------------------------------------------------------ */
/*  หน้าต้อนรับ: แสดงกิจกรรมที่เปิดลงคะแนนอยู่                              */
/* ------------------------------------------------------------------ */
async function loadOpenElections() {
  const box = document.getElementById('open-elections');
  try {
    const res = await fetch('/api/elections/open');
    const list = await res.json();
    box.innerHTML = list.length
      ? '<div class="open-elections-title">กิจกรรมที่เปิดลงคะแนนขณะนี้</div>' +
        list.map((e) => `<div class="open-elections-item">🗳 ${escapeHtml(e.title)}</div>`).join('')
      : '<div class="open-elections-title">ขณะนี้ยังไม่เปิดลงคะแนน</div>';
  } catch (e) {
    box.innerHTML = '';
  }
}

/* ------------------------------------------------------------------ */
/*  บัตรเลือกตั้ง — แสดงทีละกิจกรรม                                       */
/* ------------------------------------------------------------------ */
function stopCountdown() {
  clearInterval(countdownTimer);
  countdownTimer = null;
}

// นับถอยหลังบนบัตรเลือกตั้ง — ถ้าผู้ลงคะแนนเดินออกไป คนถัดไปจะไม่เห็น/ใช้บัตรของคนก่อน
function startCountdown() {
  stopCountdown();
  secondsLeft = BALLOT_TIMEOUT_SEC;
  const el = document.getElementById('ballot-countdown');
  el.textContent = secondsLeft;
  countdownTimer = setInterval(() => {
    secondsLeft -= 1;
    el.textContent = Math.max(0, secondsLeft);
    if (secondsLeft <= 0) {
      stopCountdown();
      showError('หมดเวลาลงคะแนน — ระบบยังไม่ได้บันทึกการใช้สิทธิ์ กรุณาเสียบบัตรใหม่');
    }
  }, 1000);
}

function renderBallot() {
  const ballot = ballots[ballotIndex];
  document.getElementById('ballot-title').textContent = ballot.title;
  document.getElementById('ballot-progress').textContent =
    ballots.length > 1 ? `บัตรเลือกตั้งใบที่ ${ballotIndex + 1} จาก ${ballots.length}` : '';
  document.getElementById('voter-name').textContent = 'ผู้ลงคะแนน: คุณ' + voterName;

  const grid = document.getElementById('candidate-grid');
  grid.innerHTML = '';
  ballot.candidates.forEach((c) => {
    const card = document.createElement('div');
    card.className = 'candidate-card';
    const isNoVote = c.candidate_no === NO_VOTE_NO;
    card.innerHTML = `
      <img class="candidate-photo" src="${escapeHtml(c.photo_url || '/img/novote.svg')}" alt="ผู้สมัครหมายเลข ${c.candidate_no}">
      <div class="candidate-no">เบอร์ ${c.candidate_no}</div>
      <div class="candidate-name">${escapeHtml(c.candidate_name)}</div>
      ${c.description ? `<div class="candidate-desc">${escapeHtml(c.description)}</div>` : ''}
      <button class="btn ${isNoVote ? 'btn-red' : 'btn-blue'} btn-vote">
        ${isNoVote ? '✕ ไม่ประสงค์ลงคะแนน' : '☑ ลงคะแนน'}
      </button>
    `;
    card.querySelector('.btn-vote').addEventListener('click', () => askConfirm(c));
    grid.appendChild(card);
  });

  showScreen('ballot');
  window.scrollTo(0, 0);
  startCountdown();
}

/* ------------------------------------------------------------------ */
/*  ยืนยันก่อนลงคะแนน (กันกดพลาด — ลงแล้วแก้ไม่ได้)                          */
/* ------------------------------------------------------------------ */
const confirmOverlay = document.getElementById('confirm-overlay');

function askConfirm(candidate) {
  if (voteLocked || !voteToken) return;
  pendingChoice = candidate;
  document.getElementById('confirm-photo').src = candidate.photo_url || '/img/novote.svg';
  document.getElementById('confirm-choice').textContent =
    candidate.candidate_no === NO_VOTE_NO
      ? 'ไม่ประสงค์ลงคะแนน'
      : `เบอร์ ${candidate.candidate_no} — ${candidate.candidate_name}`;
  confirmOverlay.style.display = 'flex';
}

function hideConfirm() {
  pendingChoice = null;
  if (confirmOverlay) confirmOverlay.style.display = 'none';
}

document.getElementById('confirm-no').addEventListener('click', hideConfirm);
document.getElementById('confirm-yes').addEventListener('click', () => {
  if (pendingChoice) castVote(pendingChoice.candidate_no);
});

/* ------------------------------------------------------------------ */
/*  ส่งคะแนน (นิรนาม) ผ่าน Fetch API                                     */
/* ------------------------------------------------------------------ */
async function castVote(candidateNo) {
  if (voteLocked || !voteToken) return;
  voteLocked = true;
  const yesBtn = document.getElementById('confirm-yes');
  yesBtn.disabled = true;

  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        token: voteToken,
        election_id: ballots[ballotIndex].election_id,
        candidate_no: candidateNo,
      }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      votedCount += 1;
      hideConfirm();
      if (ballotIndex + 1 < ballots.length) {
        ballotIndex += 1;
        renderBallot();
      } else {
        voteToken = null;
        document.getElementById('thanks-detail').textContent =
          votedCount > 1 ? `ลงคะแนนครบ ${votedCount} กิจกรรมแล้ว` : '';
        showScreen('thanks');
        resetTimer = setTimeout(resetToWelcome, 3000); // แสดงหน้าขอบคุณ 3 วินาที แล้วกลับหน้าแรก
      }
    } else if (res.status === 400) {
      // เลือกผู้สมัครที่เพิ่งถูกลบ — สิทธิ์ยังอยู่ ให้เลือกใหม่
      hideConfirm();
      alert(data.error || 'กรุณาเลือกใหม่');
    } else if (data.code === 'already-voted' || data.code === 'closed') {
      // กิจกรรมนี้ลงไม่ได้แล้ว → ข้ามไปใบถัดไป (ถ้ามี)
      hideConfirm();
      if (ballotIndex + 1 < ballots.length) {
        ballotIndex += 1;
        renderBallot();
      } else {
        showError(data.error);
      }
    } else {
      showError(data.error || 'บันทึกคะแนนไม่สำเร็จ กรุณาติดต่อเจ้าหน้าที่');
    }
  } catch (e) {
    // ไม่แน่ใจว่าบันทึกสำเร็จหรือไม่ — ให้เสียบบัตรใหม่ ระบบจะแสดงเฉพาะกิจกรรมที่ยังไม่ได้ลง
    showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาเสียบบัตรใหม่อีกครั้ง');
  } finally {
    yesBtn.disabled = false;
    voteLocked = false;
  }
}

function showError(message) {
  clearTimeout(resetTimer);
  voteToken = null;
  document.getElementById('error-message').textContent = message;
  showScreen('error');
  resetTimer = setTimeout(resetToWelcome, 5000);
}

/* ------------------------------------------------------------------ */
/*  Socket.io — รับสถานะจากเครื่องอ่านบัตรแบบเรียลไทม์                    */
/* ------------------------------------------------------------------ */
socket.on('connect', () => {
  document.getElementById('server-led').classList.add('on');
  document.getElementById('server-status').textContent = 'เชื่อมต่อแล้ว';
  loadOpenElections();
});

socket.on('disconnect', () => {
  document.getElementById('server-led').classList.remove('on');
  document.getElementById('server-status').textContent = 'หลุดการเชื่อมต่อ!';
});

socket.on('reader-status', (data) => {
  const led = document.getElementById('reader-led');
  const name = document.getElementById('reader-name');
  if (data.connected) {
    led.classList.add('on');
    name.textContent = data.name || 'พร้อมใช้งาน';
  } else {
    led.classList.remove('on');
    name.textContent = 'ไม่พบเครื่องอ่านบัตร';
  }
});

// เสียบบัตร → แสดงหน้ากำลังอ่าน
socket.on('card-inserted', () => {
  if (currentScreen === 'welcome') {
    clearTimeout(resetTimer);
    showScreen('reading');
  }
});

// ยืนยันตัวตนสำเร็จ → ปลดล็อกบัตรเลือกตั้ง (State 3)
socket.on('auth-success', (data) => {
  clearTimeout(resetTimer);
  voteToken = data.token;
  voterName = data.fullName;
  ballots = data.ballots || [];
  ballotIndex = 0;
  votedCount = 0;
  document.getElementById('manual-badge').style.display = data.manual ? '' : 'none';
  if (officerOverlay.style.display !== 'none') closeOfficer();
  renderBallot();
});

// ลงคะแนนครบทุกกิจกรรมแล้ว → เตือน 4 วินาที แล้วรีเซ็ต
socket.on('already-voted', (data) => {
  clearTimeout(resetTimer);
  voteToken = null;
  document.getElementById('warning-name').textContent = data.fullName ? 'คุณ' + data.fullName : '';
  showScreen('warning');
  resetTimer = setTimeout(resetToWelcome, 4000);
});

// ไม่มีชื่อในบัญชีผู้มีสิทธิ์ของกิจกรรมใดที่เปิดอยู่
socket.on('not-eligible', (data) => {
  clearTimeout(resetTimer);
  voteToken = null;
  document.getElementById('noteligible-name').textContent = data.fullName ? 'คุณ' + data.fullName : '';
  showScreen('noteligible');
  resetTimer = setTimeout(resetToWelcome, 5000);
});

socket.on('no-election', () => showError('ขณะนี้ยังไม่เปิดลงคะแนน'));

// อ่านบัตรผิดพลาด
socket.on('card-error', (data) => {
  showError((data && data.message) || 'อ่านบัตรไม่สำเร็จ');
});

// ผู้ดูแลเปิด/ปิดกิจกรรม หรือแก้ไขผู้สมัคร → อัปเดตหน้าต้อนรับ
socket.on('elections-updated', () => loadOpenElections());

// ดึงบัตรออกระหว่างหน้าอ่านบัตร/หน้าเตือน → กลับหน้าแรก
// (ถ้าอยู่หน้าบัตรเลือกตั้งแล้ว ให้ลงคะแนนต่อได้ตามปกติ — มีนับถอยหลังกันลืมบัตรค้าง)
socket.on('card-removed', () => {
  if (['reading', 'warning', 'noteligible', 'error'].includes(currentScreen)) {
    resetToWelcome();
  }
});

/* ------------------------------------------------------------------ */
/*  เจ้าหน้าที่กรอกเลขบัตรแทน (ชิปบัตรเสีย / เครื่องอ่านบัตรมีปัญหา)          */
/*  กดปุ่ม "🔑 เจ้าหน้าที่" ที่แถบสถานะ หรือ F9 → ใส่ PIN + เลขบัตร           */
/*  มีแป้นตัวเลขบนจอสำหรับเครื่องคูหาแบบจอสัมผัส                            */
/* ------------------------------------------------------------------ */
const officerOverlay = document.getElementById('officer-overlay');
const officerPin = document.getElementById('officer-pin');
const officerCid = document.getElementById('officer-cid');
const officerName = document.getElementById('officer-name');
const officerError = document.getElementById('officer-error');
let officerTarget = officerPin; // ช่องที่แป้นตัวเลขบนจอจะพิมพ์ลงไป

function showOfficerError(msg) {
  officerError.textContent = msg || '';
  officerError.style.display = msg ? 'block' : 'none';
}

function openOfficer() {
  // เปิดได้เฉพาะตอนไม่มีบัตรเลือกตั้งค้างอยู่ (กันเปิดทับผู้ที่กำลังลงคะแนน)
  if (!['welcome', 'error', 'noteligible', 'warning'].includes(currentScreen)) return;
  clearTimeout(resetTimer);
  showScreen('welcome');
  officerPin.value = '';
  officerCid.value = '';
  officerName.value = '';
  showOfficerError('');
  officerOverlay.style.display = 'flex';
  officerTarget = officerPin;
  officerPin.focus();
}

function closeOfficer() {
  officerOverlay.style.display = 'none';
  showOfficerError('');
  officerPin.value = '';
}

[officerPin, officerCid].forEach((el) => {
  el.addEventListener('focus', () => (officerTarget = el));
  el.addEventListener('input', () => {
    el.value = el.value.replace(/\D/g, '');
    if (el === officerPin && el.value.length === 6) officerCid.focus();
  });
});

document.getElementById('officer-pad').addEventListener('click', (ev) => {
  const k = ev.target.dataset && ev.target.dataset.k;
  if (!k) return;
  const el = officerTarget;
  if (k === 'back') el.value = el.value.slice(0, -1);
  else if (k === 'clear') el.value = '';
  else if (el.value.length < el.maxLength) el.value += k;
  if (el === officerPin && el.value.length === 6) officerTarget = officerCid;
  el.dispatchEvent(new Event('input'));
});

function submitOfficer() {
  if (!/^\d{6}$/.test(officerPin.value)) return showOfficerError('กรุณาใส่ PIN 6 หลัก');
  if (!/^\d{13}$/.test(officerCid.value)) return showOfficerError('กรุณาใส่เลขบัตรประชาชน 13 หลัก');
  showOfficerError('');
  document.getElementById('officer-submit').disabled = true;
  socket.emit('officer-entry', { pin: officerPin.value, citizenId: officerCid.value, fullName: officerName.value });
}

document.getElementById('officer-open').addEventListener('click', openOfficer);
document.getElementById('officer-close').addEventListener('click', closeOfficer);
document.getElementById('officer-cancel').addEventListener('click', closeOfficer);
document.getElementById('officer-submit').addEventListener('click', submitOfficer);
[officerPin, officerCid, officerName].forEach((el) =>
  el.addEventListener('keydown', (ev) => ev.key === 'Enter' && submitOfficer())
);

// PIN ถูกต้อง → ปิดหน้าต่าง (ล้าง PIN ทิ้งทันที) แล้วรอผลตรวจสิทธิ์เหมือนเสียบบัตร
socket.on('officer-ok', () => {
  document.getElementById('officer-submit').disabled = false;
  closeOfficer();
  showScreen('reading');
});
socket.on('officer-error', (data) => {
  document.getElementById('officer-submit').disabled = false;
  officerPin.value = '';
  officerTarget = officerPin;
  showOfficerError((data && data.message) || 'ไม่สำเร็จ');
});

/* ------------------------------------------------------------------ */
/*  โหมดจำลองบัตร (ต้องรันเซิร์ฟเวอร์ด้วย DEMO_MODE=1)                    */
/*  F2 = สุ่มผู้มีสิทธิ์จากบัญชีรายชื่อ (ถ้าไม่มี ใช้เลขบัตรสุ่ม)                */
/*  F3 = เลขบัตรสุ่มที่ไม่อยู่ในบัญชีรายชื่อ                                  */
/* ------------------------------------------------------------------ */
function randomCitizenId() {
  const d = [1];
  for (let i = 0; i < 11; i++) d.push(Math.floor(Math.random() * 10));
  let sum = 0;
  for (let i = 0; i < 12; i++) sum += d[i] * (13 - i);
  d.push((11 - (sum % 11)) % 10);
  return d.join('');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'F9') {
    e.preventDefault();
    openOfficer();
    return;
  }
  if (e.key === 'F2' || e.key === 'F3') {
    e.preventDefault();
    socket.emit('demo-card', {
      citizenId: randomCitizenId(),
      fullName: 'นายทดสอบ ระบบจำลอง',
      pick: e.key === 'F2' ? 'registered' : null,
    });
  }
});

/* ------------------------------------------------------------------ */
/*  Local Card Agent Bridge (โหมด Cloud + Agent)                        */
/*  เชื่อมต่อโปรแกรม card-agent ที่รันบนเครื่องคูหาเดียวกัน (localhost)      */
/*  เมื่อเสียบบัตรจริง Agent จะอ่านข้อมูลแล้วส่งมาที่หน้านี้ จากนั้นหน้านี้     */
/*  ส่งต่อให้เซิร์ฟเวอร์ (station-card) เพื่อตรวจสอบสิทธิ์ลงคะแนน            */
/*  หมายเหตุ: ws://127.0.0.1 ถือเป็น "loopback" จึงเชื่อมต่อจากหน้า HTTPS   */
/*  ได้ (ไม่ติด mixed-content)                                            */
/* ------------------------------------------------------------------ */
(function connectCardAgent() {
  // พอร์ตของ Agent (แก้ได้ด้วย ?agent=port บน URL หรือ localStorage 'agentPort')
  const params = new URLSearchParams(location.search);
  const port = params.get('agent') || localStorage.getItem('agentPort') || '47458';
  const AGENT_URL = `ws://127.0.0.1:${port}`;

  const readerLed = document.getElementById('reader-led');
  const readerName = document.getElementById('reader-name');
  let ws = null;
  let retryTimer = null;

  function setReader(connected, name) {
    if (!readerLed) return;
    readerLed.classList.toggle('on', !!connected);
    if (readerName) readerName.textContent = connected ? name || 'พร้อมใช้งาน' : 'ไม่พบเครื่องอ่านบัตร';
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(open, 3000); // Agent อาจยังไม่เปิด — ลองใหม่เรื่อย ๆ
  }

  function open() {
    try {
      ws = new WebSocket(AGENT_URL);
    } catch (e) {
      scheduleRetry();
      return;
    }

    ws.onopen = () => console.log('[AGENT] เชื่อมต่อ Local Card Agent แล้ว:', AGENT_URL);

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (_) {
        return;
      }
      switch (msg.type) {
        case 'reader': // สถานะเครื่องอ่านบัตร
          setReader(msg.connected, msg.name);
          break;
        case 'card-inserted': // เสียบบัตร → แสดงหน้ากำลังอ่าน
          if (currentScreen === 'welcome') {
            clearTimeout(resetTimer);
            showScreen('reading');
          }
          break;
        case 'card': // อ่านข้อมูลบัตรได้ → ส่งให้เซิร์ฟเวอร์ตรวจสอบสิทธิ์
          socket.emit('station-card', {
            citizenId: msg.citizenId,
            fullName: msg.fullName,
          });
          break;
        case 'card-removed':
          if (['reading', 'warning', 'noteligible', 'error'].includes(currentScreen)) {
            resetToWelcome();
          }
          break;
        case 'card-error':
          showError((msg && msg.message) || 'อ่านบัตรไม่สำเร็จ');
          break;
      }
    };

    ws.onclose = () => {
      setReader(false);
      scheduleRetry();
    };
    ws.onerror = () => {
      try {
        ws.close();
      } catch (_) {}
    };
  }

  open();
})();

loadOpenElections();
