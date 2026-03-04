import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { extractFromUrl, ExtractionError } from './extractor.js';

// ── Fetch mock helpers ──────────────────────────────────────────────────────

const mockFetch = vi.fn();

beforeEach(() => {
  vi.stubGlobal('fetch', mockFetch);
  mockFetch.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeResponse(
  html: string,
  options: { contentType?: string; ok?: boolean; status?: number } = {}
) {
  const { contentType = 'text/html; charset=utf-8', ok = true, status = 200 } = options;
  return {
    ok,
    status,
    headers: { get: (k: string) => (k === 'content-type' ? contentType : null) },
    text: () => Promise.resolve(html),
  };
}

// ── Sample HTML fixtures ────────────────────────────────────────────────────

const ARTICLE_HTML = `<!DOCTYPE html>
<html lang="en">
<head><title>Test Article</title></head>
<body>
  <header><nav><a href="/">Home</a></nav></header>
  <main>
    <article>
      <h1>A Readable Article</h1>
      <p>By Jane Doe</p>
      <p>This is the first paragraph of the article with enough text to pass Readability's filters. It contains meaningful content about a topic.</p>
      <p>The second paragraph adds more substance. Readability requires a minimum amount of text before it considers something an article worth extracting.</p>
      <p>A third paragraph ensures we have well over the minimum character threshold so the content extraction succeeds reliably in tests.</p>
    </article>
  </main>
  <footer><p>Copyright 2024</p></footer>
  <aside><p>Ad: Buy Now!</p></aside>
  <script>document.write('tracking');</script>
</body>
</html>`;

const SPA_SHELL_HTML = `<!DOCTYPE html>
<html>
<head><title>React App</title></head>
<body>
  <div id="root"></div>
  <script src="/static/js/main.chunk.js"></script>
  <script src="/static/js/bundle.js"></script>
</body>
</html>`;

const THIN_CONTENT_HTML = `<!DOCTYPE html>
<html>
<head><title>Empty</title></head>
<body><p>Hi</p><p>Bye</p></body>
</html>`;

// ── URL validation ──────────────────────────────────────────────────────────

describe('URL validation', () => {
  it('rejects malformed URLs', async () => {
    await expect(extractFromUrl('not a url')).rejects.toThrow(ExtractionError);
    await expect(extractFromUrl('not a url')).rejects.toMatchObject({
      code: 'INVALID_URL',
      statusCode: 400,
    });
  });

  it('rejects non-HTTP protocols', async () => {
    await expect(extractFromUrl('ftp://example.com/file')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL',
      statusCode: 400,
    });
    await expect(extractFromUrl('file:///etc/passwd')).rejects.toMatchObject({
      code: 'UNSUPPORTED_PROTOCOL',
      statusCode: 400,
    });
  });

  it('accepts http URLs', async () => {
    mockFetch.mockResolvedValue(makeResponse(ARTICLE_HTML));
    await expect(extractFromUrl('http://example.com')).resolves.toBeDefined();
  });

  it('accepts https URLs', async () => {
    mockFetch.mockResolvedValue(makeResponse(ARTICLE_HTML));
    await expect(extractFromUrl('https://example.com')).resolves.toBeDefined();
  });
});

// ── Fetch error handling ────────────────────────────────────────────────────

describe('fetch error handling', () => {
  it('throws on non-OK HTTP response', async () => {
    mockFetch.mockResolvedValue(makeResponse('', { ok: false, status: 404 }));
    await expect(extractFromUrl('https://example.com')).rejects.toMatchObject({
      code: 'FETCH_ERROR',
      statusCode: 502,
    });
  });

  it('throws when content-type is not HTML', async () => {
    mockFetch.mockResolvedValue(
      makeResponse('{"data":1}', { contentType: 'application/json' })
    );
    await expect(extractFromUrl('https://example.com/api')).rejects.toMatchObject({
      code: 'NOT_HTML',
      statusCode: 422,
    });
  });

  it('throws on network error', async () => {
    mockFetch.mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(extractFromUrl('https://example.com')).rejects.toMatchObject({
      code: 'FETCH_ERROR',
      statusCode: 502,
    });
  });

  it('throws on timeout (AbortError)', async () => {
    const abortErr = new Error('The operation was aborted');
    abortErr.name = 'AbortError';
    mockFetch.mockRejectedValue(abortErr);
    await expect(extractFromUrl('https://example.com')).rejects.toMatchObject({
      code: 'TIMEOUT',
      statusCode: 504,
    });
  });
});

// ── Successful extraction ───────────────────────────────────────────────────

describe('successful extraction', () => {
  it('returns a result with sourceUrl, title, html, markdown, and text', async () => {
    mockFetch.mockResolvedValue(makeResponse(ARTICLE_HTML));
    const result = await extractFromUrl('https://example.com/article');

    expect(result.sourceUrl).toBe('https://example.com/article');
    expect(result.content.title).toBeTruthy();
    expect(result.content.html).toBeTruthy();
    expect(result.content.markdown).toBeTruthy();
    expect(result.content.text).toBeTruthy();
    expect(typeof result.content.length).toBe('number');
  });

  it('strips nav, footer, sidebar, and script elements', async () => {
    mockFetch.mockResolvedValue(makeResponse(ARTICLE_HTML));
    const result = await extractFromUrl('https://example.com/article');

    // Navigation and footer should not appear in main content
    expect(result.content.text).not.toMatch(/Buy Now/);
    expect(result.content.text).not.toMatch(/tracking/);
  });

  it('includes the article body text', async () => {
    mockFetch.mockResolvedValue(makeResponse(ARTICLE_HTML));
    const result = await extractFromUrl('https://example.com/article');

    expect(result.content.text).toMatch(/first paragraph/);
    expect(result.content.text).toMatch(/second paragraph/);
  });

  it('produces markdown from extracted HTML', async () => {
    mockFetch.mockResolvedValue(makeResponse(ARTICLE_HTML));
    const result = await extractFromUrl('https://example.com/article');

    // The main heading should appear as a markdown heading (any level)
    expect(result.content.markdown).toMatch(/^#{1,6}\s/m);
    expect(result.content.markdown.length).toBeGreaterThan(50);
  });

  it('accepts application/xhtml+xml content-type', async () => {
    mockFetch.mockResolvedValue(
      makeResponse(ARTICLE_HTML, { contentType: 'application/xhtml+xml' })
    );
    await expect(extractFromUrl('https://example.com')).resolves.toBeDefined();
  });
});

// ── JS-rendered page detection ──────────────────────────────────────────────

describe('JS-rendered page detection', () => {
  it('returns 422 with JS_RENDERED code for SPA shell pages', async () => {
    mockFetch.mockResolvedValue(makeResponse(SPA_SHELL_HTML));
    await expect(extractFromUrl('https://example.com/app')).rejects.toMatchObject({
      code: 'JS_RENDERED',
      statusCode: 422,
    });
  });

  it('error message is descriptive', async () => {
    mockFetch.mockResolvedValue(makeResponse(SPA_SHELL_HTML));
    try {
      await extractFromUrl('https://example.com/app');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(ExtractionError);
      expect((e as ExtractionError).message).toMatch(/JavaScript/i);
    }
  });
});

// ── Extraction failure ──────────────────────────────────────────────────────

describe('extraction failure', () => {
  it('returns 422 when Readability cannot find article content', async () => {
    mockFetch.mockResolvedValue(makeResponse(THIN_CONTENT_HTML));
    await expect(extractFromUrl('https://example.com/empty')).rejects.toMatchObject({
      statusCode: 422,
    });
  });
});

// ── ExtractionError shape ───────────────────────────────────────────────────

describe('ExtractionError', () => {
  it('is an instance of Error', () => {
    const err = new ExtractionError('msg', 'CODE', 400);
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ExtractionError);
  });

  it('exposes code and statusCode', () => {
    const err = new ExtractionError('msg', 'MY_CODE', 422);
    expect(err.code).toBe('MY_CODE');
    expect(err.statusCode).toBe(422);
    expect(err.message).toBe('msg');
  });
});
