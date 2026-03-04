# URL Fetch & Content Extraction Service

A lightweight, stateless Node.js service that accepts a URL, fetches the page's raw HTML, and extracts the main readable content using [Mozilla Readability](https://github.com/mozilla/readability).

## Features

- Strips navigation, ads, footers, scripts, and sidebars — returns only the article body
- Detects JS-rendered/SPA pages and returns a descriptive 422 error
- No URLs, IPs, or content are stored or logged
- Responds within 5 seconds for standard static pages

## Quick Start

```bash
npm install
npm start        # listens on port 3000 (override with PORT env var)
```

## API

### `POST /extract`

**Request body:**
```json
{ "url": "https://example.com/some-article" }
```

**Success response (200):**
```json
{
  "url": "https://example.com/some-article",
  "title": "Article Title",
  "byline": "Author Name",
  "excerpt": "Short summary…",
  "siteName": "Example",
  "content": "<div>…cleaned HTML body…</div>",
  "textContent": "Plain text body…",
  "length": 4200
}
```

**JS-rendered page (422):**
```json
{
  "error": "This page appears to require JavaScript rendering and cannot be statically parsed. Use a headless browser to extract content from this URL.",
  "url": "https://example.com/spa"
}
```

**Other error codes:**
| Code | Reason |
|------|--------|
| 400  | Missing/invalid `url` field or unsupported protocol |
| 502  | Remote server unreachable or returned an error |
| 504  | Fetch timed out (> 4.5 s) |

### `GET /health`

Returns `{ "status": "ok" }`.

## Running Tests

```bash
npm test
```
