-- =====================================================================
--  ระบบเลือกตั้งอิเล็กทรอนิกส์ (E-Voting System) — โครงสร้างฐานข้อมูล
--  หมายเหตุ: ไม่จำเป็นต้อง import ไฟล์นี้เอง
--  server.js จะสร้างฐานข้อมูล/ตาราง/ข้อมูลเริ่มต้นให้อัตโนมัติเมื่อรัน npm start
--  (ไฟล์นี้มีไว้เพื่ออ้างอิง หรือกรณีต้องการติดตั้งฐานข้อมูลด้วยตนเอง)
-- =====================================================================

CREATE DATABASE IF NOT EXISTS evoting_db
  CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE evoting_db;

-- ---------------------------------------------------------------------
-- ตารางที่ 1: activity_logs
-- บันทึกการเข้าร่วมกิจกรรมของนักศึกษา และใช้ตรวจสอบการลงคะแนนซ้ำ
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS activity_logs (
  id INT AUTO_INCREMENT PRIMARY KEY,
  citizen_id VARCHAR(13) NOT NULL UNIQUE,
  full_name VARCHAR(255) NOT NULL,
  voted_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 2: vote_candidates
-- ผู้สมัครและคะแนนรวม (นับคะแนนแบบนิรนาม ไม่ผูกกับตัวผู้ลงคะแนน)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS vote_candidates (
  candidate_no INT PRIMARY KEY,
  candidate_name VARCHAR(255) NOT NULL,
  photo_url VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  vote_count INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ตารางที่ 3: admin_users
-- บัญชีผู้ดูแลระบบ
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  username VARCHAR(50) NOT NULL UNIQUE,
  password VARCHAR(255) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ---------------------------------------------------------------------
-- ข้อมูลเริ่มต้น
-- ---------------------------------------------------------------------
INSERT IGNORE INTO vote_candidates (candidate_no, candidate_name, photo_url, vote_count) VALUES
  (1,  'นายสมชาย ใจดี',        '/img/candidate1.svg', 0),
  (2,  'นางสาวสมหญิง รักเรียน', '/img/candidate2.svg', 0),
  (99, 'ไม่ประสงค์ลงคะแนน',     '/img/novote.svg',     0);

-- บัญชีผู้ดูแลเริ่มต้น: admin / password123
-- (หากติดตั้งผ่าน server.js รหัสผ่านจะถูกเก็บเป็น bcrypt hash โดยอัตโนมัติ
--  ระบบ login รองรับทั้งสองรูปแบบ)
INSERT IGNORE INTO admin_users (username, password) VALUES
  ('admin', 'password123');
