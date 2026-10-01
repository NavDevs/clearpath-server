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

  await ensureSqliteSchema(db);
  console.log('SQLite database initialized.');
}

/**
 * Bring any SQLite database up to the ClearPath v2 schema.
 *
 * The fallback used to create only the original four tables, so a machine without
 * Postgres could not run the verification / dispatch / approval workflow (every
 * admin query referenced columns and tables that did not exist). Every statement
 * here is idempotent, so it is safe on both fresh and pre-existing files.
 */
async function ensureSqliteSchema(db) {
  const run = (sql) => new Promise((resolve, reject) => {
    db.run(sql, (err) => (err ? reject(err) : resolve()));
  });
  const migrate = (sql) => run(sql).catch(() => {});
  const get = (sql) => new Promise((resolve, reject) => {
    db.get(sql, (err, row) => (err ? reject(err) : resolve(row || null)));
  });

  // Driver identity + approval + live location columns.
  await migrate('ALTER TABLE users ADD COLUMN vehicle_type TEXT');
  await migrate('ALTER TABLE users ADD COLUMN organization TEXT');
  await migrate("ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'pending'");
  await migrate("ALTER TABLE users ADD COLUMN availability TEXT DEFAULT 'OFFLINE'");
  await migrate('ALTER TABLE users ADD COLUMN current_latitude REAL');
  await migrate('ALTER TABLE users ADD COLUMN current_longitude REAL');
  await migrate('ALTER TABLE users ADD COLUMN last_location_update TIMESTAMP');

  // Incident lifecycle (ACTIVE -> ... -> RESOLVED) and driver reference.
  await migrate("ALTER TABLE road_reports ADD COLUMN lifecycle_state TEXT DEFAULT 'ACTIVE'");
  await migrate('ALTER TABLE road_reports ADD COLUMN driver_id TEXT');

  // Live emergency response columns on trips.
  await migrate('ALTER TABLE emergency_trips ADD COLUMN dispatch_id TEXT');
  await migrate("ALTER TABLE emergency_trips ADD COLUMN status TEXT DEFAULT 'completed'");

  // Tables the fallback never created.
  await migrate(`CREATE TABLE IF NOT EXISTS dispatches (
    id TEXT PRIMARY KEY,
    report_id TEXT,
    required_vehicle TEXT CHECK(required_vehicle IN ('ambulance', 'fire')),
    status TEXT DEFAULT 'available' CHECK(status IN ('available', 'accepted', 'completed', 'cancelled')),
    driver_id TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  await migrate(`CREATE TABLE IF NOT EXISTS driver_approval_requests (
    id TEXT PRIMARY KEY,
    user_id TEXT,
    driver_id TEXT,
    vehicle_no TEXT,
    vehicle_type TEXT,
    organization TEXT,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
    reviewed_by TEXT,
    reviewed_at TIMESTAMP,
    rejection_reason TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )`);

  // Older files baked in CHECK(status IN ('pending','verified','resolved')), which
  // rejects the REJECTED lifecycle. SQLite cannot drop a CHECK, so rebuild the table.
  const roadReports = await get("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'road_reports'");
  if (roadReports && roadReports.sql && !roadReports.sql.includes('rejected')) {
    await run('ALTER TABLE road_reports RENAME TO road_reports_legacy');
    await run(`CREATE TABLE road_reports (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      type TEXT,
      description TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'verified', 'resolved', 'rejected')),
      latitude REAL,
      longitude REAL,
      address TEXT,
      photo_url TEXT,
      points INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      lifecycle_state TEXT DEFAULT 'ACTIVE',
      driver_id TEXT
    )`);
    await run(`INSERT INTO road_reports
      (id, user_id, type, description, status, latitude, longitude, address, photo_url, points, created_at, lifecycle_state)
      SELECT id, user_id, type, description, status, latitude, longitude, address, photo_url, points, created_at, 'ACTIVE'
      FROM road_reports_legacy`);
    await run('DROP TABLE road_reports_legacy');
    console.log('SQLite: road_reports rebuilt to allow the REJECTED lifecycle.');
  }
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
      vehicle_type TEXT,
      organization TEXT,
      approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected')),
      availability TEXT DEFAULT 'OFFLINE' CHECK(availability IN ('OFFLINE', 'AVAILABLE', 'BUSY')),
      points INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    try {
      await client.query("ALTER TABLE users ADD COLUMN password TEXT");
    } catch (e) {}

    try { await client.query("ALTER TABLE users ADD COLUMN availability TEXT DEFAULT 'OFFLINE'"); } catch(e) {}

    // Add driver-specific columns if they don't exist
    try { await client.query("ALTER TABLE users ADD COLUMN driver_id TEXT UNIQUE"); } catch(e) {}
    try { await client.query("ALTER TABLE users ADD COLUMN vehicle_no TEXT"); } catch(e) {}
    try { await client.query("ALTER TABLE users ADD COLUMN vehicle_type TEXT"); } catch(e) {}
    try { await client.query("ALTER TABLE users ADD COLUMN organization TEXT"); } catch(e) {}
    try { await client.query("ALTER TABLE users ADD COLUMN approval_status TEXT DEFAULT 'pending' CHECK(approval_status IN ('pending', 'approved', 'rejected'))"); } catch(e) {}

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
      await client.query("ALTER TABLE road_reports ADD COLUMN lifecycle_state TEXT DEFAULT 'ACTIVE'");
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

    // Dispatches Table
    await client.query(`CREATE TABLE IF NOT EXISTS dispatches (
      id TEXT PRIMARY KEY,
      report_id TEXT REFERENCES road_reports(id),
      required_vehicle TEXT CHECK(required_vehicle IN ('ambulance', 'fire')),
      status TEXT DEFAULT 'available' CHECK(status IN ('available', 'accepted', 'completed', 'cancelled')),
      driver_id TEXT REFERENCES users(id),
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);

    // Allow REJECTED status for incident moderation (spec: REJECTED flow)
    try { await client.query("ALTER TABLE road_reports DROP CONSTRAINT IF EXISTS road_reports_status_check"); } catch(e) {}
    try { await client.query("ALTER TABLE road_reports ADD CONSTRAINT road_reports_status_check CHECK(status IN ('pending', 'verified', 'resolved', 'rejected'))"); } catch(e) {}

    // Driver live location for nearby dispatch
    try { await client.query("ALTER TABLE users ADD COLUMN current_latitude DOUBLE PRECISION"); } catch(e) {}
    try { await client.query("ALTER TABLE users ADD COLUMN current_longitude DOUBLE PRECISION"); } catch(e) {}
    try { await client.query("ALTER TABLE users ADD COLUMN last_location_update TIMESTAMP"); } catch(e) {}

    // Driver Approval Requests Table
    await client.query(`CREATE TABLE IF NOT EXISTS driver_approval_requests (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id),
      driver_id TEXT,
      vehicle_no TEXT,
      vehicle_type TEXT,
      organization TEXT,
      status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'rejected')),
      reviewed_by TEXT,
      reviewed_at TIMESTAMP,
      rejection_reason TEXT,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
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

/**
 * Delete every operational row so the system can be demoed from a clean slate.
 *
 * Admin credentials are environment-based, so wiping `users` does not lock anyone
 * out of the dashboard. Order below is child-before-parent for SQLite, which does
 * not support TRUNCATE ... CASCADE.
 */
const RESET_TABLES = [
  'dispatches',
  'emergency_trips',
  'reward_events',
  'driver_approval_requests',
  'road_reports',
  'users'
];

async function resetAllData() {
  if (useSqlite) {
    for (const table of RESET_TABLES) {
      // A table missing from an older file is not a failure worth stopping for.
      await dbRun('DELETE FROM ' + table).catch(() => {});
    }
    return { engine: 'sqlite', tables: RESET_TABLES };
  }

  await pool.query('TRUNCATE TABLE ' + RESET_TABLES.join(', ') + ' RESTART IDENTITY CASCADE');
  return { engine: 'postgres', tables: RESET_TABLES };
}

module.exports = { db: useSqlite ? sqliteDb : pool, dbRun, dbGet, dbAll, initPromise, resetAllData };
