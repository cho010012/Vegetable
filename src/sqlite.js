/**
 * SQLite 相容層
 * -----------------------------------------------------------------------------
 * 預設使用 Node.js 內建的 node:sqlite（Node 22.5 起提供；少數早期 22.x 版本
 * 需要在啟動時加上 --experimental-sqlite，Node 24 以上直接可用）。
 * 好處是「不需要編譯原生模組」—— Windows 上不必安裝 Visual Studio Build Tools，
 * npm install 也不會卡在 node-gyp。
 *
 * 如果你的 Node 太舊沒有 node:sqlite，而環境裡剛好裝得起 better-sqlite3，
 * 這一層也會自動改用它，其餘程式碼完全不必改。
 *
 * 這裡只包裝專案實際用到的幾個方法，介面刻意做成跟 better-sqlite3 一樣：
 *   db.exec(sql)                     執行多行 SQL（建表用）
 *   db.prepare(sql)                  → stmt.run() / stmt.get() / stmt.all()
 *   db.transaction(fn)               → 回傳一個「整批成功或整批回滾」的函式
 *   db.backupTo(path)                備份成另一個檔案
 *   db.close()
 */
'use strict';

let DatabaseSync = null;
let BetterSqlite3 = null;

try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch {
  try { BetterSqlite3 = require('better-sqlite3'); } catch { /* 兩個都沒有，下面丟錯 */ }
}

if (!DatabaseSync && !BetterSqlite3) {
  throw new Error(
    '找不到可用的 SQLite。請升級到 Node.js 22.5 以上（建議 24 LTS）：https://nodejs.org\n' +
    '  目前版本：' + process.version + '\n' +
    '  若使用 Node 22.5–23.3，啟動時需加上 --experimental-sqlite 旗標。'
  );
}

/* --------------------------------------------------------------------------
   node:sqlite 的薄包裝，讓它的介面跟 better-sqlite3 一致
-------------------------------------------------------------------------- */
class Stmt {
  constructor(raw) { this.raw = raw; }
  run(...args) {
    const r = this.raw.run(...args);
    // node:sqlite 在數字很大時會回 BigInt，統一轉成一般數字
    return { changes: Number(r.changes), lastInsertRowid: Number(r.lastInsertRowid) };
  }
  get(...args) { return this.raw.get(...args); }
  all(...args) { return this.raw.all(...args); }
}

class Db {
  constructor(file) {
    this.raw = new DatabaseSync(file);
    this.engine = 'node:sqlite';
  }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) { return new Stmt(this.raw.prepare(sql)); }
  pragma(text) { this.raw.exec('PRAGMA ' + text); }

  /**
   * 交易：把一串寫入包成不可分割的一批。
   * 中途任何一步丟出錯誤就整批回滾，不會留下「扣了庫存卻沒建訂單」這種半套狀態。
   */
  transaction(fn) {
    const raw = this.raw;
    return (...args) => {
      raw.exec('BEGIN');
      try {
        const out = fn(...args);
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        try { raw.exec('ROLLBACK'); } catch { /* 回滾失敗就讓原錯誤往上丟 */ }
        throw err;
      }
    };
  }

  /**
   * 備份到另一個檔案。
   * 用 SQLite 的 VACUUM INTO，即使備份當下有人正在下單，
   * 產出的檔案仍然是一份完整、可直接使用的資料庫。
   */
  backupTo(destPath) {
    this.raw.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
    return destPath;
  }

  close() { this.raw.close(); }
}

/* --------------------------------------------------------------------------
   better-sqlite3 的薄包裝（只有舊版 Node 才會走到這裡）
-------------------------------------------------------------------------- */
class LegacyDb {
  constructor(file) {
    this.raw = new BetterSqlite3(file);
    this.engine = 'better-sqlite3';
  }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) { return this.raw.prepare(sql); }
  pragma(text) { this.raw.pragma(text); }
  transaction(fn) { return this.raw.transaction(fn); }
  backupTo(destPath) {
    this.raw.exec(`VACUUM INTO '${String(destPath).replace(/'/g, "''")}'`);
    return destPath;
  }
  close() { this.raw.close(); }
}

function open(file) {
  return DatabaseSync ? new Db(file) : new LegacyDb(file);
}

module.exports = { open };
