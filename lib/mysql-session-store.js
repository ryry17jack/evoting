/**
 * =====================================================================
 *  ที่เก็บ session ของ express-session ใน MySQL (ตาราง sessions)
 *  - ผู้ดูแลไม่หลุดจากระบบเมื่อ redeploy / restart container (Coolify)
 *  - แทน MemoryStore ที่ข้อมูลหายทุกครั้งที่รีสตาร์ตและกินหน่วยความจำเรื่อย ๆ
 *  - ลบ session ที่หมดอายุทิ้งเป็นระยะ
 * =====================================================================
 */

const session = require('express-session');

const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

class MySQLSessionStore extends session.Store {
  /**
   * @param {() => import('mysql2/promise').Pool} getPool ฟังก์ชันคืน pool (pool ถูกสร้างหลัง store)
   */
  constructor(getPool, { cleanupIntervalMs = 15 * 60 * 1000 } = {}) {
    super();
    this.getPool = getPool;
    this.cleanupTimer = setInterval(() => this.cleanup().catch(() => {}), cleanupIntervalMs);
    this.cleanupTimer.unref();
  }

  expiresOf(sess) {
    const cookieExpires = sess && sess.cookie && sess.cookie.expires;
    return cookieExpires ? new Date(cookieExpires).getTime() : Date.now() + DEFAULT_TTL_MS;
  }

  get(sid, cb) {
    this.getPool()
      .query('SELECT data, expires FROM sessions WHERE sid = ?', [sid])
      .then(([rows]) => {
        if (rows.length === 0 || rows[0].expires < Date.now()) return cb(null, null);
        cb(null, JSON.parse(rows[0].data));
      })
      .catch((err) => cb(err));
  }

  set(sid, sess, cb = () => {}) {
    this.getPool()
      .query(
        `INSERT INTO sessions (sid, expires, data) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE expires = VALUES(expires), data = VALUES(data)`,
        [sid, this.expiresOf(sess), JSON.stringify(sess)]
      )
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  touch(sid, sess, cb = () => {}) {
    this.getPool()
      .query('UPDATE sessions SET expires = ? WHERE sid = ?', [this.expiresOf(sess), sid])
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  destroy(sid, cb = () => {}) {
    this.getPool()
      .query('DELETE FROM sessions WHERE sid = ?', [sid])
      .then(() => cb(null))
      .catch((err) => cb(err));
  }

  // ลบ session ทั้งหมดของผู้ใช้คนหนึ่ง (เช่น ถูกลบบัญชี / ถูกรีเซ็ตรหัสผ่าน)
  async destroyByUser(userId, exceptSid = null) {
    const [rows] = await this.getPool().query('SELECT sid, data FROM sessions');
    const sids = rows
      .filter((r) => r.sid !== exceptSid)
      .filter((r) => {
        try {
          return JSON.parse(r.data).userId === userId;
        } catch (e) {
          return false;
        }
      })
      .map((r) => r.sid);
    if (sids.length) await this.getPool().query('DELETE FROM sessions WHERE sid IN (?)', [sids]);
    return sids.length;
  }

  async cleanup() {
    await this.getPool().query('DELETE FROM sessions WHERE expires < ?', [Date.now()]);
  }
}

module.exports = MySQLSessionStore;
