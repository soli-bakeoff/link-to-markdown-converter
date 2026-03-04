const express = require('express');
const fetch = require('node-fetch');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');

const app = express();
app.use(express.json());

const FETCH_TIMEOUT_MS = 4500;

// Signals that a page requires JS execution to render meaningful content
const JS_FRAMEWORK_PATTERNS = [
  // Angular
  /\bng-app\b/,
  /\bng-version\b/,
  // React
  /\bdata-reactroot\b/,
  /\bdata-reactid\b/,
  // Vue
  /\bdata-v-app\b/,
  /\bid="app"\s[^>]*v-cloak/,
  // Generic SPA shell
  /<meta[^>]+name=["']fragment["'][^>]+content=["']!["']/i,
  // Nuxt / Next loading shells
  /\b__NUXT__\b/,
  /\b__NEXT_DATA__\b/,
];

// Heuristic thresholds
const MIN_TEXT_LENGTH = 100; // fewer chars in extracted text → likely JS-rendered
const MAX_SCRIPT_RATIO = 0.6; // scripts dominate page source → likely JS-rendered

function detectJsRendered(html, article) {
  // 1. Explicit SPA markers in raw HTML
  for (const pattern of JS_FRAMEWORK_PATTERNS) {
    if (pattern.test(html)) return true;
  }

  // 2. Readability found nothing useful
  if (!article || !article.textContent) return true;
  const text = article.textContent.trim();
  if (text.length < MIN_TEXT_LENGTH) return true;

  // 3. Script-to-total-content ratio (approximate)
  const scriptMatches = html.match(/<script[\s\S]*?<\/script>/gi) || [];
  const scriptChars = scriptMatches.reduce((sum, s) => sum + s.length, 0);
  if (html.length > 0 && scriptChars / html.length > MAX_SCRIPT_RATIO) return true;

  return false;
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ContentExtractor/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9',
      },
      redirect: 'follow',
    });
    return response;
  } finally {
    clearTimeout(timer);
  }
}

app.post('/extract', async (req, res) => {
  const { url } = req.body || {};

  if (!url || typeof url !== 'string') {
    return res.status(400).json({ error: 'Missing required field: url' });
  }

  // Validate URL format
  let parsedUrl;
  try {
    parsedUrl = new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL format' });
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    return res.status(400).json({ error: 'Only http and https URLs are supported' });
  }

  let response;
  try {
    response = await fetchWithTimeout(url);
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(504).json({ error: 'Request timed out fetching the URL' });
    }
    return res.status(502).json({ error: 'Failed to fetch URL', detail: err.message });
  }

  if (!response.ok) {
    return res.status(502).json({
      error: `Remote server returned ${response.status} ${response.statusText}`,
    });
  }

  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('html')) {
    return res.status(422).json({
      error: 'URL does not point to an HTML page',
      contentType,
    });
  }

  let html;
  try {
    html = await response.text();
  } catch (err) {
    return res.status(502).json({ error: 'Failed to read response body', detail: err.message });
  }

  // Parse DOM and run Readability
  let article = null;
  try {
    const dom = new JSDOM(html, { url });
    const reader = new Readability(dom.window.document);
    article = reader.parse();
  } catch (err) {
    return res.status(500).json({ error: 'Failed to parse page content', detail: err.message });
  }

  if (detectJsRendered(html, article)) {
    return res.status(422).json({
      error:
        'This page appears to require JavaScript rendering and cannot be statically parsed. ' +
        'Use a headless browser to extract content from this URL.',
      url,
    });
  }

  return res.status(200).json({
    url,
    title: article.title || null,
    byline: article.byline || null,
    excerpt: article.excerpt || null,
    siteName: article.siteName || null,
    content: article.content || null,
    textContent: article.textContent ? article.textContent.trim() : null,
    length: article.length || null,
  });
});

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  // No URL/content logging — only startup confirmation
  process.stdout.write(`Content extraction service listening on port ${PORT}\n`);
});

module.exports = app;
