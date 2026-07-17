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
const crypto = require('crypto');
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
async function processVoter(citizenId, fullName) {
  try {
    const [rows] = await pool.query(
      'SELECT id FROM activity_logs WHERE citizen_id = ?',
      [citizenId]
    );

    if (rows.length > 0) {
      // เคยลงคะแนนแล้ว
      io.emit('already-voted', { fullName });
      console.log(`[KIOSK] ปฏิเสธ: ${fullName} (ลงคะแนนไปแล้ว)`);
      return;
    }

    // ลงทะเบียนกิจกรรมทันที แล้วปลดล็อกหน้าบัตรเลือกตั้ง
    await pool.query(
      'INSERT INTO activity_logs (citizen_id, full_name) VALUES (?, ?)',
      [citizenId, fullName]
    );

    const token = issueVoteToken();
    io.emit('auth-success', { fullName, token });
    console.log(`[KIOSK] ยืนยันตัวตนสำเร็จ: ${fullName}`);
  } catch (err) {
    // กันกรณี race: เสียบบัตรซ้ำเร็ว ๆ จน INSERT ชน UNIQUE
    if (err && err.code === 'ER_DUP_ENTRY') {
      io.emit('already-voted', { fullName });
      return;
    }
    console.error('[KIOSK] ผิดพลาดขณะตรวจสอบผู้ลงคะแนน:', err.message);
    io.emit('card-error', { message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่' });
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

function initSmartCardReader() {
  let pcsclite;
  try {
    pcsclite = require('@pokusew/pcsclite');
  } catch (e) {
    console.warn('──────────────────────────────────────────────────────');
    console.warn('[CARD] ไม่พบไลบรารี @pokusew/pcsclite — ระบบทำงานต่อได้');
    console.warn('       แต่จะอ่านบัตรจริงไม่ได้ (ใช้ DEMO_MODE=1 เพื่อทดสอบ)');
    console.warn('──────────────────────────────────────────────────────');
    return;
  }

  const pcsc = pcsclite();

  pcsc.on('reader', (reader) => {
    console.log(`[CARD] พบเครื่องอ่านบัตร: ${reader.name}`);
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
      io.emit('reader-status', { connected: false });
    });
  });

  pcsc.on('error', (err) => {
    console.error(`[CARD] PC/SC error: ${err.message}`);
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
