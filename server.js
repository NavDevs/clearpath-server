const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

// Load backend/.env (gitignored) when present so local runs are configured without
// adding a dependency. Platform env vars always win; nothing is overwritten.
// Must run before ./database is required, because it reads DATABASE_URL on load.
(() => {
  try {
    const envFile = path.join(__dirname, '.env');
    if (!fs.existsSync(envFile)) return;
    for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*(.*)$/);
      if (!match) continue;
      const key = match[1];
      let value = match[2].trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (err) {
    console.warn('Could not read backend/.env:', err.message || err);
  }
})();

const { randomUUID: uuidv4 } = require('crypto');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { createClient } = require('@supabase/supabase-js');
const { dbRun, dbGet, dbAll, initPromise } = require('./database');
const { resetAllDataAndPhotos } = require('./maintenance');

// Photo storage is optional. The Command Server must always boot and serve the
// admin dashboard, so an unconfigured Supabase only disables photo uploads.
const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;
if (!supabase) console.warn('[ClearPath] Supabase storage not configured - report photos will be skipped.');

const SALT_ROUNDS = 10;
const JWT_SECRET = process.env.JWT_SECRET || 'clearpath-dev-secret-change-in-production';
const JWT_EXPIRES_IN = '30d';

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
  // No file size limit, no type filter - upload anything
});
const BUCKET = 'report-photos';

// JWT Authentication Middleware
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split(' ')[1];
  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Role-based authorization middleware
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}

// Driver approval status check
async function requireApprovedDriver(req, res, next) {
  if (!req.user || req.user.role !== 'emergency_driver') {
    return res.status(403).json({ error: 'Driver access required' });
  }
  const user = await dbGet('SELECT approval_status FROM users WHERE id = ?', [req.user.id]);
  if (!user || user.approval_status !== 'approved') {
    return res.status(403).json({ error: 'Driver not approved', approval_status: user?.approval_status || 'pending' });
  }
  next();
}

// Global Real-time
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  socket.on('disconnect', () => console.log('Client disconnected:', socket.id));
});

// Broadcast helper for Admin UI
const notifyAdmin = () => io.emit('admin_refresh');

// Resolve a driver reference that may be a users.id UUID or a human driver_id code.
async function resolveDriver(ref) {
  if (!ref) return null;
  let driver = await dbGet('SELECT * FROM users WHERE id = ?', [ref]);
  if (!driver) {
    driver = await dbGet('SELECT * FROM users WHERE driver_id = ?', [ref]);
  }
  return driver;
}

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

// Admin login -> JWT with role=admin (dashboard + approval flows)
app.post('/api/auth/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const adminUser = process.env.ADMIN_USERNAME || 'admin';
  const adminPass = process.env.ADMIN_PASSWORD || 'clearpath123';
  if (username !== adminUser || password !== adminPass) {
    return res.status(401).json({ error: 'Invalid admin credentials' });
  }
  const token = jwt.sign({ id: 'admin', role: 'admin', username: adminUser }, JWT_SECRET, { expiresIn: JWT_EXPIRES_IN });
  res.json({ token, user: { id: 'admin', role: 'admin', username: adminUser } });
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

// DRIVER REGISTRATION / APPROVAL
app.post('/api/auth/driver/register', async (req, res) => {
  const { name, phone, driver_id, vehicle_no, vehicle_type, organization } = req.body;
  
  if (!name || !phone || !driver_id || !vehicle_no || !vehicle_type) {
    return res.status(400).json({ error: 'All fields required: name, phone, driver_id, vehicle_no, vehicle_type' });
  }
  
  if (!['ambulance', 'fire'].includes(vehicle_type)) {
    return res.status(400).json({ error: 'vehicle_type must be ambulance or fire' });
  }

  const existingDriver = await dbGet('SELECT * FROM users WHERE driver_id = ?', [driver_id]);
  if (existingDriver) {
    return res.status(400).json({ error: 'Driver ID already registered' });
  }

  const existingPhone = await dbGet('SELECT * FROM users WHERE phone = ?', [phone]);
  if (existingPhone) {
    return res.status(400).json({ error: 'Phone number already registered' });
  }

  const id = uuidv4();
  await dbRun(
    `INSERT INTO users (id, role, name, phone, driver_id, vehicle_no, vehicle_type, organization, approval_status) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
    [id, 'emergency_driver', name, phone, driver_id, vehicle_no, vehicle_type, organization || '']
  );

  // Create approval request record
  const requestId = uuidv4();
  await dbRun(
    `INSERT INTO driver_approval_requests (id, user_id, driver_id, vehicle_no, vehicle_type, organization, status) 
     VALUES (?, ?, ?, ?, ?, ?, 'pending')`,
    [requestId, id, driver_id, vehicle_no, vehicle_type, organization || '']
  );

  notifyAdmin();
  
  const user = await dbGet('SELECT * FROM users WHERE id = ?', [id]);
  res.json({ user, message: 'Registration submitted for approval. Wait for admin approval.' });
});

// Driver login - returns JWT token
app.post('/api/auth/driver/login', async (req, res) => {
  const { driver_id, vehicle_no } = req.body;
  
  const user = await dbGet('SELECT * FROM users WHERE driver_id = ? AND vehicle_no = ?', [driver_id, vehicle_no]);
  if (!user) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  
  if (user.approval_status !== 'approved') {
    return res.status(403).json({ 
      error: 'Driver not approved', 
      approval_status: user.approval_status,
      message: user.approval_status === 'pending' ? 'Waiting for admin approval' : 'Registration was rejected'
    });
  }

  // Generate JWT token
  const token = jwt.sign(
    { id: user.id, role: user.role, driver_id: user.driver_id },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN }
  );

  // Mark driver as available
  await dbRun('UPDATE users SET availability = ? WHERE id = ?', ['AVAILABLE', user.id]);
  
  res.json({ user, token });
});

// Get current driver profile (requires auth)
app.get('/api/driver/profile', authMiddleware, requireApprovedDriver, async (req, res) => {
  const user = await dbGet('SELECT id, name, phone, driver_id, vehicle_no, vehicle_type, organization, approval_status, availability, points, created_at FROM users WHERE id = ?', [req.user.id]);
  if (!user) {
    return res.status(404).json({ error: 'Driver not found' });
  }
  res.json({ user });
});

// Update driver availability (requires auth)
app.patch('/api/driver/availability', authMiddleware, requireApprovedDriver, async (req, res) => {
  const { availability } = req.body;
  if (!['OFFLINE', 'AVAILABLE', 'BUSY'].includes(availability)) {
    return res.status(400).json({ error: 'Invalid availability' });
  }
  await dbRun('UPDATE users SET availability = ? WHERE id = ?', [availability, req.user.id]);
  const user = await dbGet('SELECT id, availability, driver_id, vehicle_no FROM users WHERE id = ?', [req.user.id]);
  io.emit('driver.availability_updated', user);
  res.json(user);
});

// ADMIN ENDPOINTS
// Get all driver approval requests
app.get('/api/admin/driver-requests', authMiddleware, requireRole('admin'), async (req, res) => {
  const requests = await dbAll(`
    SELECT dar.*, u.name, u.phone, u.vehicle_type, u.organization
    FROM driver_approval_requests dar
    JOIN users u ON dar.user_id = u.id
    ORDER BY dar.created_at DESC
  `);
  res.json(requests);
});

// Approve driver
app.post('/api/admin/driver-requests/:id/approve', authMiddleware, requireRole('admin'), async (req, res) => {
  const request = await dbGet('SELECT * FROM driver_approval_requests WHERE id = ?', [req.params.id]);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request already processed' });
  }

  await dbRun('UPDATE driver_approval_requests SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?', 
    ['approved', req.user.id, new Date().toISOString(), req.params.id]);
  await dbRun('UPDATE users SET approval_status = ? WHERE id = ?', ['approved', request.user_id]);

  const user = await dbGet('SELECT * FROM users WHERE id = ?', [request.user_id]);
  io.emit('driver_approval_updated', { user_id: request.user_id, status: 'approved' });
  notifyAdmin();
  
  res.json({ message: 'Driver approved', user });
});

// Reject driver
app.post('/api/admin/driver-requests/:id/reject', authMiddleware, requireRole('admin'), async (req, res) => {
  const { rejection_reason } = req.body;
  const request = await dbGet('SELECT * FROM driver_approval_requests WHERE id = ?', [req.params.id]);
  if (!request) {
    return res.status(404).json({ error: 'Request not found' });
  }
  if (request.status !== 'pending') {
    return res.status(400).json({ error: 'Request already processed' });
  }

  await dbRun('UPDATE driver_approval_requests SET status = ?, reviewed_by = ?, reviewed_at = ?, rejection_reason = ? WHERE id = ?', 
    ['rejected', req.user.id, new Date().toISOString(), rejection_reason || 'No reason provided', req.params.id]);
  await dbRun('UPDATE users SET approval_status = ? WHERE id = ?', ['rejected', request.user_id]);

  io.emit('driver_approval_updated', { user_id: request.user_id, status: 'rejected', reason: rejection_reason });
  notifyAdmin();
  
  res.json({ message: 'Driver rejected' });
});

// Get all drivers (for admin)
app.get('/api/admin/drivers', authMiddleware, requireRole('admin'), async (req, res) => {
  const drivers = await dbAll(`
    SELECT id, name, phone, driver_id, vehicle_no, vehicle_type, organization,
           approval_status, availability, current_latitude, current_longitude,
           last_location_update, points, created_at
    FROM users 
    WHERE role = 'emergency_driver'
    ORDER BY created_at DESC
  `);
  res.json(drivers);
});

// Get all users (for admin) — never expose password hashes.
app.get('/api/admin/users', authMiddleware, requireRole('admin'), async (req, res) => {
  const users = await dbAll(`
    SELECT id, role, name, phone, driver_id, vehicle_no, vehicle_type, organization,
           approval_status, availability, points, created_at
    FROM users
    ORDER BY created_at DESC
  `);
  res.json(users);
});

// Get all incidents (for admin)
app.get('/api/admin/incidents', authMiddleware, requireRole('admin'), async (req, res) => {
  const incidents = await dbAll(`
    SELECT r.*, u.name as reporter_name, u.phone as reporter_phone,
           ai.detected_type, ai.confidence, ai.severity, ai.emergency_recommended,
           ai.people_injured, ai.road_blocked, ai.raw_reasoning
    FROM road_reports r
    LEFT JOIN users u ON r.user_id = u.id
    LEFT JOIN ai_analyses ai ON ai.report_id = r.id
    ORDER BY r.created_at DESC
  `);
  res.json(incidents);
});

// Get all dispatches (for admin)
app.get('/api/admin/dispatches', authMiddleware, requireRole('admin'), async (req, res) => {
  const dispatches = await dbAll(`
    SELECT d.*, r.type as incident_type, r.address, r.latitude, r.longitude,
           u.name as driver_name, u.driver_id, u.vehicle_no
    FROM dispatches d
    JOIN road_reports r ON d.report_id = r.id
    LEFT JOIN users u ON d.driver_id = u.id
    ORDER BY d.created_at DESC
  `);
  res.json(dispatches);
});

// Get all trips (for admin)
app.get('/api/admin/trips', authMiddleware, requireRole('admin'), async (req, res) => {
  const trips = await dbAll(`
    SELECT et.*, r.type as incident_type, r.address,
           u.name as driver_name, u.driver_id, u.vehicle_no
    FROM emergency_trips et
    JOIN road_reports r ON et.report_id = r.id
    LEFT JOIN users u ON et.driver_id = u.id
    ORDER BY et.started_at DESC
  `);
  res.json(trips);
});

// Manage an emergency assignment (admin): cancel it, or re-open it for
// re-dispatch. Both cases release the assigned driver back to AVAILABLE.
app.patch('/api/admin/dispatches/:id/status', authMiddleware, requireRole('admin'), async (req, res) => {
  const { status } = req.body;
  if (!['available', 'cancelled'].includes(status)) {
    return res.status(400).json({ error: "status must be 'available' (re-dispatch) or 'cancelled'" });
  }

  const dispatch = await dbGet('SELECT * FROM dispatches WHERE id = ?', [req.params.id]);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });

  // Release whoever was assigned, and close their trip.
  if (dispatch.driver_id) {
    await dbRun('UPDATE users SET availability = ? WHERE id = ?', ['AVAILABLE', dispatch.driver_id]);
    await dbRun("UPDATE emergency_trips SET status = 'completed' WHERE dispatch_id = ? AND status IN ('en_route','arrived')", [dispatch.id]);
    io.emit('driver.availability_updated', { id: dispatch.driver_id, availability: 'AVAILABLE' });
  }

  await dbRun('UPDATE dispatches SET status = ?, driver_id = ?, updated_at = ? WHERE id = ?',
    [status, null, new Date().toISOString(), dispatch.id]);

  // Keep the incident lifecycle consistent with its assignment.
  let incident = null;
  if (dispatch.report_id) {
    const nextState = status === 'cancelled' ? 'VERIFIED' : 'DISPATCHED';
    await dbRun('UPDATE road_reports SET lifecycle_state = ?, status = ? WHERE id = ?',
      [nextState, 'verified', dispatch.report_id]);
    incident = await dbGet('SELECT * FROM road_reports WHERE id = ?', [dispatch.report_id]);
    if (incident) io.emit('report_updated', incident);
  }

  const updated = await dbGet(`
    SELECT d.*, r.type as incident_type, r.address, u.name as driver_name, u.vehicle_no
    FROM dispatches d
    JOIN road_reports r ON d.report_id = r.id
    LEFT JOIN users u ON d.driver_id = u.id
    WHERE d.id = ?`, [dispatch.id]
  );

  // Spec: the Signal-Aid app is told when a request is cancelled.
  if (status === 'cancelled') io.emit('dispatch.cancelled', { dispatchId: dispatch.id, report_id: dispatch.report_id });
  else io.emit('dispatch.created', updated);
  notifyAdmin();

  res.json({ dispatch: updated, incident });
});

// Update incident status (admin)
app.patch('/api/admin/incidents/:id/status', authMiddleware, requireRole('admin'), async (req, res) => {
  const { status, lifecycle_state } = req.body;
  if (status) {
    await dbRun('UPDATE road_reports SET status = ? WHERE id = ?', [status, req.params.id]);
  }
  if (lifecycle_state) {
    await dbRun('UPDATE road_reports SET lifecycle_state = ? WHERE id = ?', [lifecycle_state, req.params.id]);
  }
  const updated = await dbGet('SELECT * FROM road_reports WHERE id = ?', [req.params.id]);
  io.emit('report_updated', updated);
  notifyAdmin();
  res.json(updated);
});

// Admin: Manually verify incident (for human review)
app.post('/api/admin/incidents/:id/verify', authMiddleware, requireRole('admin'), async (req, res) => {
  const report = await dbGet('SELECT * FROM road_reports WHERE id = ?', [req.params.id]);
  if (!report) {
    return res.status(404).json({ error: 'Incident not found' });
  }

  await dbRun("UPDATE road_reports SET lifecycle_state = 'VERIFIED', status = 'verified' WHERE id = ?", [req.params.id]);
  let updatedReport = await dbGet('SELECT * FROM road_reports WHERE id = ?', [req.params.id]);
  io.emit('report_updated', updatedReport);
  io.emit('new_incident', updatedReport);

  // Only accident/fire create Signal-Aid dispatches.
  const norm = String(report.type || '').toLowerCase();
  const requiredVehicle = norm === 'fire' ? 'fire' : norm === 'accident' ? 'ambulance' : null;
  let fullDispatch = null;
  if (requiredVehicle) {
    const existing = await dbGet('SELECT id FROM dispatches WHERE report_id = ?', [req.params.id]);
    let dispatchId = existing?.id;
    if (!dispatchId) {
      dispatchId = uuidv4();
      await dbRun(
        `INSERT INTO dispatches (id, report_id, required_vehicle, status) VALUES (?, ?, ?, 'available')`,
        [dispatchId, req.params.id, requiredVehicle]
      );
    }
    await dbRun("UPDATE road_reports SET lifecycle_state = 'DISPATCHED', status = 'verified' WHERE id = ?", [req.params.id]);
    fullDispatch = await dbGet(`
      SELECT d.*, r.latitude, r.longitude, r.type, r.description, r.address, r.photo_url
      FROM dispatches d
      JOIN road_reports r ON d.report_id = r.id
      WHERE d.id = ?`, [dispatchId]
    );
    updatedReport = await dbGet('SELECT * FROM road_reports WHERE id = ?', [req.params.id]);
    io.emit('report_updated', updatedReport);
    io.emit('dispatch.created', fullDispatch);
  }
  notifyAdmin();

  res.json({ report: updatedReport, dispatch: fullDispatch });
});

// Admin: Reject incident
app.post('/api/admin/incidents/:id/reject', authMiddleware, requireRole('admin'), async (req, res) => {
  const { reason } = req.body;
  await dbRun("UPDATE road_reports SET lifecycle_state = 'REJECTED', status = 'rejected' WHERE id = ?", [req.params.id]);
  const updated = await dbGet('SELECT * FROM road_reports WHERE id = ?', [req.params.id]);
  io.emit('report_updated', updated);
  notifyAdmin();
  res.json(updated);
});

// Admin: wipe all operational data (incidents, trips, dispatches, approvals, users
// and uploaded photos) so the system can be demoed from a clean slate.
// Guarded by the admin role AND an explicit confirmation phrase, so it can never
// fire from a stray request or an accidental click.
app.post('/api/admin/reset-data', authMiddleware, requireRole('admin'), async (req, res) => {
  const { confirm } = req.body || {};
  if (confirm !== 'RESET_ALL_DATA') {
    return res.status(400).json({ error: "Send { \"confirm\": \"RESET_ALL_DATA\" } to wipe all data" });
  }

  try {
    const summary = await resetAllDataAndPhotos(supabase);
    console.log('[ClearPath] Data reset:', JSON.stringify(summary));
    io.emit('data_reset');
    notifyAdmin();
    res.json(summary);
  } catch (err) {
    console.error('[ClearPath] Data reset failed:', err.message || err);
    res.status(500).json({ error: 'Reset failed: ' + (err.message || String(err)) });
  }
});

// Admin: Get system stats
app.get('/api/admin/stats', authMiddleware, requireRole('admin'), async (req, res) => {
  const totalUsers = await dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'citizen'");
  const totalDrivers = await dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'emergency_driver'");
  const approvedDrivers = await dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'emergency_driver' AND approval_status = 'approved'");
  const pendingDrivers = await dbGet("SELECT COUNT(*) as count FROM users WHERE role = 'emergency_driver' AND approval_status = 'pending'");
  const totalIncidents = await dbGet("SELECT COUNT(*) as count FROM road_reports");
  const pendingIncidents = await dbGet("SELECT COUNT(*) as count FROM road_reports WHERE lifecycle_state IN ('ACTIVE','PENDING_VERIFICATION','HUMAN_REVIEW')");
  const verifiedIncidents = await dbGet("SELECT COUNT(*) as count FROM road_reports WHERE lifecycle_state IN ('VERIFIED','DISPATCHED','ACCEPTED','EN_ROUTE','ARRIVED')");
  const activeIncidents = await dbGet("SELECT COUNT(*) as count FROM road_reports WHERE lifecycle_state = 'ACTIVE'");
  const totalDispatches = await dbGet("SELECT COUNT(*) as count FROM dispatches");
  const activeDispatches = await dbGet("SELECT COUNT(*) as count FROM dispatches WHERE status = 'available'");
  
  res.json({
    users: { total: totalUsers?.count || 0 },
    drivers: { 
      total: totalDrivers?.count || 0, 
      approved: approvedDrivers?.count || 0, 
      pending: pendingDrivers?.count || 0 
    },
    incidents: { 
      total: totalIncidents?.count || 0,
      pending_verification: pendingIncidents?.count || 0,
      verified: verifiedIncidents?.count || 0,
      active: activeIncidents?.count || 0
    },
    dispatches: { 
      total: totalDispatches?.count || 0,
      available: activeDispatches?.count || 0
    }
  });
});
app.get('/api/reports', async (req, res) => {
  const reports = await dbAll('SELECT * FROM road_reports ORDER BY created_at DESC');
  res.json(reports);
});

const { analyzeIncident } = require('./ai_service');

app.post('/api/reports', upload.single('photo'), async (req, res) => {
  const { user_id, type, description, latitude, longitude, address, points } = req.body;
  const id = uuidv4();
  let photo_url = null;

  if (req.file && supabase) {
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
  } else if (req.file) {
    console.warn('Photo upload skipped: Supabase storage is not configured.');
  }

  // Spec: initial incident status must be ACTIVE.
  // Normalize incident type: accident | fire | other (+ legacy map types).
  const rawType = String(type || 'other').trim().toLowerCase();
  const typeMap = {
    accident: 'accident', fire: 'fire', other: 'other', emergency: 'other',
    other_emergency: 'other', blocked: 'blocked', congestion: 'congestion',
    pothole: 'pothole', flooding: 'flooding', roadwork: 'roadwork', road_work: 'roadwork',
  };
  const normType = typeMap[rawType] || 'other';
  await dbRun(`INSERT INTO road_reports
    (id, user_id, type, description, latitude, longitude, address, photo_url, points, lifecycle_state, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', 'pending')`,
    [id, user_id, normType, description, latitude, longitude, address, photo_url, points]
  );

  const newReport = await dbGet('SELECT * FROM road_reports WHERE id = ?', [id]);

  await dbRun('INSERT INTO reward_events (id, user_id, report_id, points, reason) VALUES (?, ?, ?, ?, ?)',
    [uuidv4(), user_id, id, points || 0, 'report_submission']
  );
  await dbRun('UPDATE users SET points = points + ? WHERE id = ?', [points || 0, user_id]);

  // Spec: do NOT broadcast unverified incidents as confirmed emergencies.
  // The reporter's own app already inserts the returned report locally.
  io.emit('report_updated', newReport);

  // AI verification runs async: ACTIVE -> PENDING_VERIFICATION -> VERIFIED/HUMAN_REVIEW/REJECTED.
  analyzeIncident(newReport, (event, data) => io.emit(event, data))
    .catch(err => console.error("AI Pipeline failed:", err));

  io.emit('points_updated', { user_id, points });
  notifyAdmin();

  // Return the ACTIVE report immediately to the citizen's app
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

// DISPATCHES & ACCEPTANCE (atomic first-driver-wins)
app.post('/api/dispatches/:id/accept', async (req, res) => {
  const dispatchId = req.params.id;
  const { driver_id, vehicle_no, criticality: requestedCriticality } = req.body;

  const dispatch = await dbGet('SELECT * FROM dispatches WHERE id = ?', [dispatchId]);
  if (!dispatch) return res.status(404).json({ error: 'Dispatch not found' });
  if (dispatch.status !== 'available') {
    return res.status(409).json({ error: 'Dispatch already accepted by another driver' });
  }

  // Backend authorization: driver must exist, be approved, and be available.
  const driver = await dbGet('SELECT * FROM users WHERE driver_id = ? AND vehicle_no = ?', [driver_id, vehicle_no]);
  if (!driver || driver.role !== 'emergency_driver') {
    return res.status(403).json({ error: 'Only approved emergency drivers can accept' });
  }
  if (driver.approval_status !== 'approved') {
    return res.status(403).json({ error: 'Driver not approved', approval_status: driver.approval_status || 'pending' });
  }
  if (driver.availability && driver.availability !== 'AVAILABLE') {
    return res.status(409).json({ error: `Driver is ${driver.availability}, must be AVAILABLE` });
  }
  // Vehicle-type eligibility: ambulance jobs need ambulance drivers, fire jobs need fire drivers.
  if (driver.vehicle_type && dispatch.required_vehicle && driver.vehicle_type !== dispatch.required_vehicle) {
    return res.status(403).json({ error: `This request needs a ${dispatch.required_vehicle} vehicle` });
  }

  // Atomic claim: only one driver can move available -> accepted.
  await dbRun("UPDATE dispatches SET status = 'accepted', driver_id = ? WHERE id = ? AND status = 'available'",
    [driver.id, dispatchId]
  );

  const verify = await dbGet("SELECT status, driver_id FROM dispatches WHERE id = ?", [dispatchId]);
  if (verify.driver_id !== driver.id) {
    return res.status(409).json({ error: 'Dispatch already accepted by another driver' });
  }

  // Driver becomes BUSY; incident moves DISPATCHED -> ACCEPTED.
  await dbRun('UPDATE users SET availability = ? WHERE id = ?', ['BUSY', driver.id]);
  await dbRun("UPDATE road_reports SET lifecycle_state = 'ACCEPTED', status = 'verified' WHERE id = ?", [dispatch.report_id]);

  // Enrich the trip with real evidence so admin monitoring never shows blank rows.
  // Criticality comes from the stored AI severity, distance from the driver's last
  // known position to the incident, confidence from the AI analysis. Nothing is invented:
  // if the backend has no evidence for a field, the field stays NULL.
  const incident = await dbGet('SELECT * FROM road_reports WHERE id = ?', [dispatch.report_id]);
  const analysis = await dbGet(
    'SELECT severity, confidence FROM ai_analyses WHERE report_id = ? ORDER BY created_at DESC LIMIT 1',
    [dispatch.report_id]
  );
  // Criticality priority: the accepting driver's choice, then the stored AI severity,
  // then 'high' — every dispatch reaching this point is a human/AI verified emergency.
  const SEVERITY_TO_CRITICALITY = { LOW: 'low', MEDIUM: 'medium', HIGH: 'high', CRITICAL: 'critical' };
  const REQUESTED_TO_CRITICALITY = { normal: 'low', low: 'low', medium: 'medium', high: 'high', critical: 'critical' };
  const criticality =
    REQUESTED_TO_CRITICALITY[String(requestedCriticality || '').toLowerCase()] ||
    SEVERITY_TO_CRITICALITY[String(analysis?.severity || '').toUpperCase()] ||
    'high';
  const confidence = analysis && analysis.confidence != null
    ? Math.round(Number(analysis.confidence) * 100)
    : null;
  let distance = null;
  if (
    driver.current_latitude != null && driver.current_longitude != null &&
    incident && incident.latitude != null && incident.longitude != null
  ) {
    distance = Number(haversineKm(
      Number(driver.current_latitude), Number(driver.current_longitude),
      Number(incident.latitude), Number(incident.longitude)
    ).toFixed(2));
  }

  const tripId = uuidv4();
  await dbRun(`INSERT INTO emergency_trips
    (id, dispatch_id, driver_id, vehicle_no, report_id, status, criticality, confidence, distance)
    VALUES (?, ?, ?, ?, ?, 'en_route', ?, ?, ?)`,
    [tripId, dispatchId, driver.id, vehicle_no, dispatch.report_id, criticality, confidence, distance]
  );

  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [tripId]);

  io.emit('dispatch.accepted', { dispatchId, driver_id: driver.id });
  io.emit('trip.started', trip);
  if (incident) io.emit('report_updated', incident);
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

  // Accept human driver codes: resolve to users.id UUID for FK integrity.
  let driverUuid = driver_id;
  if (driver_id) {
    const driver = await resolveDriver(driver_id);
    if (driver) driverUuid = driver.id;
  }

  await dbRun(`INSERT INTO emergency_trips
    (id, driver_id, report_id, criticality, travel_time, preemptions, confidence, distance, vehicle_no)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, driverUuid, report_id, criticality, travel_time, preemptions, confidence, distance, vehicle_no]
  );
  
  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [id]);
  io.emit('trip_completed', trip);
  notifyAdmin();
  res.json(trip);
});

// Driver live GPS: updates driver row + trip, promotes ACCEPTED -> EN_ROUTE.
app.patch('/api/driver/location', authMiddleware, requireApprovedDriver, async (req, res) => {
  const { latitude, longitude, availability } = req.body;
  if (latitude == null || longitude == null) return res.status(400).json({ error: 'latitude/longitude required' });
  await dbRun('UPDATE users SET current_latitude = ?, current_longitude = ?, last_location_update = CURRENT_TIMESTAMP WHERE id = ?', [latitude, longitude, req.user.id]);
  if (availability && ['OFFLINE', 'AVAILABLE', 'BUSY'].includes(availability)) {
    await dbRun('UPDATE users SET availability = ? WHERE id = ?', [availability, req.user.id]);
  }
  const driver = await dbGet('SELECT id, driver_id, vehicle_no, vehicle_type, availability, current_latitude, current_longitude FROM users WHERE id = ?', [req.user.id]);
  io.emit('driver.location_updated', { ...driver, timestamp: new Date().toISOString() });
  res.json(driver);
});

// Live GPS location broadcast during an active response
app.post('/api/trips/:id/location', async (req, res) => {
  const { latitude, longitude, driver_id } = req.body;
  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [req.params.id]);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  // Ownership: only the assigned driver updates their active emergency (UUID or human code).
  if (driver_id && trip.driver_id) {
    const sender = await resolveDriver(driver_id);
    const senderId = sender ? sender.id : driver_id;
    if (senderId !== trip.driver_id) {
      return res.status(403).json({ error: 'Only the assigned driver can update this trip' });
    }
  }
  if (latitude != null && longitude != null && trip.driver_id) {
    await dbRun('UPDATE users SET current_latitude = ?, current_longitude = ?, last_location_update = CURRENT_TIMESTAMP WHERE id = ?', [latitude, longitude, trip.driver_id]);
  }
  // First movement promotes ACCEPTED -> EN_ROUTE.
  if (trip.report_id) {
    const incident = await dbGet('SELECT lifecycle_state FROM road_reports WHERE id = ?', [trip.report_id]);
    if (incident && incident.lifecycle_state === 'ACCEPTED') {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'EN_ROUTE', status = 'verified' WHERE id = ?", [trip.report_id]);
      const updated = await dbGet('SELECT * FROM road_reports WHERE id = ?', [trip.report_id]);
      io.emit('report_updated', updated);
    }
  }
  io.emit('trip.location_updated', { tripId: req.params.id, latitude, longitude, driver_id: trip.driver_id });
  res.json({ ok: true });
});

// Trip state transitions: en_route -> arrived -> completed (RESOLVED)
app.patch('/api/trips/:id/status', async (req, res) => {
  const { status, driver_id } = req.body;
  const allowed = ['en_route', 'arrived', 'completed'];
  if (!allowed.includes(status)) return res.status(400).json({ error: 'Invalid status' });

  const trip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [req.params.id]);
  if (!trip) return res.status(404).json({ error: 'Trip not found' });
  // Ownership: only the assigned driver updates their active emergency (UUID or human code).
  if (driver_id && trip.driver_id) {
    const sender = await resolveDriver(driver_id);
    const senderId = sender ? sender.id : driver_id;
    if (senderId !== trip.driver_id) {
      return res.status(403).json({ error: 'Only the assigned driver can update this trip' });
    }
  }

  await dbRun("UPDATE emergency_trips SET status = ? WHERE id = ?", [status, req.params.id]);
  const updatedTrip = await dbGet('SELECT * FROM emergency_trips WHERE id = ?', [req.params.id]);

  if (status === 'arrived') {
    if (updatedTrip.report_id) {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'ARRIVED', status = 'verified' WHERE id = ?", [updatedTrip.report_id]);
      const incident = await dbGet('SELECT * FROM road_reports WHERE id = ?', [updatedTrip.report_id]);
      if (incident) io.emit('report_updated', incident);
    }
    io.emit('trip.arrived', updatedTrip);
  } else if (status === 'completed') {
    if (updatedTrip.dispatch_id) {
      await dbRun("UPDATE dispatches SET status = 'completed' WHERE id = ?", [updatedTrip.dispatch_id]);
    }
    if (updatedTrip.report_id) {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'RESOLVED', status = 'resolved' WHERE id = ?", [updatedTrip.report_id]);
      const incident = await dbGet('SELECT * FROM road_reports WHERE id = ?', [updatedTrip.report_id]);
      if (incident) io.emit('report_updated', incident);
    }
    if (updatedTrip.driver_id) {
      await dbRun("UPDATE users SET availability = 'AVAILABLE' WHERE id = ?", [updatedTrip.driver_id]);
    }
    io.emit('trip.completed', updatedTrip);
  } else {
    io.emit('trip.started', updatedTrip);
  }

  notifyAdmin();
  res.json(updatedTrip);
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

// Driver availability (admin-managed vehicle availability)
app.patch('/api/users/:id/availability', authMiddleware, requireRole('admin'), async (req, res) => {
  const { availability } = req.body;
  if (!['OFFLINE','AVAILABLE','BUSY'].includes(availability)) return res.status(400).json({ error: 'Invalid availability' });
  await dbRun('UPDATE users SET availability = ? WHERE id = ?', [availability, req.params.id]);
  const user = await dbGet('SELECT id, availability, driver_id, vehicle_no FROM users WHERE id = ?', [req.params.id]);
  io.emit('driver.availability_updated', user);
  notifyAdmin();
  res.json(user);
});

// GET available dispatches (Signal-Aid loads on app start)
app.get('/api/dispatches', async (req, res) => {
  const dispatches = await dbAll(`
    SELECT d.*, r.latitude, r.longitude, r.type, r.description, r.address, r.photo_url
    FROM dispatches d
    JOIN road_reports r ON d.report_id = r.id
    WHERE d.status = 'available'
    ORDER BY d.created_at DESC
  `);
  res.json(dispatches);
});

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// GET nearby available dispatches for an approved driver.
app.get('/api/dispatches/nearby', async (req, res) => {
  const { lat, lon, vehicle_type, radiusKm } = req.query;
  const radius = Number(radiusKm) || 25;
  const all = await dbAll(`
    SELECT d.*, r.latitude, r.longitude, r.type, r.description, r.address, r.photo_url
    FROM dispatches d
    JOIN road_reports r ON d.report_id = r.id
    WHERE d.status = 'available'
    ORDER BY d.created_at DESC
  `);
  const filtered = all
    .filter((d) => !vehicle_type || d.required_vehicle === vehicle_type)
    .map((d) => {
      let distanceKm = null;
      if (lat != null && lon != null && d.latitude != null && d.longitude != null) {
        distanceKm = Number(haversineKm(Number(lat), Number(lon), Number(d.latitude), Number(d.longitude)).toFixed(2));
      }
      return { ...d, distanceKm };
    })
    .filter((d) => d.distanceKm == null || d.distanceKm <= radius)
    .sort((a, b) => (a.distanceKm ?? 9999) - (b.distanceKm ?? 9999));
  res.json(filtered);
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

function toMs(createdAt) {
  const d = new Date(createdAt);
  return d.getTime();
}

async function runExpiryEngine() {
  // Step 1: Move old ACTIVE reports to RECHECK
  const activeReports = await dbAll("SELECT id, type, created_at FROM road_reports WHERE lifecycle_state = 'ACTIVE' OR lifecycle_state = 'VERIFIED'");
  const now = Date.now();
  const RECHECK_TTL_HOURS = { accident: 2, fire: 1, congestion: 3, blocked: 4, flooding: 6, pothole: 48, default: 4 };
  
  for (const r of activeReports) {
    const ttl = RECHECK_TTL_HOURS[r.type] || RECHECK_TTL_HOURS.default;
    const ageHrs = (now - toMs(r.created_at)) / 3600000;
    if (ageHrs >= ttl) {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'RECHECK', status = 'pending' WHERE id = ?", [r.id]);
      console.log(`[ClearPath] Recheck flagged: ${r.type} (${ageHrs.toFixed(1)}h old)`);
    }
  }

  // Step 2: Auto-resolve old RECHECK reports (after 30 more min)
  const recheckReports = await dbAll("SELECT id, type, created_at FROM road_reports WHERE lifecycle_state = 'RECHECK'");
  for (const r of recheckReports) {
    const ageHrs = (now - toMs(r.created_at)) / 3600000;
    const ttl = (RECHECK_TTL_HOURS[r.type] || RECHECK_TTL_HOURS.default) + 0.5;
    if (ageHrs >= ttl) {
      await dbRun("UPDATE road_reports SET lifecycle_state = 'RESOLVED', status = 'resolved' WHERE id = ?", [r.id]);
      const updated = await dbGet('SELECT * FROM road_reports WHERE id = ?', [r.id]);
      io.emit('report_updated', updated);
      console.log(`[ClearPath] Auto-resolved: ${r.type}`);
    }
  }
}

// The expiry sweep must never take the server down: a schema hiccup here would
// otherwise become an unhandled rejection and kill the process on boot.
const runExpiryEngineSafely = () =>
  runExpiryEngine().catch((err) => console.error('[ClearPath] Expiry engine failed:', err.message || err));
initPromise.then(() => { runExpiryEngineSafely(); setInterval(runExpiryEngineSafely, 10 * 60 * 1000); });

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

