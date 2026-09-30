# Simulation Notice

## Signal Preemption is SIMULATED

**This is a college project demonstration.** The signal preemption system shown in Signal-Aid is a **timer-based visual simulation** — it does NOT control real traffic lights.

---

## What Is Simulated

| Component | Reality |
|-----------|---------|
| Traffic light control | ❌ Not connected to any real traffic system |
| Signal preemption timing | ✅ Simulated: ~20-30 second intervals per intersection |
| Intersection "cleared" status | ✅ Visual animation only |
| GPS-based signal triggering | ✅ Based on elapsed time + distance estimate |
| ETA calculation | ✅ OSRM routing (real) + signal count estimate |

---

## How the Simulation Works

1. **Route Calculation:** OSRM returns real distance/duration
2. **Signal Count Estimate:** `distanceKm × 1.5` (urban average)
3. **Intersection List:** Generated from route steps (or evenly spaced)
4. **Timer:** Every ~20-30 seconds, next intersection shows "PREEMPTED"
5. **After 8 seconds:** Shows "CLEARED" (passed)
6. **Visual Only:** No external hardware/software integration

---

## Why This Matters

- **No safety risk:** Emergency vehicles must still obey real traffic laws
- **Demo purposes:** Shows *concept* of signal priority for emergency response
- **Production would need:** Integration with city traffic management SCADA/ATCS systems

---

## What IS Real (Not Simulated)

| Feature | Implementation |
|---------|----------------|
| AI Image Analysis | Groq Llama 3.2 Vision (real API) |
| Dispatch Creation | Real DB transactions, atomic acceptance |
| Live GPS Tracking | Real device GPS → backend every 5s |
| Trip History | Persisted in Neon PostgreSQL |
| User Authentication | bcrypt hashed passwords |
| Photo Storage | Supabase Storage (real CDN) |
| Routing/ETA | OSRM (real open-source routing) |

---

## Disclaimer for Evaluators

> **This project demonstrates a complete emergency response pipeline from citizen report → AI verification → driver dispatch → live tracking → completion.**
>
> The **signal preemption component is a UI simulation** to visualize the *concept* of emergency vehicle priority at intersections. In a production deployment, this would require integration with municipal traffic control systems (e.g., SCATS, SCOOT, or local ATCS via standardized protocols like NTCIP).
>
> All other components (AI analysis, dispatch logic, GPS tracking, database persistence, real-time sockets) are fully functional and production-ready.