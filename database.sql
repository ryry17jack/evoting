-- =====================================================================
--  ระบบเลือกตั้งอิเล็กทรอนิกส์ (E-Voting System) — โครงสร้างฐานข้อมูล
--  หมายเหตุ: ไม่จำเป็นต้อง import ไฟล์นี้เอง
--  server.js จะสร้างฐานข้อมูล/ตาราง/ข้อมูลเริ่มต้นให้อัตโนมัติเมื่อรัน npm start
--  และอัปเกรดฐานข้อมูลรุ่นเก่า (การเลือกตั้งเดียว) ให้อัตโนมัติด้วย
--  (ไฟล์นี้มีไว้เพื่ออ้างอิง หรือกรณีต้องการติดตั้งฐานข้อมูลด้วยตนเอง)
-- =====================================================================

CREATE DATABASE IF NOT EXISTS evoting_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE evoting_db;

-- ---------------------------------------------------------------------
-- ตารางที่ 0: elections
-- กิจกรรมเลือกตั้ง (สร้างได้หลายกิจกรรมในวันเดียว)
--   status: draft = เตรียมการ, open = เปิดลงคะแนน, closed = ปิดลงคะแนนแล้ว
--   require_registration: 1 = ลงคะแนนได้เฉพาะผู้ที่อยู่ใน eligible_voters
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS elections (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  description TEXT DEFAULT NULL,
  election_date DATE DEFAULT NULL,
  status ENUM('draft','open','closed') NOT NULL DEFAULT 'draft',
  require_registration TINYINT(1) NOT NULL DEFAULT 1,
  hide_results TINYINT(1) NOT NULL DEFAULT 1,         -- ซ่อนผลรายผู้สมัครจนกว่าจะปิดลงคะแนน
  scheduled_open_at DATETIME NULL DEFAULT NULL,       -- เปิดลงคะแนนอัตโนมัติ (เวลาไทย)
  scheduled_close_at DATETIME NULL DEFAULT NULL,      -- ปิดลงคะแนนอัตโนมัติ
  opened_at TIMESTAMP NULL DEFAULT NULL,
  closed_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 1: activity_logs
-- บันทึกผู้มาใช้สิทธิ์ต่อกิจกรรม (ใช้ตรวจสอบการลงคะแนนซ้ำด้วย)
-- บันทึกใน transaction เดียวกับการเพิ่มคะแนน — ตอนกดลงคะแนน ไม่ใช่ตอนเสียบบัตร
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  election_id INT NOT NULL,
  citizen_id VARCHAR(13) NOT NULL,
  full_name VARCHAR(255) NOT NULL,
  entry_method VARCHAR(10) NOT NULL DEFAULT 'card',   -- card = อ่านบัตร, manual = เจ้าหน้าที่กรอกเลขบัตร
  officer_id INT NULL DEFAULT NULL,                   -- เจ้าหน้าที่ที่กรอกให้ (admin_users.id)
  voted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_election_citizen (election_id, citizen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 2: vote_candidates
-- ผู้สมัครและคะแนนรวมต่อกิจกรรม (นับคะแนนแบบนิรนาม ไม่ผูกกับตัวผู้ลงคะแนน)
-- หมายเลข 99 = ไม่ประสงค์ลงคะแนน
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vote_candidates (
  id INT AUTO_INCREMENT PRIMARY KEY,
  election_id INT NOT NULL,
  candidate_no INT NOT NULL,
  candidate_name VARCHAR(255) NOT NULL,
  photo_url VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  vote_count INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_election_candidate (election_id, candidate_no)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 3: admin_users
-- บัญชีผู้ใช้ (role: admin = ผู้ดูแลระบบ, officer = เจ้าหน้าที่)
-- kiosk_pin = PIN 6 หลัก (bcrypt) สำหรับกรอกเลขบัตรแทนที่คูหา
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL,
  display_name VARCHAR(150) NOT NULL DEFAULT '',
  role ENUM('admin','officer') NOT NULL DEFAULT 'admin',
  kiosk_pin VARCHAR(255) NULL DEFAULT NULL,
  last_login_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 4: eligible_voters
-- บัญชีรายชื่อผู้มีสิทธิ์เลือกตั้งต่อกิจกรรม (import จาก CSV / Excel)
-- สถานะ "มาใช้สิทธิ์แล้ว" ดูจาก activity_logs (ไม่เก็บซ้ำที่นี่)
-- ---------------------------------------------------------------------
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 5: audit_logs — บันทึกการกระทำของผู้ดูแล/เจ้าหน้าที่ (ไม่มีข้อมูลว่าใครเลือกใคร)
-- ---------------------------------------------------------------------
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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 6: sessions — session ของผู้ใช้ (ไม่หลุดเมื่อ restart / redeploy)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  sid VARCHAR(128) NOT NULL PRIMARY KEY,
  expires BIGINT NOT NULL,
  data MEDIUMTEXT NOT NULL,
  KEY idx_expires (expires)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 7: settings — ค่าตั้งค่าของระบบ (เช่น session secret ที่สุ่มให้อัตโนมัติ)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS settings (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ข้อมูลเริ่มต้น
-- ---------------------------------------------------------------------
INSERT INTO elections (id, title, election_date, status, require_registration, opened_at)
  VALUES (1, 'การเลือกตั้งตัวอย่าง', CURDATE(), 'open', 0, NOW())
  ON DUPLICATE KEY UPDATE id = id;

INSERT IGNORE INTO vote_candidates (election_id, candidate_no, candidate_name, photo_url, vote_count) VALUES
  (1, 1,  'นายสมชาย ใจดี',        '/img/candidate1.svg', 0),
  (1, 2,  'นางสาวสมหญิง รักเรียน', '/img/candidate2.svg', 0),
  (1, 99, 'ไม่ประสงค์ลงคะแนน',     '/img/novote.svg',     0);

-- บัญชีผู้ดูแลเริ่มต้น: admin / password123
-- (หากติดตั้งผ่าน server.js รหัสผ่านจะถูกเก็บเป็น bcrypt hash โดยอัตโนมัติ
--  ระบบ login รองรับทั้งสองรูปแบบ)
INSERT IGNORE INTO admin_users (username, password, display_name, role) VALUES
  ('admin', 'password123', 'ผู้ดูแลระบบ', 'admin');
