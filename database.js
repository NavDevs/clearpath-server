const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/clearpath',
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
});

async function initDb() {
  const client = await pool.connect();
  try {
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
    } catch(e) {}

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
    console.log('Postgres Database Initialized.');
  } catch (err) {
    console.error('Error initializing Postgres DB:', err);
  } finally {
    client.release();
  }
}
initDb();

function convertSql(sql) {
  let i = 1;
  return sql.replace(/\?/g, () => "$" + (i++));
}

const dbRun = async (sql, params = []) => {
  await pool.query(convertSql(sql), params);
};

const dbGet = async (sql, params = []) => {
  const res = await pool.query(convertSql(sql), params);
  return res.rows[0];
};

const dbAll = async (sql, params = []) => {
  const res = await pool.query(convertSql(sql), params);
  return res.rows;
};

module.exports = { db: pool, dbRun, dbGet, dbAll };
