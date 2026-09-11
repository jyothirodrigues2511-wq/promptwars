const { generateWithImage } = require('../services/geminiService');
const { noKeyResponse, droneFallback } = require('../services/keylessFallback');

const droneSchema = {
  type: 'object',
  properties: {
    damage_type: {
      type: 'string',
      enum: ['collapsed_structure', 'flooding', 'fire', 'road_blockage', 'bridge_damage', 'none'],
    },
    severity_score: { type: 'number', minimum: 1, maximum: 10 },
    passable_routes: { type: 'array', items: { type: 'string' } },
    survivors_detected: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['damage_type', 'severity_score', 'passable_routes', 'survivors_detected', 'summary'],
};

async function analyzeDroneImage(req, res) {
  try {
    let imageBase64;
    let mimeType = 'image/jpeg';

    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
      mimeType = req.file.mimetype;
    } else if (req.body.image_url) {
      try {
        const response = await fetch(req.body.image_url);
        const buffer = Buffer.from(await response.arrayBuffer());
        imageBase64 = buffer.toString('base64');
        mimeType = response.headers.get('content-type') || 'image/jpeg';
      } catch (err) {
        console.warn('Image URL fetch failed, falling back to offline analysis:', err.message);
        return res.json(droneFallback());
      }
    } else {
      return res.status(400).json({ error: 'Upload an image file or provide an image_url.' });
    }

    if (noKeyResponse()) {
      return res.json(droneFallback());
    }

    const prompt = `You are an AI drone/satellite image analyst for disaster relief operations.
Examine this aerial or satellite image carefully.

Analyze for:
1. Any structural damage (collapsed buildings, bridges, roads)
2. Flooding or water damage
3. Signs of survivors (people on rooftops, waving, trapped)
4. Passable routes for emergency vehicles
5. Overall severity of the scene

Return structured JSON with:
- damage_type: one of "collapsed_structure", "flooding", "fire", "road_blockage", "bridge_damage", "none"
- severity_score: integer 1-10 (10 = catastrophic)
- passable_routes: array of strings describing any visible routes that appear usable
- survivors_detected: boolean
- summary: brief situational overview for dispatchers`;

    let result;
    try {
      result = JSON.parse(await generateWithImage(prompt, imageBase64, mimeType));
    } catch (err) {
      console.warn('LLM drone analysis unavailable, using offline fallback:', err.message);
      result = droneFallback();
    }
    res.json(result);
  } catch (err) {
    console.error('Drone analysis error:', err);
    res.status(500).json({ error: 'Drone image analysis failed.', detail: err.message });
  }
}

module.exports = { analyzeDroneImage };
