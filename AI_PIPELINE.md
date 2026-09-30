# ClearPath AI Pipeline

**Model:** Groq Llama 3.2 11B Vision Preview  
**Endpoint:** `https://api.groq.com/openai/v1/chat/completions`  
**Trigger:** Async, after citizen submits report with photo

---

## Flow

```
Citizen submits report (POST /api/reports)
        │
        ▼
Backend inserts report with lifecycle_state = 'PENDING_AI'
        │
        ▼ (async, non-blocking)
analyzeIncident(report, broadcastCallback)
        │
        ▼
UPDATE road_reports SET lifecycle_state = 'AI_ANALYZED'
        │
        ▼
Groq API Call (multimodal: text + image)
        │
        ├─ Success ▼
        │    │
        │    ▼ Parse JSON response
        │    │
        │    ▼ INSERT INTO ai_analyses (audit trail)
        │    │
        │    ▼ runDecisionEngine(report, aiResult, broadcast)
        │         │
        │         ├─ confidence < 0.70 ──▶ NEEDS_REVIEW
        │         │
        │         ├─ ACCIDENT + confidence ≥ 0.70 ──▶ VERIFIED + ambulance dispatch
        │         │
        │         ├─ FIRE + confidence ≥ 0.70 ──▶ VERIFIED + fire dispatch
        │         │
        │         └─ Other types ──▶ ACTIVE (Roadly map only)
        │
        └─ Failure ▼
             │
             ▼ UPDATE road_reports SET lifecycle_state = 'NEEDS_REVIEW'
             ▼ Log error, no crash
```

---

## Groq Prompt

```text
You are a smart city traffic AI. Analyze this road incident report.
User categorized it as: {REPORT_TYPE}
User description: {DESCRIPTION}

Assess the situation based on the text and the provided image.
Output ONLY a raw JSON object with the following schema:
{
  "detectedType": "ACCIDENT | FIRE | BLOCKED | CONGESTION | POTHOLE | OTHER",
  "severity": "LOW | MEDIUM | HIGH | CRITICAL",
  "confidence": 0.0 to 1.0,
  "peoplePossiblyInjured": boolean,
  "vehiclesInvolved": boolean,
  "roadBlocked": boolean,
  "emergencyResponseRecommended": boolean,
  "reason": "Brief 1-sentence explanation of your assessment"
}
```

---

## Response Schema (Strict JSON)

| Field | Type | Values |
|-------|------|--------|
| detectedType | string | ACCIDENT, FIRE, BLOCKED, CONGESTION, POTHOLE, OTHER |
| severity | string | LOW, MEDIUM, HIGH, CRITICAL |
| confidence | number | 0.0 - 1.0 |
| peoplePossiblyInjured | boolean | |
| vehiclesInvolved | boolean | |
| roadBlocked | boolean | |
| emergencyResponseRecommended | boolean | |
| reason | string | 1 sentence |

---

## Decision Engine Rules

**Threshold:** `CONFIDENCE_THRESHOLD = 0.70` (70%)

| AI Detected Type | Confidence ≥ 70% | Confidence < 70% |
|------------------|------------------|------------------|
| ACCIDENT | VERIFIED + **ambulance dispatch** | NEEDS_REVIEW |
| FIRE | VERIFIED + **fire dispatch** | NEEDS_REVIEW |
| BLOCKED | ACTIVE (no dispatch) | NEEDS_REVIEW |
| CONGESTION | ACTIVE (no dispatch) | NEEDS_REVIEW |
| POTHOLE | ACTIVE (no dispatch) | NEEDS_REVIEW |
| OTHER | ACTIVE (no dispatch) | NEEDS_REVIEW |

**Key Principle:** Only ACCIDENT and FIRE create emergency dispatches. All other types stay on Roadly citizen map only.

---

## Error Handling

| Failure Point | Behavior |
|---------------|----------|
| Groq API timeout | Catch, log, set `NEEDS_REVIEW` |
| Groq API error (4xx/5xx) | Catch, log, set `NEEDS_REVIEW` |
| Invalid JSON response | Catch, log, set `NEEDS_REVIEW` |
| DB insert failed | Catch, log, set `NEEDS_REVIEW` |
| Network error | Catch, log, set `NEEDS_REVIEW` |

**Never crashes the request.** Citizen gets immediate response with `PENDING_AI`.

---

## Audit Trail

Every analysis stored in `ai_analyses` table:
- Links to `road_reports` via `report_id`
- Stores raw AI reasoning for review
- Immutable (no updates, only inserts)

---

## Configuration

| Env Var | Required | Default |
|---------|----------|---------|
| `GROQ_API_KEY` | Yes | — |
| `CONFIDENCE_THRESHOLD` | No | 0.70 |

---

## Testing AI Locally

```bash
# Test Groq API directly
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama-3.2-11b-vision-preview",
    "messages": [{
      "role": "user",
      "content": [
        {"type": "text", "text": "Analyze this accident photo..."},
        {"type": "image_url", "image_url": {"url": "https://..."}}
      ]
    }],
    "response_format": {"type": "json_object"},
    "temperature": 0.1
  }'
```