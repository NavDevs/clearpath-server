const { dbRun, dbGet } = require('./database');
const { randomUUID: uuidv4 } = require('crypto');

const GROQ_API_KEY = process.env.GROQ_API_KEY;

/**
 * Analyzes a newly submitted road report using Groq AI (Llama 3.2 Vision),
 * and then passes it to the decision engine.
 */
async function analyzeIncident(report, broadcastCallback) {
  try {
    console.log(`[AI Engine] Starting analysis for report ${report.id} (${report.type})...`);

    // 1. Mark status as AI_ANALYZED
    await dbRun("UPDATE road_reports SET lifecycle_state = 'AI_ANALYZED' WHERE id = ?", [report.id]);

    // 2. Prepare payload for Groq
    const prompt = `You are a smart city traffic AI. Analyze this road incident report.
    User categorized it as: ${report.type.toUpperCase()}
    User description: ${report.description || 'None provided'}
    
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
    }`;

    const content = [{ type: "text", text: prompt }];
    
    // Add image if available
    if (report.photo_url) {
      content.push({
        type: "image_url",
        image_url: { url: report.photo_url }
      });
    }

    const requestBody = {
      model: "llama-3.2-11b-vision-preview",
      messages: [
        {
          role: "user",
          content: content
        }
      ],
      response_format: { type: "json_object" },
      temperature: 0.1
    };

    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GROQ_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody)
    });

    if (!response.ok) {
      const errText = await response.text();
      throw new Error(`Groq API Error: ${response.status} - ${errText}`);
    }

    const jsonResponse = await response.json();
    const aiResult = JSON.parse(jsonResponse.choices[0].message.content);

    // 3. Save the AI Analysis separately (Golden Rule #9)
    const analysisId = uuidv4();
    await dbRun(`INSERT INTO ai_analyses 
      (id, report_id, detected_type, severity, confidence, people_injured, road_blocked, emergency_recommended, raw_reasoning)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        analysisId, 
        report.id, 
        aiResult.detectedType || report.type, 
        aiResult.severity || 'LOW', 
        aiResult.confidence || 0.5, 
        aiResult.peoplePossiblyInjured || false, 
        aiResult.roadBlocked || false, 
        aiResult.emergencyResponseRecommended || false, 
        aiResult.reason || 'No reasoning provided.'
      ]
    );

    console.log(`[AI Engine] Analysis complete for ${report.id}. Confidence: ${aiResult.confidence}`);

    // 4. Pass to the Decision/Verification Engine (Phase 5)
    await runDecisionEngine(report, aiResult, broadcastCallback);

  } catch (error) {
    console.error(`[AI Engine] Failed to analyze report ${report.id}:`, error);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'NEEDS_REVIEW' WHERE id = ?", [report.id]);
  }
}

/**
 * Validates the AI results and determines if an emergency dispatch should be created.
 */
async function runDecisionEngine(report, aiResult, broadcastCallback) {
  console.log(`[Decision Engine] Evaluating report ${report.id}...`);

  const CONFIDENCE_THRESHOLD = 0.70; // 70% confidence required
  
  if (aiResult.confidence < CONFIDENCE_THRESHOLD) {
    console.log(`[Decision Engine] Low confidence (${aiResult.confidence}). Flagging for review.`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'NEEDS_REVIEW' WHERE id = ?", [report.id]);
    broadcastCallback('report_updated', { ...report, lifecycle_state: 'NEEDS_REVIEW' });
    return;
  }

  // Determine Dispatch Type based on AI Category
  let requiredVehicle = null;
  if (aiResult.detectedType === 'ACCIDENT') requiredVehicle = 'ambulance';
  if (aiResult.detectedType === 'FIRE') requiredVehicle = 'fire';

  if (requiredVehicle) {
    console.log(`[Decision Engine] Verified Emergency! Creating ${requiredVehicle} dispatch.`);
    
    // Update report state
    await dbRun("UPDATE road_reports SET lifecycle_state = 'VERIFIED' WHERE id = ?", [report.id]);
    
    // Create Dispatch Offer (Phase 8 & 9)
    const dispatchId = uuidv4();
    await dbRun(`INSERT INTO dispatches (id, report_id, required_vehicle, status) VALUES (?, ?, ?, 'available')`, 
      [dispatchId, report.id, requiredVehicle]
    );

    const fullDispatch = await dbGet(`
      SELECT d.*, r.latitude, r.longitude, r.type, r.description 
      FROM dispatches d 
      JOIN road_reports r ON d.report_id = r.id 
      WHERE d.id = ?`, [dispatchId]
    );

    // Notify Roadly users that it's verified
    broadcastCallback('new_incident', { ...report, lifecycle_state: 'VERIFIED' });
    
    // Notify Signal-Aid drivers about the new job
    broadcastCallback('dispatch.created', fullDispatch);
  } else {
    console.log(`[Decision Engine] Standard Incident (No emergency dispatch). Marking active.`);
    await dbRun("UPDATE road_reports SET lifecycle_state = 'ACTIVE' WHERE id = ?", [report.id]);
    
    // Only notify Roadly users (Signal-Aid drivers don't care about potholes)
    broadcastCallback('new_incident', { ...report, lifecycle_state: 'ACTIVE' });
  }
}

module.exports = { analyzeIncident };
