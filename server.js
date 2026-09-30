const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const { randomUUID: uuidv4 } = require('crypto');
const bcrypt = require('bcrypt');
const { createClient } = require('@supabase/supabase-js');
const { dbRun, dbGet, dbAll, initPromise } = require('./database');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const SALT_ROUNDS = 10;

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PATCH'],
    credentials: true
  } 
});

// Phase 18: Restrict CORS to allowed origins
const corsOptions = {
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST', 'PATCH'],
  credentials: true
};
app.use(cors(corsOptions));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'))); // Serve the Admin UI

const upload = multer({ 
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    // Phase 18: Only accept image files
    const allowedMimes = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];
    if (allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only JPEG, PNG, WebP, HEIC images allowed.'), false);
    }
  },
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB max
  }
});
const BUCKET = 'report-photos';

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
  
  // Hash password with bcrypt
  const passwordHash = await bcrypt.hash(password, SALT_ROUNDS);
  
  const id = uuidv4();
  await dbRun('INSERT INTO users (id, role, phone, name, password) VALUES (?, ?, ?, ?, ?)', [id, 'citizen', phone, name, passwordHash]);
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
  
  // Compare password with bcrypt
  const passwordMatch = await bcrypt.compare(password, user.password);
  if (!passwordMatch) {
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

const { analyzeIncident } = require('./ai_service');

app.post('/api/reports', upload.single('photo'), async (req, res) => {
  const { user_id, type, description, latitude, longitude, address, points } = req.body;
  const id = uuidv4();
  let photo_url = null;

  if (req.file) {
    const fileName = `${id}-${Date.now()}${path.extname(req.file.originalname)}`;
    const { error } = await supabase.storage
      .from(BUCKET)
      .upload(fileName, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
    
    if (!error) {
      const { data } = supabase.storage.from(BUCKET).getPublicUrl(fileName);
      photo_url = data.publicUrl;
    } else {
      console.error('Supabase upload error:', error);
    }
  }

  // Initial insert as PENDING_AI
  await dbRun(`INSERT INTO road_reports 
    (id, user_id, type, description, latitude, longitude, address, photo_url, points, lifecycle_state) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING_AI')`,
    [id, user_id, type, description, latitude, longitude, address, photo_url, points]
  );
  
  const newReport = await dbGet('SELECT * FROM road_reports WHERE id = ?', [id]);
  
  await dbRun('INSERT INTO reward_events (id, user_id, report_id, points, reason) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), user_id, id, points, 'report_submission']
  );
  await dbRun('UPDATE users SET points = points + ? WHERE id = ?', [points, user_id]);
  
  // Phase 4: Trigger the AI engine in the background asynchronously
  // We do NOT `await` this, so the citizen's phone gets a fast response.
  analyzeIncident(newReport, (event, data) => io.emit(event, data))
    .catch(err => console.error("AI Pipeline failed:", err));

  // Note: We no longer emit 'new_incident' here. The Decision Engine will emit it 
  // later once verified, to ensure unverified junk doesn't appear on the map immediately.
  
  io.emit('points_updated', { user_id, points });
  notifyAdmin();
  
  // Return the pending report immediately to the citizen's app
  res.json(newReport);
});

// Phase 18: Multer error handling middleware
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Max size is 5MB.' });
    }
    return res.status(400).json({ error: `Upload error: ${err.message}` });
  } else if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
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

// DISPATCHES & ACCEPTANCE
app.post('/api/dispatches/:id/accept', async (req, res) => {
  const dispatchId = req.params.id;
  const { driver_id, vehicle_no } = req.body;

  // 1. Concurrency Protection (Phase 12 / 40)
  // Ensure the dispatch is still 'available'
  const dispatch = await dbGet('SELECT * FROM dispatches WHERE id = ?', [dispatchId]);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });
  if (dispatch.status !== 'available') {
    return res.status(409).json({ error: 'Dispatch already accepted by another driver' });
  }

  // 2. Mark dispatch as accepted
  await dbRun("UPDATE dispatches SET status = 'accepted', driver_id = ? WHERE id = ? AND status = 'available'", 
    [driver_id, dispatchId]
  );
  
  // Verify the atomic update succeeded (in case someone beat us to it by milliseconds)
  const verify = await dbGet("SELECT status, driver_id FROM dispatches WHERE id = ?", [dispatchId]);
  if (verify.driver_id !== driver_id) {
    return res.status(409).json({ error: 'Dispatch already accepted by another driver' });
  }

  // 3. Create the Emergency Trip (Phase 13 / 19)
  const tripId = uuidv4();
  await dbRun(`INSERT INTO emergency_trips 
    (id, dispatch_id, driver_id, vehicle_no, report_id, status)
    VALUES (?, ?, ?, ?, ?, 'en_route')`,
    [tripId, dispatchId, driver_id, vehicle_no, dispatch.report_id]
  );

  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [tripId]);
  
  // Broadcast to other drivers to remove it from their screens
  io.emit('dispatch.accepted', { dispatchId, driver_id });
  io.emit('trip.started', trip);
  notifyAdmin();

  res.json(trip);
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

// PHASE 12: Live GPS location broadcast
app.post('/api/trips/:id/location', async (req, res) => {
  const { latitude, longitude } = req.body;
  io.emit('trip.location_updated', { tripId: req.params.id, latitude, longitude });
  res.json({ ok: true });
});

// PHASE 14: Trip state transitions (arrived / completed)
app.patch('/api/trips/:id/status', async (req, res) => {
  const { status, driver_id } = req.body;
  const allowed = ['en_route', 'arrived', 'completed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  await dbRun("UPDATE emergency_trips SET status = ? WHERE id = ? AND driver_id = ?", [status, req.params.id, driver_id]);
  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [req.params.id]);

  if (status === 'completed') {
    if (trip && trip.dispatch_id) {
      await dbRun("UPDATE dispatches SET status = 'completed' WHERE id = ?", [trip.dispatch_id]);
    }
    io.emit('trip.completed', trip);
  } else if (status === 'arrived') {
    io.emit('trip.arrived', trip);
  }

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

// Driver availability
app.patch('/api/users/:id/availability', async (req, res) => {
  const { availability } = req.body;
  if (!['OFFLINE','AVAILABLE','BUSY'].includes(availability)) return res.status(400).json({ error: 'Invalid availability' });
  await dbRun('UPDATE users SET availability = ? WHERE id = ?', [availability, req.params.id]);
  const user = await dbGet('SELECT id, availability, driver_id, vehicle_no FROM users WHERE id = ?', [req.params.id]);
  io.emit('driver.availability_updated', user);
  res.json(user);
});

// GET available dispatches (Signal-Aid loads on app start)
app.get('/api/dispatches', async (req, res) => {
  const dispatches = await dbAll(`
    SELECT d.*, r.latitude, r.longitude, r.type, r.description, r.address
    FROM dispatches d
    JOIN road_reports r ON d.report_id = r.id
    WHERE d.status = 'available'
    ORDER BY d.created_at DESC
  `);
  res.json(dispatches);
});

// GET route via OSRM (no API key needed)
app.get('/api/route', async (req, res) => {
  const { fromLat, fromLon, toLat, toLon } = req.query;
  if (!fromLat || !fromLon || !toLat || !toLon) return res.status(400).json({ error: 'Missing coords' });
  try {
    const osrmUrl = `http://router.project-osrm.org/route/v1/driving/${fromLon},${fromLat};${toLon},${toLat}?overview=false&steps=false`;
    const response = await fetch(osrmUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error('OSRM error');
    const data = await response.json();
    const route = data.routes[0];
    const distanceKm = (route.distance / 1000).toFixed(2);
    const durationMin = Math.ceil(route.duration / 60);
    // Estimate signal count: approx 1.5 signals per km in urban areas
    const signalCount = Math.max(1, Math.round(distanceKm * 1.5));
    res.json({ distanceKm: parseFloat(distanceKm), durationMin, signalCount });
  } catch (err) {
    // Fallback: estimate based on straight-line distance
    const R = 6371;
    const dLat = (toLat - fromLat) * Math.PI / 180;
    const dLon = (toLon - fromLon) * Math.PI / 180;
    const a = Math.sin(dLat/2)**2 + Math.cos(fromLat * Math.PI/180) * Math.cos(toLat * Math.PI/180) * Math.sin(dLon/2)**2;
    const distanceKm = parseFloat((R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a))).toFixed(2));
    const durationMin = Math.ceil(distanceKm / 0.5); // assume 30 km/h avg speed
    const signalCount = Math.max(1, Math.round(distanceKm * 1.5));
    res.json({ distanceKm, durationMin, signalCount, fallback: true });
  }
});

// GET active trip for driver (restart persistence)
app.get('/api/trips/active/:driver_id', async (req, res) => {
  const trip = await dbGet(
    "SELECT * FROM emergency_trips WHERE driver_id = ? AND status IN ('en_route','arrived') ORDER BY started_at DESC LIMIT 1",
    [req.params.driver_id]
  );
  res.json(trip || null);
});


// â”€â”€ CLEARPATH AUTO-EXPIRY ENGINE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Reports auto-expire after a type-specific TTL. Runs every 10 minutes.
const REPORT_TTL_HOURS = {
  accident: 2, congestion: 3, blocked: 4, flooding: 6, pothole: 48, default: 4
};

async function runExpiryEngine() {
  // Step 1: Move old ACTIVE reports to RECHECK
  const activeReports = await dbAll("SELECT id, type, created_at FROM road_reports WHERE lifecycle_state = 'ACTIVE' OR lifecycle_state = 'VERIFIED'");
  const now = Date.now();
  const RECHECK_TTL_HOURS = { accident: 2, fire: 1, congestion: 3, blocked: 4, flooding: 6, pothole: 48, default: 4 };
  
  for (const r of activeReports) {
    const ttl = RECHECK_TTL_HOURS[r.type] || RECHECK_TTL_HOURS.default;
    const ageHrs = (now - new Date(r.created_at + (r.created_at.includes('Z') ? '' : 'Z')).getTime()) / 3600000;
    if (ageHrs >= ttl) {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'RECHECK', status = 'pending' WHERE id = ?", [r.id]);
      console.log(`[ClearPath] Recheck flagged: ${r.type} (${ageHrs.toFixed(1)}h old)`);
    }
  }

  // Step 2: Auto-resolve old RECHECK reports (after 30 more min)
  const recheckReports = await dbAll("SELECT id, type, created_at FROM road_reports WHERE lifecycle_state = 'RECHECK'");
  for (const r of recheckReports) {
    const ageHrs = (now - new Date(r.created_at + (r.created_at.includes('Z') ? '' : 'Z')).getTime()) / 3600000;
    const ttl = (RECHECK_TTL_HOURS[r.type] || RECHECK_TTL_HOURS.default) + 0.5;
    if (ageHrs >= ttl) {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'RESOLVED', status = 'resolved' WHERE id = ?", [r.id]);
      const updated = await dbGet('SELECT * FROM road_reports WHERE id = ?', [r.id]);
      io.emit('report_updated', updated);
      console.log(`[ClearPath] Auto-resolved: ${r.type}`);
    }
  }
}

initPromise.then(() => { runExpiryEngine(); setInterval(runExpiryEngine, 10 * 60 * 1000); });

// â”€â”€ HEALTH CHECK (for keep-alive pings) â”€â”€
app.get('/health', (req, res) => {
  res.json({ status: 'ok', name: 'ClearPath Command Server', uptime: process.uptime() });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log('\nðŸ›£ï¸  ClearPath Command Server v1.0');
  console.log(`   Dashboard : http://localhost:${PORT}`);
  console.log(`   TTL rules : accident=2h | congestion=3h | blocked=4h | flooding=6h | pothole=48h\n`);
});

