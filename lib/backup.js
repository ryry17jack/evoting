/**
 * =====================================================================
 *  สำรอง / กู้คืนฐานข้อมูล (ทำงานในแอปเอง — ไม่ต้องมี mysqldump ในเครื่อง)
 *  - dump ทุกตาราง (ยกเว้นข้อมูล session) เป็นไฟล์ .sql.gz
 *  - ใช้ transaction แบบ consistent snapshot → ข้อมูลทุกตารางตรงกัน ณ เวลาเดียว
 *    แม้จะสำรองระหว่างที่มีคนกำลังลงคะแนน
 *  - 1 คำสั่ง SQL ต่อ 1 บรรทัด (ค่าที่มีขึ้นบรรทัดใหม่ถูก escape เป็น \n แล้ว)
 *    จึงกู้คืนได้ด้วยการอ่านทีละบรรทัด หรือใช้ `mysql` CLI ก็ได้
 * =====================================================================
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { promisify } = require('util');

const gzip = promisify(zlib.gzip);
const gunzip = promisify(zlib.gunzip);

const HEADER = '-- E-VOTING BACKUP v1';
const FILE_RE = /^evoting-\d{8}-\d{6}(-[a-z0-9-]+)?\.sql\.gz$/;
const ROWS_PER_INSERT = 200;

function timestamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function isBackupName(name) {
  return FILE_RE.test(String(name || ''));
}

async function createBackup(pool, dir, { reason = 'manual', keep = 30 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const conn = await pool.getConnection();
  const lines = [
    HEADER,
    `-- created: ${new Date().toISOString()} reason: ${reason}`,
    'SET NAMES utf8mb4;',
    'SET FOREIGN_KEY_CHECKS = 0;',
  ];
  const counts = {};

  try {
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
    // ค่าเวลา TIMESTAMP ถูก dump ตามเขตเวลาของ connection — ต้องกู้คืนด้วยเขตเวลาเดียวกัน
    const [[tz]] = await conn.query('SELECT @@session.time_zone AS tz');
    lines.push(`SET time_zone = ${conn.escape(tz.tz)};`);

    const [tables] = await conn.query("SHOW FULL TABLES WHERE Table_type = 'BASE TABLE'");
    for (const row of tables) {
      const table = Object.values(row)[0];
      if (table === 'sessions') continue; // ตาราง session ปล่อยให้ระบบสร้างเอง ไม่แตะตอนกู้คืน
      const [[create]] = await conn.query(`SHOW CREATE TABLE \`${table}\``);
      lines.push(`DROP TABLE IF EXISTS \`${table}\`;`);
      lines.push(create['Create Table'].replace(/\s*\n\s*/g, ' ') + ';');

      const [data] = await conn.query({ sql: `SELECT * FROM \`${table}\``, dateStrings: true });
      counts[table] = data.length;
      if (data.length === 0) continue;

      const cols = Object.keys(data[0]).map((c) => `\`${c}\``).join(', ');
      for (let i = 0; i < data.length; i += ROWS_PER_INSERT) {
        const values = data
          .slice(i, i + ROWS_PER_INSERT)
          .map((r) => '(' + Object.values(r).map((v) => conn.escape(v)).join(', ') + ')')
          .join(', ');
        lines.push(`INSERT INTO \`${table}\` (${cols}) VALUES ${values};`);
      }
    }
    await conn.query('COMMIT');
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }

  lines.push('SET FOREIGN_KEY_CHECKS = 1;');
  const safeReason = String(reason).toLowerCase().replace(/[^a-z0-9-]+/g, '-').slice(0, 30).replace(/^-|-$/g, '');
  const name = `evoting-${timestamp()}${safeReason ? '-' + safeReason : ''}.sql.gz`;
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, await gzip(lines.join('\n') + '\n'));

  const removed = pruneBackups(dir, keep);
  const { size } = fs.statSync(file);
  return { name, size, counts, removed };
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter(isBackupName)
    .map((name) => {
      const st = fs.statSync(path.join(dir, name));
      return { name, size: st.size, mtime: st.mtime };
    })
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name));
}

// เก็บไว้เฉพาะไฟล์ล่าสุด `keep` ไฟล์ (ไฟล์ที่สร้างก่อนกู้คืนมีคำว่า pre-restore — เก็บเสมอ)
function pruneBackups(dir, keep) {
  const removable = listBackups(dir).filter((b) => !b.name.includes('pre-restore'));
  const old = removable.slice(keep);
  old.forEach((b) => fs.unlinkSync(path.join(dir, b.name)));
  return old.length;
}

// ตรวจและแยกคำสั่ง SQL จากไฟล์สำรอง (รับเฉพาะไฟล์ที่ระบบนี้สร้าง)
async function readBackupStatements(buffer) {
  let text;
  try {
    text = (await gunzip(buffer)).toString('utf8');
  } catch (e) {
    throw new Error('ไฟล์ไม่ใช่ไฟล์สำรองข้อมูลแบบ .sql.gz');
  }
  if (!text.startsWith(HEADER)) throw new Error('ไฟล์นี้ไม่ได้สร้างจากระบบ E-Voting (ไม่พบส่วนหัวของไฟล์สำรอง)');
  const statements = text.split('\n').filter((l) => l.trim() && !l.startsWith('--'));
  if (!statements.some((s) => s.startsWith('CREATE TABLE `elections`'))) {
    throw new Error('ไฟล์สำรองไม่สมบูรณ์ (ไม่พบตาราง elections)');
  }
  return statements;
}

// กู้คืน: รันทีละคำสั่งบน connection เดียว (DDL ของ MySQL commit อัตโนมัติ — ตรวจไฟล์ครบก่อนเริ่ม)
async function restoreBackup(pool, buffer) {
  const statements = await readBackupStatements(buffer);
  const conn = await pool.getConnection();
  try {
    for (const sql of statements) await conn.query(sql);
  } finally {
    await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
    conn.release();
  }
  return statements.length;
}

module.exports = { createBackup, listBackups, restoreBackup, readBackupStatements, isBackupName };
