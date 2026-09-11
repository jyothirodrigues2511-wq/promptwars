const { generateStructuredJSON, generateWithAudio } = require('../services/geminiService');
const { noKeyResponse, translateFallback } = require('../services/keylessFallback');

const translateSchema = {
  type: 'object',
  properties: {
    is_invalid_input: {
      type: 'boolean',
      description: 'true when the message is NOT a real disaster report (gibberish like "kmmk", random keystrokes, single letters, punctuation-only). False for real reports.',
    },
    original_language: { type: 'string' },
    english_translation: { type: 'string' },
    key_intent: { type: 'string' },
    detected_urgency: { type: 'string', enum: ['critical', 'high', 'moderate', 'low'] },
    location: {
      type: 'object',
      properties: {
        latitude: { type: 'number' },
        longitude: { type: 'number' },
        address: { type: 'string' },
        confidence: { type: 'number', minimum: 0, maximum: 100 },
      },
      required: ['latitude', 'longitude', 'address', 'confidence'],
    },
  },
  required: ['is_invalid_input', 'original_language', 'english_translation', 'key_intent', 'detected_urgency', 'location'],
};

async function translateInput(req, res) {
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text field is required.' });
    }

    if (noKeyResponse()) {
      return res.json(translateFallback(text));
    }

    const prompt = `You are a GIS-enabled crisis communication translator for disaster relief operations.
The following message was received from a disaster zone, possibly in a local dialect, minority language, or informal speech.
Analyze it, translate it to English, determine the intent, assess urgency, and extract the incident location.

Original message:
"""${text}"""

GATE CHECK: If the message is NOT a real disaster report — e.g. gibberish ("kmmk"), a single letter,
random keystrokes, or punctuation only — set is_invalid_input to true, english_translation to "",
key_intent to "invalid input", detected_urgency to "low", and location to confidence 0 with 0 coordinates.
Real reports (even short urgent ones like "there is a flood") must set is_invalid_input to false.

Return a structured JSON with:
- is_invalid_input: boolean — true ONLY for non-reports (gibberish/nonsense)
- original_language: the detected language or dialect name
- english_translation: accurate English translation
- key_intent: the core request or report (e.g., "need medical help", "building collapsed", "requesting food")
- detected_urgency: one of "critical", "high", "moderate", "low"
- location: object with latitude, longitude, address (place/village/street as mentioned), and confidence (0-100).
  If the message contains no usable place reference, use confidence 0 with latitude/longitude as 0.
  If the place is clearly outside the greater Seattle area (e.g. "Bengaluru", "Dandeli"), still return its real coordinates.`;

    const result = await generateStructuredJSON(prompt, translateSchema);
    res.json(JSON.parse(result));
  } catch (err) {
    console.error('Translation error:', err);
    res.status(500).json({ error: 'Translation failed.', detail: err.message });
  }
}

module.exports = { translateInput, translateAudio };

async function translateAudio(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'Audio file is required.' });
    }

    if (noKeyResponse()) {
      return res.status(502).json({
        error: 'Audio transcription requires a GEMINI_API_KEY.',
        detail: 'Voice-note transcription is speech-to-text — not available in key-free demo mode. Configure your key or use a text report instead.',
      });
    }

    const audioBase64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'audio/webm';

    const prompt = `You are a crisis communication translator for disaster relief operations.
Transcribe the attached voice note, which may be spoken in a local dialect, minority language, or informal speech.
Translate it to English, determine the intent, and assess urgency.

Return a structured JSON with:
- original_language: the detected language or dialect name
- english_translation: accurate English translation
- key_intent: the core request or report (e.g., "need medical help", "building collapsed", "requesting food")
- detected_urgency: one of "critical", "high", "moderate", "low"`;

    const result = await generateWithAudio(prompt, audioBase64, mimeType);
    res.json(JSON.parse(result));
  } catch (err) {
    console.error('Audio translation error:', err);
    res.status(500).json({ error: 'Audio translation failed.', detail: err.message });
  }
}
