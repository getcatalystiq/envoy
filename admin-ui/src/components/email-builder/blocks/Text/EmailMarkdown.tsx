import insane from 'insane';
import { marked, Renderer, type Tokens } from 'marked';
import { useMemo, CSSProperties } from 'react';

const ALLOWED_TAGS = [
  'a', 'article', 'b', 'blockquote', 'br', 'caption', 'code', 'del', 'details',
  'div', 'em', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins',
  'kbd', 'li', 'main', 'ol', 'p', 'pre', 'section', 'span', 'strong', 'sub',
  'summary', 'sup', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'u', 'ul',
];

const GENERIC_ALLOWED_ATTRIBUTES = ['style', 'title'];

function sanitizer(html: string): string {
  return insane(html, {
    allowedTags: ALLOWED_TAGS,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedAttributes: {
      ...ALLOWED_TAGS.reduce((res, tag) => {
        res[tag] = [...GENERIC_ALLOWED_ATTRIBUTES];
        return res;
      }, {} as Record<string, string[]>),
      img: ['src', 'alt', 'width', 'height', ...GENERIC_ALLOWED_ATTRIBUTES],
      table: ['width', ...GENERIC_ALLOWED_ATTRIBUTES],
      td: ['align', 'width', ...GENERIC_ALLOWED_ATTRIBUTES],
      th: ['align', 'width', ...GENERIC_ALLOWED_ATTRIBUTES],
      a: ['href', 'target', ...GENERIC_ALLOWED_ATTRIBUTES],
      ol: ['start', ...GENERIC_ALLOWED_ATTRIBUTES],
      ul: ['start', ...GENERIC_ALLOWED_ATTRIBUTES],
    },
    filter: (token: { tag: string; attrs: Record<string, string | undefined> }) => {
      if (token.tag === 'a' && 'href' in token.attrs && token.attrs.href === undefined) {
        token.attrs.href = '';
      }
      if (token.tag === 'img' && 'src' in token.attrs && token.attrs.src === undefined) {
        token.attrs.src = '';
      }
      return true;
    },
  });
}

class CustomRenderer extends Renderer {
  table(token: Tokens.Table): string {
    // Render header cells
    const headerCells = token.header.map((cell) => {
      const content = this.parser?.parseInline(cell.tokens) ?? cell.text;
      const align = cell.align ? ` align="${cell.align}"` : '';
      return `<th${align}>${content}</th>`;
    }).join('');

    // Render body rows
    const bodyRows = token.rows.map((row) => {
      const cells = row.map((cell) => {
        const content = this.parser?.parseInline(cell.tokens) ?? cell.text;
        const align = cell.align ? ` align="${cell.align}"` : '';
        return `<td${align}>${content}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('\n');

    return `<table width="100%">
<thead>
<tr>${headerCells}</tr>
</thead>
<tbody>
${bodyRows}
</tbody>
</table>`;
  }

  link(token: Tokens.Link): string {
    const href = token.href;
    const title = token.title;
    const text = this.parser?.parseInline(token.tokens) ?? token.text;
    if (!title) {
      return `<a href="${href}" target="_blank">${text}</a>`;
    }
    return `<a href="${href}" title="${title}" target="_blank">${text}</a>`;
  }
}

function renderMarkdownString(str: string): string {
  const html = marked.parse(str, {
    async: false,
    breaks: true,
    gfm: true,
    renderer: new CustomRenderer(),
  });

  if (typeof html !== 'string') {
    throw new Error('marked.parse did not return a string');
  }

  return sanitizer(html);
}

interface EmailMarkdownProps {
  markdown: string;
  style?: CSSProperties;
}

export function EmailMarkdown({ markdown, style }: EmailMarkdownProps) {
  const data = useMemo(() => renderMarkdownString(markdown), [markdown]);
  return <div style={style} dangerouslySetInnerHTML={{ __html: data }} />;
}
