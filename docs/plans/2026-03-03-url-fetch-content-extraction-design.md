# URL Fetch & Content Extraction Service — Design

## Overview

A lightweight, stateless Node.js/Express service that accepts a URL via POST, fetches the raw HTML, extracts main readable content using Mozilla's Readability.js, and returns a structured JSON response. No URLs, IPs, or content are stored or logged.

## Stack

- **Runtime:** Node.js (>=18)
- **Framework:** Express (minimal, no logging middleware)
- **HTML Fetching:** native `fetch` (Node 18+) with 5s timeout via `AbortController`
- **DOM Parsing:** `jsdom` (no script execution, sandboxed)
- **Content Extraction:** `@mozilla/readability`
- **Testing:** Jest + supertest

## Endpoint

```
POST /extract
Content-Type: application/json
Body: { "url": "https://example.com/article" }
```

### Success Response (200)

```json
{
  "title": "Article Title",
  "content": "<p>Extracted HTML...</p>",
  "textContent": "Plain text version...",
  "url": "https://example.com/article",
  "byline": "Author Name",
  "siteName": "Example Site",
  "length": 2341
}
```

### Error Responses

| Status | Error Code | Condition |
|--------|-----------|-----------|
| 400 | `INVALID_URL` | Missing, malformed, or non-http(s) URL |
| 400 | `UNSAFE_URL` | Private IP, localhost, or SSRF-risk target |
| 422 | `JS_RENDERED` | Page requires JS to render meaningful content |
| 502 | `FETCH_FAILED` | Network error, timeout, or non-2xx response |

## File Structure

```
src/
  index.js       — Express app setup, /extract route
  extract.js     — fetch + parse + extract pipeline
  validate.js    — URL validation, SSRF protection, JS-detection heuristics
package.json
```

## Content Extraction Pipeline

1. Validate URL (format, scheme, SSRF check)
2. `fetch(url, { signal: AbortController(5000) })` with realistic User-Agent
3. Parse HTML with `new JSDOM(html, { runScripts: 'outside-only', resources: 'usable' })` — scripts disabled
4. Run `isProbablyReaderable(document)` — fast pre-check
5. Check JS-heavy heuristics (sparse body text, empty SPA root, framework markers)
6. If unreaderable: return 422 `JS_RENDERED`
7. `new Readability(document.cloneNode(true)).parse()` — extract content
8. Return structured response

## JS Detection Heuristics

A page is considered JS-rendered (and thus unextractable) when ANY of:
- `isProbablyReaderable()` returns false AND body text < 200 characters
- Body contains a React/Next/Vue/Angular root element with no meaningful children
- HTML contains `<noscript>Please enable JavaScript</noscript>` near top

## Privacy

- No `morgan` or request logging middleware
- No console output of URLs or content
- No persistence layer
- `jsdom` created fresh per request, discarded after response

## Security

- SSRF protection: reject private IP ranges (RFC 1918), localhost, file://, etc.
- URL must be http or https only
- jsdom runs with scripts disabled (`runScripts: 'outside-only'`)
- No redirect following to private addresses
