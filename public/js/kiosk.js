/* =====================================================================
   KIOSK.JS — ควบคุมสถานะหน้าจอคูหาลงคะแนน (State Machine)
   State 1: welcome → (เสียบบัตร) → reading
   → เคยลงคะแนน: warning (4 วินาที) → welcome
   → ยังไม่เคย:  ballot → (กดลงคะแนน) → thanks (3 วินาที) → welcome
   ===================================================================== */

const socket = io();

const SCREENS = ['welcome', 'reading', 'warning', 'error', 'ballot', 'thanks'];
let currentScreen = 'welcome';
let voteToken = null;   // token สิทธิ์ลงคะแนน (ใช้ได้ครั้งเดียว)
let voteLocked = false; // กันการกดปุ่มรัว ๆ
let resetTimer = null;

function showScreen(name) {
  currentScreen = name;
  SCREENS.forEach((s) => {
    document.getElementById('screen-' + s).classList.toggle('active', s === name);
  });
}

function resetToWelcome() {
  clearTimeout(resetTimer);
  voteToken = null;
  voteLocked = false;
  showScreen('welcome');
}

/* ------------------------------------------------------------------ */
/*  โหลดรายชื่อผู้สมัครและสร้างการ์ดบนบัตรเลือกตั้ง                        */
/* ------------------------------------------------------------------ */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = String(str == null ? '' : str);
  return div.innerHTML;
}

async function loadCandidates() {
  try {
    const res = await fetch('/api/candidates');
    const candidates = await res.json();
    const grid = document.getElementById('candidate-grid');
    grid.innerHTML = '';

    candidates.forEach((c) => {
      const card = document.createElement('div');
      card.className = 'candidate-card';

      const isNoVote = c.candidate_no === 99;
      card.innerHTML = `
        <img class="candidate-photo" src="${escapeHtml(c.photo_url || '/img/novote.svg')}" alt="ผู้สมัครหมายเลข ${c.candidate_no}">
        <div class="candidate-no">เบอร์ ${c.candidate_no}</div>
        <div class="candidate-name">${escapeHtml(c.candidate_name)}</div>
        ${c.description ? `<div class="candidate-desc">${escapeHtml(c.description)}</div>` : ''}
        <button class="btn ${isNoVote ? 'btn-red' : 'btn-blue'} btn-vote" data-no="${c.candidate_no}">
          ${isNoVote ? '✕ ไม่ประสงค์ลงคะแนน' : '☑ ลงคะแนน'}
        </button>
      `;
      grid.appendChild(card);
    });

    grid.querySelectorAll('.btn-vote').forEach((btn) => {
      btn.addEventListener('click', () => castVote(parseInt(btn.dataset.no, 10)));
    });
  } catch (e) {
    console.error('โหลดรายชื่อผู้สมัครไม่สำเร็จ:', e);
  }
}

/* ------------------------------------------------------------------ */
/*  ส่งคะแนน (นิรนาม) ผ่าน Fetch API                                     */
/* ------------------------------------------------------------------ */
async function castVote(candidateNo) {
  if (voteLocked || !voteToken) return;
  voteLocked = true;
  document.querySelectorAll('.btn-vote').forEach((b) => (b.disabled = true));

  try {
    const res = await fetch('/api/vote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ candidate_no: candidateNo, token: voteToken }),
    });
    const data = await res.json();

    if (res.ok && data.ok) {
      voteToken = null;
      showScreen('thanks');
      // แสดงหน้าขอบคุณ 3 วินาที แล้วกลับหน้าแรก
      resetTimer = setTimeout(resetToWelcome, 3000);
    } else {
      showError(data.error || 'บันทึกคะแนนไม่สำเร็จ กรุณาติดต่อเจ้าหน้าที่');
    }
  } catch (e) {
    showError('เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาติดต่อเจ้าหน้าที่');
  } finally {
    document.querySelectorAll('.btn-vote').forEach((b) => (b.disabled = false));
    voteLocked = false;
  }
}

function showError(message) {
  document.getElementById('error-message').textContent = message;
  showScreen('error');
  resetTimer = setTimeout(resetToWelcome, 4000);
}

/* ------------------------------------------------------------------ */
/*  Socket.io — รับสถานะจากเครื่องอ่านบัตรแบบเรียลไทม์                    */
/* ------------------------------------------------------------------ */
socket.on('connect', () => {
  document.getElementById('server-led').classList.add('on');
  document.getElementById('server-status').textContent = 'เชื่อมต่อแล้ว';
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
  document.getElementById('voter-name').textContent = 'คุณ' + data.fullName;
  showScreen('ballot');
});

// เคยลงคะแนนแล้ว → เตือน 4 วินาที แล้วรีเซ็ต
socket.on('already-voted', (data) => {
  clearTimeout(resetTimer);
  voteToken = null;
  document.getElementById('warning-name').textContent = data.fullName ? 'คุณ' + data.fullName : '';
  showScreen('warning');
  resetTimer = setTimeout(resetToWelcome, 4000);
});

// อ่านบัตรผิดพลาด
socket.on('card-error', (data) => {
  clearTimeout(resetTimer);
  showError((data && data.message) || 'อ่านบัตรไม่สำเร็จ');
});

// ผู้ดูแลแก้ไขรายชื่อผู้สมัคร → โหลดบัตรเลือกตั้งใหม่ทันที
socket.on('candidates-updated', () => loadCandidates());

// ดึงบัตรออกระหว่างหน้าอ่านบัตร/หน้าเตือน → กลับหน้าแรก
// (ถ้าอยู่หน้าบัตรเลือกตั้งแล้ว ให้ลงคะแนนต่อได้ตามปกติ)
socket.on('card-removed', () => {
  if (currentScreen === 'reading' || currentScreen === 'warning' || currentScreen === 'error') {
    resetToWelcome();
  }
});

/* ------------------------------------------------------------------ */
/*  โหมดจำลองบัตร (ต้องรันเซิร์ฟเวอร์ด้วย DEMO_MODE=1)                    */
/*  กด F2 เพื่อจำลองการเสียบบัตรด้วยเลขสุ่ม                               */
/* ------------------------------------------------------------------ */
document.addEventListener('keydown', (e) => {
  if (e.key === 'F2') {
    e.preventDefault();
    const randomId = '1' + String(Math.floor(Math.random() * 1e12)).padStart(12, '0');
    socket.emit('demo-card', {
      citizenId: randomId,
      fullName: 'นายทดสอบ ระบบจำลอง',
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
          if (currentScreen === 'reading' || currentScreen === 'warning' || currentScreen === 'error') {
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

loadCandidates();
