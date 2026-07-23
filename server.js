/**
 * =====================================================================
 *  ระบบเลือกตั้งอิเล็กทรอนิกส์หน้างาน (On-site E-Voting System)
 *  - Node.js + Express + Socket.io + MySQL
 *  - อ่านบัตรประชาชนไทยผ่านเครื่องอ่านบัตร USB (PC/SC)
 *  - ป้องกันการลงคะแนนซ้ำ / บันทึกกิจกรรมนักศึกษา / นับคะแนนแบบนิรนาม
 * =====================================================================
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { exec } = require('child_process');
const express = require('express');
const multer = require('multer');
const session = require('express-session');
const http = require('http');
const { Server } = require('socket.io');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const iconv = require('iconv-lite');

/* ------------------------------------------------------------------ */
/*  โหลดไฟล์ .env อย่างง่าย (ถ้ามี) — ไม่ต้องพึ่งแพ็กเกจ dotenv            */
/* ------------------------------------------------------------------ */
try {
  const envFile = require('fs').readFileSync(path.join(__dirname, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  }
} catch (e) {
  /* ไม่มีไฟล์ .env ก็ใช้ค่าเริ่มต้น */
}

/* ------------------------------------------------------------------ */
/*  การตั้งค่า (แก้ไขได้ผ่านไฟล์ .env หรือ Environment Variables)        */
/* ------------------------------------------------------------------ */
const CONFIG = {
  PORT: parseInt(process.env.PORT || '3000', 10),
  DB_HOST: process.env.DB_HOST || 'localhost',
  DB_USER: process.env.DB_USER || 'root',
  DB_PASS: process.env.DB_PASS || '',
  DB_NAME: process.env.DB_NAME || 'evoting_db',
  SESSION_SECRET: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  // เปิดโหมดจำลองบัตร (สำหรับทดสอบโดยไม่มีเครื่องอ่านบัตร): set DEMO_MODE=1
  DEMO_MODE: process.env.DEMO_MODE === '1',
  // โหมด Local Agent: อ่านบัตรจริงผ่านโปรแกรม card-agent บนเครื่องคูหา (ไม่ใช่บนเซิร์ฟเวอร์)
  // ตั้ง AGENT_MODE=1 เมื่อโฮสต์บน Cloud/Coolify — หน้าตรวจสอบระบบจะไม่ถือว่าเซิร์ฟเวอร์
  // ต้องมีเครื่องอ่านบัตร/ไลบรารี PC/SC ในตัว
  AGENT_MODE: process.env.AGENT_MODE === '1',
};

let pool; // MySQL connection pool

/* ------------------------------------------------------------------ */
/*  สร้างฐานข้อมูล + ตาราง + ข้อมูลเริ่มต้นอัตโนมัติ (Single-run setup)   */
/* ------------------------------------------------------------------ */
async function initDatabase() {
  const conn = await mysql.createConnection({
    host: CONFIG.DB_HOST,
    user: CONFIG.DB_USER,
    password: CONFIG.DB_PASS,
    charset: 'utf8mb4',
  });

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${CONFIG.DB_NAME}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${CONFIG.DB_NAME}\``);

  // ตารางที่ 1: บันทึกกิจกรรม (ใช้ตรวจสอบการลงคะแนนซ้ำด้วย)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      citizen_id VARCHAR(13) NOT NULL UNIQUE,
      full_name VARCHAR(255) NOT NULL,
      voted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตารางที่ 2: ผู้สมัครและคะแนน (นับคะแนนแบบนิรนาม — ไม่ผูกกับผู้ลงคะแนน)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS vote_candidates (
      candidate_no INT PRIMARY KEY,
      candidate_name VARCHAR(255) NOT NULL,
      photo_url VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      vote_count INT NOT NULL DEFAULT 0
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Migration: เพิ่มคอลัมน์ description ให้ฐานข้อมูลรุ่นเก่าที่สร้างไว้แล้ว
  const [descCol] = await conn.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'vote_candidates' AND COLUMN_NAME = 'description'`,
    [CONFIG.DB_NAME]
  );
  if (descCol.length === 0) {
    await conn.query(`ALTER TABLE vote_candidates ADD COLUMN description TEXT DEFAULT NULL AFTER photo_url`);
    console.log('[DB] เพิ่มคอลัมน์ description ในตาราง vote_candidates');
  }

  // ตารางที่ 3: ผู้ดูแลระบบ
  await conn.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ข้อมูลผู้สมัครเริ่มต้น
  await conn.query(`
    INSERT IGNORE INTO vote_candidates (candidate_no, candidate_name, photo_url, vote_count) VALUES
      (1,  'นายสมชาย ใจดี',        '/img/candidate1.svg', 0),
      (2,  'นางสาวสมหญิง รักเรียน', '/img/candidate2.svg', 0),
      (99, 'ไม่ประสงค์ลงคะแนน',     '/img/novote.svg',     0)
  `);

  // บัญชีผู้ดูแลเริ่มต้น admin / password123 (เก็บเป็น bcrypt hash)
  const [admins] = await conn.query(`SELECT id FROM admin_users WHERE username = 'admin'`);
  if (admins.length === 0) {
    const hash = await bcrypt.hash('password123', 10);
    await conn.query(`INSERT INTO admin_users (username, password) VALUES ('admin', ?)`, [hash]);
    console.log('[DB] สร้างบัญชีผู้ดูแลเริ่มต้น: admin / password123');
  }

  await conn.end();

  pool = mysql.createPool({
    host: CONFIG.DB_HOST,
    user: CONFIG.DB_USER,
    password: CONFIG.DB_PASS,
    database: CONFIG.DB_NAME,
    charset: 'utf8mb4',
    waitForConnections: true,
    connectionLimit: 10,
  });

  console.log(`[DB] เชื่อมต่อฐานข้อมูล "${CONFIG.DB_NAME}" สำเร็จ`);
}

/* ------------------------------------------------------------------ */
/*  Express + Socket.io                                                */
/* ------------------------------------------------------------------ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(
  session({
    secret: CONFIG.SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, maxAge: 8 * 60 * 60 * 1000 }, // 8 ชั่วโมง
  })
);

/* ------------------------------------------------------------------ */
/*  อัปโหลดรูปผู้สมัคร (เก็บใน public/img/uploads)                       */
/* ------------------------------------------------------------------ */
const UPLOAD_DIR = path.join(__dirname, 'public', 'img', 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname) || '.png').toLowerCase();
      cb(null, `candidate_${Date.now()}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    },
  }),
  limits: { fileSize: 3 * 1024 * 1024 }, // สูงสุด 3 MB
  fileFilter: (req, file, cb) => {
    const ok = /^image\/(png|jpe?g|gif|webp|svg\+xml)$/.test(file.mimetype);
    cb(ok ? null : new Error('รองรับเฉพาะไฟล์รูปภาพ (PNG/JPG/GIF/WebP/SVG)'), ok);
  },
});

// ลบไฟล์รูปที่ระบบอัปโหลดไว้ (ลบเฉพาะไฟล์ใน uploads เท่านั้น เพื่อไม่แตะรูปตัวอย่าง)
function deleteUploadedPhoto(photoUrl) {
  if (!photoUrl || !photoUrl.startsWith('/img/uploads/')) return;
  const filePath = path.join(UPLOAD_DIR, path.basename(photoUrl));
  fs.unlink(filePath, () => {});
}

/* ------------------------------------------------------------------ */
/*  Vote Token — ออกให้เมื่อยืนยันตัวตนสำเร็จ ใช้ลงคะแนนได้ครั้งเดียว      */
/*  (ไม่เก็บเลขบัตรคู่กับ token ฝั่งลงคะแนน เพื่อความนิรนามของบัตรเลือกตั้ง) */
/* ------------------------------------------------------------------ */
const voteTokens = new Map(); // token -> expiresAt
const TOKEN_TTL_MS = 5 * 60 * 1000;

function issueVoteToken() {
  const token = crypto.randomBytes(24).toString('hex');
  voteTokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}
function consumeVoteToken(token) {
  const exp = voteTokens.get(token);
  if (!exp) return false;
  voteTokens.delete(token);
  return exp > Date.now();
}
setInterval(() => {
  const now = Date.now();
  for (const [t, exp] of voteTokens) if (exp <= now) voteTokens.delete(t);
}, 60 * 1000).unref();

/* ------------------------------------------------------------------ */
/*  ขั้นตอนตรวจสอบผู้ลงคะแนน (e-KYC + กันลงคะแนนซ้ำ)                     */
/* ------------------------------------------------------------------ */
// emitter = ปลายทางที่จะส่งผลลัพธ์กลับ:
//   - io (ค่าเริ่มต้น) → กระจายให้ทุกหน้าจอ ใช้กับเครื่องอ่านบัตรฝั่งเซิร์ฟเวอร์ (bare-metal) และ DEMO_MODE
//   - socket ของสถานีนั้น ๆ → ตอบเฉพาะเครื่องที่เสียบบัตร ใช้กับสถานีที่อ่านบัตรผ่าน Local Agent
//     (จำเป็นเมื่อมีหลายเครื่องพร้อมกัน ไม่งั้นบัตรที่เครื่องหนึ่งจะปลดล็อกบัตรเลือกตั้งของทุกเครื่อง)
async function processVoter(citizenId, fullName, emitter = io) {
  try {
    const [rows] = await pool.query(
      'SELECT id FROM activity_logs WHERE citizen_id = ?',
      [citizenId]
    );

    if (rows.length > 0) {
      // เคยลงคะแนนแล้ว
      emitter.emit('already-voted', { fullName });
      console.log(`[KIOSK] ปฏิเสธ: ${fullName} (ลงคะแนนไปแล้ว)`);
      return;
    }

    // ลงทะเบียนกิจกรรมทันที แล้วปลดล็อกหน้าบัตรเลือกตั้ง
    await pool.query(
      'INSERT INTO activity_logs (citizen_id, full_name) VALUES (?, ?)',
      [citizenId, fullName]
    );

    const token = issueVoteToken();
    emitter.emit('auth-success', { fullName, token });
    console.log(`[KIOSK] ยืนยันตัวตนสำเร็จ: ${fullName}`);
  } catch (err) {
    // กันกรณี race: เสียบบัตรซ้ำเร็ว ๆ จน INSERT ชน UNIQUE
    if (err && err.code === 'ER_DUP_ENTRY') {
      emitter.emit('already-voted', { fullName });
      return;
    }
    console.error('[KIOSK] ผิดพลาดขณะตรวจสอบผู้ลงคะแนน:', err.message);
    emitter.emit('card-error', { message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่' });
  }
}

/* ------------------------------------------------------------------ */
/*  เครื่องอ่านบัตรประชาชนไทย (PC/SC ผ่าน @pokusew/pcsclite)             */
/* ------------------------------------------------------------------ */
const APDU = {
  // เลือก Applet ของบัตรประชาชนไทย
  SELECT_THAI_ID: [0x00, 0xa4, 0x04, 0x00, 0x08, 0xa0, 0x00, 0x00, 0x00, 0x54, 0x48, 0x00, 0x01],
  // เลขประจำตัวประชาชน 13 หลัก
  CID: [0x80, 0xb0, 0x00, 0x04, 0x02, 0x00, 0x0d],
  // ชื่อ-นามสกุล (ภาษาไทย)
  FULLNAME_TH: [0x80, 0xb0, 0x00, 0x11, 0x02, 0x00, 0x64],
};

/* สถานะล่าสุดของระบบอ่านบัตร — ใช้แสดงในหน้าตรวจสอบทรัพยากรระบบ */
const cardReaderState = {
  moduleLoaded: false,   // โหลดไลบรารี @pokusew/pcsclite ได้หรือไม่
  moduleError: null,     // สาเหตุที่โหลดไม่ได้
  pcscError: null,       // ข้อผิดพลาดล่าสุดจากบริการ PC/SC
  readers: [],           // ชื่อเครื่องอ่านบัตรที่เชื่อมต่ออยู่ขณะนี้
  lastCardReadAt: null,  // เวลาที่อ่านบัตรสำเร็จครั้งล่าสุด
};

function initSmartCardReader() {
  let pcsclite;
  try {
    pcsclite = require('@pokusew/pcsclite');
    cardReaderState.moduleLoaded = true;
  } catch (e) {
    cardReaderState.moduleError = e.message;
    console.warn('──────────────────────────────────────────────────────');
    console.warn('[CARD] ไม่พบไลบรารี @pokusew/pcsclite — ระบบทำงานต่อได้');
    console.warn('       แต่จะอ่านบัตรจริงไม่ได้ (ใช้ DEMO_MODE=1 เพื่อทดสอบ)');
    console.warn('──────────────────────────────────────────────────────');
    return;
  }

  const pcsc = pcsclite();

  pcsc.on('reader', (reader) => {
    console.log(`[CARD] พบเครื่องอ่านบัตร: ${reader.name}`);
    if (!cardReaderState.readers.includes(reader.name)) cardReaderState.readers.push(reader.name);
    io.emit('reader-status', { connected: true, name: reader.name });

    reader.on('status', (status) => {
      const changes = reader.state ^ status.state;
      if (!changes) return;

      // ดึงบัตรออก
      if (changes & reader.SCARD_STATE_EMPTY && status.state & reader.SCARD_STATE_EMPTY) {
        reader.disconnect(reader.SCARD_LEAVE_CARD, () => {});
        io.emit('card-removed');
        console.log('[CARD] บัตรถูกดึงออก');
      }
      // เสียบบัตร
      else if (changes & reader.SCARD_STATE_PRESENT && status.state & reader.SCARD_STATE_PRESENT) {
        io.emit('card-inserted');
        console.log('[CARD] ตรวจพบบัตร กำลังอ่านข้อมูล...');
        // หน่วงเล็กน้อยให้บัตรพร้อมใช้งาน
        setTimeout(() => readThaiIdCard(reader, status.atr), 400);
      }
    });

    reader.on('error', (err) => console.error(`[CARD] reader error: ${err.message}`));
    reader.on('end', () => {
      console.log('[CARD] เครื่องอ่านบัตรถูกถอดออก');
      cardReaderState.readers = cardReaderState.readers.filter((n) => n !== reader.name);
      io.emit('reader-status', { connected: false });
    });
  });

  pcsc.on('error', (err) => {
    console.error(`[CARD] PC/SC error: ${err.message}`);
    cardReaderState.pcscError = err.message;
    io.emit('reader-status', { connected: false });
  });
}

function transmit(reader, protocol, bytes, resLen = 258) {
  return new Promise((resolve, reject) => {
    reader.transmit(Buffer.from(bytes), resLen, protocol, (err, data) => {
      if (err) reject(err);
      else resolve(data);
    });
  });
}

async function readThaiIdCard(reader, atr) {
  reader.connect({ share_mode: reader.SCARD_SHARE_SHARED }, async (err, protocol) => {
    if (err) {
      console.error('[CARD] เชื่อมต่อบัตรไม่สำเร็จ:', err.message);
      io.emit('card-error', { message: 'อ่านบัตรไม่สำเร็จ กรุณาเสียบบัตรใหม่' });
      return;
    }

    try {
      // คำสั่ง GET RESPONSE ต่างกันตามรุ่นของบัตร (ดูจาก ATR)
      const getResponse =
        atr && atr[0] === 0x3b && atr[1] === 0x67
          ? [0x00, 0xc0, 0x00, 0x01]
          : [0x00, 0xc0, 0x00, 0x00];

      const readField = async (cmd) => {
        await transmit(reader, protocol, cmd);
        const expectLen = cmd[cmd.length - 1];
        const data = await transmit(reader, protocol, [...getResponse, expectLen]);
        return data.slice(0, -2); // ตัด Status Word (SW1 SW2) ท้ายข้อมูล
      };

      await transmit(reader, protocol, APDU.SELECT_THAI_ID);

      const cidRaw = await readField(APDU.CID);
      const nameRaw = await readField(APDU.FULLNAME_TH);

      const citizenId = cidRaw.toString('ascii').replace(/\D/g, '');
      // ชื่อบนบัตรเข้ารหัส TIS-620 รูปแบบ "คำนำหน้า#ชื่อ#ชื่อกลาง#นามสกุล"
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

      console.log(`[CARD] อ่านบัตรสำเร็จ: ${citizenId.substring(0, 4)}********* ${fullName}`);
      cardReaderState.lastCardReadAt = new Date().toISOString();
      await processVoter(citizenId, fullName);
    } catch (e) {
      console.error('[CARD] อ่านข้อมูลบัตรผิดพลาด:', e.message);
      io.emit('card-error', { message: 'อ่านบัตรไม่สำเร็จ กรุณาเสียบบัตรใหม่อีกครั้ง' });
    } finally {
      reader.disconnect(reader.SCARD_LEAVE_CARD, () => {});
    }
  });
}

/* ------------------------------------------------------------------ */
/*  Socket.io                                                          */
/* ------------------------------------------------------------------ */
io.on('connection', (socket) => {
  // ── สถานีที่อ่านบัตรผ่าน Local Agent (โหมด Cloud + Agent) ─────────────
  // หน้าคูหาบนเครื่องที่เสียบเครื่องอ่านบัตรจะรับข้อมูลบัตรจาก Agent ที่รันบน
  // เครื่องเดียวกัน (ws://127.0.0.1) แล้วส่งต่อมาที่นี่ ผลลัพธ์ตอบกลับเฉพาะ
  // socket ของสถานีนั้น เพื่อให้รองรับหลายเครื่องพร้อมกันได้
  socket.on('station-card', async (payload) => {
    const citizenId = String((payload && payload.citizenId) || '').replace(/\D/g, '');
    const fullName = String((payload && payload.fullName) || '').trim();
    if (citizenId.length !== 13 || !fullName) {
      socket.emit('card-error', { message: 'ข้อมูลบัตรไม่ถูกต้อง กรุณาเสียบบัตรใหม่' });
      return;
    }
    cardReaderState.lastCardReadAt = new Date().toISOString();
    await processVoter(citizenId, fullName, socket);
  });

  // โหมดจำลองบัตร (เฉพาะตอนตั้ง DEMO_MODE=1) — ใช้ทดสอบระบบโดยไม่มีเครื่องอ่านบัตร
  if (CONFIG.DEMO_MODE) {
    socket.on('demo-card', async (payload) => {
      const citizenId = String((payload && payload.citizenId) || '').replace(/\D/g, '');
      const fullName = String((payload && payload.fullName) || 'นายทดสอบ ระบบ').trim();
      if (citizenId.length !== 13) {
        socket.emit('card-error', { message: 'เลขบัตรจำลองต้องมี 13 หลัก' });
        return;
      }
      io.emit('card-inserted');
      setTimeout(() => processVoter(citizenId, fullName), 600);
    });
  }
});

/* ------------------------------------------------------------------ */
/*  API สาธารณะ (หน้าจอลงคะแนน)                                         */
/* ------------------------------------------------------------------ */

// รายชื่อผู้สมัคร (ไม่ส่ง vote_count เพื่อไม่ให้เห็นคะแนนที่หน้าคูหา)
app.get('/api/candidates', async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT candidate_no, candidate_name, photo_url, description FROM vote_candidates ORDER BY candidate_no ASC'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

// ลงคะแนน (นิรนาม) — ต้องมี vote token ที่ได้จากการเสียบบัตรเท่านั้น
app.post('/api/vote', async (req, res) => {
  const { candidate_no, token } = req.body || {};

  if (!consumeVoteToken(token)) {
    return res.status(403).json({ ok: false, error: 'ไม่มีสิทธิ์ลงคะแนน กรุณาเสียบบัตรใหม่' });
  }

  try {
    const [result] = await pool.query(
      'UPDATE vote_candidates SET vote_count = vote_count + 1 WHERE candidate_no = ?',
      [parseInt(candidate_no, 10)]
    );
    if (result.affectedRows === 0) {
      return res.status(400).json({ ok: false, error: 'ไม่พบหมายเลขผู้สมัคร' });
    }
    console.log(`[VOTE] มีการลงคะแนนให้หมายเลข ${candidate_no} (นิรนาม)`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  ส่วนผู้ดูแลระบบ (Admin Portal)                                       */
/* ------------------------------------------------------------------ */
function requireAdmin(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.redirect('/admin/login');
}
function requireAdminApi(req, res, next) {
  if (req.session && req.session.adminId) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.get('/admin', (req, res) => {
  res.redirect(req.session && req.session.adminId ? '/admin/dashboard' : '/admin/login');
});

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.adminId) return res.redirect('/admin/dashboard');
  res.sendFile(path.join(__dirname, 'views', 'admin-login.html'));
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  try {
    const [rows] = await pool.query('SELECT * FROM admin_users WHERE username = ?', [
      String(username || ''),
    ]);
    const admin = rows[0];

    // รองรับทั้งรหัสผ่านแบบ bcrypt hash และแบบ plaintext (กรณี import จาก database.sql)
    let valid = false;
    if (admin) {
      if (admin.password.startsWith('$2')) {
        valid = await bcrypt.compare(String(password || ''), admin.password);
      } else {
        valid = admin.password === String(password || '');
      }
    }

    if (!valid) {
      return res.redirect('/admin/login?error=1');
    }

    req.session.adminId = admin.id;
    req.session.adminUsername = admin.username;
    res.redirect('/admin/dashboard');
  } catch (e) {
    console.error('[ADMIN] login error:', e.message);
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'admin-dashboard.html'));
});

// รายการบันทึกกิจกรรมนักศึกษา (ตรวจสอบการเข้าร่วม)
app.get('/admin/api/logs', requireAdminApi, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT citizen_id, full_name,
              DATE_FORMAT(voted_at, '%d/%m/%Y %H:%i:%s') AS voted_at
       FROM activity_logs ORDER BY voted_at DESC, id DESC`
    );
    res.json({ total: rows.length, logs: rows, username: req.session.adminUsername });
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

// ผลคะแนนสด
app.get('/admin/api/results', requireAdminApi, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT candidate_no, candidate_name, photo_url, vote_count FROM vote_candidates ORDER BY candidate_no ASC'
    );
    const totalVotes = rows.reduce((sum, r) => sum + r.vote_count, 0);
    res.json({ totalVotes, results: rows });
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  ตรวจสอบทรัพยากรที่ระบบต้องใช้ (System Requirements Check)            */
/*  - เครื่องอ่านบัตร / ไลบรารีของระบบปฏิบัติการ / เซิร์ฟเวอร์+ฐานข้อมูล    */
/*  (ส่วนความเข้ากันได้ของเบราว์เซอร์ตรวจฝั่งหน้าเว็บ)                     */
/* ------------------------------------------------------------------ */

// รันคำสั่งของระบบปฏิบัติการแบบไม่โยน error — คืน stdout หรือ null เมื่อล้มเหลว
function execSafe(cmd, timeout = 5000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? null : String(stdout)));
  });
}

// ตรวจว่ามีโมดูล npm ตัวนี้ติดตั้งอยู่หรือไม่ พร้อมอ่านเลขเวอร์ชัน
function inspectModule(name) {
  try {
    const pkgPath = require.resolve(`${name}/package.json`, { paths: [__dirname] });
    return { installed: true, version: JSON.parse(fs.readFileSync(pkgPath, 'utf8')).version };
  } catch (e) {
    // บางโมดูลไม่ยอมให้เข้าถึง package.json ตรง ๆ (exports) — ลอง resolve ตัวโมดูลแทน
    try {
      require.resolve(name, { paths: [__dirname] });
      return { installed: true, version: null };
    } catch (e2) {
      return { installed: false, version: null };
    }
  }
}

// ไลบรารี PC/SC ของระบบปฏิบัติการที่ @pokusew/pcsclite เรียกใช้
function pcscLibraryInfo() {
  if (process.platform === 'win32') {
    const dll = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'winscard.dll');
    return { label: 'winscard.dll (Windows Smart Card API)', path: dll, found: fs.existsSync(dll) };
  }
  if (process.platform === 'darwin') {
    const fw = '/System/Library/Frameworks/PCSC.framework';
    return { label: 'PCSC.framework (macOS)', path: fw, found: fs.existsSync(fw) };
  }
  const candidates = [
    '/usr/lib/x86_64-linux-gnu/libpcsclite.so.1',
    '/usr/lib/aarch64-linux-gnu/libpcsclite.so.1',
    '/usr/lib/libpcsclite.so.1',
    '/lib/x86_64-linux-gnu/libpcsclite.so.1',
    '/usr/lib64/libpcsclite.so.1',
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  return { label: 'libpcsclite.so.1 (PC/SC Lite)', path: hit || candidates[0], found: Boolean(hit) };
}

// สถานะบริการ PC/SC ของระบบปฏิบัติการ
async function pcscServiceStatus() {
  if (process.platform === 'win32') {
    const out = await execSafe('sc query SCardSvr');
    if (out === null) return { label: 'บริการ Smart Card (SCardSvr)', state: 'ตรวจสอบไม่ได้', running: null };
    if (/RUNNING/i.test(out)) return { label: 'บริการ Smart Card (SCardSvr)', state: 'กำลังทำงาน (RUNNING)', running: true };
    if (/STOPPED/i.test(out)) return { label: 'บริการ Smart Card (SCardSvr)', state: 'หยุดทำงาน (STOPPED)', running: false };
    return { label: 'บริการ Smart Card (SCardSvr)', state: 'ไม่ทราบสถานะ', running: null };
  }
  if (process.platform === 'darwin') {
    return { label: 'บริการ PC/SC (com.apple.ifdreader)', state: 'มาพร้อมระบบปฏิบัติการ', running: true };
  }
  const out = await execSafe('systemctl is-active pcscd');
  if (out === null) return { label: 'บริการ PC/SC (pcscd)', state: 'ไม่ทำงาน หรือตรวจสอบไม่ได้', running: false };
  const state = out.trim();
  return { label: 'บริการ PC/SC (pcscd)', state, running: state === 'active' };
}

app.get('/admin/api/system-check', requireAdminApi, async (req, res) => {
  try {
    const checks = [];
    const add = (group, name, status, value, hint) => checks.push({ group, name, status, value, hint: hint || null });

    // เซิร์ฟเวอร์ไม่จำเป็นต้องมีเครื่องอ่านบัตร/ไลบรารี PC/SC ในตัว เมื่อ:
    //   - DEMO_MODE: จำลองบัตรเพื่อทดสอบ  หรือ
    //   - AGENT_MODE: อ่านบัตรจริงผ่าน Local Agent บนเครื่องคูหา (โฮสต์บน Cloud)
    // ในกรณีเหล่านี้ให้แสดงเป็นคำเตือน/ข้อมูล ไม่ใช่ข้อผิดพลาด (fail)
    const cardStackOptional = CONFIG.DEMO_MODE || CONFIG.AGENT_MODE;
    const optionalReason = CONFIG.AGENT_MODE
      ? 'โหมด Local Agent เปิดอยู่ — อ่านบัตรจริงผ่านโปรแกรม card-agent บนเครื่องคูหา จึงไม่จำเป็นบนเซิร์ฟเวอร์'
      : 'ขณะนี้เปิด DEMO_MODE อยู่ จึงไม่จำเป็นต้องมี (จำเป็นเฉพาะเมื่ออ่านบัตรบนเซิร์ฟเวอร์โดยตรง)';

    /* ---------- กลุ่มที่ 1: เครื่องอ่านบัตรประชาชน ---------- */
    if (CONFIG.AGENT_MODE) {
      add('reader', 'โหมดอ่านบัตร', 'ok',
        'Local Agent (อ่านบัตรบนเครื่องคูหา)',
        'เปิดโปรแกรม card-agent บนเครื่องที่เสียบเครื่องอ่านบัตร แล้วเปิดหน้าคูหาบนเครื่องเดียวกัน');
    }
    if (cardReaderState.moduleLoaded) {
      const mod = inspectModule('@pokusew/pcsclite');
      add('reader', 'ไลบรารีอ่านบัตร @pokusew/pcsclite', 'ok',
        `ติดตั้งแล้ว${mod.version ? ` (v${mod.version})` : ''}`);
    } else {
      add('reader', 'ไลบรารีอ่านบัตร @pokusew/pcsclite',
        cardStackOptional ? 'warn' : 'fail',
        'ไม่พบไลบรารี (บนเซิร์ฟเวอร์)',
        cardStackOptional
          ? optionalReason
          : 'ติดตั้งด้วยคำสั่ง: npm install @pokusew/pcsclite (ต้องมีเครื่องมือคอมไพล์ของระบบ)');
    }

    const readerCount = cardReaderState.readers.length;
    add('reader', 'เครื่องอ่านบัตร USB ที่เชื่อมต่ออยู่ (บนเซิร์ฟเวอร์)',
      readerCount > 0 ? 'ok' : 'warn',
      readerCount > 0 ? cardReaderState.readers.join(', ') : 'ไม่พบเครื่องอ่านบัตร',
      readerCount > 0 ? null : CONFIG.AGENT_MODE
        ? 'โหมด Local Agent: เครื่องอ่านบัตรอยู่ที่เครื่องคูหา ไม่ใช่เซิร์ฟเวอร์ (ตรวจสถานะได้ที่หน้าคูหา)'
        : 'เสียบเครื่องอ่านบัตรเข้าพอร์ต USB แล้วกดตรวจสอบอีกครั้ง');

    add('reader', 'อ่านบัตรสำเร็จครั้งล่าสุด',
      cardReaderState.lastCardReadAt ? 'ok' : 'warn',
      cardReaderState.lastCardReadAt
        ? new Date(cardReaderState.lastCardReadAt).toLocaleString('th-TH')
        : 'ยังไม่เคยอ่านบัตรตั้งแต่เปิดเซิร์ฟเวอร์',
      cardReaderState.lastCardReadAt ? null : 'ทดลองเสียบบัตรประชาชนที่หน้าคูหาเพื่อยืนยันการทำงาน');

    if (cardReaderState.pcscError) {
      add('reader', 'ข้อผิดพลาดล่าสุดของ PC/SC', 'fail', cardReaderState.pcscError);
    }

    add('reader', 'โหมดจำลองบัตร (DEMO_MODE)',
      CONFIG.DEMO_MODE ? 'warn' : 'ok',
      CONFIG.DEMO_MODE ? 'เปิดใช้งาน — ใช้สำหรับทดสอบเท่านั้น' : 'ปิด (โหมดใช้งานจริง)',
      CONFIG.DEMO_MODE ? 'ก่อนใช้งานเลือกตั้งจริง ให้ตั้งค่า DEMO_MODE=0 ในไฟล์ .env' : null);

    /* ---------- กลุ่มที่ 2: ไลบรารีของระบบปฏิบัติการ ---------- */
    // เมื่อ DEMO_MODE หรือ AGENT_MODE (เช่น รันบน Cloud/Docker ที่ไม่มีเครื่องอ่านบัตร)
    // ไลบรารีและบริการ PC/SC ของระบบปฏิบัติการฝั่งเซิร์ฟเวอร์ไม่จำเป็นต้องมี จึงแสดง
    // เป็นคำเตือน (warn) แทนข้อผิดพลาด (fail) — บังคับให้ต้องมีเฉพาะเมื่ออ่านบัตรบน
    // เซิร์ฟเวอร์โดยตรง (bare-metal)
    const lib = pcscLibraryInfo();
    add('os', lib.label, lib.found ? 'ok' : cardStackOptional ? 'warn' : 'fail',
      lib.found ? `พบที่ ${lib.path}` : `ไม่พบที่ ${lib.path}`,
      lib.found ? null : cardStackOptional
        ? optionalReason
        : 'ระบบปฏิบัติการนี้ยังไม่มีไลบรารี PC/SC — ติดตั้งไดรเวอร์เครื่องอ่านบัตรก่อน');

    const svc = await pcscServiceStatus();
    const svcStatus = svc.running === true ? 'ok' : cardStackOptional ? 'warn' : svc.running === false ? 'fail' : 'warn';
    add('os', svc.label, svcStatus,
      svc.state,
      svc.running === true ? null : cardStackOptional
        ? optionalReason
        : 'เปิดบริการ Smart Card ของระบบปฏิบัติการก่อนใช้งานเครื่องอ่านบัตร');

    add('os', 'ระบบปฏิบัติการ', 'ok', `${os.type()} ${os.release()} (${process.arch})`);
    add('os', 'หน่วยประมวลผล (CPU)', 'ok',
      `${(os.cpus()[0] || {}).model || 'ไม่ทราบรุ่น'} — ${os.cpus().length} คอร์`);

    const totalMemGb = os.totalmem() / 1024 ** 3;
    const freeMemGb = os.freemem() / 1024 ** 3;
    add('os', 'หน่วยความจำ (RAM)',
      totalMemGb >= 2 ? 'ok' : 'warn',
      `ทั้งหมด ${totalMemGb.toFixed(1)} GB — ว่าง ${freeMemGb.toFixed(1)} GB`,
      totalMemGb >= 2 ? null : 'แนะนำอย่างน้อย 2 GB สำหรับเครื่องคูหา');

    /* ---------- กลุ่มที่ 3: เซิร์ฟเวอร์และฐานข้อมูล ---------- */
    const nodeMajor = parseInt(process.versions.node.split('.')[0], 10);
    add('server', 'Node.js', nodeMajor >= 18 ? 'ok' : 'fail',
      `v${process.versions.node}`,
      nodeMajor >= 18 ? null : 'ระบบต้องใช้ Node.js เวอร์ชัน 18 ขึ้นไป');

    try {
      const [[row]] = await pool.query('SELECT VERSION() AS v');
      add('server', 'ฐานข้อมูล MySQL / MariaDB', 'ok', `เชื่อมต่อได้ — v${row.v} (${CONFIG.DB_NAME})`);
    } catch (e) {
      add('server', 'ฐานข้อมูล MySQL / MariaDB', 'fail', `เชื่อมต่อไม่ได้ — ${e.message}`,
        'เปิด MySQL ใน XAMPP แล้วตรวจค่า DB_HOST / DB_USER / DB_PASS ในไฟล์ .env');
    }

    for (const name of ['express', 'socket.io', 'mysql2', 'multer', 'bcryptjs', 'iconv-lite', 'express-session']) {
      const mod = inspectModule(name);
      add('server', `แพ็กเกจ ${name}`,
        mod.installed ? 'ok' : 'fail',
        mod.installed ? `ติดตั้งแล้ว${mod.version ? ` (v${mod.version})` : ''}` : 'ไม่พบ',
        mod.installed ? null : 'รันคำสั่ง npm install เพื่อติดตั้งแพ็กเกจให้ครบ');
    }

    const upMin = Math.floor(process.uptime() / 60);
    add('server', 'เซิร์ฟเวอร์ทำงานต่อเนื่อง', 'ok',
      `${Math.floor(upMin / 60)} ชั่วโมง ${upMin % 60} นาที (พอร์ต ${CONFIG.PORT})`);

    res.json({ ok: true, generatedAt: new Date().toLocaleString('th-TH'), checks });
  } catch (e) {
    console.error('[ADMIN] ตรวจสอบทรัพยากรระบบไม่สำเร็จ:', e.message);
    res.status(500).json({ ok: false, error: 'ตรวจสอบทรัพยากรระบบไม่สำเร็จ' });
  }
});

/* ------------------------------------------------------------------ */
/*  จัดการผู้สมัคร (CRUD) — เฉพาะผู้ดูแลระบบ                              */
/* ------------------------------------------------------------------ */

// แจ้งหน้าคูหาให้โหลดรายชื่อผู้สมัครใหม่เมื่อมีการแก้ไข
function notifyCandidatesChanged() {
  io.emit('candidates-updated');
}

// ตัวช่วยจัดการ multipart + แปลง error ของ multer เป็นข้อความอ่านได้
function uploadPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) {
      const msg =
        err.code === 'LIMIT_FILE_SIZE' ? 'ไฟล์รูปใหญ่เกิน 3 MB' : err.message || 'อัปโหลดรูปไม่สำเร็จ';
      return res.status(400).json({ ok: false, error: msg });
    }
    next();
  });
}

// รายชื่อผู้สมัครทั้งหมด (รวมคะแนน สำหรับหน้าจัดการ)
app.get('/admin/api/candidates', requireAdminApi, async (req, res) => {
  try {
    const [rows] = await pool.query(
      'SELECT candidate_no, candidate_name, photo_url, description, vote_count FROM vote_candidates ORDER BY candidate_no ASC'
    );
    res.json({ candidates: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// เพิ่มผู้สมัครใหม่
app.post('/admin/api/candidates', requireAdminApi, uploadPhoto, async (req, res) => {
  const no = parseInt(req.body.candidate_no, 10);
  const name = String(req.body.candidate_name || '').trim();
  const description = String(req.body.description || '').trim() || null;

  if (!Number.isInteger(no) || no < 0 || no > 999 || !name) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ ok: false, error: 'กรุณากรอกหมายเลข (0-999) และชื่อผู้สมัคร' });
  }

  const photoUrl = req.file ? `/img/uploads/${req.file.filename}` : '/img/novote.svg';

  try {
    await pool.query(
      'INSERT INTO vote_candidates (candidate_no, candidate_name, photo_url, description, vote_count) VALUES (?, ?, ?, ?, 0)',
      [no, name, photoUrl, description]
    );
    console.log(`[ADMIN] เพิ่มผู้สมัครหมายเลข ${no}: ${name}`);
    notifyCandidatesChanged();
    res.json({ ok: true });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, error: `มีผู้สมัครหมายเลข ${no} อยู่แล้ว` });
    }
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// แก้ไขข้อมูลผู้สมัคร (ชื่อ / รายละเอียด / รูปภาพ)
app.put('/admin/api/candidates/:no', requireAdminApi, uploadPhoto, async (req, res) => {
  const no = parseInt(req.params.no, 10);
  const name = String(req.body.candidate_name || '').trim();
  const description = String(req.body.description || '').trim() || null;

  if (!Number.isInteger(no) || !name) {
    if (req.file) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อผู้สมัคร' });
  }

  try {
    const [rows] = await pool.query('SELECT photo_url FROM vote_candidates WHERE candidate_no = ?', [no]);
    if (rows.length === 0) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ ok: false, error: 'ไม่พบหมายเลขผู้สมัครนี้' });
    }

    if (req.file) {
      // อัปโหลดรูปใหม่ → ลบรูปเก่าที่เคยอัปโหลดไว้ทิ้ง
      await pool.query(
        'UPDATE vote_candidates SET candidate_name = ?, description = ?, photo_url = ? WHERE candidate_no = ?',
        [name, description, `/img/uploads/${req.file.filename}`, no]
      );
      deleteUploadedPhoto(rows[0].photo_url);
    } else {
      await pool.query(
        'UPDATE vote_candidates SET candidate_name = ?, description = ? WHERE candidate_no = ?',
        [name, description, no]
      );
    }

    console.log(`[ADMIN] แก้ไขผู้สมัครหมายเลข ${no}: ${name}`);
    notifyCandidatesChanged();
    res.json({ ok: true });
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  ล้างข้อมูลการเลือกตั้ง (เลือกได้ว่าจะล้างอะไร — สำหรับเริ่มการเลือกตั้งใหม่) */
/* ------------------------------------------------------------------ */
app.post('/admin/api/clear-data', requireAdminApi, async (req, res) => {
  const clearLogs = req.body && req.body.logs === true;   // บันทึกผู้มาใช้สิทธิ์
  const clearVotes = req.body && req.body.votes === true; // คะแนนของผู้สมัครทุกคน

  if (!clearLogs && !clearVotes) {
    return res.status(400).json({ ok: false, error: 'กรุณาเลือกข้อมูลที่ต้องการล้างอย่างน้อย 1 รายการ' });
  }

  try {
    const cleared = { logs: 0, votes: 0 };

    if (clearLogs) {
      const [r] = await pool.query('DELETE FROM activity_logs');
      cleared.logs = r.affectedRows;
    }
    if (clearVotes) {
      const [r] = await pool.query('UPDATE vote_candidates SET vote_count = 0 WHERE vote_count > 0');
      cleared.votes = r.affectedRows;
    }

    console.log(
      `[ADMIN] ${req.session.adminUsername} ล้างข้อมูล — ` +
      `บันทึกผู้ใช้สิทธิ์: ${clearLogs ? cleared.logs + ' แถว' : 'ไม่ล้าง'}, ` +
      `คะแนน: ${clearVotes ? 'รีเซ็ต ' + cleared.votes + ' คน' : 'ไม่ล้าง'}`
    );
    res.json({ ok: true, cleared });
  } catch (e) {
    console.error('[ADMIN] clear-data error:', e.message);
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// ลบผู้สมัคร
app.delete('/admin/api/candidates/:no', requireAdminApi, async (req, res) => {
  const no = parseInt(req.params.no, 10);
  try {
    const [rows] = await pool.query('SELECT photo_url FROM vote_candidates WHERE candidate_no = ?', [no]);
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'ไม่พบหมายเลขผู้สมัครนี้' });
    }

    await pool.query('DELETE FROM vote_candidates WHERE candidate_no = ?', [no]);
    deleteUploadedPhoto(rows[0].photo_url);

    console.log(`[ADMIN] ลบผู้สมัครหมายเลข ${no}`);
    notifyCandidatesChanged();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  หน้าจอคูหาลงคะแนน (Voter Kiosk)                                     */
/* ------------------------------------------------------------------ */
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'views', 'kiosk.html'));
});

/* ------------------------------------------------------------------ */
/*  เริ่มต้นระบบ                                                        */
/* ------------------------------------------------------------------ */
(async () => {
  try {
    await initDatabase();
  } catch (e) {
    console.error('══════════════════════════════════════════════════');
    console.error('[DB] เชื่อมต่อ MySQL ไม่สำเร็จ:', e.message);
    console.error('     กรุณาเปิด MySQL (XAMPP) ก่อน แล้วรัน npm start ใหม่');
    console.error('══════════════════════════════════════════════════');
    process.exit(1);
  }

  initSmartCardReader();

  server.listen(CONFIG.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   ระบบเลือกตั้งอิเล็กทรอนิกส์ (E-VOTING SYSTEM)      ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  คูหาลงคะแนน : http://localhost:${CONFIG.PORT}/            ║`);
    console.log(`║  ผู้ดูแลระบบ  : http://localhost:${CONFIG.PORT}/admin       ║`);
    console.log('║  (admin / password123)                           ║');
    if (CONFIG.DEMO_MODE) {
      console.log('║  ★ DEMO_MODE เปิดอยู่ — กด F2 ที่หน้าคูหาเพื่อจำลองบัตร ║');
    }
    console.log('╚══════════════════════════════════════════════════╝');
  });
})();
