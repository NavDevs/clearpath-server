# ClearPath Socket.IO Events

**Server:** `wss://clearpath-server.onrender.com`  
**Transport:** WebSocket (Socket.IO v4)  
**Auth:** None (MVP - open for demo)

---

## Connection

```javascript
const socket = io('https://clearpath-server.onrender.com', {
  transports: ['websocket']
});
```

---

## Server → Client Events

### `new_incident`
**Trigger:** Report submitted (ACTIVE) or incident dispatched  
**Audience:** Roadly citizens (all connected)  
**Payload:** Full report object with `lifecycle_state`

```json
{
  "id": "uuid",
  "user_id": "uuid",
  "type": "accident",
  "description": "Car crash",
  "status": "pending",
  "lifecycle_state": "ACTIVE",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "address": "MG Road",
  "photo_url": "https://...",
  "points": 20,
  "created_at": "2026-09-30T..."
}
```

---

### `report_updated`
**Trigger:** TTL auto-expiry engine, dispatch/lifecycle change  
**Audience:** Roadly citizens, Admin dashboard  
**Payload:** Updated report object (partial or full)

```json
{
  "id": "uuid",
  "status": "resolved",
  "lifecycle_state": "RESOLVED"
}
```

---

### `report_deleted`
**Trigger:** Retention purge — right after an incident became RESOLVED (hard delete)  
**Audience:** Roadly citizens, Admin dashboard  
**Payload:**

```json
{
  "id": "uuid"
}
```

---

### `dispatch.created`
**Trigger:** Accident/fire report submitted (immediate dispatch)  
**Audience:** Signal-Aid drivers (all connected)  
**Payload:** Dispatch with joined report data

```json
{
  "id": "uuid",
  "report_id": "uuid",
  "required_vehicle": "ambulance",
  "status": "available",
  "driver_id": null,
  "created_at": "2026-09-30T...",
  "latitude": 12.9716,
  "longitude": 77.5946,
  "type": "ACCIDENT",
  "description": "Car crash",
  "address": "MG Road"
}
```

---

### `dispatch.accepted`
**Trigger:** Driver accepts dispatch via POST `/api/dispatches/:id/accept`  
**Audience:** All Signal-Aid drivers (to remove from their list)  
**Payload:**

```json
{
  "dispatchId": "uuid",
  "driver_id": "uuid"
}
```

---

### `trip.started`
**Trigger:** Dispatch accepted, emergency_trips row created  
**Audience:** Admin dashboard  
**Payload:** Full trip object

---

### `trip.location_updated`
**Trigger:** Driver app calls POST `/api/trips/:id/location` every 5s  
**Audience:** Admin dashboard (live tracking)  
**Payload:**

```json
{
  "tripId": "uuid",
  "latitude": 12.9716,
  "longitude": 77.5946
}
```

---

### `trip.arrived`
**Trigger:** Driver taps MARK ARRIVED (PATCH `/api/trips/:id/status`)  
**Audience:** Admin dashboard  
**Payload:** Trip object with `status: "arrived"`

---

### `trip.completed`
**Trigger:** Driver taps COMPLETE RESPONSE (PATCH status=completed)  
**Audience:** Admin dashboard  
**Payload:** Trip object with `status: "completed"`

---

### `points_updated`
**Trigger:** Citizen submits report, points awarded  
**Audience:** Roadly citizens (leaderboard refresh)  
**Payload:**

```json
{
  "user_id": "uuid",
  "points": 120
}
```

---

### `driver.availability_updated`
**Trigger:** Driver logs in/out, accepts/completes trip  
**Audience:** Admin dashboard  
**Payload:**

```json
{
  "id": "uuid",
  "availability": "BUSY",
  "driver_id": "AMB-001",
  "vehicle_no": "MH12AB1234"
}
```

---

### `admin_refresh`
**Trigger:** Any admin-relevant change (new user, report, trip, dispatch)  
**Audience:** Admin dashboard only  
**Payload:** None (trigger to refetch)

---

## Client → Server Events

**None required for MVP.** All actions via REST API. Socket is receive-only for real-time updates.

---

## Event Flow Diagrams

### Accident Report → Dispatch
```
Citizen POST /api/reports (type: accident/fire)
        │
        ▼ (immediate, same request)
Critical type → createDispatch
        │
        ├─▶ DISPATCHED + ambulance/fire dispatch
        │       │
        │       ▼ INSERT dispatches
        │       ▼ EMIT dispatch.created → Signal-Aid drivers
        │       ▼ EMIT new_incident → Roadly citizens
        │
        └─▶ ACTIVE (non-emergency)
                ▼
                EMIT new_incident (ACTIVE) → Roadly citizens
```

### Driver Accepts Dispatch
```
Driver POST /api/dispatches/:id/accept
        │
        ▼ Atomic check + UPDATE
        ├─▶ 409 if already taken
        │
        └─▶ 200 + INSERT emergency_trips
                │
                ▼ EMIT dispatch.accepted → Other drivers (remove from list)
                ▼ EMIT trip.started → Admin
```

### Live Response
```
Driver on Response Screen
        │
        ├─▶ GPS every 5s → POST /api/trips/:id/location
        │       ▼ EMIT trip.location_updated → Admin
        │
        ├─▶ MARK ARRIVED → PATCH /api/trips/:id/status
        │       ▼ EMIT trip.arrived → Admin
        │
        └─▶ COMPLETE RESPONSE → PATCH status=completed
                ▼ EMIT trip.completed → Admin
                ▼ UPDATE dispatches=completed
                ▼ Driver availability → AVAILABLE
```

---

## Reconnection

Socket.IO handles auto-reconnect. On reconnect:
- Roadly: `fetchReports()` called in provider init
- Signal-Aid: `fetchDispatches()` + `fetchActiveTrip()` called
- No missed events (REST fallback)

---

## Debugging

```javascript
socket.onConnect(() => console.log('Connected'));
socket.onDisconnect((reason) => console.log('Disconnected:', reason));
socket.onConnectError((err) => console.log('Connection error:', err));
```