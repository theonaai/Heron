function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isWordChar(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9]/.test(char);
}

function findClosingUnderscore(text: string, from: number): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === '_' && !isWordChar(text[i + 1])) return i;
  }
  return -1;
}

// Inline markdown used by the generated diff. This intentionally stays small:
// code, bold, asterisk italic and underscore italic. Every text segment is
// escaped before markup is emitted.
function inlineMd(text: string): string {
  let html = '';
  let i = 0;

  while (i < text.length) {
    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        html += `<code>${escapeHtml(text.slice(i + 1, end))}</code>`;
        i = end + 1;
        continue;
      }
    }

    if (text.startsWith('**', i)) {
      const end = text.indexOf('**', i + 2);
      if (end !== -1) {
        html += `<strong>${inlineMd(text.slice(i + 2, end))}</strong>`;
        i = end + 2;
        continue;
      }
    }

    if (text[i] === '*') {
      const end = text.indexOf('*', i + 1);
      if (end !== -1) {
        html += `<em>${inlineMd(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }

    if (text[i] === '_' && !isWordChar(text[i - 1]) && text[i + 1] !== ' ') {
      const end = findClosingUnderscore(text, i + 1);
      if (end !== -1) {
        html += `<em>${inlineMd(text.slice(i + 1, end))}</em>`;
        i = end + 1;
        continue;
      }
    }

    html += escapeHtml(text[i]);
    i++;
  }

  return html;
}

function splitTableCells(row: string): string[] {
  return row
    .slice(1, -1)
    .split('|')
    .map((cell) => cell.trim());
}

// Line-based markdown parser tuned for Heron's generated diff output.
// Handles GFM tables, nested bullet lists, h1-h3 headings and inline marks.
//
// Accepts null/undefined defensively. The legacy DiffView passed
// `diff.diffMarkdown` straight in; with the new structured-diff path
// that field is null on responses that carry only diffJson — and we
// don't want bundle-mismatch races to surface as a runtime crash.
export function diffMarkdownToHtml(md: string | null | undefined): string {
  if (!md) return '';
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  const listStack: Array<{ liOpen: boolean }> = [];
  let i = 0;

  const closeListsTo = (targetDepth: number) => {
    while (listStack.length > targetDepth) {
      const current = listStack[listStack.length - 1];
      if (current.liOpen) out.push('</li>');
      out.push('</ul>');
      listStack.pop();
    }
  };

  const closeLists = () => closeListsTo(0);

  const openListTo = (targetDepth: number) => {
    while (listStack.length < targetDepth) {
      out.push('<ul>');
      listStack.push({ liOpen: false });
    }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      closeLists();
      i++;
      continue;
    }

    if (trimmed.startsWith('|') && trimmed.endsWith('|')) {
      const next = (lines[i + 1] || '').trim();
      const isSeparator = /^\|[\s:|-]+\|$/.test(next) && next.includes('-');
      if (isSeparator) {
        closeLists();
        out.push('<div class="diff-table-wrap"><table class="diff-table"><thead><tr>');
        splitTableCells(trimmed).forEach((cell) => out.push(`<th>${inlineMd(cell)}</th>`));
        out.push('</tr></thead><tbody>');
        i += 2;

        while (i < lines.length) {
          const row = lines[i].trim();
          if (!row.startsWith('|') || !row.endsWith('|')) break;
          out.push('<tr>');
          splitTableCells(row).forEach((cell) => out.push(`<td>${inlineMd(cell)}</td>`));
          out.push('</tr>');
          i++;
        }

        out.push('</tbody></table></div>');
        continue;
      }
    }

    const headingMatch = /^(#{1,3}) (.+)$/.exec(trimmed);
    if (headingMatch) {
      closeLists();
      const level = headingMatch[1].length;
      out.push(`<h${level}>${inlineMd(headingMatch[2])}</h${level}>`);
      i++;
      continue;
    }

    const listMatch = /^(\s*)[-*] (.+)$/.exec(line);
    if (listMatch) {
      const targetDepth = Math.floor(listMatch[1].length / 2) + 1;
      closeListsTo(targetDepth);
      openListTo(targetDepth);

      const current = listStack[listStack.length - 1];
      if (current.liOpen) out.push('</li>');
      out.push(`<li>${inlineMd(listMatch[2])}`);
      current.liOpen = true;
      i++;
      continue;
    }

    closeLists();
    out.push(`<p>${inlineMd(trimmed)}</p>`);
    i++;
  }

  closeLists();
  return out.join('\n');
}
