import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import { htmlToMarkdown } from './converter.js';

export interface ExtractedContent {
  title: string;
  html: string;
  markdown: string;
  text: string;
  byline: string | null;
  excerpt: string | null;
  length: number;
}

export interface ExtractionResult {
  sourceUrl: string;
  content: ExtractedContent;
}

export class ExtractionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 422
  ) {
    super(message);
    this.name = 'ExtractionError';
  }
}

const FETCH_TIMEOUT_MS = 5000;

/**
 * Heuristic detection of pages that require JavaScript to render content.
 * Returns true when the page has SPA shell patterns or near-empty body text
 * despite substantial HTML, indicating client-side rendering is required.
 */
function isJsRendered(dom: JSDOM, articleContent: string | null): boolean {
  const doc = dom.window.document;
  const bodyText = (doc.body?.textContent ?? '').trim();

  // Explicit SPA mount-point patterns with minimal visible text
  const hasSpaRoot = !!(
    doc.querySelector('#root, #app, #__next, #__nuxt') ||
    doc.querySelector('[data-reactroot], [data-v-app]')
  );
  if (hasSpaRoot && bodyText.length < 200) {
    return true;
  }

  // Readability found nothing meaningful and HTML is non-trivial
  if (!articleContent || articleContent.trim().length < 50) {
    const htmlSize = dom.serialize().length;
    if (htmlSize > 5000 && bodyText.length < 100) {
      return true;
    }
  }

  return false;
}

/**
 * Fetch the HTML at `url` and extract the main readable content.
 *
 * Throws ExtractionError for invalid URLs, fetch failures, JS-rendered pages,
 * or when no article content can be found.
 *
 * No URL, IP, or content is stored or logged.
 */
export async function extractFromUrl(url: string): Promise<ExtractionResult> {
  // Validate URL
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ExtractionError('Invalid URL', 'INVALID_URL', 400);
  }

  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    throw new ExtractionError(
      'Only HTTP and HTTPS URLs are supported',
      'UNSUPPORTED_PROTOCOL',
      400
    );
  }

  // Fetch with timeout — no URL/content is logged
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let html: string;
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ContentExtractor/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      throw new ExtractionError(
        `Remote server returned ${response.status}`,
        'FETCH_ERROR',
        502
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/html') && !contentType.includes('application/xhtml')) {
      throw new ExtractionError(
        'URL does not return HTML content',
        'NOT_HTML',
        422
      );
    }

    html = await response.text();
  } catch (e) {
    if (e instanceof ExtractionError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new ExtractionError(
        'Request timed out after 5 seconds',
        'TIMEOUT',
        504
      );
    }
    throw new ExtractionError(
      `Failed to fetch URL: ${(e as Error).message}`,
      'FETCH_ERROR',
      502
    );
  } finally {
    clearTimeout(timeout);
  }

  // Parse with JSDOM (required by Readability)
  const dom = new JSDOM(html, { url });

  // Run Readability to extract main article content
  const reader = new Readability(dom.window.document);
  const article = reader.parse();

  // Detect JS-rendered pages that cannot be statically parsed
  if (isJsRendered(dom, article?.content ?? null)) {
    throw new ExtractionError(
      'This page appears to require JavaScript rendering and cannot be statically parsed',
      'JS_RENDERED',
      422
    );
  }

  if (!article || !article.content || (article.textContent ?? '').trim().length < 50) {
    throw new ExtractionError(
      'Could not extract readable content from this page',
      'EXTRACTION_FAILED',
      422
    );
  }

  const markdown = htmlToMarkdown(article.content);

  return {
    sourceUrl: url,
    content: {
      title: article.title ?? '',
      html: article.content,
      markdown,
      text: article.textContent ?? '',
      byline: article.byline ?? null,
      excerpt: article.excerpt ?? null,
      length: article.length ?? 0,
    },
  };
}
