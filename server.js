const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { dbRun, dbGet, dbAll } = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(express.static(path.join(__dirname, 'public'))); // Serve the Admin UI

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, 'uploads/'),
  filename: (req, file, cb) => cb(null, Date.now() + '-' + file.originalname)
});
const upload = multer({ storage });

const fs = require('fs');
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');

// Global Real-time
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Broadcast helper for Admin UI
const notifyAdmin = () => io.emit('admin_refresh');

// AUTHENTICATION
app.post('/api/auth/register', async (req, res) => {
  const { phone, name, password } = req.body;
  
  const existing = await dbGet('SELECT * FROM users WHERE phone = ?', [phone]);
  if (existing) {
    return res.status(400).json({ error: 'Phone number already registered' });
  }
  
  const id = uuidv4();
  await dbRun('INSERT INTO users (id, role, phone, name, password) VALUES (?, ?, ?, ?, ?)', [id, 'citizen', phone, name, password]);
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
  notifyAdmin();
  
  res.json({ user });
});

app.post('/api/auth/login', async (req, res) => {
  const { phone, password } = req.body;
  
  const user = await dbGet('SELECT * FROM users WHERE phone = ?', [phone]);
  if (!user) {
    return res.status(404).json({ error: 'User not found' });
  }
  
  if (user.password !== password) {
    return res.status(401).json({ error: 'Incorrect password' });
  }
  
  res.json({ user });
});

app.post('/api/auth/roadly', async (req, res) => {
  // Keeping this for backward compatibility temporarily if needed, but it should return error
  res.status(400).json({ error: 'Please use /register or /login endpoints' });
});

app.post('/api/auth/signalaid', async (req, res) => {
  const { driver_id, vehicle_no } = req.body;
  let user = await dbGet('SELECT * FROM users WHERE driver_id = ? AND vehicle_no = ?', [driver_id, vehicle_no]);
  if (!user) {
    const id = uuidv4();
    await dbRun('INSERT INTO users (id, role, driver_id, vehicle_no) VALUES (?, ?, ?, ?)', [id, 'emergency_driver', driver_id, vehicle_no]);
    user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
    notifyAdmin();
  }
  res.json({ user });
});

// REPORTS
app.get('/api/reports', async (req, res) => {
  const reports = await dbAll('SELECT * FROM road_reports ORDER BY created_at DESC');
  res.json(reports);
});

app.post('/api/reports', upload.single('photo'), async (req, res) => {
  const { user_id, type, description, latitude, longitude, address, points } = req.body;
  const id = uuidv4();
  const photo_url = req.file ? `/uploads/${req.file.filename}` : null;
  
  await dbRun(`INSERT INTO road_reports 
    (id, user_id, type, description, latitude, longitude, address, photo_url, points) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, user_id, type, description, latitude, longitude, address, photo_url, points]
  );
  
  const newReport = await dbGet('SELECT * FROM road_reports WHERE id = ?', [id]);
  
  await dbRun('INSERT INTO reward_events (id, user_id, report_id, points, reason) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), user_id, id, points, 'report_submission']
  );
  await dbRun('UPDATE users SET points = points + ? WHERE id = ?', [points, user_id]);
  
  io.emit('new_incident', newReport);
  io.emit('points_updated', { user_id, points });
  notifyAdmin();
  res.json(newReport);
});

// Admin endpoint to verify/resolve reports
app.post('/api/reports/:id/status', async (req, res) => {
  const { status } = req.body;
  await dbRun('UPDATE road_reports SET status = ? WHERE id = ?', [status, req.params.id]);
  const updatedReport = await dbGet('SELECT * FROM road_reports WHERE id = ?', [req.params.id]);
  io.emit('report_updated', updatedReport);
  notifyAdmin();
  res.json(updatedReport);
});

// TRIPS
app.get('/api/trips/:driver_id', async (req, res) => {
  const trips = await dbAll('SELECT * FROM emergency_trips WHERE driver_id = ? ORDER BY started_at DESC', [req.params.driver_id]);
  res.json(trips);
});

app.get('/api/trips', async (req, res) => {
  const trips = await dbAll('SELECT * FROM emergency_trips ORDER BY started_at DESC');
  res.json(trips);
});

app.post('/api/trips', async (req, res) => {
  const { driver_id, report_id, criticality, travel_time, preemptions, confidence, distance, vehicle_no } = req.body;
  const id = uuidv4();
  
  await dbRun(`INSERT INTO emergency_trips 
    (id, driver_id, report_id, criticality, travel_time, preemptions, confidence, distance, vehicle_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, driver_id, report_id, criticality, travel_time, preemptions, confidence, distance, vehicle_no]
  );
  
  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [id]);
  io.emit('trip_completed', trip);
  notifyAdmin();
  res.json(trip);
});

// LEADERBOARD / USERS
app.get('/api/leaderboard', async (req, res) => {
  const users = await dbAll("SELECT id, phone, name, points FROM users WHERE role = 'citizen' ORDER BY points DESC LIMIT 50");
  res.json(users);
});

app.get('/api/users', async (req, res) => {
  const users = await dbAll("SELECT * FROM users ORDER BY created_at DESC");
  res.json(users);
});

// ── CLEARPATH AUTO-EXPIRY ENGINE ──────────────────────────────────────
// Reports auto-expire after a type-specific TTL. Runs every 10 minutes.
const REPORT_TTL_HOURS = {
  accident: 2, congestion: 3, blocked: 4, flooding: 6, pothole: 48, default: 4
};

async function runExpiryEngine() {
  const reports = await dbAll("SELECT id, type, created_at FROM road_reports WHERE status != 'resolved'");
  const now = Date.now();
  let count = 0;
  for (const r of reports) {
    const ttl = REPORT_TTL_HOURS[r.type] || REPORT_TTL_HOURS.default;
    const ageHrs = (now - new Date(r.created_at + 'Z').getTime()) / 3600000;
    if (ageHrs >= ttl) {
      await dbRun("UPDATE road_reports SET status = 'resolved' WHERE id = ?", [r.id]);
      const updated = await dbGet('SELECT * FROM road_reports WHERE id = ?', [r.id]);
      io.emit('report_updated', updated);
      count++;
      console.log(`[ClearPath] Auto-resolved: ${r.type} (${ageHrs.toFixed(1)}h old)`);
    }
  }
  if (count > 0) notifyAdmin();
}

runExpiryEngine();
setInterval(runExpiryEngine, 10 * 60 * 1000);

// ── HEALTH CHECK (for keep-alive pings) ──
app.get('/health', (req, res) => {
  res.json({ status: 'ok', name: 'ClearPath Command Server', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\n🛣️  ClearPath Command Server v1.0');
  console.log(`   Dashboard : http://localhost:${PORT}`);
  console.log(`   TTL rules : accident=2h | congestion=3h | blocked=4h | flooding=6h | pothole=48h\n`);
});

