const { generateStructuredJSON, generateWithImage } = require('../services/geminiService');
const { noKeyResponse, triageTextFallback } = require('../services/keylessFallback');

const triageSchema = {
  type: 'object',
  properties: {
    triage_level: { type: 'string', enum: ['RED', 'YELLOW', 'GREEN'] },
    condition_summary: { type: 'string' },
    recommended_first_aid_steps: { type: 'array', items: { type: 'string' } },
    required_medical_supplies: { type: 'array', items: { type: 'string' } },
  },
  required: ['triage_level', 'condition_summary', 'recommended_first_aid_steps', 'required_medical_supplies'],
};

async function triagePatient(req, res) {
  try {
    const { text } = req.body;
    let imageBase64 = null;
    let mimeType = 'image/jpeg';

    if (req.file) {
      imageBase64 = req.file.buffer.toString('base64');
      mimeType = req.file.mimetype;
    }

    if (!text && !imageBase64) {
      return res.status(400).json({ error: 'Provide a text description or upload a medical image.' });
    }

    if (noKeyResponse()) {
      if (imageBase64) {
        return res.status(502).json({
          error: 'Medical image analysis requires a GEMINI_API_KEY.',
          detail: 'Configure your key in .env, or test with a text description using key-free demo mode.',
        });
      }
      return res.json(triageTextFallback(text));
    }

    const prompt = `You are an AI medical triage assistant for emergency disaster response.
Evaluate the following patient information and determine the appropriate triage level.

${text ? `Patient description:\n"""${text}"""` : 'No text description provided. Analyze the attached medical image.'}

Use this triage system:
- RED (Critical/Immediate): Life-threatening conditions requiring immediate intervention. E.g., heavy uncontrolled bleeding, difficulty breathing, unconsciousness, severe burns.
- YELLOW (Delayed/Urgent): Serious but not immediately life-threatening. E.g., broken bones, moderate bleeding, moderate burns.
- GREEN (Minor): Walking wounded, minor injuries. E.g., small cuts, bruises, minor sprains.

Return structured JSON with:
- triage_level: "RED", "YELLOW", or "GREEN"
- condition_summary: brief clinical assessment
- recommended_first_aid_steps: ordered array of immediate first aid actions
- required_medical_supplies: array of specific supplies needed`;

    let result;
    try {
      if (imageBase64) {
        result = await generateWithImage(prompt, imageBase64, mimeType);
      } else {
        result = await generateStructuredJSON(prompt, triageSchema);
      }
      result = JSON.parse(result);
    } catch (err) {
      console.warn('LLM triage unavailable, using offline heuristics:', err.message);
      if (imageBase64) {
        return res.status(502).json({
          error: 'Medical image analysis is unavailable right now.',
          detail: 'Image triage requires a working Gemini vision backend, which is offline. Use a text description instead.',
        });
      }
      result = triageTextFallback(text);
    }
    res.json(result);
  } catch (err) {
    console.error('Triage error:', err);
    res.status(500).json({ error: 'Triage analysis failed.', detail: err.message });
  }
}

module.exports = { triagePatient };
