/**
 * Integration / unit tests for the content extraction service.
 * Run with: node test.js
 *
 * Uses only Node built-ins plus the app's own dependencies — no test framework needed.
 */

const http = require('http');
const assert = require('assert');

// Start the server on a random free port for testing
process.env.PORT = '0'; // will be assigned dynamically below

const app = require('./server');

let server;
let baseUrl;

async function startServer() {
  return new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
}

async function stopServer() {
  return new Promise((resolve) => server.close(resolve));
}

async function post(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const url = new URL(path, baseUrl);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    };
    const req = http.request(options, (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function get(path) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    http.get(url.toString(), (res) => {
      let raw = '';
      res.on('data', (chunk) => (raw += chunk));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode, body: raw });
        }
      });
    }).on('error', reject);
  });
}

// ─── helpers ────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓  ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗  ${name}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ─── test suites ─────────────────────────────────────────────────────────────

async function runTests() {
  await startServer();
  console.log(`\nRunning tests against ${baseUrl}\n`);

  // --- Health check ---
  await test('GET /health returns 200 ok', async () => {
    const res = await get('/health');
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.body.status, 'ok');
  });

  // --- Input validation ---
  await test('POST /extract with no body returns 400', async () => {
    const res = await post('/extract', {});
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  await test('POST /extract with invalid URL returns 400', async () => {
    const res = await post('/extract', { url: 'not-a-url' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  await test('POST /extract with non-http URL returns 400', async () => {
    const res = await post('/extract', { url: 'ftp://example.com' });
    assert.strictEqual(res.status, 400);
    assert.ok(res.body.error);
  });

  // --- Local mock HTML server ---
  // Start a tiny static server that serves known HTML so tests are deterministic
  const { createServer } = require('http');

  const STATIC_HTML = `<!DOCTYPE html>
<html>
<head><title>Test Article</title></head>
<body>
  <nav>Navigation menu</nav>
  <article>
    <h1>My Test Article</h1>
    <p>This is a meaningful paragraph with enough content to pass Readability's threshold.
    It contains multiple sentences so the extractor considers it real content worth keeping.
    The quick brown fox jumped over the lazy dog. Lorem ipsum dolor sit amet consectetur.</p>
    <p>Second paragraph adds more body to ensure the article is long enough to be extracted
    properly by the Readability algorithm which requires a minimum amount of text.</p>
  </article>
  <footer>Footer content</footer>
</body>
</html>`;

  // SPA shell — body has almost nothing, just a mount point + scripts
  const SPA_HTML = `<!DOCTYPE html>
<html>
<head><title>My SPA</title></head>
<body>
  <div id="app" data-reactroot></div>
  <script>window.__INITIAL_STATE__={};</script>
  <script src="/bundle.js"></script>
</body>
</html>`;

  const mockServer = createServer((req, res) => {
    if (req.url === '/static') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(STATIC_HTML);
    } else if (req.url === '/spa') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(SPA_HTML);
    } else if (req.url === '/json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ data: 'not html' }));
    } else {
      res.writeHead(404);
      res.end('Not found');
    }
  });

  await new Promise((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
  const mockPort = mockServer.address().port;
  const mockBase = `http://127.0.0.1:${mockPort}`;

  // --- Static page extraction ---
  await test('POST /extract with static HTML returns 200 with title and content', async () => {
    const res = await post('/extract', { url: `${mockBase}/static` });
    assert.strictEqual(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.title, 'Should have title');
    assert.ok(res.body.content || res.body.textContent, 'Should have content');
    assert.strictEqual(res.body.url, `${mockBase}/static`);
  });

  await test('POST /extract response contains url field', async () => {
    const res = await post('/extract', { url: `${mockBase}/static` });
    assert.strictEqual(res.body.url, `${mockBase}/static`);
  });

  // --- JS-rendered page detection ---
  await test('POST /extract returns 422 for SPA / JS-rendered page', async () => {
    const res = await post('/extract', { url: `${mockBase}/spa` });
    assert.strictEqual(res.status, 422, `Expected 422, got ${res.status}: ${JSON.stringify(res.body)}`);
    assert.ok(res.body.error, 'Should have error message');
    assert.ok(
      /javascript|js.rendered|statically/i.test(res.body.error),
      `Error should mention JS rendering: "${res.body.error}"`
    );
  });

  // --- Non-HTML content type ---
  await test('POST /extract returns 422 for non-HTML content type', async () => {
    const res = await post('/extract', { url: `${mockBase}/json` });
    assert.strictEqual(res.status, 422);
    assert.ok(res.body.error);
  });

  // --- 404 from remote ---
  await test('POST /extract returns 502 when remote returns 404', async () => {
    const res = await post('/extract', { url: `${mockBase}/does-not-exist` });
    assert.strictEqual(res.status, 502);
  });

  await new Promise((resolve) => mockServer.close(resolve));
  await stopServer();

  console.log(`\nResults: ${passed} passed, ${failed} failed\n`);
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch((err) => {
  console.error('Test runner error:', err);
  process.exit(1);
});
