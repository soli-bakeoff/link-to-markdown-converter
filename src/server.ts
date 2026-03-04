import { createServer, IncomingMessage, ServerResponse } from 'http';
import { extractFromUrl, ExtractionError } from './extractor.js';

const PORT = Number(process.env.PORT) || 3000;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

export const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  if (req.method === 'POST' && req.url === '/extract') {
    let body: string;
    try {
      body = await readBody(req);
    } catch {
      send(res, 400, { error: 'Failed to read request body', code: 'BAD_REQUEST' });
      return;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      send(res, 400, { error: 'Request body must be valid JSON', code: 'INVALID_JSON' });
      return;
    }

    if (typeof parsed !== 'object' || parsed === null || !('url' in parsed)) {
      send(res, 400, { error: 'Request body must contain a "url" field', code: 'MISSING_URL' });
      return;
    }

    const url = (parsed as Record<string, unknown>).url;
    if (typeof url !== 'string') {
      send(res, 400, { error: '"url" must be a string', code: 'INVALID_URL' });
      return;
    }

    try {
      const result = await extractFromUrl(url);
      send(res, 200, result);
    } catch (e) {
      if (e instanceof ExtractionError) {
        send(res, e.statusCode, { error: e.message, code: e.code });
      } else {
        send(res, 500, { error: 'Internal server error', code: 'INTERNAL_ERROR' });
      }
    }
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    send(res, 200, { status: 'ok' });
    return;
  }

  send(res, 404, { error: 'Not found', code: 'NOT_FOUND' });
});

// Start listening only when run directly, not when imported
const isMain = process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts');
if (isMain) {
  server.listen(PORT);
}
