/**
 * OmniLauncher Markdown renderer — shared across ChatBubble and FormattedSubtitle.
 * Extracted from App.tsx to avoid duplication.
 */

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function safeHref(href: string): string {
  const trimmed = href.trim();
  if (/^mailto:/i.test(trimmed)) return escapeHtml(trimmed);
  if (/^https?:/i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname) return escapeHtml(trimmed);
    } catch {
      // Invalid URLs are rendered inert below.
    }
  }
  return "#";
}

const BARE_URL_PATTERN =
  /(^|[\s>(\[{*~'"]|&(?:lt|quot|#39);)((?:https?:\/\/|www\.)(?:(?!&(?:lt|gt|quot|#39);)[^\s<>"`*~])+)/gi;

function decodeEscapedUrl(url: string): string {
  return url
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function splitTrailingPunctuation(candidate: string): [string, string] {
  const openCounts = { "(": 0, "[": 0, "{": 0 };
  const closeCounts = { ")": 0, "]": 0, "}": 0 };
  for (const character of candidate) {
    if (character in openCounts) {
      openCounts[character as keyof typeof openCounts]++;
    } else if (character in closeCounts) {
      closeCounts[character as keyof typeof closeCounts]++;
    }
  }

  const pairs = { ")": "(", "]": "[", "}": "{" } as const;
  let end = candidate.length;
  while (end > 0) {
    const last = candidate[end - 1];
    const opener = pairs[last as keyof typeof pairs];
    const unmatchedCloser =
      opener !== undefined &&
      closeCounts[last as keyof typeof closeCounts] > openCounts[opener];
    const punctuationBeforeUnmatchedCloser =
      /[!?]/.test(last) &&
      end > 1 &&
      pairs[candidate[end - 2] as keyof typeof pairs] !== undefined;
    if (
      !/[.,;:]/.test(last) &&
      !unmatchedCloser &&
      !punctuationBeforeUnmatchedCloser
    ) break;
    if (punctuationBeforeUnmatchedCloser) {
      end--;
      continue;
    }
    if (unmatchedCloser) closeCounts[last as keyof typeof closeCounts]--;
    end--;
  }
  return [candidate.slice(0, end), candidate.slice(end)];
}

function formatEmphasis(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>")
    .replace(/~~(.+?)~~/g, "<del>$1</del>");
}

function formatBareUrls(text: string): string {
  let result = "";
  let cursor = 0;
  BARE_URL_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(BARE_URL_PATTERN)) {
    const prefix = match[1];
    const candidate = match[2];
    result += text.slice(cursor, match.index) + prefix;
    const [bareUrl, suffix] = splitTrailingPunctuation(candidate);
    const decodedUrl = decodeEscapedUrl(bareUrl);
    const url = /^www\./i.test(decodedUrl) ? `https://${decodedUrl}` : decodedUrl;
    const href = safeHref(url);
    result += href === "#"
      ? `${bareUrl}${suffix}`
      : `<a class="md-link" href="${href}" target="_blank">${bareUrl}</a>${suffix}`;
    cursor = match.index! + match[0].length;
  }
  return formatEmphasis(result + text.slice(cursor));
}

function formatText(text: string): string {
  let result = "";
  let plainStart = 0;
  let labelStart = -1;
  let labelEnd = -1;
  let hrefParenDepth = 0;

  for (let index = 0; index < text.length; index++) {
    if (labelEnd >= 0) {
      if (text[index] === "(") {
        hrefParenDepth++;
        continue;
      }
      if (text[index] !== ")") continue;
      if (hrefParenDepth > 0) {
        hrefParenDepth--;
        continue;
      }
      if (index === labelEnd + 2) {
        labelStart = -1;
        labelEnd = -1;
        continue;
      }
      result += formatBareUrls(text.slice(plainStart, labelStart));
      const label = text.slice(labelStart + 1, labelEnd);
      const href = text.slice(labelEnd + 2, index);
      result += `<a class="md-link" href="${safeHref(decodeEscapedUrl(href))}" target="_blank">${formatEmphasis(label)}</a>`;
      plainStart = index + 1;
      labelStart = -1;
      labelEnd = -1;
      continue;
    }

    if (text[index] === "[") {
      labelStart = index;
    } else if (
      labelStart >= 0 &&
      index > labelStart + 1 &&
      text[index] === "]" &&
      text[index + 1] === "("
    ) {
      labelEnd = index;
      hrefParenDepth = 0;
      index++;
    }
  }

  return result + formatBareUrls(text.slice(plainStart));
}

export function inlineFormat(text: string): string {
  return text
    .split(/(`[^`]+?`)/g)
    .map((segment) =>
      segment.startsWith("`") && segment.endsWith("`")
        ? `<code class="md-inline-code">${segment.slice(1, -1)}</code>`
        : formatText(segment),
    )
    .join("");
}

export function renderTable(rows: string[]): string {
  if (rows.length === 0) return "";
  const parseRow = (row: string) =>
    row
      .split("|")
      .filter((_c, i, arr) => i > 0 && i < arr.length - 1)
      .map((c) => escapeHtml(c.trim()));

  let html = '<table class="md-table"><thead><tr>';
  const header = parseRow(rows[0]);
  header.forEach((cell) => {
    html += `<th>${inlineFormat(cell)}</th>`;
  });
  html += "</tr></thead><tbody>";
  for (let i = 1; i < rows.length; i++) {
    html += "<tr>";
    parseRow(rows[i]).forEach((cell) => {
      html += `<td>${inlineFormat(cell)}</td>`;
    });
    html += "</tr>";
  }
  html += "</tbody></table>";
  // Wrap the table so wide tables can break out of the reading column and/or
  // scroll horizontally without stretching the surrounding prose. ChatPane
  // measures `.md-table-wrap` after render and sets the breakout amount.
  return `<div class="md-table-wrap">${html}</div>`;
}

export function renderMarkdown(text: string): string {
  let html = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const escaped = escapeHtml(code.trimEnd());
    return `<pre class="md-codeblock"><code class="md-lang-${lang || "text"}">${escaped}</code></pre>`;
  });

  const lines = html.split("\n");
  const result: string[] = [];
  let inList = false;
  let listType = "";
  let inTable = false;
  let tableRows: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.includes('<pre class="md-codeblock">')) {
      result.push(line);
      while (i < lines.length - 1 && !lines[i].includes("</pre>")) {
        i++;
        result.push(lines[i]);
      }
      continue;
    }

    if (line.match(/^\|(.+)\|$/)) {
      if (!inTable) {
        inTable = true;
        tableRows = [];
      }
      if (!line.match(/^\|[\s\-:|]+\|$/)) tableRows.push(line);
      continue;
    } else if (inTable) {
      inTable = false;
      result.push(renderTable(tableRows));
      tableRows = [];
    }

    if (inList && !line.match(/^(\s*[-*]\s|^\s*\d+\.\s)/)) {
      result.push(listType === "ul" ? "</ul>" : "</ol>");
      inList = false;
    }

    if (line.match(/^#{1,6}\s/)) {
      const level = line.match(/^(#{1,6})\s/)![1].length;
      const content = escapeHtml(line.replace(/^#{1,6}\s/, ""));
      result.push(
        `<h${level} class="md-h${level}">${inlineFormat(content)}</h${level}>`,
      );
      continue;
    }

    if (line.match(/^\s*[-*]\s/)) {
      if (!inList || listType !== "ul") {
        if (inList) result.push("</ol>");
        result.push('<ul class="md-list">');
        inList = true;
        listType = "ul";
      }
      result.push(
        `<li>${inlineFormat(escapeHtml(line.replace(/^\s*[-*]\s/, "")))}</li>`,
      );
      continue;
    }

    if (line.match(/^\s*\d+\.\s/)) {
      if (!inList || listType !== "ol") {
        if (inList) result.push("</ul>");
        result.push('<ol class="md-list">');
        inList = true;
        listType = "ol";
      }
      result.push(
        `<li>${inlineFormat(escapeHtml(line.replace(/^\s*\d+\.\s/, "")))}</li>`,
      );
      continue;
    }

    if (line.match(/^---+$/)) {
      result.push('<hr class="md-hr"/>');
      continue;
    }
    if (line.trim() === "") {
      result.push('<div class="md-spacer"></div>');
      continue;
    }
    result.push(`<p class="md-p">${inlineFormat(escapeHtml(line))}</p>`);
  }

  if (inList) result.push(listType === "ul" ? "</ul>" : "</ol>");
  if (inTable) result.push(renderTable(tableRows));

  return result.join("\n");
}

/**
 * Detect whether a string contains Markdown formatting worth rendering:
 * tables, fenced code, lists, headers, bold/italic.
 */
export function hasMarkdown(text: string): boolean {
  return (
    /^\|.+\|/m.test(text) || // table rows
    /```/.test(text) || // fenced code
    /^#{1,6}\s/m.test(text) || // headers
    /^\s*[-*]\s/m.test(text) || // unordered list
    /^\s*\d+\.\s/m.test(text) || // ordered list
    /\*\*.+\*\*/.test(text) || // bold
    /`[^`]+`/.test(text) // inline code
  );
}
