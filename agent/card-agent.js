/**
 * =====================================================================
 *  E-Voting Local Card Agent — โปรแกรมอ่านบัตรประชาชนฝั่งเครื่องคูหา
 * ---------------------------------------------------------------------
 *  รันบน "เครื่องคูหา" ที่เสียบเครื่องอ่านบัตร USB จริง แล้วเปิดหน้าเว็บ
 *  ระบบเลือกตั้ง (โฮสต์บน Cloud/Coolify) บนเครื่องเดียวกัน หน้าเว็บจะเชื่อม
 *  มาที่ Agent นี้ผ่าน ws://127.0.0.1:<PORT> เพื่อรับข้อมูลบัตร
 *
 *  ทำไมต้องมี Agent: เบราว์เซอร์เข้าถึงเครื่องอ่านบัตร USB โดยตรงไม่ได้
 *  (ถูกแซนด์บ็อกซ์) และเซิร์ฟเวอร์บน Cloud ก็อยู่คนละเครื่องกับเครื่องอ่าน
 *  Agent ตัวเล็ก ๆ นี้จึงทำหน้าที่เป็นสะพานบนเครื่องคูหา
 *
 *  ใช้งาน:  node card-agent.js
 *  ตั้งค่า:  AGENT_PORT (ค่าเริ่มต้น 47458)
 *           ALLOW_ORIGIN (โดเมนหน้าเว็บที่อนุญาต, ค่าเริ่มต้น * = ทุกโดเมน)
 * =====================================================================
 */

const http = require('http');
const { WebSocketServer } = require('ws');
const iconv = require('iconv-lite');
const pcsclite = require('@pokusew/pcsclite');

const PORT = parseInt(process.env.AGENT_PORT || '47458', 10);
const ALLOW_ORIGIN = process.env.ALLOW_ORIGIN || '*';

/* ------------------------------------------------------------------ */
/*  คำสั่ง APDU สำหรับบัตรประชาชนไทย (ตรงกับฝั่งเซิร์ฟเวอร์)               */
/* ------------------------------------------------------------------ */
const APDU = {
  SELECT_THAI_ID: [0x00, 0xa4, 0x04, 0x00, 0x08, 0xa0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01],
  CID: [0x80, 0xb0, 0x00, 0x04, 0x02, 0x00, 0x0d],
  FULLNAME_TH: [0x80, 0xb0, 0x00, 0x11, 0x02, 0x00, 0x64],
};

/* ------------------------------------------------------------------ */
/*  WebSocket server บน loopback เท่านั้น (127.0.0.1)                    */
/* ------------------------------------------------------------------ */
const server = http.createServer((req, res) => {
  // endpoint สุขภาพ + รองรับ CORS/Private-Network-Access preflight
  res.setHeader('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify({ ok: true, service: 'evoting-card-agent', readers: readerNames() }));
});

const wss = new WebSocketServer({ server });

// แนบ header อนุญาต Private Network Access ให้กับการ handshake ของ WebSocket
// (Chrome ต้องการเมื่อหน้า HTTPS สาธารณะเชื่อมมายัง loopback)
wss.on('headers', (headers) => {
  headers.push('Access-Control-Allow-Private-Network: true');
});

const clients = new Set();

function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

wss.on('connection', (ws) => {
  clients.add(ws);
  // แจ้งสถานะเครื่องอ่านบัตรล่าสุดให้ทันทีที่เชื่อมต่อ
  const names = readerNames();
  ws.send(JSON.stringify({ type: 'reader', connected: names.length > 0, name: names.join(', ') }));
  ws.on('close', () => clients.delete(ws));
  ws.on('error', () => clients.delete(ws));
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('══════════════════════════════════════════════════════');
  console.log(`  E-Voting Card Agent พร้อมใช้งานที่ ws://127.0.0.1:${PORT}`);
  console.log('  เปิดหน้าเว็บระบบเลือกตั้งบนเครื่องนี้ แล้วเสียบบัตรได้เลย');
  console.log('  ─────────────────────────────────────────────────');
  console.log('  ✅ เมื่อเสร็จสิ้นการลงคะแนน กดปุ่ม  ESC  เพื่อปิดโปรแกรม');
  console.log('══════════════════════════════════════════════════════');
  setupKeyExit();
});

// รับปุ่มกดจากแป้นพิมพ์เพื่อปิดโปรแกรม: กด ESC (หรือ Q / Ctrl+C) เพื่อออก
function setupKeyExit() {
  if (!process.stdin.isTTY) return; // ไม่มีหน้าจอ console (เช่นรันเป็น service) ก็ข้ามไป
  try {
    process.stdin.setRawMode(true);
  } catch (_) {
    return;
  }
  process.stdin.resume();
  process.stdin.on('data', (buf) => {
    const b = buf[0];
    // ESC = 0x1b, Ctrl+C = 0x03, q = 0x71, Q = 0x51
    if (b === 0x1b || b === 0x03 || b === 0x71 || b === 0x51) {
      console.log('\n[AGENT] กำลังปิดโปรแกรม... ขอบคุณครับ');
      process.exit(0);
    }
  });
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[AGENT] พอร์ต ${PORT} ถูกใช้งานอยู่แล้ว — อาจเปิด Agent ซ้ำ`);
  } else {
    console.error('[AGENT] เซิร์ฟเวอร์ผิดพลาด:', err.message);
  }
  process.exit(1);
});

/* ------------------------------------------------------------------ */
/*  ส่วนอ่านบัตร PC/SC                                                   */
/* ------------------------------------------------------------------ */
const connectedReaders = new Map(); // name -> reader

function readerNames() {
  return Array.from(connectedReaders.keys());
}

function transmit(reader, protocol, bytes, resLen = 258) {
  return new Promise((resolve, reject) => {
    reader.transmit(Buffer.from(bytes), resLen, protocol, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

function readThaiIdCard(reader, atr) {
  reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, async (err, protocol) => {
    if (err) {
      console.error('[AGENT] เชื่อมต่อบัตรไม่สำเร็จ:', err.message);
      broadcast({ type: 'card-error', message: 'อ่านบัตรไม่สำเร็จ กรุณาเสียบบัตรใหม่' });
      return;
    }
    try {
      const getResponse =
        atr && atr[0] === 0x3b && atr[1] === 0x67
          ? [0x00, 0xc0, 0x00, 0x01]
          : [0x00, 0xc0, 0x00, 0x00];

      const readField = async (cmd) => {
        await transmit(reader, protocol, cmd);
        const expectLen = cmd[cmd.length - 1];
        const data = await transmit(reader, protocol, [...getResponse, expectLen]);
        return data.slice(0, -2); // ตัด Status Word (SW1 SW2)
      };

      await transmit(reader, protocol, APDU.SELECT_THAI_ID);

      const cidRaw = await readField(APDU.CID);
      const nameRaw = await readField(APDU.FULLNAME_TH);

      const citizenId = cidRaw.toString('ascii').replace(/\D/g, '');
      const fullName = iconv
        .decode(nameRaw, 'tis620')
        .replace(/\0/g, '')
        .split('#')
        .map((s) => s.trim())
        .filter(Boolean)
        .join(' ')
        .trim();

      if (citizenId.length !== 13 || !fullName) {
        throw new Error('ข้อมูลบนบัตรไม่ถูกต้อง');
      }

      console.log(`[AGENT] อ่านบัตรสำเร็จ: ${citizenId.substring(0, 4)}********* ${fullName}`);
      broadcast({ type: 'card', citizenId, fullName });
    } catch (e) {
      console.error('[AGENT] อ่านข้อมูลบัตรผิดพลาด:', e.message);
      broadcast({ type: 'card-error', message: 'อ่านบัตรไม่สำเร็จ กรุณาเสียบบัตรใหม่อีกครั้ง' });
    } finally {
      reader.disconnect(reader.SCARD_LEAVE_CARD, () => {});
    }
  });
}

function startPcsc() {
  let pcsc;
  try {
    pcsc = pcsclite();
  } catch (e) {
    console.error('[AGENT] เริ่มระบบ PC/SC ไม่สำเร็จ:', e.message);
    console.error('        ตรวจว่าติดตั้งไดรเวอร์เครื่องอ่านบัตร/บริการ Smart Card แล้ว');
    process.exit(1);
  }

  pcsc.on('reader', (reader) => {
    console.log(`[AGENT] พบเครื่องอ่านบัตร: ${reader.name}`);
    connectedReaders.set(reader.name, reader);
    broadcast({ type: 'reader', connected: true, name: readerNames().join(', ') });

    reader.on('status', (status) => {
      const changes = reader.state ^ status.state;
      if (!changes) return;

      if (changes & reader.SCARD_STATE_EMPTY && status.state & reader.SCARD_STATE_EMPTY) {
        reader.disconnect(reader.SCARD_LEAVE_CARD, () => {});
        broadcast({ type: 'card-removed' });
        console.log('[AGENT] บัตรถูกดึงออก');
      } else if (changes & reader.SCARD_STATE_PRESENT && status.state & reader.SCARD_STATE_PRESENT) {
        broadcast({ type: 'card-inserted' });
        console.log('[AGENT] ตรวจพบบัตร กำลังอ่านข้อมูล...');
        setTimeout(() => readThaiIdCard(reader, status.atr), 400);
      }
    });

    reader.on('error', (err) => console.error(`[AGENT] reader error: ${err.message}`));
    reader.on('end', () => {
      console.log('[AGENT] เครื่องอ่านบัตรถูกถอดออก');
      connectedReaders.delete(reader.name);
      const names = readerNames();
      broadcast({ type: 'reader', connected: names.length > 0, name: names.join(', ') });
    });
  });

  pcsc.on('error', (err) => {
    console.error(`[AGENT] PC/SC error: ${err.message}`);
  });
}

startPcsc();
