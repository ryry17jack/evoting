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
const { parseVoterList, isValidCitizenId, normalizeCitizenId, splitPrefix } = require('./lib/voter-import');
const MySQLSessionStore = require('./lib/mysql-session-store');
const backup = require('./lib/backup');

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
/*  เขตเวลาของระบบ (Timezone) — ค่าเริ่มต้น Asia/Bangkok (UTC+7)         */
/*  ต้องตั้งก่อนใช้งาน Date ครั้งแรก เพื่อให้เวลาที่แสดงผลเป็นเวลาไทยเสมอ    */
/*  แม้เซิร์ฟเวอร์/คอนเทนเนอร์จะตั้งเขตเวลาเป็น UTC ก็ตาม                  */
/* ------------------------------------------------------------------ */
process.env.TZ = process.env.TZ || 'Asia/Bangkok';

// แปลงชื่อเขตเวลาเป็น offset แบบ "+07:00" — MySQL ไม่ได้โหลดตารางชื่อเขตเวลา
// (mysql.time_zone_name) ไว้ตามค่าเริ่มต้น จึงต้องส่งเป็น offset เท่านั้น
function tzToOffset(timeZone) {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName').value; // เช่น "GMT+07:00" หรือ "GMT"
    const m = name.match(/([+-]\d{2}:\d{2})$/);
    return m ? m[1] : '+00:00';
  } catch (e) {
    return '+07:00';
  }
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
  // ถ้าไม่ได้ตั้ง หรือยังเป็นค่าตัวอย่าง ระบบจะสุ่มแล้วเก็บในฐานข้อมูลให้เอง (ใช้ค่าเดิมทุกครั้งที่ restart)
  SESSION_SECRET: process.env.SESSION_SECRET || '',
  // สำรองข้อมูลอัตโนมัติ: โฟลเดอร์ปลายทาง / ทุกกี่ชั่วโมง (0 = ปิด) / เก็บไฟล์ล่าสุดกี่ไฟล์
  BACKUP_DIR: process.env.BACKUP_DIR || path.join(__dirname, 'backups'),
  BACKUP_INTERVAL_HOURS: Math.max(0, parseFloat(process.env.BACKUP_INTERVAL_HOURS || '6') || 0),
  BACKUP_KEEP: Math.max(1, parseInt(process.env.BACKUP_KEEP || '30', 10) || 30),
  // อยู่หลัง reverse proxy (Coolify / Traefik / Nginx) — ให้ได้ IP จริงของผู้ใช้และ cookie แบบ secure
  TRUST_PROXY: process.env.TRUST_PROXY !== '0',
  // เปิดโหมดจำลองบัตร (สำหรับทดสอบโดยไม่มีเครื่องอ่านบัตร): set DEMO_MODE=1
  DEMO_MODE: process.env.DEMO_MODE === '1',
  // โหมด Local Agent: อ่านบัตรจริงผ่านโปรแกรม card-agent บนเครื่องคูหา (ไม่ใช่บนเซิร์ฟเวอร์)
  // ตั้ง AGENT_MODE=1 เมื่อโฮสต์บน Cloud/Coolify — หน้าตรวจสอบระบบจะไม่ถือว่าเซิร์ฟเวอร์
  // ต้องมีเครื่องอ่านบัตร/ไลบรารี PC/SC ในตัว
  AGENT_MODE: process.env.AGENT_MODE === '1',
  // เขตเวลาของแอป (ใช้กับการแสดงผลเวลาทั้งหมด)
  TZ: process.env.TZ,
  // เขตเวลาที่ใช้กับ MySQL — ต้องเป็น offset รูปแบบ "+07:00"
  // ถ้าไม่ได้ระบุ DB_TIMEZONE จะคำนวณจาก TZ ให้อัตโนมัติ
  DB_TIMEZONE: /^[+-]\d{2}:\d{2}$/.test(process.env.DB_TIMEZONE || '')
    ? process.env.DB_TIMEZONE
    : tzToOffset(process.env.TZ),
};

let pool; // MySQL connection pool

// รหัสผ่านเริ่มต้นของบัญชี admin — ระบบจะแจ้งเตือนจนกว่าจะเปลี่ยน
const DEFAULT_ADMIN_PASSWORD = 'password123';
// ค่าตัวอย่างใน docker-compose / .env.example — ถือว่า "ยังไม่ได้ตั้ง"
const PLACEHOLDER_SECRETS = ['', 'change-me-to-a-long-random-string'];

/* ------------------------------------------------------------------ */
/*  สร้างฐานข้อมูล + ตาราง + ข้อมูลเริ่มต้นอัตโนมัติ (Single-run setup)   */
/* ------------------------------------------------------------------ */
async function initDatabase() {
  const conn = await mysql.createConnection({
    host: CONFIG.DB_HOST,
    user: CONFIG.DB_USER,
    password: CONFIG.DB_PASS,
    charset: 'utf8mb4',
    timezone: CONFIG.DB_TIMEZONE,
  });

  // ให้ CURRENT_TIMESTAMP / NOW() และการอ่านคอลัมน์ TIMESTAMP เป็นเวลาไทย
  await conn.query(`SET time_zone = '${CONFIG.DB_TIMEZONE}'`);

  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${CONFIG.DB_NAME}\`
     CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
  );
  await conn.query(`USE \`${CONFIG.DB_NAME}\``);

  const hasColumn = async (table, column) => {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [CONFIG.DB_NAME, table, column]
    );
    return rows.length > 0;
  };

  // ตารางที่ 0: กิจกรรมเลือกตั้ง (สร้างได้หลายกิจกรรมในวันเดียว แต่ละกิจกรรมมีผู้สมัคร/
  // ผู้มีสิทธิ์/บันทึกผู้มาใช้สิทธิ์เป็นของตัวเอง)
  //   status: draft = เตรียมการ, open = เปิดลงคะแนน, closed = ปิดลงคะแนนแล้ว
  //   require_registration: 1 = ลงคะแนนได้เฉพาะผู้ที่อยู่ในบัญชีรายชื่อผู้มีสิทธิ์
  await conn.query(`
    CREATE TABLE IF NOT EXISTS elections (
      id INT AUTO_INCREMENT PRIMARY KEY,
      title VARCHAR(255) NOT NULL,
      description TEXT DEFAULT NULL,
      election_date DATE DEFAULT NULL,
      status ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
      require_registration TINYINT(1) NOT NULL DEFAULT 1,
      hide_results TINYINT(1) NOT NULL DEFAULT 1,
      scheduled_open_at DATETIME NULL DEFAULT NULL,
      scheduled_close_at DATETIME NULL DEFAULT NULL,
      opened_at TIMESTAMP NULL DEFAULT NULL,
      closed_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตารางที่ 1: บันทึกผู้มาใช้สิทธิ์ (ใช้ตรวจสอบการลงคะแนนซ้ำด้วย)
  // บันทึกพร้อมกับการนับคะแนนใน transaction เดียวกัน — ไม่ใช่ตอนเสียบบัตร
  await conn.query(`
    CREATE TABLE IF NOT EXISTS activity_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      election_id INT NOT NULL,
      citizen_id VARCHAR(13) NOT NULL,
      full_name VARCHAR(255) NOT NULL,
      entry_method VARCHAR(10) NOT NULL DEFAULT 'card',
      officer_id INT NULL DEFAULT NULL,
      voted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_election_citizen (election_id, citizen_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตารางที่ 2: ผู้สมัครและคะแนน (นับคะแนนแบบนิรนาม — ไม่ผูกกับผู้ลงคะแนน)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS vote_candidates (
      id INT AUTO_INCREMENT PRIMARY KEY,
      election_id INT NOT NULL,
      candidate_no INT NOT NULL,
      candidate_name VARCHAR(255) NOT NULL,
      photo_url VARCHAR(255) DEFAULT NULL,
      description TEXT DEFAULT NULL,
      vote_count INT NOT NULL DEFAULT 0,
      UNIQUE KEY uq_election_candidate (election_id, candidate_no)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตารางที่ 4: บัญชีรายชื่อผู้มีสิทธิ์เลือกตั้ง (import จากไฟล์ แยกตามกิจกรรม)
  // สถานะ "มาใช้สิทธิ์แล้ว" ไม่ได้เก็บที่นี่ — ดึงจาก activity_logs เพื่อให้มีแหล่งข้อมูลเดียว
  await conn.query(`
    CREATE TABLE IF NOT EXISTS eligible_voters (
      id INT AUTO_INCREMENT PRIMARY KEY,
      election_id INT NOT NULL,
      citizen_id VARCHAR(13) NOT NULL,
      prefix VARCHAR(50) NOT NULL DEFAULT '',
      first_name VARCHAR(150) NOT NULL,
      last_name VARCHAR(150) NOT NULL DEFAULT '',
      group_name VARCHAR(150) NOT NULL DEFAULT '',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE KEY uq_election_voter (election_id, citizen_id),
      KEY idx_citizen (citizen_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Migration: เพิ่มคอลัมน์ description ให้ฐานข้อมูลรุ่นเก่าที่สร้างไว้แล้ว
  if (!(await hasColumn('vote_candidates', 'description'))) {
    await conn.query(`ALTER TABLE vote_candidates ADD COLUMN description TEXT DEFAULT NULL AFTER photo_url`);
    console.log('[DB] เพิ่มคอลัมน์ description ในตาราง vote_candidates');
  }

  // Migration: ฐานข้อมูลรุ่นเก่ามีการเลือกตั้งเดียว → ย้ายผู้สมัคร/บันทึกเดิมเข้ากิจกรรม "ข้อมูลเดิม"
  // (เปิดลงคะแนนไว้ และไม่บังคับบัญชีรายชื่อ เพื่อให้ทำงานเหมือนเดิมหลังอัปเกรด)
  const legacyCandidates = !(await hasColumn('vote_candidates', 'election_id'));
  const legacyLogs = !(await hasColumn('activity_logs', 'election_id'));
  let seedElectionId = null;

  const [[{ electionCount }]] = await conn.query('SELECT COUNT(*) AS electionCount FROM elections');
  if (electionCount === 0) {
    const isUpgrade = legacyCandidates || legacyLogs;
    const [r] = await conn.query(
      `INSERT INTO elections (title, election_date, status, require_registration, hide_results, opened_at)
       VALUES (?, CURDATE(), 'open', 0, ?, NOW())`,
      [isUpgrade ? 'การเลือกตั้ง (ข้อมูลเดิม)' : 'การเลือกตั้งตัวอย่าง', isUpgrade ? 0 : 1]
    );
    seedElectionId = r.insertId;
    console.log(`[DB] สร้างกิจกรรมเลือกตั้งเริ่มต้น #${seedElectionId}`);
  }

  if (legacyCandidates) {
    const [[first]] = await conn.query('SELECT MIN(id) AS id FROM elections');
    await conn.query(`
      ALTER TABLE vote_candidates
        DROP PRIMARY KEY,
        ADD COLUMN id INT AUTO_INCREMENT PRIMARY KEY FIRST,
        ADD COLUMN election_id INT NOT NULL DEFAULT 0 AFTER id`);
    await conn.query('UPDATE vote_candidates SET election_id = ?', [first.id]);
    await conn.query('ALTER TABLE vote_candidates ADD UNIQUE KEY uq_election_candidate (election_id, candidate_no)');
    console.log(`[DB] ย้ายผู้สมัครเดิมเข้ากิจกรรม #${first.id}`);
  }

  if (legacyLogs) {
    const [[first]] = await conn.query('SELECT MIN(id) AS id FROM elections');
    await conn.query('ALTER TABLE activity_logs ADD COLUMN election_id INT NOT NULL DEFAULT 0 AFTER id');
    await conn.query('UPDATE activity_logs SET election_id = ?', [first.id]);
    // ดัชนี UNIQUE เดิมอยู่ที่ citizen_id อย่างเดียว (ลงคะแนนได้ครั้งเดียวทั้งระบบ) → เปลี่ยนเป็นต่อกิจกรรม
    const [idx] = await conn.query(
      `SELECT INDEX_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'activity_logs' AND NON_UNIQUE = 0
         AND INDEX_NAME <> 'PRIMARY' AND COLUMN_NAME = 'citizen_id' AND SEQ_IN_INDEX = 1`,
      [CONFIG.DB_NAME]
    );
    for (const { INDEX_NAME } of idx) {
      await conn.query(`ALTER TABLE activity_logs DROP INDEX \`${INDEX_NAME}\``);
    }
    await conn.query('ALTER TABLE activity_logs ADD UNIQUE KEY uq_election_citizen (election_id, citizen_id)');
    console.log(`[DB] ย้ายบันทึกผู้มาใช้สิทธิ์เดิมเข้ากิจกรรม #${first.id}`);
  }

  // ข้อมูลผู้สมัครตัวอย่าง — เฉพาะตอนติดตั้งใหม่ (ไม่ใส่ซ้ำทุกครั้งที่รัน ผู้สมัครที่ลบไปจะไม่กลับมา)
  if (seedElectionId && !legacyCandidates) {
    await conn.query(
      `INSERT IGNORE INTO vote_candidates (election_id, candidate_no, candidate_name, photo_url, vote_count) VALUES
        (?, 1,  'นายสมชาย ใจดี',        '/img/candidate1.svg', 0),
        (?, 2,  'นางสาวสมหญิง รักเรียน', '/img/candidate2.svg', 0),
        (?, 99, 'ไม่ประสงค์ลงคะแนน',     '/img/novote.svg',     0)`,
      [seedElectionId, seedElectionId, seedElectionId]
    );
  }

  // Migration: คอลัมน์ที่เพิ่มภายหลังของ elections / activity_logs
  // (กิจกรรมเดิมคงการแสดงผลคะแนนสดไว้ hide_results = 0 — กิจกรรมใหม่ซ่อนผลเป็นค่าเริ่มต้น)
  if (!(await hasColumn('elections', 'hide_results'))) {
    await conn.query(`ALTER TABLE elections
      ADD COLUMN hide_results TINYINT(1) NOT NULL DEFAULT 0 AFTER require_registration,
      ADD COLUMN scheduled_open_at DATETIME NULL DEFAULT NULL AFTER hide_results,
      ADD COLUMN scheduled_close_at DATETIME NULL DEFAULT NULL AFTER scheduled_open_at`);
    await conn.query('ALTER TABLE elections ALTER COLUMN hide_results SET DEFAULT 1');
    console.log('[DB] เพิ่มคอลัมน์ซ่อนผลคะแนน/ตั้งเวลาเปิด-ปิด ในตาราง elections');
  }
  if (!(await hasColumn('activity_logs', 'entry_method'))) {
    await conn.query(`ALTER TABLE activity_logs
      ADD COLUMN entry_method VARCHAR(10) NOT NULL DEFAULT 'card' AFTER full_name,
      ADD COLUMN officer_id INT NULL DEFAULT NULL AFTER entry_method`);
    console.log('[DB] เพิ่มคอลัมน์วิธียืนยันตัวตนในตาราง activity_logs');
  }

  // ตารางที่ 3: ผู้ใช้งานระบบ (ผู้ดูแล / เจ้าหน้าที่)
  //   role: admin = จัดการได้ทุกอย่าง, officer = ดูข้อมูล + กรอกเลขบัตรแทนที่คูหา
  //   kiosk_pin: PIN (bcrypt) สำหรับกรอกเลขบัตรแทนเมื่อชิปบัตรอ่านไม่ได้
  await conn.query(`
    CREATE TABLE IF NOT EXISTS admin_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(50) NOT NULL UNIQUE,
      password VARCHAR(255) NOT NULL,
      display_name VARCHAR(150) NOT NULL DEFAULT '',
      role ENUM('admin','officer') NOT NULL DEFAULT 'admin',
      kiosk_pin VARCHAR(255) NULL DEFAULT NULL,
      last_login_at TIMESTAMP NULL DEFAULT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  if (!(await hasColumn('admin_users', 'role'))) {
    await conn.query(`ALTER TABLE admin_users
      ADD COLUMN display_name VARCHAR(150) NOT NULL DEFAULT '' AFTER password,
      ADD COLUMN role ENUM('admin','officer') NOT NULL DEFAULT 'admin' AFTER display_name,
      ADD COLUMN kiosk_pin VARCHAR(255) NULL DEFAULT NULL AFTER role,
      ADD COLUMN last_login_at TIMESTAMP NULL DEFAULT NULL AFTER kiosk_pin,
      ADD COLUMN created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP AFTER last_login_at`);
    console.log('[DB] เพิ่มคอลัมน์บทบาท/PIN ในตาราง admin_users');
  }

  // บัญชีผู้ดูแลเริ่มต้น admin / password123 (เก็บเป็น bcrypt hash) — ระบบจะเตือนให้เปลี่ยนรหัสผ่าน
  const [[{ userCount }]] = await conn.query('SELECT COUNT(*) AS userCount FROM admin_users');
  if (userCount === 0) {
    const hash = await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 10);
    await conn.query(
      `INSERT INTO admin_users (username, password, display_name, role) VALUES ('admin', ?, 'ผู้ดูแลระบบ', 'admin')`,
      [hash]
    );
    console.log(`[DB] สร้างบัญชีผู้ดูแลเริ่มต้น: admin / ${DEFAULT_ADMIN_PASSWORD} (กรุณาเปลี่ยนรหัสผ่านหลังเข้าสู่ระบบ)`);
  }

  // ตารางที่ 5: บันทึกการใช้งานระบบ (Audit Log) — เพิ่มได้อย่างเดียว ไม่มีหน้าลบ
  // ไม่บันทึกว่าใครเลือกใคร (บันทึกเฉพาะการกระทำของผู้ดูแล/เจ้าหน้าที่)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id INT AUTO_INCREMENT PRIMARY KEY,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      user_id INT NULL DEFAULT NULL,
      username VARCHAR(50) NOT NULL DEFAULT '',
      action VARCHAR(50) NOT NULL,
      election_id INT NULL DEFAULT NULL,
      detail TEXT NULL,
      ip VARCHAR(64) NOT NULL DEFAULT '',
      KEY idx_created (created_at),
      KEY idx_election (election_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตารางที่ 6: session ของผู้ใช้ (เก็บใน MySQL — ไม่หลุดเมื่อ redeploy/restart container)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      sid VARCHAR(128) NOT NULL PRIMARY KEY,
      expires BIGINT NOT NULL,
      data MEDIUMTEXT NOT NULL,
      KEY idx_expires (expires)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // ตารางที่ 7: ค่าตั้งค่าของระบบ (เช่น session secret ที่สุ่มให้อัตโนมัติ)
  await conn.query(`
    CREATE TABLE IF NOT EXISTS settings (
      k VARCHAR(64) NOT NULL PRIMARY KEY,
      v TEXT NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await conn.end();

  pool = mysql.createPool({
    host: CONFIG.DB_HOST,
    user: CONFIG.DB_USER,
    password: CONFIG.DB_PASS,
    database: CONFIG.DB_NAME,
    charset: 'utf8mb4',
    timezone: CONFIG.DB_TIMEZONE,
    waitForConnections: true,
    connectionLimit: 10,
  });

  // ทุก connection ที่ pool สร้างใหม่ต้องใช้เขตเวลาเดียวกัน (คำสั่งนี้ถูกจัดคิว
  // ก่อนคำสั่งอื่นของ connection นั้นเสมอ)
  pool.on('connection', (conn) => {
    conn.query(`SET time_zone = '${CONFIG.DB_TIMEZONE}'`, (err) => {
      if (err) console.warn('[DB] ตั้งเขตเวลาให้ connection ไม่สำเร็จ:', err.message);
    });
  });

  console.log(`[DB] เชื่อมต่อฐานข้อมูล "${CONFIG.DB_NAME}" สำเร็จ`);
  console.log(`[TZ] เขตเวลา: ${CONFIG.TZ} (MySQL ${CONFIG.DB_TIMEZONE}) — ${new Date().toLocaleString('th-TH')}`);
}

/* ------------------------------------------------------------------ */
/*  Express + Socket.io                                                */
/* ------------------------------------------------------------------ */
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// import รายชื่อผู้มีสิทธิ์ส่งข้อความทั้งไฟล์มา (หลายพันแถว) จึงให้ขนาดใหญ่ได้เฉพาะเส้นทางนั้น
const jsonSmall = express.json();
const jsonLarge = express.json({ limit: '15mb' });
app.use((req, res, next) => (/\/voters\/import$/.test(req.path) ? jsonLarge : jsonSmall)(req, res, next));
app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/*  Cache busting — ต่อท้าย ?v=<hash เนื้อไฟล์> ให้ลิงก์ /js /css /vendor ในหน้าเว็บ   */
/*  Cloudflare บังคับ Cache-Control ของไฟล์ JS/CSS เป็น 4 ชั่วโมง เบราว์เซอร์จึงใช้ */
/*  JS เก่ากับ HTML ใหม่หลัง deploy (หน้าเว็บพัง) — เมื่อไฟล์เปลี่ยน URL ก็เปลี่ยน     */
/*  ทำให้ได้ไฟล์ใหม่ทันที ส่วนไฟล์ที่ไม่เปลี่ยนยังใช้แคชได้ตามปกติ                     */
/* ------------------------------------------------------------------ */
const PUBLIC_DIR = path.join(__dirname, 'public');
const assetHashes = new Map(); // "/js/kiosk.js" -> hash (คำนวณครั้งเดียวต่อการรัน — ไฟล์ไม่เปลี่ยนระหว่างรัน)
const viewCache = new Map();

function assetVersion(urlPath) {
  if (!assetHashes.has(urlPath)) {
    let hash = '';
    try {
      const file = path.join(PUBLIC_DIR, urlPath);
      if (file.startsWith(PUBLIC_DIR)) {
        hash = crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex').slice(0, 10);
      }
    } catch (e) {
      hash = '';
    }
    assetHashes.set(urlPath, hash);
  }
  return assetHashes.get(urlPath);
}

// ส่งไฟล์ใน views/ พร้อมเติมเวอร์ชันให้ลิงก์ไฟล์ static — HTML เองห้ามแคช
function sendView(res, name) {
  if (!viewCache.has(name)) {
    const html = fs
      .readFileSync(path.join(__dirname, 'views', name), 'utf8')
      .replace(/(src|href)="(\/(?:js|css|vendor)\/[^"?#]+)"/g, (m, attr, url) => {
        const v = assetVersion(url);
        return v ? `${attr}="${url}?v=${v}"` : m;
      });
    viewCache.set(name, html);
  }
  res.set('Cache-Control', 'no-cache');
  res.type('html').send(viewCache.get(name));
}

// อยู่หลัง reverse proxy ของ Coolify → เชื่อ X-Forwarded-* เพื่อให้ req.ip เป็น IP จริง
// (ใช้ใน audit log / จำกัดการเดารหัสผ่าน) และรู้ว่าเป็น HTTPS (cookie แบบ secure)
if (CONFIG.TRUST_PROXY) app.set('trust proxy', 1);

// session เก็บใน MySQL — สร้าง middleware หลังเชื่อมต่อฐานข้อมูลแล้ว (ดู initSessions)
const sessionStore = new MySQLSessionStore(() => pool);
let sessionMiddleware = null;
app.use((req, res, next) => (sessionMiddleware ? sessionMiddleware(req, res, next) : next()));

// ใช้ SESSION_SECRET จาก env ถ้าตั้งไว้จริง ไม่เช่นนั้นสุ่มครั้งแรกแล้วเก็บในตาราง settings
// (ถ้าสุ่มใหม่ทุกครั้งที่รีสตาร์ต ผู้ใช้จะหลุดจากระบบทุกครั้งที่ redeploy)
async function initSessions() {
  let secret = CONFIG.SESSION_SECRET;
  let source = 'env';
  if (PLACEHOLDER_SECRETS.includes(secret)) {
    const [[row]] = await pool.query("SELECT v FROM settings WHERE k = 'session_secret'");
    if (row) {
      secret = row.v;
    } else {
      secret = crypto.randomBytes(48).toString('hex');
      await pool.query("INSERT INTO settings (k, v) VALUES ('session_secret', ?)", [secret]);
    }
    source = 'database';
  }
  CONFIG.SESSION_SECRET_SOURCE = source;
  sessionMiddleware = session({
    name: 'evoting.sid',
    secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true, // ต่ออายุทุกครั้งที่ใช้งาน — หมดอายุเมื่อไม่ได้ใช้งาน 8 ชั่วโมง
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: 'auto', // HTTPS (Coolify) = secure cookie, HTTP ในเครื่อง = ปกติ
      maxAge: 8 * 60 * 60 * 1000,
    },
  });
}

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
/*  Vote Token — ออกให้เมื่อยืนยันตัวตนสำเร็จ ใช้ลงคะแนนได้ครั้งเดียวต่อกิจกรรม */
/*  การเสียบบัตร "ไม่" ถือว่าใช้สิทธิ์แล้ว — ผู้ลงคะแนนถูกบันทึกเมื่อกดลงคะแนน */
/*  สำเร็จเท่านั้น (บันทึกพร้อมนับคะแนนใน transaction เดียว) ถ้าอ่านบัตรผิดพลาด  */
/*  หรือเดินออกไปก่อนลงคะแนน ก็กลับมาเสียบบัตรใหม่ได้                        */
/*  token อยู่ในหน่วยความจำเท่านั้น — ตารางคะแนนไม่มีข้อมูลว่าใครเลือกใคร        */
/* ------------------------------------------------------------------ */
// token -> { citizenId, fullName, entry: {method, officer}, pending:Set<electionId>, expiresAt }
const voteTokens = new Map();
const TOKEN_TTL_MS = 5 * 60 * 1000;

function issueVoteToken(citizenId, fullName, electionIds, entry) {
  const token = crypto.randomBytes(24).toString('hex');
  voteTokens.set(token, {
    citizenId,
    fullName,
    entry,
    pending: new Set(electionIds),
    expiresAt: Date.now() + TOKEN_TTL_MS,
  });
  return token;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, entry] of voteTokens) if (entry.expiresAt <= now) voteTokens.delete(t);
}, 60 * 1000).unref();

const NO_VOTE_NO = 99; // หมายเลขผู้สมัครพิเศษ "ไม่ประสงค์ลงคะแนน"

/* ------------------------------------------------------------------ */
/*  ขั้นตอนตรวจสอบผู้ลงคะแนน (e-KYC + บัญชีผู้มีสิทธิ์ + กันลงคะแนนซ้ำ)       */
/*  หา "กิจกรรมที่เปิดอยู่ซึ่งผู้นี้มีสิทธิ์และยังไม่ได้ลงคะแนน" แล้วส่งบัตรเลือกตั้ง */
/*  ทุกใบให้หน้าคูหาลงตามลำดับ (กรณีมีหลายกิจกรรมพร้อมกันในวันเดียว)          */
/* ------------------------------------------------------------------ */
// emitter = ปลายทางที่จะส่งผลลัพธ์กลับ:
//   - io (ค่าเริ่มต้น) → กระจายให้ทุกหน้าจอ ใช้กับเครื่องอ่านบัตรฝั่งเซิร์ฟเวอร์ (bare-metal) และ DEMO_MODE
//   - socket ของสถานีนั้น ๆ → ตอบเฉพาะเครื่องที่เสียบบัตร ใช้กับสถานีที่อ่านบัตรผ่าน Local Agent
//     (จำเป็นเมื่อมีหลายเครื่องพร้อมกัน ไม่งั้นบัตรที่เครื่องหนึ่งจะปลดล็อกบัตรเลือกตั้งของทุกเครื่อง)
// entry = วิธียืนยันตัวตน: { method: 'card' } (อ่านจากบัตร) หรือ
//         { method: 'manual', officer } (เจ้าหน้าที่กรอกเลขบัตรแทน เมื่อชิปบัตรอ่านไม่ได้)
async function processVoter(citizenId, fullName, emitter = io, entry = { method: 'card', officer: null }) {
  try {
    const [elections] = await pool.query(
      `SELECT id, title, description, require_registration FROM elections
       WHERE status = 'open' ORDER BY election_date ASC, id ASC`
    );
    if (elections.length === 0) {
      emitter.emit('no-election', { fullName });
      console.log(`[KIOSK] ปฏิเสธ: ${fullName} (ไม่มีกิจกรรมที่เปิดลงคะแนน)`);
      return;
    }

    const ids = elections.map((e) => e.id);
    const [registered] = await pool.query(
      'SELECT election_id FROM eligible_voters WHERE citizen_id = ? AND election_id IN (?)',
      [citizenId, ids]
    );
    const [voted] = await pool.query(
      'SELECT election_id FROM activity_logs WHERE citizen_id = ? AND election_id IN (?)',
      [citizenId, ids]
    );
    const registeredSet = new Set(registered.map((r) => r.election_id));
    const votedSet = new Set(voted.map((r) => r.election_id));

    const eligible = elections.filter((e) => !e.require_registration || registeredSet.has(e.id));
    if (eligible.length === 0) {
      emitter.emit('not-eligible', { fullName });
      console.log(`[KIOSK] ปฏิเสธ: ${fullName} (ไม่มีชื่อในบัญชีผู้มีสิทธิ์)`);
      return;
    }

    const pending = eligible.filter((e) => !votedSet.has(e.id));
    if (pending.length === 0) {
      emitter.emit('already-voted', { fullName });
      console.log(`[KIOSK] ปฏิเสธ: ${fullName} (ลงคะแนนครบทุกกิจกรรมแล้ว)`);
      return;
    }

    const [candidates] = await pool.query(
      `SELECT election_id, candidate_no, candidate_name, photo_url, description
       FROM vote_candidates WHERE election_id IN (?) ORDER BY candidate_no ASC`,
      [pending.map((e) => e.id)]
    );
    const ballots = pending
      .map((e) => ({
        election_id: e.id,
        title: e.title,
        description: e.description,
        candidates: candidates.filter((c) => c.election_id === e.id),
      }))
      .filter((b) => b.candidates.length > 0); // กิจกรรมที่ยังไม่มีผู้สมัคร ไม่แสดงบัตร

    if (ballots.length === 0) {
      emitter.emit('card-error', { message: 'กิจกรรมที่เปิดอยู่ยังไม่มีผู้สมัคร กรุณาติดต่อเจ้าหน้าที่' });
      return;
    }

    const token = issueVoteToken(citizenId, fullName, ballots.map((b) => b.election_id), entry);
    emitter.emit('auth-success', { fullName, token, ballots, manual: entry.method === 'manual' });
    console.log(`[KIOSK] ยืนยันตัวตนสำเร็จ: ${fullName} (บัตรเลือกตั้ง ${ballots.length} ใบ)`);
  } catch (err) {
    console.error('[KIOSK] ผิดพลาดขณะตรวจสอบผู้ลงคะแนน:', err.message);
    emitter.emit('card-error', { message: 'เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่' });
  }
}

// แจ้งทุกหน้าจอว่ากิจกรรม/ผู้สมัครเปลี่ยน (หน้าคูหาอัปเดตรายชื่อกิจกรรมที่เปิดอยู่)
function notifyElectionsChanged() {
  io.emit('elections-updated');
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
// IP ของเครื่องคูหา (หลัง reverse proxy ใช้ X-Forwarded-For ตัวแรก)
function socketIp(socket) {
  const fwd = CONFIG.TRUST_PROXY && socket.handshake.headers['x-forwarded-for'];
  const ip = fwd ? String(fwd).split(',')[0].trim() : socket.handshake.address;
  return String(ip || '').replace(/^::ffff:/, '');
}

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

  // ── เจ้าหน้าที่กรอกเลขบัตรแทน (ชิปบัตรเสีย / เครื่องอ่านบัตรมีปัญหา) ────────
  // ต้องใช้ PIN 6 หลักของเจ้าหน้าที่ (ตั้งในแดชบอร์ด) — จำกัดการเดา PIN ต่อ IP
  // ทุกครั้งถูกบันทึกลง audit log ว่าเจ้าหน้าที่คนใดกรอกให้ใคร และติดป้ายในบันทึกผู้มาใช้สิทธิ์
  socket.on('officer-entry', async (payload) => {
    const ip = socketIp(socket);
    const reply = (message) => socket.emit('officer-error', { message });
    const pin = String((payload && payload.pin) || '');
    const citizenId = normalizeCitizenId(payload && payload.citizenId);
    const typedName = String((payload && payload.fullName) || '').trim().slice(0, 255);
    const fakeReq = { ip, user: null };

    if (pinLimiter.isLocked(ip)) return reply('ใส่ PIN ผิดหลายครั้งเกินไป — กรุณารอ 5 นาที');
    if (!/^\d{6}$/.test(pin)) return reply('PIN ต้องเป็นตัวเลข 6 หลัก');
    if (!isValidCitizenId(citizenId)) return reply('เลขบัตรประชาชนไม่ถูกต้อง (13 หลัก / หลักตรวจสอบไม่ตรง)');

    try {
      const officer = await findUserByPin(pin);
      if (!officer) {
        const locked = pinLimiter.fail(ip);
        await audit(fakeReq, 'officer-pin-failed', `PIN ไม่ถูกต้อง${locked ? ' — ล็อก 5 นาที' : ''}`, null, null);
        return reply(locked ? 'ใส่ PIN ผิดหลายครั้งเกินไป — กรุณารอ 5 นาที' : 'PIN ไม่ถูกต้อง');
      }
      pinLimiter.reset(ip);

      // ใช้ชื่อจากบัญชีรายชื่อของกิจกรรมที่เปิดอยู่ (ถ้ามี) — ไม่เช่นนั้นใช้ชื่อที่เจ้าหน้าที่พิมพ์
      const [[reg]] = await pool.query(
        `SELECT v.prefix, v.first_name, v.last_name FROM eligible_voters v
         JOIN elections e ON e.id = v.election_id AND e.status = 'open'
         WHERE v.citizen_id = ? LIMIT 1`,
        [citizenId]
      );
      const fullName = reg
        ? `${reg.prefix}${reg.first_name} ${reg.last_name}`.trim()
        : typedName || 'ผู้มีสิทธิ์ (เจ้าหน้าที่กรอกเลขบัตร)';

      await audit(Object.assign(fakeReq, { user: officer }), 'officer-entry',
        `กรอกเลขบัตรแทน: ${maskCid(citizenId)} ${fullName}${reg ? '' : ' (ไม่พบในบัญชีรายชื่อ)'}`);
      socket.emit('officer-ok');
      await processVoter(citizenId, fullName, socket, {
        method: 'manual',
        officer: { id: officer.id, username: officer.username },
      });
    } catch (err) {
      console.error('[OFFICER] ผิดพลาด:', err.message);
      reply('เกิดข้อผิดพลาดของระบบ กรุณาลองใหม่');
    }
  });

  // โหมดจำลองบัตร (เฉพาะตอนตั้ง DEMO_MODE=1) — ใช้ทดสอบระบบโดยไม่มีเครื่องอ่านบัตร
  if (CONFIG.DEMO_MODE) {
    socket.on('demo-card', async (payload) => {
      let citizenId = String((payload && payload.citizenId) || '').replace(/\D/g, '');
      let fullName = String((payload && payload.fullName) || 'นายทดสอบ ระบบ').trim();

      // pick = 'registered' → สุ่มจากบัญชีผู้มีสิทธิ์ของกิจกรรมที่เปิดอยู่ซึ่งยังไม่ได้ลงคะแนน
      // (ใช้ทดสอบระบบบัญชีรายชื่อ ถ้าไม่มีรายชื่อเหลือ จะใช้เลขบัตรสุ่มที่ส่งมาแทน)
      if (payload && payload.pick === 'registered') {
        try {
          const [[v]] = await pool.query(
            `SELECT v.citizen_id, v.prefix, v.first_name, v.last_name
             FROM eligible_voters v
             JOIN elections e ON e.id = v.election_id AND e.status = 'open'
             LEFT JOIN activity_logs l ON l.election_id = v.election_id AND l.citizen_id = v.citizen_id
             WHERE l.id IS NULL ORDER BY RAND() LIMIT 1`
          );
          if (v) {
            citizenId = v.citizen_id;
            fullName = `${v.prefix} ${v.first_name} ${v.last_name}`.trim();
          }
        } catch (e) {
          /* ใช้เลขบัตรสุ่มแทน */
        }
      }

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

// กิจกรรมที่เปิดลงคะแนนอยู่ (แสดงที่หน้าต้อนรับของคูหา — ไม่มีคะแนน)
app.get('/api/elections/open', async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, title FROM elections WHERE status = 'open' ORDER BY election_date ASC, id ASC`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

// ลงคะแนน (นิรนาม) — ต้องมี vote token ที่ได้จากการเสียบบัตร ใช้ได้ครั้งเดียวต่อกิจกรรม
// บันทึก "ผู้มาใช้สิทธิ์" + เพิ่มคะแนน ใน transaction เดียว: ถ้าอย่างใดอย่างหนึ่งล้มเหลว
// จะไม่มีอะไรถูกบันทึก ผู้ลงคะแนนจึงไม่ถูกทำเครื่องหมายว่าใช้สิทธิ์แล้วโดยที่คะแนนไม่ถูกนับ
app.post('/api/vote', async (req, res) => {
  const { token } = req.body || {};
  const electionId = parseInt((req.body || {}).election_id, 10);
  const candidateNo = parseInt((req.body || {}).candidate_no, 10);

  const entry = voteTokens.get(String(token || ''));
  if (!entry || entry.expiresAt <= Date.now() || !entry.pending.has(electionId)) {
    return res.status(403).json({ ok: false, error: 'หมดเวลาลงคะแนนหรือไม่มีสิทธิ์ กรุณาเสียบบัตรใหม่' });
  }

  // ตัดสิทธิ์ใน token ทันที (ก่อน await) กันการกดส่งซ้ำพร้อมกัน — คืนให้ถ้าบันทึกไม่สำเร็จ
  entry.pending.delete(electionId);
  const restore = () => {
    entry.pending.add(electionId);
    if (!voteTokens.has(token)) voteTokens.set(token, entry);
  };

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [[election]] = await conn.query('SELECT status FROM elections WHERE id = ? FOR UPDATE', [electionId]);
    if (!election || election.status !== 'open') {
      await conn.rollback();
      return res.status(409).json({ ok: false, code: 'closed', error: 'กิจกรรมนี้ปิดการลงคะแนนแล้ว' });
    }

    try {
      await conn.query(
        'INSERT INTO activity_logs (election_id, citizen_id, full_name, entry_method, officer_id) VALUES (?, ?, ?, ?, ?)',
        [electionId, entry.citizenId, entry.fullName, entry.entry.method, entry.entry.officer ? entry.entry.officer.id : null]
      );
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') {
        // ลงคะแนนจากอีกเครื่องไปแล้ว (เสียบบัตรเดียวกันสองเครื่องพร้อมกัน)
        return res.status(409).json({ ok: false, code: 'already-voted', error: 'ท่านได้ลงคะแนนในกิจกรรมนี้ไปแล้ว' });
      }
      throw e;
    }

    const [result] = await conn.query(
      'UPDATE vote_candidates SET vote_count = vote_count + 1 WHERE election_id = ? AND candidate_no = ?',
      [electionId, candidateNo]
    );
    if (result.affectedRows === 0) {
      await conn.rollback();
      restore();
      return res.status(400).json({ ok: false, error: 'ไม่พบหมายเลขผู้สมัคร กรุณาเลือกใหม่' });
    }

    await conn.commit();

    if (entry.pending.size === 0) voteTokens.delete(token);
    else entry.expiresAt = Date.now() + TOKEN_TTL_MS; // ต่อเวลาให้บัตรใบถัดไป

    console.log(`[VOTE] กิจกรรม #${electionId}: มีการลงคะแนน 1 เสียง (นิรนาม)`);
    res.json({ ok: true, remaining: entry.pending.size });
  } catch (e) {
    if (conn) await conn.rollback().catch(() => {});
    restore();
    console.error('[VOTE] บันทึกคะแนนไม่สำเร็จ:', e.message);
    res.status(500).json({ ok: false, error: 'บันทึกคะแนนไม่สำเร็จ กรุณากดลงคะแนนอีกครั้ง' });
  } finally {
    if (conn) conn.release();
  }
});

/* ------------------------------------------------------------------ */
/*  บันทึกการใช้งานระบบ (Audit Log)                                      */
/*  บันทึกการกระทำของผู้ดูแล/เจ้าหน้าที่ลงฐานข้อมูล (ไม่ใช่แค่ console)       */
/*  ไม่บันทึกการเลือกผู้สมัคร — คะแนนยังเป็นนิรนามเหมือนเดิม                  */
/* ------------------------------------------------------------------ */
function clientIp(req) {
  return req ? String(req.ip || (req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '') : '';
}

// user: ผู้กระทำ (ค่าเริ่มต้น req.user) — null = ระบบ (เช่น ตั้งเวลาเปิด-ปิดอัตโนมัติ)
async function audit(req, action, detail = null, electionId = null, user = undefined) {
  const actor = user === undefined ? (req && req.user) || null : user;
  const username = actor ? actor.username : 'system';
  console.log(`[AUDIT] ${username} ${action}${electionId ? ` #${electionId}` : ''}${detail ? ` — ${detail}` : ''}`);
  try {
    await pool.query(
      'INSERT INTO audit_logs (user_id, username, action, election_id, detail, ip) VALUES (?, ?, ?, ?, ?, ?)',
      [actor ? actor.id : null, username.slice(0, 50), action, electionId, detail, clientIp(req).slice(0, 64)]
    );
  } catch (e) {
    console.error('[AUDIT] บันทึกไม่สำเร็จ:', e.message);
  }
}

// ปิดเลขบัตรบางส่วนก่อนเขียนลง audit log (ข้อมูลส่วนบุคคล)
function maskCid(cid) {
  return /^\d{13}$/.test(cid) ? `${cid[0]}-xxxx-xxxxx-${cid.slice(10, 12)}-${cid[12]}` : cid;
}

/* ------------------------------------------------------------------ */
/*  จำกัดการเดารหัสผ่าน / PIN (brute-force)                              */
/* ------------------------------------------------------------------ */
class AttemptLimiter {
  constructor({ max, windowMs, lockMs }) {
    Object.assign(this, { max, windowMs, lockMs, map: new Map() });
    setInterval(() => {
      const now = Date.now();
      for (const [k, v] of this.map) if (v.until < now && v.first + this.windowMs < now) this.map.delete(k);
    }, 60 * 1000).unref();
  }
  isLocked(key) {
    const v = this.map.get(key);
    return Boolean(v && v.until > Date.now());
  }
  fail(key) {
    const now = Date.now();
    let v = this.map.get(key);
    if (!v || v.first + this.windowMs < now) v = { count: 0, first: now, until: 0 };
    v.count += 1;
    if (v.count >= this.max) {
      v.until = now + this.lockMs;
      v.count = 0;
      v.first = now;
    }
    this.map.set(key, v);
    return v.until > now;
  }
  reset(key) {
    this.map.delete(key);
  }
}
const loginLimiter = new AttemptLimiter({ max: 5, windowMs: 15 * 60 * 1000, lockMs: 5 * 60 * 1000 });
const pinLimiter = new AttemptLimiter({ max: 5, windowMs: 15 * 60 * 1000, lockMs: 5 * 60 * 1000 });

/* ------------------------------------------------------------------ */
/*  ผู้ใช้งาน / สิทธิ์ (admin = ผู้ดูแลระบบ, officer = เจ้าหน้าที่)           */
/*  โหลดผู้ใช้จากฐานข้อมูลทุกคำขอ — ถ้าถูกลบบัญชี/ลดสิทธิ์ จะมีผลทันที         */
/* ------------------------------------------------------------------ */
const ROLE_LABEL = { admin: 'ผู้ดูแลระบบ', officer: 'เจ้าหน้าที่' };
const MIN_PASSWORD = 8;

async function loadSessionUser(req) {
  if (!req.session || !req.session.userId) return null;
  const [[user]] = await pool.query(
    `SELECT id, username, display_name, role, (kiosk_pin IS NOT NULL) AS has_pin
     FROM admin_users WHERE id = ?`,
    [req.session.userId]
  );
  return user || null;
}

function requireLoginWith(onFail) {
  return async (req, res, next) => {
    try {
      req.user = await loadSessionUser(req);
    } catch (e) {
      return res.status(500).json({ ok: false, error: 'database error' });
    }
    if (!req.user) return onFail(req, res);
    next();
  };
}

// หน้าเว็บ: ต้องล็อกอิน (ทุกบทบาท) — ไม่เช่นนั้นไปหน้า login
const requireLogin = requireLoginWith((req, res) => res.redirect('/admin/login'));
// API อ่านข้อมูล: ต้องล็อกอิน (ทุกบทบาท)
const requireLoginApi = requireLoginWith((req, res) => res.status(401).json({ ok: false, error: 'unauthorized' }));
// API จัดการ/แก้ไขข้อมูล: เฉพาะผู้ดูแลระบบ
const requireAdminApi = [
  requireLoginApi,
  (req, res, next) =>
    req.user.role === 'admin' ? next() : res.status(403).json({ ok: false, error: 'เฉพาะผู้ดูแลระบบเท่านั้น' }),
];

async function verifyPassword(user, password) {
  if (!user) return false;
  // รองรับรหัสผ่านแบบ plaintext (กรณีติดตั้งจาก database.sql) — จะถูกแปลงเป็น bcrypt หลังล็อกอินสำเร็จ
  if (user.password.startsWith('$2')) return bcrypt.compare(String(password || ''), user.password);
  return user.password === String(password || '');
}

function validateNewPassword(pw) {
  pw = String(pw || '');
  if (pw.length < MIN_PASSWORD) return `รหัสผ่านต้องยาวอย่างน้อย ${MIN_PASSWORD} ตัวอักษร`;
  if (pw === DEFAULT_ADMIN_PASSWORD) return 'ห้ามใช้รหัสผ่านเริ่มต้นของระบบ';
  return null;
}

// หาเจ้าหน้าที่จาก PIN (PIN ไม่ซ้ำกันระหว่างผู้ใช้ — ตรวจตอนตั้ง PIN)
async function findUserByPin(pin, exceptUserId = null) {
  const [rows] = await pool.query(
    'SELECT id, username, display_name, role, kiosk_pin FROM admin_users WHERE kiosk_pin IS NOT NULL'
  );
  for (const u of rows) {
    if (u.id !== exceptUserId && (await bcrypt.compare(String(pin), u.kiosk_pin))) return u;
  }
  return null;
}

app.get('/admin', (req, res) => {
  res.redirect(req.session && req.session.userId ? '/admin/dashboard' : '/admin/login');
});

app.get('/admin/login', (req, res) => {
  if (req.session && req.session.userId) return res.redirect('/admin/dashboard');
  sendView(res, 'admin-login.html');
});

app.post('/admin/login', async (req, res) => {
  const username = String((req.body && req.body.username) || '').trim().slice(0, 50);
  const password = String((req.body && req.body.password) || '');
  const key = `${clientIp(req)}|${username.toLowerCase()}`;

  if (loginLimiter.isLocked(key)) {
    await audit(req, 'login-locked', `ชื่อผู้ใช้ "${username}" ถูกล็อกชั่วคราว`, null, null);
    return res.redirect('/admin/login?error=locked');
  }

  try {
    const [[user]] = await pool.query('SELECT * FROM admin_users WHERE username = ?', [username]);
    if (!(await verifyPassword(user, password))) {
      const locked = loginLimiter.fail(key);
      await audit(req, 'login-failed', `ชื่อผู้ใช้ "${username}"${locked ? ' — ล็อก 5 นาที' : ''}`, null, null);
      return res.redirect(locked ? '/admin/login?error=locked' : '/admin/login?error=1');
    }
    loginLimiter.reset(key);

    if (!user.password.startsWith('$2')) {
      await pool.query('UPDATE admin_users SET password = ? WHERE id = ?', [await bcrypt.hash(password, 10), user.id]);
    }
    await pool.query('UPDATE admin_users SET last_login_at = NOW() WHERE id = ?', [user.id]);

    // สร้าง session ใหม่หลังล็อกอิน (กัน session fixation)
    req.session.regenerate(async (err) => {
      if (err) return res.redirect('/admin/login?error=1');
      req.session.userId = user.id;
      req.session.weakPassword = password === DEFAULT_ADMIN_PASSWORD;
      await audit(req, 'login', ROLE_LABEL[user.role], null, user);
      req.session.save(() => res.redirect('/admin/dashboard'));
    });
  } catch (e) {
    console.error('[ADMIN] login error:', e.message);
    res.redirect('/admin/login?error=1');
  }
});

app.get('/admin/logout', requireLoginWith((req, res) => res.redirect('/admin/login')), async (req, res) => {
  await audit(req, 'logout');
  req.session.destroy(() => res.redirect('/admin/login'));
});

app.get('/admin/dashboard', requireLogin, (req, res) => {
  sendView(res, 'admin-dashboard.html');
});

// ข้อมูลผู้ใช้ที่ล็อกอินอยู่ (ใช้ซ่อน/แสดงส่วนต่าง ๆ ของแดชบอร์ดตามบทบาท)
app.get('/admin/api/me', requireLoginApi, (req, res) => {
  res.json({
    ok: true,
    user: Object.assign({}, req.user, { role_label: ROLE_LABEL[req.user.role] }),
    weakPassword: Boolean(req.session.weakPassword),
  });
});

// เปลี่ยนรหัสผ่านของตัวเอง — session อื่นของผู้ใช้นี้ (เครื่องอื่น) จะถูกออกจากระบบ
app.post('/admin/api/me/password', requireLoginApi, async (req, res) => {
  const { current, next: newPassword } = req.body || {};
  try {
    const [[user]] = await pool.query('SELECT * FROM admin_users WHERE id = ?', [req.user.id]);
    if (!(await verifyPassword(user, current))) {
      return res.status(400).json({ ok: false, error: 'รหัสผ่านปัจจุบันไม่ถูกต้อง' });
    }
    const problem = validateNewPassword(newPassword);
    if (problem) return res.status(400).json({ ok: false, error: problem });

    await pool.query('UPDATE admin_users SET password = ? WHERE id = ?', [await bcrypt.hash(newPassword, 10), user.id]);
    req.session.weakPassword = false;
    const kicked = await sessionStore.destroyByUser(user.id, req.sessionID);
    await audit(req, 'password-change', kicked ? `ออกจากระบบเครื่องอื่น ${kicked} session` : null);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// ตั้ง / ล้าง PIN สำหรับกรอกเลขบัตรแทนที่คูหา (ต้องยืนยันด้วยรหัสผ่าน)
app.post('/admin/api/me/pin', requireLoginApi, async (req, res) => {
  const { password, pin } = req.body || {};
  try {
    const [[user]] = await pool.query('SELECT * FROM admin_users WHERE id = ?', [req.user.id]);
    if (!(await verifyPassword(user, password))) {
      return res.status(400).json({ ok: false, error: 'รหัสผ่านไม่ถูกต้อง' });
    }
    if (pin === '' || pin === null) {
      await pool.query('UPDATE admin_users SET kiosk_pin = NULL WHERE id = ?', [user.id]);
      await audit(req, 'pin-clear');
      return res.json({ ok: true });
    }
    if (!/^\d{6}$/.test(String(pin))) return res.status(400).json({ ok: false, error: 'PIN ต้องเป็นตัวเลข 6 หลัก' });
    if (/^(\d)\1{5}$/.test(pin) || '0123456789'.includes(pin) || '9876543210'.includes(pin)) {
      return res.status(400).json({ ok: false, error: 'PIN เดาง่ายเกินไป (เลขเรียงหรือเลขซ้ำ)' });
    }
    if (await findUserByPin(pin, user.id)) {
      return res.status(400).json({ ok: false, error: 'PIN นี้ถูกใช้โดยผู้ใช้อื่นแล้ว กรุณาเลือก PIN อื่น' });
    }
    await pool.query('UPDATE admin_users SET kiosk_pin = ? WHERE id = ?', [await bcrypt.hash(pin, 10), user.id]);
    await audit(req, 'pin-set');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  จัดการบัญชีผู้ใช้ (เฉพาะผู้ดูแลระบบ)                                     */
/* ------------------------------------------------------------------ */
async function countAdmins(exceptId = null) {
  const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM admin_users WHERE role = 'admin' AND id <> ?", [
    exceptId || 0,
  ]);
  return n;
}

app.get('/admin/api/users', requireAdminApi, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT id, username, display_name, role, (kiosk_pin IS NOT NULL) AS has_pin,
              DATE_FORMAT(last_login_at, '%d/%m/%Y %H:%i') AS last_login_at,
              DATE_FORMAT(created_at, '%d/%m/%Y') AS created_at
       FROM admin_users ORDER BY role ASC, username ASC`
    );
    res.json({ ok: true, users: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

app.post('/admin/api/users', requireAdminApi, async (req, res) => {
  const b = req.body || {};
  const username = String(b.username || '').trim();
  const role = b.role === 'admin' ? 'admin' : 'officer';
  const displayName = String(b.display_name || '').trim().slice(0, 150);
  if (!/^[A-Za-z0-9._-]{3,50}$/.test(username)) {
    return res.status(400).json({ ok: false, error: 'ชื่อผู้ใช้ต้องเป็นภาษาอังกฤษ/ตัวเลข/._- ยาว 3-50 ตัว' });
  }
  const problem = validateNewPassword(b.password);
  if (problem) return res.status(400).json({ ok: false, error: problem });
  try {
    await pool.query('INSERT INTO admin_users (username, password, display_name, role) VALUES (?, ?, ?, ?)', [
      username,
      await bcrypt.hash(String(b.password), 10),
      displayName,
      role,
    ]);
    await audit(req, 'user-create', `${username} (${ROLE_LABEL[role]})`);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ ok: false, error: 'มีชื่อผู้ใช้นี้อยู่แล้ว' });
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// แก้ไขชื่อ/บทบาท, รีเซ็ตรหัสผ่าน, ล้าง PIN ของผู้ใช้อื่น
app.put('/admin/api/users/:uid', requireAdminApi, async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  const b = req.body || {};
  try {
    const [[target]] = await pool.query('SELECT id, username, role FROM admin_users WHERE id = ?', [uid]);
    if (!target) return res.status(404).json({ ok: false, error: 'ไม่พบผู้ใช้นี้' });

    const role = b.role === 'admin' ? 'admin' : b.role === 'officer' ? 'officer' : target.role;
    if (target.role === 'admin' && role !== 'admin' && (await countAdmins(uid)) === 0) {
      return res.status(400).json({ ok: false, error: 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน' });
    }
    const changes = [];
    await pool.query('UPDATE admin_users SET display_name = ?, role = ? WHERE id = ?', [
      String(b.display_name || '').trim().slice(0, 150),
      role,
      uid,
    ]);
    if (role !== target.role) changes.push(`บทบาท ${ROLE_LABEL[target.role]} → ${ROLE_LABEL[role]}`);

    if (b.password) {
      const problem = validateNewPassword(b.password);
      if (problem) return res.status(400).json({ ok: false, error: problem });
      await pool.query('UPDATE admin_users SET password = ? WHERE id = ?', [await bcrypt.hash(String(b.password), 10), uid]);
      await sessionStore.destroyByUser(uid, uid === req.user.id ? req.sessionID : null);
      changes.push('รีเซ็ตรหัสผ่าน');
    }
    if (b.clear_pin) {
      await pool.query('UPDATE admin_users SET kiosk_pin = NULL WHERE id = ?', [uid]);
      changes.push('ล้าง PIN');
    }
    await audit(req, 'user-update', `${target.username}${changes.length ? ': ' + changes.join(', ') : ''}`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

app.delete('/admin/api/users/:uid', requireAdminApi, async (req, res) => {
  const uid = parseInt(req.params.uid, 10);
  if (uid === req.user.id) return res.status(400).json({ ok: false, error: 'ลบบัญชีของตัวเองไม่ได้' });
  try {
    const [[target]] = await pool.query('SELECT id, username, role FROM admin_users WHERE id = ?', [uid]);
    if (!target) return res.status(404).json({ ok: false, error: 'ไม่พบผู้ใช้นี้' });
    if (target.role === 'admin' && (await countAdmins(uid)) === 0) {
      return res.status(400).json({ ok: false, error: 'ต้องมีผู้ดูแลระบบอย่างน้อย 1 คน' });
    }
    await pool.query('DELETE FROM admin_users WHERE id = ?', [uid]);
    await sessionStore.destroyByUser(uid);
    await audit(req, 'user-delete', target.username);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  อ่านบันทึกการใช้งานระบบ (เฉพาะผู้ดูแลระบบ)                                */
/* ------------------------------------------------------------------ */
async function queryAudit(limit) {
  const [rows] = await pool.query(
    `SELECT a.id, DATE_FORMAT(a.created_at, '%d/%m/%Y %H:%i:%s') AS created_at, a.username, a.action,
            a.election_id, e.title AS election_title, a.detail, a.ip
     FROM audit_logs a LEFT JOIN elections e ON e.id = a.election_id
     ORDER BY a.id DESC LIMIT ?`,
    [limit]
  );
  return rows;
}

app.get('/admin/api/audit', requireAdminApi, async (req, res) => {
  try {
    const limit = Math.min(5000, Math.max(1, parseInt(req.query.limit, 10) || 1000));
    res.json({ ok: true, logs: await queryAudit(limit) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  กิจกรรมเลือกตั้ง (หลายกิจกรรมในวันเดียว)                               */
/* ------------------------------------------------------------------ */
const ELECTION_COLUMNS = `
  e.id, e.title, e.description,
  DATE_FORMAT(e.election_date, '%Y-%m-%d') AS election_date,
  e.status, e.require_registration, e.hide_results,
  DATE_FORMAT(e.scheduled_open_at, '%Y-%m-%dT%H:%i') AS scheduled_open_at,
  DATE_FORMAT(e.scheduled_close_at, '%Y-%m-%dT%H:%i') AS scheduled_close_at,
  DATE_FORMAT(e.opened_at, '%d/%m/%Y %H:%i:%s') AS opened_at,
  DATE_FORMAT(e.closed_at, '%d/%m/%Y %H:%i:%s') AS closed_at,
  (SELECT COUNT(*) FROM eligible_voters v WHERE v.election_id = e.id) AS eligible_count,
  (SELECT COUNT(*) FROM activity_logs l WHERE l.election_id = e.id) AS voted_count,
  (SELECT COUNT(*) FROM vote_candidates c WHERE c.election_id = e.id) AS candidate_count,
  (SELECT CAST(COALESCE(SUM(c.vote_count), 0) AS SIGNED) FROM vote_candidates c WHERE c.election_id = e.id) AS total_votes`;

const STATUS_LABEL = { draft: 'เตรียมการ', open: 'เปิดลงคะแนน', closed: 'ปิดลงคะแนน' };

async function fetchElection(id) {
  const [[row]] = await pool.query(`SELECT ${ELECTION_COLUMNS} FROM elections e WHERE e.id = ?`, [id]);
  return row || null;
}

// ซ่อนผลคะแนนรายผู้สมัครระหว่างเปิดลงคะแนน (ความลับของผล — ไม่มีใครเห็นผลก่อนปิดหีบ)
// ยังเห็น "จำนวนบัตรรวม" ได้ เพื่อตรวจว่าระบบนับคะแนนทำงานปกติ
function resultsHidden(election) {
  return election.status === 'open' && Boolean(election.hide_results);
}
function maskVotes(rows, election) {
  return resultsHidden(election) ? rows.map((r) => Object.assign({}, r, { vote_count: null })) : rows;
}

// middleware: โหลดกิจกรรมจาก :id ใส่ req.election (404 ถ้าไม่พบ)
// ถ้าใช้หลังอัปโหลดรูป (multer) แล้วไม่พบกิจกรรม ให้ลบไฟล์ที่เพิ่งอัปโหลดทิ้งด้วย
async function loadElection(req, res, next) {
  try {
    const election = await fetchElection(parseInt(req.params.id, 10));
    if (!election) {
      if (req.file) fs.unlink(req.file.path, () => {});
      return res.status(404).json({ ok: false, error: 'ไม่พบกิจกรรมเลือกตั้งนี้' });
    }
    req.election = election;
    next();
  } catch (e) {
    if (req.file) fs.unlink(req.file.path, () => {});
    res.status(500).json({ ok: false, error: 'database error' });
  }
}

// "2026-09-29T08:30" (input datetime-local) → "2026-09-29 08:30:00" / ค่าว่าง → null
function parseLocalDateTime(value) {
  const s = String(value || '').trim();
  if (!s) return { value: null };
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(:\d{2})?$/);
  return m ? { value: `${m[1]} ${m[2]}:00` } : { error: 'รูปแบบวันเวลาไม่ถูกต้อง' };
}

// ตรวจและแปลงข้อมูลฟอร์มกิจกรรม
function readElectionForm(body) {
  const b = body || {};
  const title = String(b.title || '').trim().slice(0, 255);
  const description = String(b.description || '').trim() || null;
  const date = String(b.election_date || '').trim();
  const flag = (v) => (v === true || v === '1' || v === 1 ? 1 : 0);
  if (!title) return { error: 'กรุณากรอกชื่อกิจกรรมเลือกตั้ง' };
  if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: 'รูปแบบวันที่ไม่ถูกต้อง' };
  const openAt = parseLocalDateTime(b.scheduled_open_at);
  const closeAt = parseLocalDateTime(b.scheduled_close_at);
  if (openAt.error || closeAt.error) return { error: openAt.error || closeAt.error };
  if (openAt.value && closeAt.value && closeAt.value <= openAt.value) {
    return { error: 'เวลาปิดลงคะแนนต้องหลังเวลาเปิด' };
  }
  return {
    title,
    description,
    election_date: date || null,
    require_registration: flag(b.require_registration),
    hide_results: flag(b.hide_results),
    scheduled_open_at: openAt.value,
    scheduled_close_at: closeAt.value,
  };
}

// เปลี่ยนสถานะกิจกรรม — ใช้ร่วมกันระหว่างปุ่มในแดชบอร์ดและตัวตั้งเวลาอัตโนมัติ
// req = null เมื่อระบบเป็นผู้เปลี่ยน (ตั้งเวลา) — บันทึก audit ในชื่อ system
async function changeElectionStatus(e, status, req = null) {
  if (!['draft', 'open', 'closed'].includes(status)) return { error: 'สถานะไม่ถูกต้อง' };
  if (status === 'open') {
    const [[{ n }]] = await pool.query(
      'SELECT COUNT(*) AS n FROM vote_candidates WHERE election_id = ? AND candidate_no <> ?',
      [e.id, NO_VOTE_NO]
    );
    if (n === 0) return { error: 'ยังไม่มีผู้สมัคร — เพิ่มผู้สมัครก่อนเปิดลงคะแนน' };
    if (e.require_registration && e.eligible_count === 0) {
      return {
        error: 'กิจกรรมนี้ลงคะแนนได้เฉพาะผู้มีรายชื่อ แต่ยังไม่มีบัญชีรายชื่อ — import รายชื่อก่อน หรือปิดตัวเลือก "เฉพาะผู้มีรายชื่อ"',
      };
    }
  }
  if (status === 'draft' && e.voted_count > 0) {
    return { error: 'มีผู้ลงคะแนนแล้ว ย้อนกลับเป็น "เตรียมการ" ไม่ได้' };
  }

  // เปิด → ล้างเวลาเปิดอัตโนมัติ / ปิด → ล้างเวลาที่ตั้งไว้ทั้งหมด (กันระบบเปิด-ปิดซ้ำเองภายหลัง)
  await pool.query(
    `UPDATE elections SET status = ?,
       opened_at = IF(? = 'open', COALESCE(opened_at, NOW()), opened_at),
       closed_at = IF(? = 'closed', NOW(), NULL),
       scheduled_open_at = IF(? IN ('open', 'closed'), NULL, scheduled_open_at),
       scheduled_close_at = IF(? = 'closed', NULL, scheduled_close_at)
     WHERE id = ?`,
    [status, status, status, status, status, e.id]
  );
  await audit(
    req,
    'election-status',
    `${e.title}: ${STATUS_LABEL[e.status]} → ${STATUS_LABEL[status]}${req ? '' : ' (ตามเวลาที่ตั้งไว้)'}`,
    e.id,
    req ? undefined : null
  );
  notifyElectionsChanged();

  // ปิดลงคะแนนแล้ว → สำรองข้อมูลทันที (ผลการเลือกตั้งอยู่ในไฟล์สำรองแน่นอน)
  if (status === 'closed') runBackup(`close-e${e.id}`, null).catch(() => {});
  return { ok: true };
}

app.get('/admin/api/elections', requireLoginApi, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT ${ELECTION_COLUMNS} FROM elections e ORDER BY e.election_date DESC, e.id DESC`
    );
    res.json({ elections: rows, username: req.user.username });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// สร้างกิจกรรมใหม่ (สถานะเตรียมการ) พร้อมช่อง "ไม่ประสงค์ลงคะแนน" ให้อัตโนมัติ
app.post('/admin/api/elections', requireAdminApi, async (req, res) => {
  const form = readElectionForm(req.body);
  if (form.error) return res.status(400).json({ ok: false, error: form.error });
  try {
    const [r] = await pool.query(
      `INSERT INTO elections (title, description, election_date, require_registration, hide_results,
         scheduled_open_at, scheduled_close_at, status)
       VALUES (?, ?, COALESCE(?, CURDATE()), ?, ?, ?, ?, 'draft')`,
      [form.title, form.description, form.election_date, form.require_registration, form.hide_results,
        form.scheduled_open_at, form.scheduled_close_at]
    );
    if (req.body.add_novote !== false) {
      await pool.query(
        `INSERT INTO vote_candidates (election_id, candidate_no, candidate_name, photo_url, vote_count)
         VALUES (?, ?, 'ไม่ประสงค์ลงคะแนน', '/img/novote.svg', 0)`,
        [r.insertId, NO_VOTE_NO]
      );
    }
    await audit(req, 'election-create', form.title, r.insertId);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    console.error('[ADMIN] create election:', e.message);
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

app.put('/admin/api/elections/:id', requireAdminApi, loadElection, async (req, res) => {
  const form = readElectionForm(req.body);
  const e = req.election;
  if (form.error) return res.status(400).json({ ok: false, error: form.error });
  if (e.status === 'open' && form.require_registration && e.eligible_count === 0) {
    return res.status(400).json({ ok: false, error: 'กิจกรรมเปิดอยู่แต่ยังไม่มีบัญชีรายชื่อ — import รายชื่อก่อนเปิดใช้ "เฉพาะผู้มีรายชื่อ"' });
  }
  try {
    await pool.query(
      `UPDATE elections SET title = ?, description = ?, election_date = COALESCE(?, election_date),
         require_registration = ?, hide_results = ?, scheduled_open_at = ?, scheduled_close_at = ?
       WHERE id = ?`,
      [form.title, form.description, form.election_date, form.require_registration, form.hide_results,
        form.scheduled_open_at, form.scheduled_close_at, e.id]
    );

    // สรุปการเปลี่ยนแปลงที่สำคัญลง audit log
    const changes = [];
    if (form.title !== e.title) changes.push(`ชื่อ "${e.title}" → "${form.title}"`);
    if (form.require_registration !== e.require_registration) {
      changes.push(form.require_registration ? 'บังคับบัญชีรายชื่อ' : 'ยกเลิกบังคับบัญชีรายชื่อ');
    }
    if (form.hide_results !== e.hide_results) {
      changes.push(form.hide_results ? 'ซ่อนผลคะแนนระหว่างลงคะแนน'
        : `แสดงผลคะแนนระหว่างลงคะแนน${e.status === 'open' ? ' (ขณะเปิดลงคะแนนอยู่!)' : ''}`);
    }
    const norm = (v) => (v ? v.replace('T', ' ').slice(0, 16) : '');
    if (norm(form.scheduled_open_at) !== norm(e.scheduled_open_at)) {
      changes.push(`เวลาเปิดอัตโนมัติ: ${norm(form.scheduled_open_at) || 'ไม่ตั้ง'}`);
    }
    if (norm(form.scheduled_close_at) !== norm(e.scheduled_close_at)) {
      changes.push(`เวลาปิดอัตโนมัติ: ${norm(form.scheduled_close_at) || 'ไม่ตั้ง'}`);
    }
    await audit(req, 'election-update', changes.join(', ') || 'แก้ไขรายละเอียด', e.id);

    notifyElectionsChanged();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// เปลี่ยนสถานะ: draft (เตรียมการ) / open (เปิดลงคะแนน) / closed (ปิดลงคะแนน)
app.post('/admin/api/elections/:id/status', requireAdminApi, loadElection, async (req, res) => {
  try {
    const result = await changeElectionStatus(req.election, String((req.body && req.body.status) || ''), req);
    if (result.error) return res.status(400).json({ ok: false, error: result.error });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// ลบกิจกรรม (พร้อมผู้สมัคร / บัญชีรายชื่อ / บันทึกผู้มาใช้สิทธิ์) — ต้องปิดลงคะแนนก่อน
app.delete('/admin/api/elections/:id', requireAdminApi, loadElection, async (req, res) => {
  const e = req.election;
  if (e.status === 'open') {
    return res.status(400).json({ ok: false, error: 'กิจกรรมกำลังเปิดลงคะแนน — ปิดลงคะแนนก่อนจึงลบได้' });
  }
  let conn;
  try {
    // สำรองข้อมูลก่อนลบเสมอ (กู้คืนได้ถ้าลบผิดกิจกรรม)
    await runBackup(`pre-delete-e${e.id}`, req);
    const [photos] = await pool.query('SELECT photo_url FROM vote_candidates WHERE election_id = ?', [e.id]);
    conn = await pool.getConnection();
    await conn.beginTransaction();
    for (const table of ['activity_logs', 'eligible_voters', 'vote_candidates']) {
      await conn.query(`DELETE FROM ${table} WHERE election_id = ?`, [e.id]);
    }
    await conn.query('DELETE FROM elections WHERE id = ?', [e.id]);
    await conn.commit();
    photos.forEach((p) => deleteUploadedPhoto(p.photo_url));
    await audit(req, 'election-delete',
      `${e.title} (ผู้มาใช้สิทธิ์ ${e.voted_count}, บัญชีรายชื่อ ${e.eligible_count}, บัตร ${e.total_votes})`, e.id);
    notifyElectionsChanged();
    res.json({ ok: true });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    res.status(500).json({ ok: false, error: 'database error' });
  } finally {
    if (conn) conn.release();
  }
});

// รายชื่อผู้มาใช้สิทธิ์ (บันทึกการเข้าร่วมกิจกรรม) — ระบุว่าอยู่ในบัญชีรายชื่อหรือไม่
app.get('/admin/api/elections/:id/logs', requireLoginApi, loadElection, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT l.citizen_id, l.full_name, COALESCE(v.group_name, '') AS group_name,
              (v.id IS NOT NULL) AS in_registry, l.entry_method, u.username AS officer,
              DATE_FORMAT(l.voted_at, '%d/%m/%Y %H:%i:%s') AS voted_at
       FROM activity_logs l
       LEFT JOIN eligible_voters v ON v.election_id = l.election_id AND v.citizen_id = l.citizen_id
       LEFT JOIN admin_users u ON u.id = l.officer_id
       WHERE l.election_id = ? ORDER BY l.voted_at DESC, l.id DESC`,
      [req.election.id]
    );
    res.json({ total: rows.length, logs: rows });
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

// ผลคะแนนสด (ซ่อนคะแนนรายผู้สมัครระหว่างเปิดลงคะแนน ถ้ากิจกรรมตั้งไว้)
app.get('/admin/api/elections/:id/results', requireLoginApi, loadElection, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT candidate_no, candidate_name, photo_url, vote_count FROM vote_candidates
       WHERE election_id = ? ORDER BY candidate_no ASC`,
      [req.election.id]
    );
    const totalVotes = rows.reduce((sum, r) => sum + r.vote_count, 0);
    res.json({
      election: req.election,
      totalVotes,
      hidden: resultsHidden(req.election),
      results: maskVotes(rows, req.election),
    });
  } catch (e) {
    res.status(500).json({ error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  บัญชีรายชื่อผู้มีสิทธิ์เลือกตั้ง (import / เพิ่ม / ลบ / คัดลอก / พิมพ์)     */
/* ------------------------------------------------------------------ */
app.get('/admin/api/elections/:id/voters', requireLoginApi, loadElection, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT v.id, v.citizen_id, v.prefix, v.first_name, v.last_name, v.group_name,
              DATE_FORMAT(l.voted_at, '%d/%m/%Y %H:%i:%s') AS voted_at
       FROM eligible_voters v
       LEFT JOIN activity_logs l ON l.election_id = v.election_id AND l.citizen_id = v.citizen_id
       WHERE v.election_id = ? ORDER BY v.id ASC`,
      [req.election.id]
    );
    res.json({ election: req.election, voters: rows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// บันทึกรายชื่อหลายคนพร้อมกัน (ถ้าเลขบัตรซ้ำในกิจกรรมเดียวกัน → อัปเดตชื่อ/กลุ่มแทน)
async function upsertVoters(conn, electionId, voters) {
  const CHUNK = 500;
  for (let i = 0; i < voters.length; i += CHUNK) {
    const values = voters
      .slice(i, i + CHUNK)
      .map((v) => [electionId, v.citizen_id, v.prefix, v.first_name, v.last_name, v.group_name]);
    await conn.query(
      `INSERT INTO eligible_voters (election_id, citizen_id, prefix, first_name, last_name, group_name)
       VALUES ?
       ON DUPLICATE KEY UPDATE prefix = VALUES(prefix), first_name = VALUES(first_name),
         last_name = VALUES(last_name), group_name = VALUES(group_name)`,
      [values]
    );
  }
}

// import จากไฟล์ CSV / ข้อความที่คัดลอกจาก Excel
//   mode: append = เพิ่ม/อัปเดตต่อจากเดิม, replace = ล้างบัญชีเดิมแล้วใส่ใหม่ทั้งหมด
//   dryRun: true = ตรวจสอบอย่างเดียว ยังไม่บันทึก (ใช้แสดงตัวอย่างก่อนยืนยัน)
app.post('/admin/api/elections/:id/voters/import', requireAdminApi, loadElection, async (req, res) => {
  const { text, mode, dryRun } = req.body || {};
  const { voters, errors } = parseVoterList(text);
  const e = req.election;

  if (dryRun) {
    const [existing] = voters.length
      ? await pool.query('SELECT citizen_id FROM eligible_voters WHERE election_id = ? AND citizen_id IN (?)', [
          e.id,
          voters.map((v) => v.citizen_id),
        ])
      : [[]];
    return res.json({
      ok: true,
      dryRun: true,
      valid: voters.length,
      existing: mode === 'replace' ? 0 : existing.length,
      errors: errors.slice(0, 200),
      errorCount: errors.length,
      sample: voters.slice(0, 5),
    });
  }

  if (voters.length === 0) {
    return res.status(400).json({ ok: false, error: 'ไม่พบรายชื่อที่ถูกต้องในข้อมูล', errors: errors.slice(0, 200) });
  }

  let conn;
  try {
    conn = await pool.getConnection();
    await conn.beginTransaction();
    if (mode === 'replace') await conn.query('DELETE FROM eligible_voters WHERE election_id = ?', [e.id]);
    const [[before]] = await conn.query('SELECT COUNT(*) AS n FROM eligible_voters WHERE election_id = ?', [e.id]);
    await upsertVoters(conn, e.id, voters);
    const [[after]] = await conn.query('SELECT COUNT(*) AS n FROM eligible_voters WHERE election_id = ?', [e.id]);
    await conn.commit();

    const added = after.n - before.n;
    await audit(
      req,
      'voters-import',
      `${mode === 'replace' ? 'แทนที่บัญชีเดิม' : 'เพิ่มต่อ'} — เพิ่ม ${added}, อัปเดต ${voters.length - added}, ` +
        `ข้ามแถวผิด ${errors.length} (รวม ${after.n} คน)`,
      e.id
    );
    res.json({ ok: true, added, updated: voters.length - added, total: after.n, errorCount: errors.length, errors: errors.slice(0, 200) });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[ADMIN] import voters:', err.message);
    res.status(500).json({ ok: false, error: 'บันทึกรายชื่อไม่สำเร็จ' });
  } finally {
    if (conn) conn.release();
  }
});

// เพิ่มผู้มีสิทธิ์ทีละคน (เช่น ตกหล่นจากไฟล์)
app.post('/admin/api/elections/:id/voters', requireAdminApi, loadElection, async (req, res) => {
  const b = req.body || {};
  const citizenId = normalizeCitizenId(b.citizen_id);
  let prefix = String(b.prefix || '').trim();
  let firstName = String(b.first_name || '').trim();
  const lastName = String(b.last_name || '').trim();
  if (!prefix) ({ prefix, rest: firstName } = splitPrefix(firstName));

  if (!isValidCitizenId(citizenId)) {
    return res.status(400).json({ ok: false, error: 'เลขบัตรประชาชนไม่ถูกต้อง (ต้องเป็น 13 หลัก และหลักตรวจสอบถูกต้อง)' });
  }
  if (!firstName) return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อ' });

  try {
    await pool.query(
      `INSERT INTO eligible_voters (election_id, citizen_id, prefix, first_name, last_name, group_name)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.election.id, citizenId, prefix.slice(0, 50), firstName.slice(0, 150), lastName.slice(0, 150),
        String(b.group_name || '').trim().slice(0, 150)]
    );
    await audit(req, 'voter-add', `${prefix}${firstName} ${lastName} (${maskCid(citizenId)})`, req.election.id);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, error: 'เลขบัตรนี้มีอยู่ในบัญชีรายชื่อของกิจกรรมนี้แล้ว' });
    }
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

app.delete('/admin/api/elections/:id/voters/:voterId', requireAdminApi, loadElection, async (req, res) => {
  try {
    const voterId = parseInt(req.params.voterId, 10);
    const [[v]] = await pool.query(
      'SELECT citizen_id, prefix, first_name, last_name FROM eligible_voters WHERE id = ? AND election_id = ?',
      [voterId, req.election.id]
    );
    if (!v) return res.status(404).json({ ok: false, error: 'ไม่พบรายชื่อนี้' });
    await pool.query('DELETE FROM eligible_voters WHERE id = ?', [voterId]);
    await audit(req, 'voter-delete', `${v.prefix}${v.first_name} ${v.last_name} (${maskCid(v.citizen_id)})`, req.election.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// คัดลอกบัญชีรายชื่อจากกิจกรรมอื่น (เช่น หลายกิจกรรมในวันเดียวที่ใช้ผู้มีสิทธิ์ชุดเดียวกัน)
app.post('/admin/api/elections/:id/voters/copy', requireAdminApi, loadElection, async (req, res) => {
  const fromId = parseInt((req.body || {}).from_election_id, 10);
  if (!Number.isInteger(fromId) || fromId === req.election.id) {
    return res.status(400).json({ ok: false, error: 'กรุณาเลือกกิจกรรมต้นทาง' });
  }
  try {
    const [r] = await pool.query(
      `INSERT IGNORE INTO eligible_voters (election_id, citizen_id, prefix, first_name, last_name, group_name)
       SELECT ?, citizen_id, prefix, first_name, last_name, group_name
       FROM eligible_voters WHERE election_id = ? ORDER BY id ASC`,
      [req.election.id, fromId]
    );
    await audit(req, 'voters-copy', `คัดลอกจากกิจกรรม #${fromId}: เพิ่ม ${r.affectedRows} คน`, req.election.id);
    res.json({ ok: true, added: r.affectedRows });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  รายงานผลการเลือกตั้ง + ส่งออก CSV                                    */
/* ------------------------------------------------------------------ */
app.get('/admin/api/elections/:id/report', requireLoginApi, loadElection, async (req, res) => {
  const e = req.election;
  try {
    const [candidates] = await pool.query(
      `SELECT candidate_no, candidate_name, description, vote_count FROM vote_candidates
       WHERE election_id = ? ORDER BY candidate_no ASC`,
      [e.id]
    );
    const [[turnout]] = await pool.query(
      `SELECT COUNT(*) AS voted,
              CAST(COALESCE(SUM(v.id IS NOT NULL), 0) AS SIGNED) AS voted_registered,
              CAST(COALESCE(SUM(l.entry_method = 'manual'), 0) AS SIGNED) AS manual_entries,
              DATE_FORMAT(MIN(l.voted_at), '%d/%m/%Y %H:%i:%s') AS first_vote_at,
              DATE_FORMAT(MAX(l.voted_at), '%d/%m/%Y %H:%i:%s') AS last_vote_at
       FROM activity_logs l
       LEFT JOIN eligible_voters v ON v.election_id = l.election_id AND v.citizen_id = l.citizen_id
       WHERE l.election_id = ?`,
      [e.id]
    );
    const [byGroup] = await pool.query(
      `SELECT v.group_name, COUNT(*) AS eligible, CAST(SUM(l.id IS NOT NULL) AS SIGNED) AS voted
       FROM eligible_voters v
       LEFT JOIN activity_logs l ON l.election_id = v.election_id AND l.citizen_id = v.citizen_id
       WHERE v.election_id = ? GROUP BY v.group_name ORDER BY v.group_name ASC`,
      [e.id]
    );
    const [hourly] = await pool.query(
      `SELECT DATE_FORMAT(voted_at, '%d/%m/%Y %H:00') AS hour, COUNT(*) AS count
       FROM activity_logs WHERE election_id = ?
       GROUP BY DATE_FORMAT(voted_at, '%d/%m/%Y %H:00'), DATE(voted_at), HOUR(voted_at)
       ORDER BY DATE(voted_at), HOUR(voted_at)`,
      [e.id]
    );

    const totalVotes = candidates.reduce((s, c) => s + c.vote_count, 0);
    const noVote = candidates.filter((c) => c.candidate_no === NO_VOTE_NO).reduce((s, c) => s + c.vote_count, 0);
    const hidden = resultsHidden(e);

    res.json({
      ok: true,
      election: e,
      generatedAt: new Date().toLocaleString('th-TH'),
      hidden, // ซ่อนคะแนนรายผู้สมัคร (ยังเปิดลงคะแนนอยู่) — แสดงเฉพาะข้อมูลการใช้สิทธิ์
      candidates: maskVotes(candidates, e),
      totalVotes,
      noVote: hidden ? null : noVote,
      noVoteNo: NO_VOTE_NO,
      eligible: e.eligible_count,
      voted: turnout.voted,
      votedRegistered: turnout.voted_registered,
      votedUnregistered: turnout.voted - turnout.voted_registered,
      manualEntries: turnout.manual_entries,
      firstVoteAt: turnout.first_vote_at,
      lastVoteAt: turnout.last_vote_at,
      byGroup,
      hourly,
    });
  } catch (err) {
    console.error('[ADMIN] report:', err.message);
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// สร้างไฟล์ CSV (UTF-8 + BOM ให้ Excel อ่านภาษาไทยถูก)
function sendCsv(res, filename, headers, rows) {
  const esc = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // เลขบัตร 13 หลัก: ห่อเป็น ="..." ไม่ให้ Excel แปลงเป็นเลขยกกำลัง
  const cell = (v) => (/^\d{13}$/.test(String(v)) ? `="${v}"` : esc(v));
  const body = [headers.map(esc).join(','), ...rows.map((r) => r.map(cell).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.send('﻿' + body);
}

// ส่งออกข้อมูล — ไฟล์ที่มีเลขบัตรประชาชน (ข้อมูลส่วนบุคคล) ถูกบันทึกลง audit log ทุกครั้ง
app.get('/admin/api/elections/:id/export/:kind.csv', requireLoginApi, loadElection, async (req, res) => {
  const e = req.election;
  const KIND_LABEL = { voters: 'บัญชีรายชื่อผู้มีสิทธิ์', logs: 'รายชื่อผู้มาใช้สิทธิ์', results: 'ผลคะแนน' };
  if (!KIND_LABEL[req.params.kind]) return res.status(404).json({ ok: false, error: 'ไม่รู้จักประเภทไฟล์' });
  if (req.params.kind === 'results' && resultsHidden(e)) {
    return res.status(403).json({ ok: false, error: 'ผลคะแนนถูกซ่อนจนกว่าจะปิดลงคะแนน' });
  }
  await audit(req, 'export', `ดาวน์โหลด CSV: ${KIND_LABEL[req.params.kind]}`, e.id);
  try {
    if (req.params.kind === 'voters') {
      const [rows] = await pool.query(
        `SELECT v.citizen_id, v.prefix, v.first_name, v.last_name, v.group_name,
                DATE_FORMAT(l.voted_at, '%d/%m/%Y %H:%i:%s') AS voted_at
         FROM eligible_voters v
         LEFT JOIN activity_logs l ON l.election_id = v.election_id AND l.citizen_id = v.citizen_id
         WHERE v.election_id = ? ORDER BY v.id ASC`,
        [e.id]
      );
      return sendCsv(res, `ผู้มีสิทธิ์-${e.id}.csv`,
        ['ลำดับ', 'เลขประจำตัวประชาชน', 'คำนำหน้า', 'ชื่อ', 'นามสกุล', 'กลุ่ม/ชั้น', 'สถานะ', 'เวลาใช้สิทธิ์'],
        rows.map((r, i) => [i + 1, r.citizen_id, r.prefix, r.first_name, r.last_name, r.group_name,
          r.voted_at ? 'มาใช้สิทธิ์แล้ว' : 'ยังไม่มาใช้สิทธิ์', r.voted_at || '']));
    }
    if (req.params.kind === 'logs') {
      const [rows] = await pool.query(
        `SELECT l.citizen_id, l.full_name, COALESCE(v.group_name, '') AS group_name, (v.id IS NOT NULL) AS in_registry,
                l.entry_method, u.username AS officer,
                DATE_FORMAT(l.voted_at, '%d/%m/%Y %H:%i:%s') AS voted_at
         FROM activity_logs l
         LEFT JOIN eligible_voters v ON v.election_id = l.election_id AND v.citizen_id = l.citizen_id
         LEFT JOIN admin_users u ON u.id = l.officer_id
         WHERE l.election_id = ? ORDER BY l.voted_at ASC, l.id ASC`,
        [e.id]
      );
      return sendCsv(res, `ผู้มาใช้สิทธิ์-${e.id}.csv`,
        ['ลำดับ', 'เลขประจำตัวประชาชน', 'ชื่อ-นามสกุล', 'กลุ่ม/ชั้น', 'อยู่ในบัญชีรายชื่อ', 'ยืนยันตัวตนด้วย', 'เวลาใช้สิทธิ์'],
        rows.map((r, i) => [i + 1, r.citizen_id, r.full_name, r.group_name, r.in_registry ? 'ใช่' : 'ไม่ใช่',
          r.entry_method === 'manual' ? `เจ้าหน้าที่กรอกเลขบัตร (${r.officer || '-'})` : 'บัตรประชาชน', r.voted_at]));
    }
    if (req.params.kind === 'results') {
      const [rows] = await pool.query(
        'SELECT candidate_no, candidate_name, vote_count FROM vote_candidates WHERE election_id = ? ORDER BY vote_count DESC, candidate_no ASC',
        [e.id]
      );
      const total = rows.reduce((s, r) => s + r.vote_count, 0);
      return sendCsv(res, `ผลคะแนน-${e.id}.csv`,
        ['หมายเลข', 'ชื่อผู้สมัคร', 'คะแนน', 'ร้อยละ'],
        rows.map((r) => [r.candidate_no, r.candidate_name, r.vote_count, total ? ((r.vote_count / total) * 100).toFixed(2) : '0.00']));
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

app.get('/admin/api/audit.csv', requireAdminApi, async (req, res) => {
  try {
    const rows = await queryAudit(100000);
    sendCsv(res, 'บันทึกการใช้งานระบบ.csv',
      ['เวลา', 'ผู้ใช้', 'การกระทำ', 'กิจกรรม', 'รายละเอียด', 'IP'],
      rows.map((r) => [r.created_at, r.username, r.action, r.election_title || (r.election_id ? `#${r.election_id}` : ''), r.detail, r.ip]));
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// หน้าพิมพ์ (ประกาศรายชื่อผู้มีสิทธิ์ / รายงานผลการเลือกตั้ง) — ข้อมูลโหลดด้วย JS จาก API ด้านบน
app.get('/admin/print/voters', requireLogin, (req, res) => {
  sendView(res, 'print-voters.html');
});
app.get('/admin/print/report', requireLogin, (req, res) => {
  sendView(res, 'print-report.html');
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

    // เขตเวลา — เวลาของเซิร์ฟเวอร์กับฐานข้อมูลต้องตรงกัน ไม่เช่นนั้นเวลาที่บันทึก
    // การใช้สิทธิ์จะเพี้ยนไปจากเวลาจริง
    try {
      const [[tzRow]] = await pool.query(
        `SELECT @@session.time_zone AS tz, DATE_FORMAT(NOW(), '%d/%m/%Y %H:%i:%s') AS now`
      );
      const tzMatch = tzRow.tz === CONFIG.DB_TIMEZONE;
      add('server', 'เขตเวลา (Timezone)', tzMatch ? 'ok' : 'warn',
        `เซิร์ฟเวอร์ ${CONFIG.TZ} — ${new Date().toLocaleString('th-TH')} | ฐานข้อมูล ${tzRow.tz} — ${tzRow.now}`,
        tzMatch ? null : `ฐานข้อมูลใช้เขตเวลา ${tzRow.tz} ไม่ตรงกับ ${CONFIG.DB_TIMEZONE} — ตรวจค่า TZ / DB_TIMEZONE ในไฟล์ .env`);
    } catch (e) {
      add('server', 'เขตเวลา (Timezone)', 'warn',
        `เซิร์ฟเวอร์ ${CONFIG.TZ} — ${new Date().toLocaleString('th-TH')} (ตรวจฝั่งฐานข้อมูลไม่ได้)`);
    }

    /* ---------- กลุ่มที่ 4: ความปลอดภัยและการสำรองข้อมูล ---------- */
    add('security', 'ที่เก็บ session', 'ok', 'MySQL (ตาราง sessions) — ไม่หลุดจากระบบเมื่อ redeploy');
    add('security', 'SESSION_SECRET',
      CONFIG.SESSION_SECRET_SOURCE === 'env' ? 'ok' : 'warn',
      CONFIG.SESSION_SECRET_SOURCE === 'env' ? 'ตั้งค่าไว้ใน Environment Variables' : 'สุ่มให้อัตโนมัติและเก็บในฐานข้อมูล',
      CONFIG.SESSION_SECRET_SOURCE === 'env' ? null : 'ใช้งานได้ แต่แนะนำให้ตั้ง SESSION_SECRET (สตริงสุ่มยาว ๆ) ใน Coolify');

    const [users] = await pool.query("SELECT username, password, role FROM admin_users");
    const weak = [];
    for (const u of users) {
      if (u.password === DEFAULT_ADMIN_PASSWORD || (u.password.startsWith('$2') && (await bcrypt.compare(DEFAULT_ADMIN_PASSWORD, u.password)))) {
        weak.push(u.username);
      }
    }
    add('security', 'รหัสผ่านเริ่มต้น (password123)', weak.length ? 'fail' : 'ok',
      weak.length ? `ยังใช้อยู่: ${weak.join(', ')}` : 'ไม่มีบัญชีใดใช้รหัสผ่านเริ่มต้น',
      weak.length ? 'เปลี่ยนรหัสผ่านที่เมนู "บัญชีของฉัน" ก่อนใช้งานจริง' : null);
    add('security', 'บัญชีผู้ใช้', 'ok',
      `ผู้ดูแลระบบ ${users.filter((u) => u.role === 'admin').length} คน, เจ้าหน้าที่ ${users.filter((u) => u.role === 'officer').length} คน`);

    let backupDirOk = false;
    try {
      fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true });
      fs.accessSync(CONFIG.BACKUP_DIR, fs.constants.W_OK);
      backupDirOk = true;
    } catch (e) {
      backupDirOk = false;
    }
    add('security', 'โฟลเดอร์สำรองข้อมูล', backupDirOk ? 'ok' : 'fail',
      `${CONFIG.BACKUP_DIR} — ${backupDirOk ? 'เขียนได้' : 'เขียนไม่ได้'}`,
      backupDirOk ? null : 'ตรวจสิทธิ์ของโฟลเดอร์ หรือ volume "backups" ใน docker-compose');
    const latest = backup.listBackups(CONFIG.BACKUP_DIR)[0];
    const ageHours = latest ? (Date.now() - latest.mtime.getTime()) / 3600000 : Infinity;
    const expected = CONFIG.BACKUP_INTERVAL_HOURS || 24;
    add('security', 'สำรองข้อมูลล่าสุด',
      backupState.lastError ? 'fail' : ageHours <= expected * 1.5 ? 'ok' : 'warn',
      latest ? `${latest.name} (${latest.mtime.toLocaleString('th-TH')})` : 'ยังไม่เคยสำรองข้อมูล',
      backupState.lastError
        ? `สำรองครั้งล่าสุดล้มเหลว: ${backupState.lastError}`
        : ageHours <= expected * 1.5 ? null : 'กด "สำรองข้อมูลตอนนี้" ในส่วนสำรองข้อมูล');
    add('security', 'สำรองอัตโนมัติ', CONFIG.BACKUP_INTERVAL_HOURS > 0 ? 'ok' : 'warn',
      CONFIG.BACKUP_INTERVAL_HOURS > 0
        ? `ทุก ${CONFIG.BACKUP_INTERVAL_HOURS} ชั่วโมง + ทุกครั้งที่ปิดลงคะแนน (เก็บ ${CONFIG.BACKUP_KEEP} ไฟล์ล่าสุด)`
        : 'ปิดอยู่ (BACKUP_INTERVAL_HOURS=0) — ยังสำรองเมื่อปิดลงคะแนน',
      null);

    res.json({ ok: true, generatedAt: new Date().toLocaleString('th-TH'), checks });
  } catch (e) {
    console.error('[ADMIN] ตรวจสอบทรัพยากรระบบไม่สำเร็จ:', e.message);
    res.status(500).json({ ok: false, error: 'ตรวจสอบทรัพยากรระบบไม่สำเร็จ' });
  }
});

/* ------------------------------------------------------------------ */
/*  จัดการผู้สมัคร (CRUD) แยกตามกิจกรรม — เฉพาะผู้ดูแลระบบ                   */
/* ------------------------------------------------------------------ */

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

// ลบไฟล์รูปที่เพิ่งอัปโหลด เมื่อบันทึกไม่สำเร็จ
function discardUpload(req) {
  if (req.file) fs.unlink(req.file.path, () => {});
}

// รายชื่อผู้สมัครทั้งหมดของกิจกรรม (รวมคะแนน สำหรับหน้าจัดการ)
app.get('/admin/api/elections/:id/candidates', requireLoginApi, loadElection, async (req, res) => {
  try {
    const [rows] = await pool.query(
      `SELECT candidate_no, candidate_name, photo_url, description, vote_count FROM vote_candidates
       WHERE election_id = ? ORDER BY candidate_no ASC`,
      [req.election.id]
    );
    res.json({ candidates: maskVotes(rows, req.election), hidden: resultsHidden(req.election) });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// เพิ่มผู้สมัครใหม่
app.post('/admin/api/elections/:id/candidates', requireAdminApi, uploadPhoto, loadElection, async (req, res) => {
  const no = parseInt(req.body.candidate_no, 10);
  const name = String(req.body.candidate_name || '').trim();
  const description = String(req.body.description || '').trim() || null;

  if (!Number.isInteger(no) || no < 0 || no > 999 || !name) {
    discardUpload(req);
    return res.status(400).json({ ok: false, error: 'กรุณากรอกหมายเลข (0-999) และชื่อผู้สมัคร' });
  }

  const photoUrl = req.file ? `/img/uploads/${req.file.filename}` : '/img/novote.svg';

  try {
    await pool.query(
      `INSERT INTO vote_candidates (election_id, candidate_no, candidate_name, photo_url, description, vote_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
      [req.election.id, no, name, photoUrl, description]
    );
    await audit(req, 'candidate-add', `หมายเลข ${no}: ${name}`, req.election.id);
    notifyElectionsChanged();
    res.json({ ok: true });
  } catch (e) {
    discardUpload(req);
    if (e.code === 'ER_DUP_ENTRY') {
      return res.status(409).json({ ok: false, error: `มีผู้สมัครหมายเลข ${no} อยู่แล้วในกิจกรรมนี้` });
    }
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// แก้ไขข้อมูลผู้สมัคร (ชื่อ / รายละเอียด / รูปภาพ)
app.put('/admin/api/elections/:id/candidates/:no', requireAdminApi, uploadPhoto, loadElection, async (req, res) => {
  const no = parseInt(req.params.no, 10);
  const name = String(req.body.candidate_name || '').trim();
  const description = String(req.body.description || '').trim() || null;
  const electionId = req.election.id;

  if (!Number.isInteger(no) || !name) {
    discardUpload(req);
    return res.status(400).json({ ok: false, error: 'กรุณากรอกชื่อผู้สมัคร' });
  }

  try {
    const [rows] = await pool.query(
      'SELECT photo_url FROM vote_candidates WHERE election_id = ? AND candidate_no = ?',
      [electionId, no]
    );
    if (rows.length === 0) {
      discardUpload(req);
      return res.status(404).json({ ok: false, error: 'ไม่พบหมายเลขผู้สมัครนี้' });
    }

    if (req.file) {
      // อัปโหลดรูปใหม่ → ลบรูปเก่าที่เคยอัปโหลดไว้ทิ้ง
      await pool.query(
        'UPDATE vote_candidates SET candidate_name = ?, description = ?, photo_url = ? WHERE election_id = ? AND candidate_no = ?',
        [name, description, `/img/uploads/${req.file.filename}`, electionId, no]
      );
      deleteUploadedPhoto(rows[0].photo_url);
    } else {
      await pool.query(
        'UPDATE vote_candidates SET candidate_name = ?, description = ? WHERE election_id = ? AND candidate_no = ?',
        [name, description, electionId, no]
      );
    }

    await audit(req, 'candidate-update', `หมายเลข ${no}: ${name}${req.file ? ' (เปลี่ยนรูป)' : ''}`, electionId);
    notifyElectionsChanged();
    res.json({ ok: true });
  } catch (e) {
    discardUpload(req);
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

// ลบผู้สมัคร — ห้ามลบผู้ที่มีคะแนนแล้ว (คะแนนจะหายไปจากผลรวม)
app.delete('/admin/api/elections/:id/candidates/:no', requireAdminApi, loadElection, async (req, res) => {
  const no = parseInt(req.params.no, 10);
  const electionId = req.election.id;
  try {
    const [rows] = await pool.query(
      'SELECT candidate_name, photo_url, vote_count FROM vote_candidates WHERE election_id = ? AND candidate_no = ?',
      [electionId, no]
    );
    if (rows.length === 0) {
      return res.status(404).json({ ok: false, error: 'ไม่พบหมายเลขผู้สมัครนี้' });
    }
    if (rows[0].vote_count > 0) {
      return res.status(400).json({ ok: false, error: 'ผู้สมัครนี้มีคะแนนแล้ว ลบไม่ได้ (ล้างผลการลงคะแนนของกิจกรรมก่อน)' });
    }

    await pool.query('DELETE FROM vote_candidates WHERE election_id = ? AND candidate_no = ?', [electionId, no]);
    deleteUploadedPhoto(rows[0].photo_url);

    await audit(req, 'candidate-delete', `หมายเลข ${no}: ${rows[0].candidate_name}`, electionId);
    notifyElectionsChanged();
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'database error' });
  }
});

/* ------------------------------------------------------------------ */
/*  ล้างข้อมูลของกิจกรรม (สำหรับเริ่มการเลือกตั้งใหม่)                      */
/*  - votes: ผลการลงคะแนน = บันทึกผู้มาใช้สิทธิ์ + คะแนน (ล้างพร้อมกันเสมอ    */
/*    เพราะทั้งสองถูกบันทึกคู่กันใน transaction เดียว — ล้างแยกกันจะทำให้      */
/*    จำนวนผู้มาใช้สิทธิ์กับจำนวนบัตรไม่ตรงกัน หรือเปิดช่องให้ลงคะแนนซ้ำ)        */
/*  - registry: บัญชีรายชื่อผู้มีสิทธิ์                                     */
/* ------------------------------------------------------------------ */
app.post('/admin/api/elections/:id/clear-data', requireAdminApi, loadElection, async (req, res) => {
  const clearVotes = req.body && req.body.votes === true;
  const clearRegistry = req.body && req.body.registry === true;
  const e = req.election;

  if (!clearVotes && !clearRegistry) {
    return res.status(400).json({ ok: false, error: 'กรุณาเลือกข้อมูลที่ต้องการล้างอย่างน้อย 1 รายการ' });
  }
  if (e.status === 'open') {
    return res.status(400).json({ ok: false, error: 'กิจกรรมกำลังเปิดลงคะแนน — ปิดลงคะแนนก่อนล้างข้อมูล' });
  }

  let conn;
  try {
    // สำรองข้อมูลก่อนล้างเสมอ (กู้คืนได้ถ้าล้างผิดกิจกรรม)
    await runBackup(`pre-clear-e${e.id}`, req);
    const cleared = { logs: 0, votes: 0, registry: 0 };
    conn = await pool.getConnection();
    await conn.beginTransaction();
    if (clearVotes) {
      const [l] = await conn.query('DELETE FROM activity_logs WHERE election_id = ?', [e.id]);
      const [v] = await conn.query('UPDATE vote_candidates SET vote_count = 0 WHERE election_id = ? AND vote_count > 0', [e.id]);
      cleared.logs = l.affectedRows;
      cleared.votes = v.affectedRows;
    }
    if (clearRegistry) {
      const [r] = await conn.query('DELETE FROM eligible_voters WHERE election_id = ?', [e.id]);
      cleared.registry = r.affectedRows;
    }
    await conn.commit();

    await audit(
      req,
      'clear-data',
      `ผลการลงคะแนน: ${clearVotes ? `ลบผู้มาใช้สิทธิ์ ${cleared.logs} แถว, รีเซ็ตคะแนน ${cleared.votes} คน` : 'ไม่ล้าง'}, ` +
        `บัญชีรายชื่อ: ${clearRegistry ? `ลบ ${cleared.registry} คน` : 'ไม่ล้าง'}`,
      e.id
    );
    res.json({ ok: true, cleared });
  } catch (err) {
    if (conn) await conn.rollback().catch(() => {});
    console.error('[ADMIN] clear-data error:', err.message);
    res.status(500).json({ ok: false, error: 'database error' });
  } finally {
    if (conn) conn.release();
  }
});

/* ------------------------------------------------------------------ */
/*  สำรอง / กู้คืนข้อมูล                                                  */
/*  - อัตโนมัติทุก BACKUP_INTERVAL_HOURS ชั่วโมง + ทุกครั้งที่ปิดลงคะแนน      */
/*  - ก่อนลบกิจกรรม / ล้างข้อมูล / กู้คืน จะสำรองให้ก่อนเสมอ                  */
/*  - บน Coolify: โฟลเดอร์ backups เป็น volume แยก (คงอยู่แม้ redeploy)      */
/*    และควรดาวน์โหลดไฟล์เก็บนอกเซิร์ฟเวอร์ด้วย                               */
/* ------------------------------------------------------------------ */
const backupState = { lastAt: null, lastName: null, lastError: null };
let backupChain = Promise.resolve();

// จัดคิวให้สำรองทีละครั้ง (กันสองงานเขียนไฟล์พร้อมกัน)
function runBackup(reason, req) {
  const job = backupChain.then(() => doBackup(reason, req));
  backupChain = job.catch(() => {});
  return job;
}

async function doBackup(reason, req) {
  const actor = req ? undefined : null;
  try {
    const result = await backup.createBackup(pool, CONFIG.BACKUP_DIR, { reason, keep: CONFIG.BACKUP_KEEP });
    Object.assign(backupState, { lastAt: new Date(), lastName: result.name, lastError: null });
    const detail = `${result.name} (${(result.size / 1024).toFixed(1)} KB)${result.removed ? `, ลบไฟล์เก่า ${result.removed} ไฟล์` : ''}`;
    // สำรองอัตโนมัติตามรอบเวลาไม่ลง audit log (ไม่ให้รก) — ดูได้จากรายการไฟล์สำรอง
    if (reason === 'auto') console.log(`[BACKUP] ${detail}`);
    else await audit(req, 'backup-create', detail, null, actor);
    return result;
  } catch (err) {
    backupState.lastError = err.message;
    await audit(req, 'backup-failed', `${reason}: ${err.message}`, null, actor);
    err.message = `สำรองข้อมูลไม่สำเร็จ: ${err.message}`;
    throw err;
  }
}

app.get('/admin/api/backups', requireAdminApi, (req, res) => {
  res.json({
    ok: true,
    backups: backup.listBackups(CONFIG.BACKUP_DIR),
    dir: CONFIG.BACKUP_DIR,
    intervalHours: CONFIG.BACKUP_INTERVAL_HOURS,
    keep: CONFIG.BACKUP_KEEP,
    lastError: backupState.lastError,
  });
});

app.post('/admin/api/backups', requireAdminApi, async (req, res) => {
  try {
    const r = await runBackup('manual', req);
    res.json({ ok: true, name: r.name, size: r.size });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/admin/api/backups/:name', requireAdminApi, async (req, res) => {
  const name = req.params.name;
  const file = path.join(CONFIG.BACKUP_DIR, name);
  if (!backup.isBackupName(name) || !fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: 'ไม่พบไฟล์สำรองนี้' });
  }
  await audit(req, 'backup-download', name);
  res.download(file, name);
});

// อัปโหลดไฟล์สำรองจากเครื่อง (ที่เคยดาวน์โหลดไว้) — เก็บเข้ารายการก่อน แล้วค่อยกดกู้คืน
app.post(
  '/admin/api/backups/upload',
  requireAdminApi,
  express.raw({ type: () => true, limit: '100mb' }),
  async (req, res) => {
    try {
      await backup.readBackupStatements(req.body); // ตรวจว่าเป็นไฟล์สำรองของระบบนี้จริง
      const name = `evoting-${new Date().toLocaleString('sv-SE').replace(/[-: ]/g, '').replace(/^(\d{8})(\d{6})$/, '$1-$2')}-uploaded.sql.gz`;
      fs.mkdirSync(CONFIG.BACKUP_DIR, { recursive: true });
      fs.writeFileSync(path.join(CONFIG.BACKUP_DIR, name), req.body);
      await audit(req, 'backup-upload', `${name} (${(req.body.length / 1024).toFixed(1)} KB)`);
      res.json({ ok: true, name });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  }
);

// กู้คืน — แทนที่ข้อมูลทั้งหมดด้วยไฟล์สำรอง (ต้องไม่มีกิจกรรมที่เปิดลงคะแนนอยู่)
app.post('/admin/api/backups/:name/restore', requireAdminApi, async (req, res) => {
  const name = req.params.name;
  const file = path.join(CONFIG.BACKUP_DIR, name);
  if (!backup.isBackupName(name) || !fs.existsSync(file)) {
    return res.status(404).json({ ok: false, error: 'ไม่พบไฟล์สำรองนี้' });
  }
  if (String((req.body || {}).confirm) !== 'RESTORE') {
    return res.status(400).json({ ok: false, error: 'กรุณาพิมพ์คำว่า RESTORE เพื่อยืนยัน' });
  }
  try {
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM elections WHERE status = 'open'");
    if (n > 0) {
      return res.status(400).json({ ok: false, error: 'มีกิจกรรมที่กำลังเปิดลงคะแนน — ปิดลงคะแนนทุกกิจกรรมก่อนกู้คืน' });
    }
    const buffer = fs.readFileSync(file);
    await backup.readBackupStatements(buffer); // ตรวจไฟล์ก่อน — ไฟล์เสียจะไม่แตะข้อมูลปัจจุบันเลย
    const safety = await runBackup('pre-restore', req);
    const count = await backup.restoreBackup(pool, buffer);
    voteTokens.clear(); // บัตรเลือกตั้งที่ค้างบนคูหาใช้ไม่ได้แล้ว
    await audit(req, 'backup-restore', `กู้คืนจาก ${name} (${count} คำสั่ง) — ข้อมูลก่อนกู้คืนสำรองไว้ที่ ${safety.name}`);
    notifyElectionsChanged();
    res.json({ ok: true, safetyBackup: safety.name });
  } catch (e) {
    console.error('[BACKUP] restore:', e.message);
    await audit(req, 'backup-restore-failed', `${name}: ${e.message}`);
    res.status(500).json({ ok: false, error: `กู้คืนไม่สำเร็จ: ${e.message}` });
  }
});

/* ------------------------------------------------------------------ */
/*  ตั้งเวลาเปิด / ปิดลงคะแนนอัตโนมัติ (ตรวจทุก 15 วินาที)                   */
/*  ใช้เวลาของฐานข้อมูล (NOW() = เวลาไทย) เปรียบเทียบ                       */
/* ------------------------------------------------------------------ */
let schedulerBusy = false;
async function runScheduler() {
  if (schedulerBusy) return;
  schedulerBusy = true;
  try {
    const [due] = await pool.query(
      `SELECT id FROM elections
       WHERE (status = 'draft' AND scheduled_open_at IS NOT NULL AND scheduled_open_at <= NOW())
          OR (status = 'open' AND scheduled_close_at IS NOT NULL AND scheduled_close_at <= NOW())`
    );
    for (const { id } of due) {
      const e = await fetchElection(id);
      const [[{ closePassed }]] = await pool.query(
        'SELECT (scheduled_close_at IS NOT NULL AND scheduled_close_at <= NOW()) AS closePassed FROM elections WHERE id = ?',
        [id]
      );

      if (e.status === 'draft') {
        if (closePassed) {
          // เวลาปิดผ่านไปแล้วก่อนได้เปิด (เช่น เซิร์ฟเวอร์ดับช่วงนั้น) → ไม่เปิด
          await pool.query('UPDATE elections SET scheduled_open_at = NULL, scheduled_close_at = NULL WHERE id = ?', [id]);
          await audit(null, 'schedule-skipped', `${e.title}: เลยเวลาปิดที่ตั้งไว้แล้ว จึงไม่เปิดลงคะแนน`, id, null);
          continue;
        }
        const r = await changeElectionStatus(e, 'open', null);
        if (r.error) {
          // เปิดไม่ได้ (เช่น ยังไม่มีผู้สมัคร) → ยกเลิกเวลาเปิด ไม่ลองซ้ำทุก 15 วินาที
          await pool.query('UPDATE elections SET scheduled_open_at = NULL WHERE id = ?', [id]);
          await audit(null, 'schedule-failed', `${e.title}: เปิดลงคะแนนอัตโนมัติไม่สำเร็จ — ${r.error}`, id, null);
          notifyElectionsChanged();
        }
      } else if (e.status === 'open') {
        await changeElectionStatus(e, 'closed', null);
      }
    }
  } catch (err) {
    console.error('[SCHEDULER]', err.message);
  } finally {
    schedulerBusy = false;
  }
}

/* ------------------------------------------------------------------ */
/*  หน้าจอคูหาลงคะแนน (Voter Kiosk)                                     */
/* ------------------------------------------------------------------ */
app.get('/', (req, res) => {
  sendView(res, 'kiosk.html');
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

  await initSessions();
  console.log(`[SESSION] เก็บ session ใน MySQL (secret จาก ${CONFIG.SESSION_SECRET_SOURCE === 'env' ? 'SESSION_SECRET' : 'ฐานข้อมูล — สุ่มให้อัตโนมัติ'})`);

  // ตั้งเวลาเปิด-ปิดลงคะแนน: ตรวจทันทีตอนเริ่ม (กรณีเลยเวลาระหว่าง redeploy) แล้วทุก 15 วินาที
  runScheduler();
  setInterval(runScheduler, 15 * 1000).unref();

  // สำรองข้อมูลอัตโนมัติตามรอบเวลา
  if (CONFIG.BACKUP_INTERVAL_HOURS > 0) {
    setInterval(() => runBackup('auto', null).catch(() => {}), CONFIG.BACKUP_INTERVAL_HOURS * 3600 * 1000).unref();
    console.log(`[BACKUP] สำรองอัตโนมัติทุก ${CONFIG.BACKUP_INTERVAL_HOURS} ชั่วโมง → ${CONFIG.BACKUP_DIR} (เก็บ ${CONFIG.BACKUP_KEEP} ไฟล์ล่าสุด)`);
  }

  initSmartCardReader();

  server.listen(CONFIG.PORT, () => {
    console.log('');
    console.log('╔══════════════════════════════════════════════════╗');
    console.log('║   ระบบเลือกตั้งอิเล็กทรอนิกส์ (E-VOTING SYSTEM)      ║');
    console.log('╠══════════════════════════════════════════════════╣');
    console.log(`║  คูหาลงคะแนน : http://localhost:${CONFIG.PORT}/            ║`);
    console.log(`║  ผู้ดูแลระบบ  : http://localhost:${CONFIG.PORT}/admin       ║`);
    console.log('║  (บัญชีแรก: admin / password123 — เปลี่ยนทันที)    ║');
    if (CONFIG.DEMO_MODE) {
      console.log('║  ★ DEMO_MODE เปิดอยู่ — กด F2 ที่หน้าคูหาเพื่อจำลองบัตร ║');
    }
    console.log('╚══════════════════════════════════════════════════╝');
  });
})();
