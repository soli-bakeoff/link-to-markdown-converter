import { parse, HTMLElement, NodeType } from 'node-html-parser';
import type { Node } from 'node-html-parser';

interface Context {
  listDepth: number;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) =>
      String.fromCharCode(parseInt(hex, 16))
    );
}

function convertChildren(el: HTMLElement, ctx: Context): string {
  return el.childNodes.map((n) => convert(n, ctx)).join('');
}

/** Wrap content as a Markdown block element (blank lines above and below). */
function block(content: string): string {
  const s = content.trim();
  return s ? `\n\n${s}\n\n` : '';
}

function convert(n: Node, ctx: Context): string {
  // Text node
  if (n.nodeType === NodeType.TEXT_NODE) {
    return n.rawText.replace(/\s+/g, ' ');
  }

  if (n.nodeType !== NodeType.ELEMENT_NODE) return '';

  const el = n as HTMLElement;
  const tag = el.tagName?.toLowerCase() ?? '';

  switch (tag) {
    // ── Headings ────────────────────────────────────────────────────────────
    case 'h1':
      return block(`# ${convertChildren(el, ctx).trim()}`);
    case 'h2':
      return block(`## ${convertChildren(el, ctx).trim()}`);
    case 'h3':
      return block(`### ${convertChildren(el, ctx).trim()}`);
    case 'h4':
      return block(`#### ${convertChildren(el, ctx).trim()}`);
    case 'h5':
      return block(`##### ${convertChildren(el, ctx).trim()}`);
    case 'h6':
      return block(`###### ${convertChildren(el, ctx).trim()}`);

    // ── Paragraph / line break ───────────────────────────────────────────
    case 'p': {
      const c = convertChildren(el, ctx).trim();
      return c ? block(c) : '';
    }
    case 'br':
      return '\n';

    // ── Inline formatting ────────────────────────────────────────────────
    case 'strong':
    case 'b': {
      const c = convertChildren(el, ctx).trim();
      return c ? `**${c}**` : '';
    }
    case 'em':
    case 'i': {
      const c = convertChildren(el, ctx).trim();
      return c ? `*${c}*` : '';
    }
    case 'del':
    case 's': {
      const c = convertChildren(el, ctx).trim();
      return c ? `~~${c}~~` : '';
    }

    // ── Code ─────────────────────────────────────────────────────────────
    case 'code': {
      const c = decodeEntities(el.innerText);
      return c ? `\`${c}\`` : '';
    }
    case 'pre': {
      // el.rawText contains the raw inner HTML (e.g. <code class="...">...</code>)
      // because <pre> is treated as a block text element by the parser.
      const rawInner = el.rawText;
      let lang = '';
      let content = '';

      const codeWrap = rawInner.match(/^<code([^>]*)>([\s\S]*?)<\/code>\s*$/s);
      if (codeWrap) {
        const langM = codeWrap[1].match(/(?:language|lang)-(\S+?)(?:["'\s]|$)/);
        lang = langM?.[1] ?? '';
        content = decodeEntities(codeWrap[2]);
      } else {
        content = decodeEntities(rawInner);
      }

      // Remove the final trailing newline so the closing fence sits cleanly
      if (content.endsWith('\n')) content = content.slice(0, -1);

      return block(`\`\`\`${lang}\n${content}\n\`\`\``);
    }

    // ── Blockquote ───────────────────────────────────────────────────────
    case 'blockquote': {
      const c = convertChildren(el, ctx).trim();
      const quoted = c
        .split('\n')
        .map((l) => `> ${l}`)
        .join('\n');
      return block(quoted);
    }

    // ── Lists ────────────────────────────────────────────────────────────
    case 'ul': {
      const lctx = { ...ctx, listDepth: ctx.listDepth + 1 };
      const items = convertListItems(el, lctx, false);
      return ctx.listDepth === 0 ? block(items) : `\n${items}`;
    }
    case 'ol': {
      const lctx = { ...ctx, listDepth: ctx.listDepth + 1 };
      const items = convertListItems(el, lctx, true);
      return ctx.listDepth === 0 ? block(items) : `\n${items}`;
    }
    case 'li': {
      // Fallback when an <li> is encountered outside a list handler
      const c = convertChildren(el, ctx).trim();
      return `- ${c}\n`;
    }

    // ── Links & images ───────────────────────────────────────────────────
    case 'a': {
      const href = el.getAttribute('href') ?? '';
      const c = convertChildren(el, ctx).trim();
      if (!c && !href) return '';
      if (!c) return href;
      if (!href) return c;
      return `[${c}](${href})`;
    }
    case 'img': {
      const src = el.getAttribute('src') ?? '';
      const alt = el.getAttribute('alt') ?? '';
      return src ? `![${alt}](${src})` : alt;
    }

    // ── Thematic break ───────────────────────────────────────────────────
    case 'hr':
      return block('---');

    // ── Generic block containers ─────────────────────────────────────────
    case 'div':
    case 'section':
    case 'article':
    case 'main':
    case 'header':
    case 'footer':
    case 'nav':
    case 'aside':
    case 'figure': {
      const c = convertChildren(el, ctx).trim();
      return c ? `\n${c}\n` : '';
    }
    case 'figcaption': {
      const c = convertChildren(el, ctx).trim();
      return c ? block(c) : '';
    }

    // ── Transparent inline containers ────────────────────────────────────
    case 'span':
    case 'abbr':
    case 'cite':
    case 'mark':
    case 'small':
    case 'sub':
    case 'sup':
    case 'time':
    case 'kbd':
    case 'samp':
    case 'u':
    case 'var':
    case 'label':
      return convertChildren(el, ctx);

    // ── Elements to discard entirely ─────────────────────────────────────
    case 'script':
    case 'style':
    case 'head':
    case 'link':
    case 'meta':
    case 'noscript':
    case 'template':
    case 'iframe':
      return '';

    // ── Document root / passthrough ──────────────────────────────────────
    default:
      return convertChildren(el, ctx);
  }
}

function convertListItems(
  listEl: HTMLElement,
  ctx: Context,
  ordered: boolean
): string {
  const indent = '  '.repeat(ctx.listDepth - 1);
  let counter = 0;
  const lines: string[] = [];

  for (const child of listEl.childNodes) {
    if (child.nodeType !== NodeType.ELEMENT_NODE) continue;
    const el = child as HTMLElement;
    if (el.tagName?.toLowerCase() !== 'li') continue;

    counter++;
    const prefix = ordered ? `${counter}. ` : '- ';
    const content = convertListItemContent(el, ctx);
    lines.push(`${indent}${prefix}${content}`);
  }

  return lines.join('\n');
}

function convertListItemContent(li: HTMLElement, ctx: Context): string {
  let inline = '';
  let nested = '';

  for (const child of li.childNodes) {
    if (child.nodeType === NodeType.ELEMENT_NODE) {
      const tag = (child as HTMLElement).tagName?.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        nested += convert(child, ctx);
        continue;
      }
    }
    inline += convert(child, ctx);
  }

  return inline.trim() + nested;
}

function clean(text: string): string {
  return (
    text
      // Strip trailing horizontal whitespace on every line (handles
      // whitespace-only lines that arise between block elements)
      .replace(/[ \t]+$/gm, '')
      // Collapse 3+ consecutive blank lines into exactly one blank line
      .replace(/\n{3,}/g, '\n\n')
      .trim() + '\n'
  );
}

/**
 * Convert an HTML string into clean, well-formatted Markdown.
 *
 * Handles headings (h1–h6), paragraphs, bold, italic, inline code, fenced
 * code blocks (with language hints), blockquotes, ordered/unordered lists
 * (including nesting), hyperlinks, and images.
 *
 * @param html - Raw HTML string (fragment or full document).
 * @returns Markdown string with a single trailing newline.
 */
export function htmlToMarkdown(html: string): string {
  const root = parse(html, {
    // Keep these as raw text so we can discard or handle them correctly.
    // pre:true preserves the full inner HTML in rawText for code block extraction.
    blockTextElements: {
      script: true,
      noscript: true,
      style: true,
      pre: true,
    },
  });
  const raw = convert(root, { listDepth: 0 });
  return clean(raw);
}
