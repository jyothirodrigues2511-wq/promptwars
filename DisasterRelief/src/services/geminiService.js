const { GoogleGenAI } = require('@google/genai');

const LLM_PROVIDER = (process.env.LLM_PROVIDER || '').toLowerCase() || null; // gemini | ollama | openai | none
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const OLLAMA_BASE_URL = (process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'qwen2.5';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || '').replace(/\/+$/, '');
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';

function activeProvider() {
  if (LLM_PROVIDER === 'gemini' || LLM_PROVIDER === 'ollama' || LLM_PROVIDER === 'openai') return LLM_PROVIDER;
  if (process.env.GEMINI_API_KEY) return 'gemini';
  return 'none';
}

function hasLLMBackend() {
  const provider = activeProvider();
  if (provider === 'gemini') return !!process.env.GEMINI_API_KEY;
  if (provider === 'ollama') return true;
  if (provider === 'openai') return !!process.env.OPENAI_API_KEY && !!process.env.OPENAI_BASE_URL;
  return false;
}

function providerLabel() {
  const provider = activeProvider();
  if (provider === 'gemini') return `gemini (${GEMINI_MODEL})`;
  if (provider === 'ollama') return `ollama (${OLLAMA_MODEL} @ ${OLLAMA_BASE_URL})`;
  if (provider === 'openai') return `openai-compatible (${OPENAI_MODEL})`;
  return 'none/keyless';
}

function buildChatUrl(provider) {
  return provider === 'ollama' ? `${OLLAMA_BASE_URL}/v1/chat/completions` : `${OPENAI_BASE_URL}/chat/completions`;
}

function chatModel(provider) {
  return provider === 'ollama' ? OLLAMA_MODEL : OPENAI_MODEL;
}

async function openAIChat({ provider, system, userContent, useJson = false, imageParts = null, timeoutMs = 180000 }) {
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });

  let content;
  if (imageParts && imageParts.length) {
    content = imageParts.map((part) => ({
      type: 'image_url',
      image_url: { url: `data:${part.mimeType};base64,${part.data}` },
    }));
    content.push({ type: 'text', text: userContent });
  } else {
    content = userContent;
  }
  messages.push({ role: 'user', content });

  const body = {
    model: chatModel(provider),
    messages,
    temperature: 0,
    stream: false,
  };
  if (useJson && provider === 'ollama') body.response_format = { type: 'json_object' };
  if (useJson && provider === 'openai') body.response_format = { type: 'json_object' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (provider === 'openai' && process.env.OPENAI_API_KEY) {
      headers.Authorization = `Bearer ${process.env.OPENAI_API_KEY}`;
    }
    const res = await fetch(buildChatUrl(provider), {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${provider} API returned HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const data = await res.json();
    const contentText = data.choices?.[0]?.message?.content;
    if (!contentText) throw new Error(`${provider} API returned no completion content.`);
    return cleanJSONText(contentText);
  } finally {
    clearTimeout(timer);
  }
}

function cleanJSONText(text) {
  const s = String(text || '').trim();
  const fence = s.match(/^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/);
  if (fence) return fence[1].trim();
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) return s.slice(firstBrace, lastBrace + 1);
  return s;
}

const GEMINI_JSON_HEADER = 'Respond with ONLY valid JSON matching the requested schema. Do not include markdown, commentary, or code fences.';

async function generateStructuredJSON(prompt, schema, imageParts = null) {
  const provider = activeProvider();

  if (provider === 'gemini') {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const config = {
      responseMimeType: 'application/json',
      responseSchema: schema,
    };
    const contents = [];
    if (imageParts && imageParts.length > 0) {
      contents.push(...imageParts, GEMINI_JSON_HEADER + '\n\n' + prompt);
    } else {
      contents.push(prompt);
    }
    const response = await genai.models.generateContent({
      model: GEMINI_MODEL,
      contents,
      config,
    });
    return cleanJSONText(response.text);
  }

  if (provider === 'ollama' || provider === 'openai') {
    const result = await openAIChat({
      provider,
      system: GEMINI_JSON_HEADER,
      userContent: prompt,
      useJson: true,
      imageParts,
    });
    return result;
  }

  throw new Error('No LLM backend configured. Set GEMINI_API_KEY, LLM_PROVIDER=ollama, or LLM_PROVIDER=openai.');
}

async function generateWithImage(prompt, imageBase64, mimeType = 'image/jpeg') {
  const provider = activeProvider();
  const imagePart = { inlineData: { data: imageBase64, mimeType } };

  if (provider === 'gemini') {
    const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    const response = await genai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [imagePart, prompt],
    });
    return response.text;
  }

  if (provider === 'ollama' || provider === 'openai') {
    return openAIChat({
      provider,
      userContent: prompt,
      imageParts: [{ data: imageBase64, mimeType }],
    });
  }

  throw new Error('Image analysis requires GEMINI_API_KEY or an Ollama vision model (e.g. llama3.2-vision / qwen2.5vl).');
}

async function generateWithAudio(prompt, audioBase64, mimeType = 'audio/webm') {
  const provider = activeProvider();
  if (provider !== 'gemini') {
    throw new Error('Audio transcription requires GEMINI_API_KEY. Ollama/OpenAI-compatible providers do not transcribe audio.');
  }
  const genai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const audioPart = { inlineData: { data: audioBase64, mimeType } };
  const response = await genai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [audioPart, prompt],
  });
  return response.text;
}

module.exports = {
  generateStructuredJSON,
  generateWithImage,
  generateWithAudio,
  activeProvider,
  hasLLMBackend,
  providerLabel,
  LLM_PROVIDER,
  GEMINI_MODEL,
  OLLAMA_BASE_URL,
  OLLAMA_MODEL,
  OPENAI_BASE_URL,
  OPENAI_MODEL,
};