const { generateStructuredJSON } = require('../services/geminiService');
const { noKeyResponse, scamFallback } = require('../services/keylessFallback');

const scamSchema = {
  type: 'object',
  properties: {
    confidence_score: {
      type: 'number',
      minimum: 0,
      maximum: 100,
      description: 'SCAM LIKELIHOOD 0-100. 0 = definitely genuine/critical real report, 100 = definitely a fake/duplicate/scam.',
    },
    is_flagged_as_scam: { type: 'boolean', description: 'true when confidence_score >= 70, false otherwise. Real urgent reports (e.g. "there is a flood") must be flagged false.' },
    reasoning: { type: 'string' },
    risk_factors: { type: 'array', items: { type: 'string' } },
  },
  required: ['confidence_score', 'is_flagged_as_scam', 'reasoning', 'risk_factors'],
};

async function verifyReport(req, res) {
  try {
    const { text, reports } = req.body;
    const reportsToAnalyze = reports || (text ? [{ text }] : []);

    if (reportsToAnalyze.length === 0) {
      return res.status(400).json({ error: 'Provide text or an array of reports to analyze.' });
    }

    if (noKeyResponse()) {
      return res.json(scamFallback(text, reportsToAnalyze));
    }

    const serialized = reportsToAnalyze
      .map((r, i) => `Report ${i + 1}:\n${r.text || JSON.stringify(r)}`)
      .join('\n\n');

    const prompt = `You are an AI fraud and sybil detection system for a disaster relief platform.
Analyze the following disaster report(s) for signs of inauthenticity, scams, or resource hijacking.

Reports to analyze:
"""
${serialized}
"""

FIRST PRINCIPLE: Real survivors write short, urgent, specific messages ("there is a flood", "my house is underwater",
"building collapsed near the bridge", "we need water"). These are ALWAYS genuine regardless of brevity.
Only flag when there is CONCRETE evidence of inauthenticity.

Look for these red flags (high confidence scam only):
1. Recycled or generic language patterns typical of bot-generated requests
2. Duplicate or near-duplicate content across multiple submissions
3. Requests to extract maximum resources with vague or inconsistent details (e.g. bulk quantity lists, "500 tents, unlimited supplies")
4. Missing geographic/situational detail combined with inflated quantities
5. Medically implausible descriptions
6. Excessive urgency words with zero concrete information

Return structured JSON with:
- confidence_score: SCAM LIKELIHOOD 0-100 (0 = definitely genuine, 100 = definitely fake/scam).
  Simple urgent real reports like "there is a flood" must be LOW (< 20).
- is_flagged_as_scam: boolean (true ONLY if confidence_score >= 70)
- reasoning: detailed explanation of your assessment
- risk_factors: array of specific concerns identified (empty array for genuine reports)`;

    let result;
    try {
      result = JSON.parse(await generateStructuredJSON(prompt, scamSchema));
    } catch (err) {
      console.warn('LLM scam filter unavailable, using offline heuristics:', err.message);
      result = scamFallback(text, reportsToAnalyze);
    }
    res.json(result);
  } catch (err) {
    console.error('Scam filter error:', err);
    res.status(500).json({ error: 'Scam verification failed.', detail: err.message });
  }
}

module.exports = { verifyReport };
