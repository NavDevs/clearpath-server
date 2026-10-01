# ClearPath Command Server - API Reference

**Base URL:** `https://clearpath-server.onrender.com`  
**WebSocket:** `wss://clearpath-server.onrender.com` (Socket.IO)

---

## Authentication

### POST /api/auth/register
Register a new citizen user.

**Request:**
```json
{
  "phone": "9876543210",
  "name": "John Doe",
  "password": "securePass123"
}
```

**Response (200):**
```json
{
  "user": {
    "id": "uuid",
    "role": "citizen",
    "phone": "9876543210",
    "name": "John Doe",
    "points": 0,
    "created_at": "2026-09-30T..."
  }
}
```

**Errors:** 400 (phone exists), 400 (validation)

---

### POST /api/auth/login
Login with phone and password.

**Request:**
```json
{
  "phone": "9876543210",
  "password": "securePass123"
}
```

**Response (200):**
```json
{
  "user": { "id", "role", "phone", "name", "points", "created_at" }
}
```

**Errors:** 404 (not found), 401 (wrong password)

---

### POST /api/auth/signalaid
Emergency driver login/register with driver ID and vehicle number.

**Request:**
```json
{
  "driver_id": "AMB-001",
  "vehicle_no": "MH12AB1234"
}
```

**Response (200):**
```json
{
  "user": { "id", "role": "emergency_driver", "driver_id", "vehicle_no", "created_at" }
}
```

---

## Reports

### GET /api/reports
Get all road reports (latest first).

**Response (200):** Array of report objects

**Report Object:**
```json
{
  "id": "uuid",
  "user_id": "uuid",
  "type": "accident|congestion|blocked|flooding|pothole",
  "description": "string",
  "status": "pending|resolved|rejected",
  "lifecycle_state": "ACTIVE|DISPATCHED|ACCEPTED|EN_ROUTE|ARRIVED|RESOLVED|REJECTED",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "address": "MG Road, Bangalore",
  "photo_url": "https://supabase.co/storage/v1/object/public/report-photos/...",
  "points": 20,
  "created_at": "2026-09-30T..."
}
```

---

### POST /api/reports
Submit a new road report with optional photo.

**Content-Type:** `multipart/form-data`

**Fields:**
| Field | Type | Required |
|-------|------|----------|
| user_id | string | Yes |
| type | string | Yes (accident/congestion/blocked/flooding/pothole) |
| description | string | No |
| latitude | number | Yes |
| longitude | number | Yes |
| address | string | No |
| points | number | No (default from type) |
| photo | file | No (image only, max 5MB) |

**Response (200):** Report object with `lifecycle_state: "ACTIVE"` (immediately followed by `DISPATCHED` for accident/fire)

**Errors:** 400 (invalid file type), 400 (file too large >5MB)

---

### POST /api/reports/:id/status
Update report status (admin only).

**Request:**
```json
{ "status": "resolved" }
```

**Status values:** `pending`, `resolved`, `rejected`

---

## Dispatches (Emergency Jobs)

### GET /api/dispatches
Get all available emergency dispatches (for Signal-Aid drivers).

**Response (200):** Array of dispatch objects with joined report data

**Dispatch Object:**
```json
{
  "id": "uuid",
  "report_id": "uuid",
  "required_vehicle": "ambulance|fire",
  "status": "available|accepted|completed|cancelled",
  "driver_id": "uuid|null",
  "created_at": "2026-09-30T...",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "type": "ACCIDENT",
  "description": "Car crash",
  "address": "MG Road"
}
```

---

### POST /api/dispatches/:id/accept
Accept an emergency dispatch (driver only).

**Request:**
```json
{
  "driver_id": "uuid",
  "vehicle_no": "MH12AB1234"
}
```

**Response (200):** Created trip object

**Errors:** 404 (not found), 409 (already accepted)

---

## Trips

### GET /api/trips/:driver_id
Get trip history for a driver.

---

### GET /api/trips
Get all trips (admin).

---

### GET /api/trips/active/:driver_id
Get active (in-progress) trip for driver restart recovery.

---

### POST /api/trips
Create a trip (legacy/manual).

---

### POST /api/trips/:id/location
Update live GPS location during active response.

**Request:**
```json
{
  "latitude": 12.9716,
  "longitude": 77.5946
}
```

---

### PATCH /api/trips/:id/status
Update trip status: `en_route` → `arrived` → `completed`

**Request:**
```json
{
  "status": "arrived",
  "driver_id": "uuid"
}
```

---

## Routing

### GET /api/route
Get route, ETA, and signal count between two points.

**Query Params:**
- `fromLat`, `fromLon`, `toLat`, `toLon` (required)

**Response (200):**
```json
{
  "distanceKm": 3.2,
  "durationMin": 7,
  "signalCount": 5,
  "fallback": false
}
```

---

## Leaderboard

### GET /api/leaderboard
Top 50 citizens by points.

---

## Users (Admin)

### GET /api/users
All users with roles.

---

### PATCH /api/users/:id/availability
Update driver availability.

**Request:**
```json
{ "availability": "AVAILABLE" }
```

**Values:** `OFFLINE`, `AVAILABLE`, `BUSY`

---

## Health Check

### GET /health
```json
{ "status": "ok", "name": "ClearPath Command Server", "uptime": 12345 }
```

---

## Socket.IO Events

### Client → Server
- Connection only (no auth required for MVP)

### Server → Client
| Event | Payload | Description |
|-------|---------|-------------|
| `new_incident` | Report object | New active report for Roadly map |
| `report_updated` | Report object | Report status/lifecycle changed |
| `dispatch.created` | Dispatch object | New emergency job for Signal-Aid |
| `dispatch.accepted` | `{dispatchId, driver_id}` | Job taken by another driver |
| `trip.started` | Trip object | Trip created after acceptance |
| `trip.location_updated` | `{tripId, latitude, longitude}` | Live GPS from driver |
| `trip.arrived` | Trip object | Driver marked arrived |
| `trip.completed` | Trip object | Trip finished |
| `points_updated` | `{user_id, points}` | Leaderboard update |
| `driver.availability_updated` | `{id, availability, driver_id, vehicle_no}` | Driver status change |
| `admin_refresh` | — | Admin dashboard refresh trigger |

---

## Error Format
```json
{ "error": "Human-readable error message" }
```

---

## Environment Variables Required
| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | Neon PostgreSQL connection string |
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service role key |
| `CORS_ORIGIN` | Allowed frontend origin (e.g., `https://your-app.com`) |