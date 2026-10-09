import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';

const root = join(process.cwd(), 'public');
const port = Number(process.env.PORT || 4173);
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const types = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

function sendJson(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request, maximumBytes = 12_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > maximumBytes) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function cleanSentence(text) {
  return String(text ?? '')
    .trim()
    .replace(/^['"`]+|['"`]+$/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 500);
}

async function repairWithGemini(rawText) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    const error = new Error('Gemini is not configured. Set GEMINI_API_KEY and restart EyeSpeak.');
    error.status = 503;
    throw error;
  }
  const prompt = [
    'You repair text created by an assistive eye keyboard.',
    'The input may have no spaces, spelling errors, or omitted letters.',
    'Infer the most likely concise sentence while preserving the person\'s intended meaning.',
    'Do not add facts, requests, names, or information that is not supported by the input.',
    'If meaning is genuinely unclear, make only minimal spacing and capitalization fixes.',
    'Return only the corrected sentence as plain text, with no explanation, label, markdown, or quotation marks.',
    `Input: ${rawText}`,
  ].join('\n');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 100 },
      }),
    },
  );
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error('Gemini could not repair this sentence.');
    error.status = 502;
    throw error;
  }
  const repaired = cleanSentence(body.candidates?.[0]?.content?.parts?.map((part) => part.text ?? '').join(''));
  if (!repaired) {
    const error = new Error('Gemini returned no usable sentence.');
    error.status = 502;
    throw error;
  }
  return repaired;
}

createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === 'POST' && url.pathname === '/api/repair') {
    try {
      const body = await readJson(request);
      const text = cleanSentence(body.text);
      if (!text) {
        sendJson(response, 400, { error: 'Write something before speaking.' });
        return;
      }
      sendJson(response, 200, { text: await repairWithGemini(text) });
    } catch (error) {
      sendJson(response, error.status || 400, { error: error.message || 'Sentence repair is unavailable.' });
    }
    return;
  }

  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(join(root, requested));
  if (!safePath.startsWith(root) || !existsSync(safePath) || !statSync(safePath).isFile()) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  response.writeHead(200, {
    'Content-Type': types[extname(safePath)] || 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  createReadStream(safePath).pipe(response);
}).listen(port, '127.0.0.1', () => {
  console.log(`EyeSpeak is running at http://localhost:${port}`);
});
