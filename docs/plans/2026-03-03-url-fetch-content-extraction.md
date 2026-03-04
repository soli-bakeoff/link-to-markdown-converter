# URL Fetch & Content Extraction Service Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a stateless Node.js/Express service with a `POST /extract` endpoint that fetches a URL, extracts readable content using Mozilla's Readability.js, and returns structured JSON — with no logging, no persistence, and graceful detection of JS-rendered pages.

**Architecture:** Single Express app with three modules: URL validation (with SSRF protection), content extraction pipeline (fetch → jsdom → Readability), and the Express route. No middleware that logs requests. Each request is self-contained with a 5-second fetch timeout.

**Tech Stack:** Node.js 18+, Express 4, `@mozilla/readability`, `jsdom`, Jest, supertest

---

### Task 1: Initialize the project

**Files:**
- Create: `package.json`
- Create: `src/index.js`

**Step 1: Initialize package.json**

```bash
cd /private/var/folders/yf/sjjj6jcx1kl4tvnshrtlkr3h0000gp/T/executor-x23jZg
npm init -y
```

**Step 2: Install dependencies**

```bash
npm install express @mozilla/readability jsdom
npm install --save-dev jest supertest
```

**Step 3: Update package.json scripts and type**

Edit `package.json` to add:
```json
{
  "main": "src/index.js",
  "scripts": {
    "start": "node src/index.js",
    "test": "jest --testEnvironment node"
  },
  "jest": {
    "testEnvironment": "node"
  }
}
```

**Step 4: Create minimal `src/index.js`**

```js
const express = require('express');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT);
}

module.exports = app;
```

**Step 5: Verify server starts**

```bash
node src/index.js &
curl -s http://localhost:3000/health
kill %1
```
Expected: `{"status":"ok"}`

**Step 6: Commit**

```bash
git add package.json package-lock.json src/index.js
git commit -m "feat: initialize express app skeleton"
```

---

### Task 2: URL validation module

**Files:**
- Create: `src/validate.js`
- Create: `tests/validate.test.js`

**Step 1: Write failing tests**

Create `tests/validate.test.js`:
```js
const { validateUrl } = require('../src/validate');

describe('validateUrl', () => {
  test('accepts valid https URL', () => {
    expect(() => validateUrl('https://example.com/article')).not.toThrow();
  });

  test('accepts valid http URL', () => {
    expect(() => validateUrl('http://example.com/page')).not.toThrow();
  });

  test('rejects missing url', () => {
    expect(() => validateUrl(undefined)).toThrow(/INVALID_URL/);
  });

  test('rejects empty string', () => {
    expect(() => validateUrl('')).toThrow(/INVALID_URL/);
  });

  test('rejects non-string', () => {
    expect(() => validateUrl(42)).toThrow(/INVALID_URL/);
  });

  test('rejects malformed URL', () => {
    expect(() => validateUrl('not a url')).toThrow(/INVALID_URL/);
  });

  test('rejects ftp scheme', () => {
    expect(() => validateUrl('ftp://example.com/file')).toThrow(/INVALID_URL/);
  });

  test('rejects localhost', () => {
    expect(() => validateUrl('http://localhost/admin')).toThrow(/UNSAFE_URL/);
  });

  test('rejects 127.0.0.1', () => {
    expect(() => validateUrl('http://127.0.0.1/secret')).toThrow(/UNSAFE_URL/);
  });

  test('rejects private 192.168.x.x', () => {
    expect(() => validateUrl('http://192.168.1.1/')).toThrow(/UNSAFE_URL/);
  });

  test('rejects private 10.x.x.x', () => {
    expect(() => validateUrl('http://10.0.0.1/')).toThrow(/UNSAFE_URL/);
  });

  test('rejects private 172.16.x.x', () => {
    expect(() => validateUrl('http://172.16.0.1/')).toThrow(/UNSAFE_URL/);
  });

  test('rejects 0.0.0.0', () => {
    expect(() => validateUrl('http://0.0.0.0/')).toThrow(/UNSAFE_URL/);
  });

  test('rejects ::1 (IPv6 loopback)', () => {
    expect(() => validateUrl('http://[::1]/')).toThrow(/UNSAFE_URL/);
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx jest tests/validate.test.js --no-coverage
```
Expected: All tests FAIL with "Cannot find module"

**Step 3: Implement `src/validate.js`**

```js
'use strict';

class ExtractError extends Error {
  constructor(code, message, status) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const PRIVATE_IP_RE = /^(localhost|127\.|0\.0\.0\.0|192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/i;
const IPV6_LOOPBACK_RE = /^\[::1\]/;

function validateUrl(url) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new ExtractError('INVALID_URL', 'url must be a non-empty string', 400);
  }

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new ExtractError('INVALID_URL', `Invalid URL: ${url}`, 400);
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ExtractError('INVALID_URL', 'URL must use http or https scheme', 400);
  }

  const host = parsed.hostname;
  if (PRIVATE_IP_RE.test(host) || IPV6_LOOPBACK_RE.test(host)) {
    throw new ExtractError('UNSAFE_URL', 'URL points to a private or reserved address', 400);
  }

  return parsed;
}

module.exports = { validateUrl, ExtractError };
```

**Step 4: Run tests to verify they pass**

```bash
npx jest tests/validate.test.js --no-coverage
```
Expected: All 14 tests PASS

**Step 5: Commit**

```bash
git add src/validate.js tests/validate.test.js
git commit -m "feat: add URL validation with SSRF protection"
```

---

### Task 3: Content extraction module

**Files:**
- Create: `src/extract.js`
- Create: `tests/extract.test.js`

**Step 1: Write failing tests**

Create `tests/extract.test.js`:
```js
const { extractContent, isJsRendered } = require('../src/extract');

describe('isJsRendered', () => {
  test('returns true for nearly-empty body', () => {
    const html = '<html><body><div id="root"></div></body></html>';
    expect(isJsRendered(html)).toBe(true);
  });

  test('returns true for React SPA shell with no content', () => {
    const html = `<html><head><script src="main.js"></script></head>
      <body><div id="root"><!-- react mount --></div></body></html>`;
    expect(isJsRendered(html)).toBe(true);
  });

  test('returns true for Next.js shell', () => {
    const html = `<html><body><div id="__next"></div><script src="/_next/static/chunks/main.js"></script></body></html>`;
    expect(isJsRendered(html)).toBe(true);
  });

  test('returns false for page with real content', () => {
    const html = `<html><body>
      <article>
        <h1>Real Article Title</h1>
        <p>This is a real paragraph with enough content to be meaningful. It has many words and sentences that indicate static content is present.</p>
        <p>Another paragraph with more real content here to ensure the heuristic passes correctly.</p>
      </article>
    </body></html>`;
    expect(isJsRendered(html)).toBe(false);
  });
});

describe('extractContent', () => {
  test('extracts title and content from static HTML', async () => {
    const html = `<html>
      <head><title>Test Article</title></head>
      <body>
        <nav>Navigation menu</nav>
        <article>
          <h1>Test Article</h1>
          <p>This is the main content of the article. It has enough text to be meaningful and should be extracted by Readability. Adding more sentences here to ensure the content passes readability thresholds.</p>
          <p>Second paragraph with more content to make sure extraction works properly.</p>
        </article>
        <footer>Footer content</footer>
      </body>
    </html>`;

    const result = await extractContent(html, 'https://example.com/article');
    expect(result.title).toBeDefined();
    expect(result.content).toBeDefined();
    expect(result.textContent).toBeDefined();
    expect(result.url).toBe('https://example.com/article');
    expect(result.length).toBeGreaterThan(0);
  });

  test('throws JS_RENDERED for empty SPA shell', async () => {
    const html = '<html><body><div id="root"></div></body></html>';
    await expect(extractContent(html, 'https://example.com')).rejects.toMatchObject({
      code: 'JS_RENDERED',
    });
  });

  test('throws JS_RENDERED when Readability returns null', async () => {
    // Nearly empty but not an obvious SPA - readability will return null
    const html = '<html><body><p>Hi</p></body></html>';
    await expect(extractContent(html, 'https://example.com')).rejects.toMatchObject({
      code: 'JS_RENDERED',
    });
  });
});
```

**Step 2: Run tests to verify they fail**

```bash
npx jest tests/extract.test.js --no-coverage
```
Expected: FAIL with "Cannot find module"

**Step 3: Implement `src/extract.js`**

```js
'use strict';

const { JSDOM } = require('jsdom');
const { Readability, isProbablyReaderable } = require('@mozilla/readability');
const { ExtractError } = require('./validate');

const SPA_ROOT_RE = /id=["'](root|__next|app|__nuxt)["']/i;
const NOSCRIPT_RE = /please\s+enable\s+javascript/i;
const MIN_TEXT_LENGTH = 200;

function isJsRendered(html) {
  // Heuristic 1: SPA root element with very little body text
  const bodyTextMatch = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (SPA_ROOT_RE.test(html) && bodyTextMatch.length < MIN_TEXT_LENGTH) {
    return true;
  }

  // Heuristic 2: noscript "please enable javascript" message
  if (NOSCRIPT_RE.test(html)) {
    return true;
  }

  // Heuristic 3: body has almost no text content at all
  if (bodyTextMatch.length < 100) {
    return true;
  }

  return false;
}

async function extractContent(html, url) {
  if (isJsRendered(html)) {
    throw new ExtractError(
      'JS_RENDERED',
      'This page requires JavaScript to render its content and cannot be statically parsed.',
      422
    );
  }

  const dom = new JSDOM(html, {
    url,
    runScripts: 'outside-only',
    resources: 'usable',
  });

  const { document } = dom.window;

  if (!isProbablyReaderable(document)) {
    throw new ExtractError(
      'JS_RENDERED',
      'This page does not appear to contain extractable article content. It may require JavaScript or lack a main content area.',
      422
    );
  }

  const reader = new Readability(document);
  const article = reader.parse();

  if (!article) {
    throw new ExtractError(
      'JS_RENDERED',
      'Could not extract readable content from this page. The page may rely on JavaScript or have an unsupported structure.',
      422
    );
  }

  return {
    title: article.title || '',
    content: article.content || '',
    textContent: article.textContent ? article.textContent.trim() : '',
    url,
    byline: article.byline || null,
    siteName: article.siteName || null,
    length: article.length || 0,
  };
}

module.exports = { extractContent, isJsRendered };
```

**Step 4: Run tests to verify they pass**

```bash
npx jest tests/extract.test.js --no-coverage
```
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/extract.js tests/extract.test.js
git commit -m "feat: add content extraction with JS-rendered page detection"
```

---

### Task 4: Wire up the POST /extract endpoint

**Files:**
- Modify: `src/index.js`
- Create: `tests/server.test.js`

**Step 1: Write failing integration tests**

Create `tests/server.test.js`:
```js
const request = require('supertest');
const app = require('../src/index');

describe('POST /extract', () => {
  test('returns 400 for missing url', async () => {
    const res = await request(app).post('/extract').send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_URL');
    expect(res.body.message).toBeDefined();
  });

  test('returns 400 for empty url', async () => {
    const res = await request(app).post('/extract').send({ url: '' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_URL');
  });

  test('returns 400 for non-http scheme', async () => {
    const res = await request(app).post('/extract').send({ url: 'ftp://example.com' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_URL');
  });

  test('returns 400 for localhost URL', async () => {
    const res = await request(app).post('/extract').send({ url: 'http://localhost/admin' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSAFE_URL');
  });

  test('returns 400 for private IP', async () => {
    const res = await request(app).post('/extract').send({ url: 'http://192.168.1.1/' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('UNSAFE_URL');
  });

  test('returns 400 for malformed URL', async () => {
    const res = await request(app).post('/extract').send({ url: 'not-a-url' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('INVALID_URL');
  });

  test('GET /health returns ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});
```

**Step 2: Run tests to verify failures are correct**

```bash
npx jest tests/server.test.js --no-coverage
```
Expected: Some pass (health), some fail (extract not implemented yet)

**Step 3: Update `src/index.js` with the /extract route**

Replace the contents of `src/index.js`:
```js
'use strict';

const express = require('express');
const { validateUrl, ExtractError } = require('./validate');
const { extractContent } = require('./extract');

const app = express();
app.use(express.json());

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

app.post('/extract', async (req, res) => {
  let parsedUrl;
  try {
    parsedUrl = validateUrl(req.body && req.body.url);
  } catch (err) {
    return res.status(err.status || 400).json({ error: err.code, message: err.message });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  let html;
  try {
    const response = await fetch(parsedUrl.toString(), {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ContentExtractor/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      redirect: 'follow',
    });

    if (!response.ok) {
      return res.status(502).json({
        error: 'FETCH_FAILED',
        message: `Remote server returned ${response.status} ${response.statusText}`,
      });
    }

    html = await response.text();
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(502).json({
        error: 'FETCH_FAILED',
        message: 'Request timed out after 5 seconds',
      });
    }
    return res.status(502).json({
      error: 'FETCH_FAILED',
      message: `Failed to fetch URL: ${err.message}`,
    });
  } finally {
    clearTimeout(timeout);
  }

  try {
    const result = await extractContent(html, parsedUrl.toString());
    return res.json(result);
  } catch (err) {
    if (err instanceof ExtractError) {
      return res.status(err.status).json({ error: err.code, message: err.message });
    }
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: 'Unexpected extraction error' });
  }
});

const PORT = process.env.PORT || 3000;
if (require.main === module) {
  app.listen(PORT);
}

module.exports = app;
```

**Step 4: Run tests to verify they pass**

```bash
npx jest tests/server.test.js --no-coverage
```
Expected: All 7 tests PASS

**Step 5: Run all tests**

```bash
npx jest --no-coverage
```
Expected: All tests pass

**Step 6: Commit**

```bash
git add src/index.js tests/server.test.js
git commit -m "feat: add POST /extract endpoint with fetch and error handling"
```

---

### Task 5: Final verification and cleanup

**Step 1: Run full test suite**

```bash
npx jest --no-coverage --verbose
```
Expected: All tests PASS

**Step 2: Smoke test the server manually**

```bash
node src/index.js &
SERVER_PID=$!

# Test health
curl -s http://localhost:3000/health

# Test invalid URL
curl -s -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url": ""}' | jq .

# Test localhost SSRF
curl -s -X POST http://localhost:3000/extract \
  -H "Content-Type: application/json" \
  -d '{"url": "http://localhost/admin"}' | jq .

kill $SERVER_PID
```

Expected:
- Health: `{"status":"ok"}`
- Empty URL: `{"error":"INVALID_URL","message":"..."}`
- Localhost: `{"error":"UNSAFE_URL","message":"..."}`

**Step 3: Update README.md**

Replace `README.md` contents with:
```markdown
# link-to-markdown-converter

A stateless HTTP service that fetches a URL and extracts its main readable content.

## API

### POST /extract

Accepts a URL and returns extracted article content.

**Request:**
```json
{ "url": "https://example.com/article" }
```

**Success (200):**
```json
{
  "title": "Article Title",
  "content": "<p>Extracted HTML...</p>",
  "textContent": "Plain text...",
  "url": "https://example.com/article",
  "byline": "Author Name or null",
  "siteName": "Site Name or null",
  "length": 2341
}
```

**Errors:**
| Status | Code | Reason |
|--------|------|--------|
| 400 | `INVALID_URL` | Missing, malformed, or non-http(s) URL |
| 400 | `UNSAFE_URL` | Private/reserved address (SSRF protection) |
| 422 | `JS_RENDERED` | Page requires JavaScript to render content |
| 502 | `FETCH_FAILED` | Network error, timeout, or non-2xx response |

## Running

```bash
npm install
npm start          # starts on port 3000
PORT=8080 npm start  # custom port
```

## Testing

```bash
npm test
```

## Privacy

No URLs, IPs, or content are stored or logged.
```

**Step 4: Commit final state**

```bash
git add README.md
git commit -m "docs: update README with API documentation"
```

**Step 5: Tag the release**

```bash
git tag v1.0.0
```
