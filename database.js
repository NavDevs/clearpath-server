const { Pool } = require('pg');
const path = require('path');

const connectionString = process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/clearpath';
let pool = null;
let sqliteDb = null;
let useSqlite = false;

function createPgPool() {
  const pgPool = new Pool({
    connectionString,
    ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
  });

  pgPool.on('error', (err) => {
    console.error('Unexpected error on idle client', err);
  });

  return pgPool;
}

function setupSqlite() {
  const sqlite3 = require('sqlite3').verbose();
  sqliteDb = new sqlite3.Database(path.join(__dirname, 'clearpath.db'));
  return sqliteDb;
}

async function initSqliteDb() {
  const db = setupSqlite();
  await new Promise((resolve, reject) => {
    db.serialize(() => {
      const statements = [
        `CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          role TEXT CHECK(role IN ('citizen', 'emergency_driver', 'admin')),
          phone TEXT UNIQUE,
          name TEXT,
          password TEXT,
          driver_id TEXT UNIQUE,
          vehicle_no TEXT,
          points INTEGER DEFAULT 0,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS road_reports (
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
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS emergency_trips (
          id TEXT PRIMARY KEY,
          driver_id TEXT,
          vehicle_no TEXT,
          report_id TEXT,
          criticality TEXT CHECK(criticality IN ('low', 'medium', 'high', 'critical')),
          travel_time REAL,
          preemptions INTEGER,
          confidence INTEGER,
          distance REAL,
          started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`,
        `CREATE TABLE IF NOT EXISTS reward_events (
          id TEXT PRIMARY KEY,
          user_id TEXT,
          report_id TEXT,
          points INTEGER,
          reason TEXT,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )`
      ];

      let index = 0;
      const runNext = () => {
        if (index >= statements.length) return resolve();
        const sql = statements[index++];
        db.run(sql, (err) => {
          if (err) return reject(err);
          runNext();
        });
      };

      runNext();
    });
  });

  console.log('SQLite database initialized.');
}

async function initDb() {
  try {
    pool = createPgPool();
    const client = await pool.connect();
    await client.query(`CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      role TEXT CHECK(role IN ('citizen', 'emergency_driver', 'admin')),
      phone TEXT UNIQUE,
      name TEXT,
      password TEXT,
      driver_id TEXT UNIQUE,
      vehicle_no TEXT,
      points INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    try {
      await client.query("ALTER TABLE users ADD COLUMN password TEXT");
    } catch (e) {}

    try { await client.query("ALTER TABLE users ADD COLUMN availability TEXT DEFAULT 'OFFLINE'"); } catch(e) {}

    await client.query(`CREATE TABLE IF NOT EXISTS road_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT,
      description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'resolved')),
      latitude DOUBLE PRECISION,
      longitude DOUBLE PRECISION,
      address TEXT,
      photo_url TEXT,
      points INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Safely add the new lifecycle column without breaking existing constraints
    try {
      await client.query("ALTER TABLE road_reports ADD COLUMN lifecycle_state TEXT DEFAULT 'PENDING_AI'");
    } catch (e) {}

    await client.query(`CREATE TABLE IF NOT EXISTS emergency_trips (
      id TEXT PRIMARY KEY,
      driver_id TEXT,
      vehicle_no TEXT,
      report_id TEXT,
      criticality TEXT CHECK(criticality IN ('low', 'medium', 'high', 'critical')),
      travel_time DOUBLE PRECISION,
      preemptions INTEGER,
      confidence INTEGER,
      distance DOUBLE PRECISION,
      started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(driver_id) REFERENCES users(id),
      FOREIGN KEY(report_id) REFERENCES road_reports(id)
    )`);

    // Safely upgrade emergency_trips for the new live-response workflow
    try {
      await client.query("ALTER TABLE emergency_trips ADD COLUMN dispatch_id TEXT");
      await client.query("ALTER TABLE emergency_trips ADD COLUMN status TEXT DEFAULT 'completed'");
    } catch (e) {}

    await client.query(`CREATE TABLE IF NOT EXISTS reward_events (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      report_id TEXT,
      points INTEGER,
      reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(user_id) REFERENCES users(id),
      FOREIGN KEY(report_id) REFERENCES road_reports(id)
    )`);

    // PHASE 2: New AI Analyses Table
    await client.query(`CREATE TABLE IF NOT EXISTS ai_analyses (
      id TEXT PRIMARY KEY,
      report_id TEXT REFERENCES road_reports(id),
      detected_type TEXT,
      severity TEXT,
      confidence DOUBLE PRECISION,
      people_injured BOOLEAN,
      road_blocked BOOLEAN,
      emergency_recommended BOOLEAN,
      raw_reasoning TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // PHASE 2: New Dispatches Table
    await client.query(`CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY,
      report_id TEXT REFERENCES road_reports(id),
      required_vehicle TEXT CHECK(required_vehicle IN ('ambulance', 'fire')),
      status TEXT DEFAULT 'available' CHECK(status IN ('available', 'accepted', 'completed', 'cancelled')),
      driver_id TEXT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    client.release();
    console.log('Postgres Database Initialized (ClearPath v2 Schema).');
    return;
  } catch (err) {
    console.warn('Postgres unavailable, falling back to SQLite:', err.message || err);
    useSqlite = true;
    await initSqliteDb();
  }
}

const initPromise = initDb();

function convertSql(sql) {
  if (useSqlite) return sql;
  let i = 1;
  return sql.replace(/\?/g, () => "$" + (i++));
}

const dbRun = async (sql, params = []) => {
  if (useSqlite) {
    return new Promise((resolve, reject) => {
      sqliteDb.run(sql, params, (err) => err ? reject(err) : resolve());
    });
  }

  await pool.query(convertSql(sql), params);
};

const dbGet = async (sql, params = []) => {
  if (useSqlite) {
    return new Promise((resolve, reject) => {
      sqliteDb.get(sql, params, (err, row) => err ? reject(err) : resolve(row || null));
    });
  }

  const res = await pool.query(convertSql(sql), params);
  return res.rows[0];
};

const dbAll = async (sql, params = []) => {
  if (useSqlite) {
    return new Promise((resolve, reject) => {
      sqliteDb.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows || []));
    });
  }

  const res = await pool.query(convertSql(sql), params);
  return res.rows;
};

module.exports = { db: useSqlite ? sqliteDb : pool, dbRun, dbGet, dbAll, initPromise };
