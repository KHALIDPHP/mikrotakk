const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcryptjs');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const dbPath = path.join(dataDir, 'mikrotik.db');
const raw = new sqlite3.Database(dbPath);

// Promise wrappers
const db = {
  _db: raw,
  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      raw.run(sql, params, function (err) {
        if (err) reject(err);
        else resolve({ lastInsertRowid: this.lastID, changes: this.changes });
      });
    });
  },
  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      raw.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  },
  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      raw.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows || []);
      });
    });
  },
  exec(sql) {
    return new Promise((resolve, reject) => {
      raw.exec(sql, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  },
  // Sync-style wrappers using better-sqlite3 API shape
  prepare(sql) {
    const stmt = raw.prepare(sql);
    return {
      run(...args) {
        return new Promise((resolve, reject) => {
          stmt.run(...args, function (err) {
            if (err) reject(err);
            else resolve({ lastInsertRowid: this.lastID, changes: this.changes });
          });
        });
      },
      get(...args) {
        return new Promise((resolve, reject) => {
          stmt.get(...args, (err, row) => {
            if (err) reject(err);
            else resolve(row);
          });
        });
      },
      all(...args) {
        return new Promise((resolve, reject) => {
          stmt.all(...args, (err, rows) => {
            if (err) reject(err);
            else resolve(rows || []);
          });
        });
      }
    };
  }
};

// Initialize schema + seed
async function init() {
  await db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA foreign_keys=ON;

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      email TEXT,
      role TEXT DEFAULT 'admin',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_login DATETIME
    );

    CREATE TABLE IF NOT EXISTS devices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      host TEXT NOT NULL,
      port INTEGER DEFAULT 8728,
      username TEXT NOT NULL,
      password TEXT NOT NULL,
      description TEXT,
      status TEXT DEFAULT 'offline',
      last_seen DATETIME,
      model TEXT,
      version TEXT,
      serial TEXT,
      token TEXT UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS device_cache (
      device_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (device_id, key)
    );

    CREATE TABLE IF NOT EXISTS device_commands (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      device_id INTEGER NOT NULL,
      command TEXT NOT NULL,
      command_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS activity_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      device_id INTEGER,
      action TEXT NOT NULL,
      details TEXT,
      ip TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  try {
    await db.run('ALTER TABLE devices ADD COLUMN token TEXT UNIQUE');
  } catch (err) {}

  try {
    await db.run('ALTER TABLE device_commands ADD COLUMN command_id TEXT');
  } catch (err) {}

  const admin = await db.get('SELECT id FROM users WHERE username = ?', ['admin']);
  if (!admin) {
    const hashed = bcrypt.hashSync('admin123', 10);
    await db.run(
      'INSERT INTO users (username, password, email, role) VALUES (?, ?, ?, ?)',
      ['admin', hashed, 'admin@mikrotik.local', 'admin']
    );
    console.log('✅ Default admin created: admin / admin123');
  }
}

init().catch(console.error);

module.exports = db;
