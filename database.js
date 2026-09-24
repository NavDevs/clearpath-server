const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) console.error('Database connection error:', err);
  else console.log('Connected to SQLite database.');
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    role TEXT CHECK(role IN ('citizen', 'emergency_driver', 'admin')),
    phone TEXT UNIQUE,
    name TEXT,
    password TEXT,
    driver_id TEXT UNIQUE,
    vehicle_no TEXT,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);
  
  // Add password column if missing
  db.run("ALTER TABLE users ADD COLUMN password TEXT", (err) => {});

  db.run(`CREATE TABLE IF NOT EXISTS road_reports (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    type TEXT,
    description TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'resolved')),
    latitude REAL,
    longitude REAL,
    address TEXT,
    photo_url TEXT,
    points INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS emergency_trips (
    id TEXT PRIMARY KEY,
    driver_id TEXT,
    vehicle_no TEXT,
    report_id TEXT,
    criticality TEXT CHECK(criticality IN ('low', 'medium', 'high', 'critical')),
    travel_time REAL,
    preemptions INTEGER,
    confidence INTEGER,
    distance REAL,
    started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(driver_id) REFERENCES users(id),
    FOREIGN KEY(report_id) REFERENCES road_reports(id)
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS reward_events (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    report_id TEXT,
    points INTEGER,
    reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(user_id) REFERENCES users(id),
    FOREIGN KEY(report_id) REFERENCES road_reports(id)
  )`);
});

const dbRun = (sql, params = []) => new Promise((resolve, reject) => {
  db.run(sql, params, function(err) { if (err) reject(err); else resolve(this); });
});

const dbGet = (sql, params = []) => new Promise((resolve, reject) => {
  db.get(sql, params, (err, row) => { if (err) reject(err); else resolve(row); });
});

const dbAll = (sql, params = []) => new Promise((resolve, reject) => {
  db.all(sql, params, (err, rows) => { if (err) reject(err); else resolve(rows); });
});

module.exports = { db, dbRun, dbGet, dbAll };
