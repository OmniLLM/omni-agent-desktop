import { describe, it, expect } from "vitest";
import {
  escapeHtml,
  safeHref,
  inlineFormat,
  renderTable,
  renderMarkdown,
  hasMarkdown,
} from "./markdown";

// ===========================================================================
// escapeHtml
// ===========================================================================

describe("escapeHtml", () => {
  it("escapes ampersand", () => {
    expect(escapeHtml("a & b")).toBe("a &amp; b");
  });

  it("escapes angle brackets", () => {
    expect(escapeHtml("<script>alert('xss')</script>")).toBe(
      "&lt;script&gt;alert(&#39;xss&#39;)&lt;/script&gt;"
    );
  });

  it("escapes double and single quotes", () => {
    expect(escapeHtml('"hello" \'world\'')).toBe("&quot;hello&quot; &#39;world&#39;");
  });

  it("handles empty string", () => {
    expect(escapeHtml("")).toBe("");
  });

  it("passes through safe text unchanged", () => {
    expect(escapeHtml("Hello World 123")).toBe("Hello World 123");
  });

  it("escapes multiple special characters together", () => {
    expect(escapeHtml('<a href="x">&')).toBe("&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

// ===========================================================================
// safeHref
// ===========================================================================

describe("safeHref", () => {
  it("allows http URLs", () => {
    expect(safeHref("http://example.com")).toBe("http://example.com");
  });

  it("allows https URLs", () => {
    expect(safeHref("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1"
    );
  });

  it("allows mailto links", () => {
    expect(safeHref("mailto:user@example.com")).toBe("mailto:user@example.com");
  });

  it("blocks javascript: URLs", () => {
    expect(safeHref("javascript:alert('xss')")).toBe("#");
  });

  it("blocks data: URLs", () => {
    expect(safeHref("data:text/html,<h1>hi</h1>")).toBe("#");
  });

  it("blocks relative paths", () => {
    expect(safeHref("/etc/passwd")).toBe("#");
  });

  it("blocks ftp URLs", () => {
    expect(safeHref("ftp://files.example.com")).toBe("#");
  });

  it("trims whitespace from href", () => {
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
  });

  it("escapes HTML entities in the URL", () => {
    expect(safeHref('https://example.com?a=1&b="2"')).toContain("&amp;");
  });
});

// ===========================================================================
// inlineFormat
// ===========================================================================

describe("inlineFormat", () => {
  it("formats bold text", () => {
    expect(inlineFormat("**bold**")).toBe("<strong>bold</strong>");
  });

  it("formats italic text", () => {
    expect(inlineFormat("*italic*")).toBe("<em>italic</em>");
  });

  it("formats strikethrough text", () => {
    expect(inlineFormat("~~deleted~~")).toBe("<del>deleted</del>");
  });

  it("formats inline code", () => {
    expect(inlineFormat("`code`")).toBe('<code class="md-inline-code">code</code>');
  });

  it("formats markdown links", () => {
    const result = inlineFormat("[Click](https://example.com)");
    expect(result).toContain('class="md-link"');
    expect(result).toContain("https://example.com");
    expect(result).toContain("Click");
    expect(result).toContain('target="_blank"');
  });

  it("autolinks a bare https URL", () => {
    const result = inlineFormat("See https://example.com for details");
    expect(result).toContain('<a class="md-link" href="https://example.com" target="_blank">https://example.com</a>');
  });

  it("autolinks a bare www URL by adding https scheme to the href", () => {
    const result = inlineFormat("Visit www.example.com now");
    expect(result).toContain('href="https://www.example.com"');
    expect(result).toContain(">www.example.com</a>");
  });

  it("does not double-wrap a markdown link's URL when autolinking", () => {
    const result = inlineFormat("[Click](https://example.com)");
    const matches = result.match(/<a /g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("strips trailing punctuation from an autolinked bare URL", () => {
    const result = inlineFormat("Check https://example.com/path, thanks.");
    expect(result).toContain('href="https://example.com/path"');
  });

  it("keeps bare URLs inside inline code inert", () => {
    expect(renderMarkdown("`https://example.com`"))
      .toContain('<code class="md-inline-code">https://example.com</code>');
    expect(renderMarkdown("`https://example.com`")).not.toContain("md-link");
  });

  it("preserves query parameters in bare URL hrefs", () => {
    const html = renderMarkdown("https://example.com/?a=1&b=2");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/?a=1&b=2",
    );
  });

  it("strips terminal dots as prose punctuation", () => {
    expect(renderMarkdown("Open https://example.com. now")).toContain(
      'href="https://example.com" target="_blank">https://example.com</a>.',
    );
    expect(renderMarkdown("Open https://example.com... now")).toContain(
      'href="https://example.com" target="_blank">https://example.com</a>...',
    );
    expect(renderMarkdown("Open https://example.com/path. now")).toContain(
      'href="https://example.com/path" target="_blank">https://example.com/path</a>.',
    );
  });

  it("keeps balanced parentheses in bare URLs", () => {
    const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    expect(renderMarkdown(url)).toContain(`href="${url}"`);
  });

  it("keeps balanced parentheses in explicit Markdown link destinations", () => {
    const url = "https://en.wikipedia.org/wiki/Function_(mathematics)";
    const html = renderMarkdown(`[Wikipedia](${url})`);
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain(">Wikipedia</a>");
  });

  it("does not autolink www inside another token", () => {
    expect(renderMarkdown("prefixwww.example.com")).not.toContain("md-link");
    expect(renderMarkdown("user@www.example.com")).not.toContain("md-link");
  });

  it("excludes prose punctuation after unmatched URL wrappers", () => {
    expect(renderMarkdown("Open (https://example.com/path)!")).toContain(
      'href="https://example.com/path" target="_blank">https://example.com/path</a>)!',
    );
  });

  it("preserves meaningful terminal URL punctuation", () => {
    expect(renderMarkdown("https://example.com/search?q=what?")).toContain(
      'href="https://example.com/search?q=what?"',
    );
    expect(renderMarkdown("https://example.com/bang!")).toContain(
      'href="https://example.com/bang!"',
    );
  });

  it("does not confuse input with internal formatting state", () => {
    expect(renderMarkdown("[safe](https://safe.test)\0link:0\0").match(/<a /g)).toHaveLength(1);
    expect(renderMarkdown("text\0code:0\0")).toContain("text\0code:0\0");
  });

  it("excludes unmatched closing delimiters from bare URLs", () => {
    expect(renderMarkdown("See {https://example.com}")).toContain(
      'href="https://example.com" target="_blank">https://example.com</a>}',
    );
    expect(renderMarkdown("See https://example.com<next>")).toContain(
      'href="https://example.com" target="_blank">https://example.com</a>',
    );
  });

  it("autolinks bare URLs inside emphasis", () => {
    expect(renderMarkdown("**https://example.com**")).toContain(
      '<strong><a class="md-link" href="https://example.com" target="_blank">https://example.com</a></strong>',
    );
  });

  it("handles angle-bracket autolinks without including the closing entity", () => {
    const html = renderMarkdown("<https://example.com>");
    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com",
    );
    expect(container.textContent).toBe("<https://example.com>");
  });

  it("does not autolink hostless HTTP URLs", () => {
    expect(renderMarkdown("http://?")).not.toContain("md-link");
    expect(safeHref("http://?")).toBe("#");
  });

  it("handles long malformed link syntax without pathological backtracking", () => {
    const malformed = "[".repeat(100_000);
    expect(inlineFormat(malformed)).toBe(malformed);
  });

  it("handles multiple inline formats in one string", () => {
    const result = inlineFormat("**bold** and *italic* and `code`");
    expect(result).toContain("<strong>bold</strong>");
    expect(result).toContain("<em>italic</em>");
    expect(result).toContain('<code class="md-inline-code">code</code>');
  });

  it("passes plain text through unchanged", () => {
    expect(inlineFormat("plain text")).toBe("plain text");
  });
});

// ===========================================================================
// renderTable
// ===========================================================================

describe("renderTable", () => {
  it("returns empty string for empty rows", () => {
    expect(renderTable([])).toBe("");
  });

  it("renders a simple table with header and one row", () => {
    const rows = ["| Name | Age |", "| Alice | 30 |"];
    const html = renderTable(rows);
    expect(html).toContain('<div class="md-table-wrap">');
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<thead>");
    expect(html).toContain("<th>Name</th>");
    expect(html).toContain("<th>Age</th>");
    expect(html).toContain("<tbody>");
    expect(html).toContain("<td>Alice</td>");
    expect(html).toContain("<td>30</td>");
    expect(html).toContain("</table>");
  });

  it("renders multiple body rows", () => {
    const rows = [
      "| Color | Hex |",
      "| Red | #ff0000 |",
      "| Blue | #0000ff |",
    ];
    const html = renderTable(rows);
    expect(html).toContain("<td>Red</td>");
    expect(html).toContain("<td>Blue</td>");
    expect(html).toContain("<td>#ff0000</td>");
  });

  it("applies inline formatting inside table cells", () => {
    const rows = ["| Feature |", "| **bold** |"];
    const html = renderTable(rows);
    expect(html).toContain("<strong>bold</strong>");
  });

  it("escapes HTML in table cells", () => {
    const rows = ["| Header |", "| <script> |"];
    const html = renderTable(rows);
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
});

// ===========================================================================
// renderMarkdown
// ===========================================================================

describe("renderMarkdown", () => {
  it("renders a heading", () => {
    const html = renderMarkdown("# Title");
    expect(html).toContain('<h1 class="md-h1">');
    expect(html).toContain("Title");
  });

  it("renders h2 through h6", () => {
    for (let level = 2; level <= 6; level++) {
      const prefix = "#".repeat(level);
      const html = renderMarkdown(`${prefix} Heading`);
      expect(html).toContain(`<h${level} class="md-h${level}">`);
    }
  });

  it("renders an unordered list", () => {
    const html = renderMarkdown("- Item A\n- Item B");
    expect(html).toContain('<ul class="md-list">');
    expect(html).toContain("<li>Item A</li>");
    expect(html).toContain("<li>Item B</li>");
    expect(html).toContain("</ul>");
  });

  it("renders an ordered list", () => {
    const html = renderMarkdown("1. First\n2. Second");
    expect(html).toContain('<ol class="md-list">');
    expect(html).toContain("<li>First</li>");
    expect(html).toContain("<li>Second</li>");
  });

  it("renders a fenced code block", () => {
    const html = renderMarkdown('```js\nconsole.log("hi");\n```');
    expect(html).toContain('<pre class="md-codeblock">');
    expect(html).toContain('<code class="md-lang-js">');
    expect(html).toContain("console.log");
  });

  it("renders a code block without language", () => {
    const html = renderMarkdown("```\nplain code\n```");
    expect(html).toContain('<code class="md-lang-text">');
    expect(html).toContain("plain code");
  });

  it("renders a horizontal rule", () => {
    const html = renderMarkdown("---");
    expect(html).toContain('<hr class="md-hr"/>');
  });

  it("renders empty lines as spacers", () => {
    const html = renderMarkdown("line1\n\nline2");
    expect(html).toContain('<div class="md-spacer">');
  });

  it("renders a paragraph for plain text", () => {
    const html = renderMarkdown("Just some text");
    expect(html).toContain('<p class="md-p">Just some text</p>');
  });

  it("renders a table within markdown", () => {
    const md = "| Col1 | Col2 |\n|------|------|\n| A | B |";
    const html = renderMarkdown(md);
    expect(html).toContain('<table class="md-table">');
    expect(html).toContain("<td>A</td>");
  });

  it("renders safe links with an external href", () => {
    const html = renderMarkdown("[OpenAI](https://openai.com)");
    expect(html).toContain(
      '<a class="md-link" href="https://openai.com" target="_blank">',
    );
  });

  it("escapes HTML in headings", () => {
    const html = renderMarkdown("# <script>alert('xss')</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("escapes HTML in paragraphs", () => {
    const html = renderMarkdown('<img src="x" onerror="alert(1)">');
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
  });

  it("closes open lists at end of input", () => {
    const html = renderMarkdown("- item");
    expect(html).toContain("</ul>");
  });

  it("closes open tables at end of input", () => {
    const html = renderMarkdown("| A | B |");
    expect(html).toContain("</table>");
  });

  it("renders mixed content correctly", () => {
    const md = "# Title\n\n- item 1\n- item 2\n\nSome **bold** text\n\n```\ncode\n```";
    const html = renderMarkdown(md);
    expect(html).toContain('<h1 class="md-h1">');
    expect(html).toContain("<li>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<pre class="md-codeblock">');
  });
});

// ===========================================================================
// hasMarkdown
// ===========================================================================

describe("hasMarkdown", () => {
  it("detects tables", () => {
    expect(hasMarkdown("| A | B |")).toBe(true);
  });

  it("detects fenced code", () => {
    expect(hasMarkdown("```js\ncode\n```")).toBe(true);
  });

  it("detects headers", () => {
    expect(hasMarkdown("# Hello")).toBe(true);
    expect(hasMarkdown("## Hello")).toBe(true);
  });

  it("detects unordered lists", () => {
    expect(hasMarkdown("- item")).toBe(true);
    expect(hasMarkdown("* item")).toBe(true);
  });

  it("detects ordered lists", () => {
    expect(hasMarkdown("1. item")).toBe(true);
  });

  it("detects bold text", () => {
    expect(hasMarkdown("**bold**")).toBe(true);
  });

  it("detects inline code", () => {
    expect(hasMarkdown("`code`")).toBe(true);
  });

  it("returns false for plain text", () => {
    expect(hasMarkdown("Just plain text without any formatting")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(hasMarkdown("")).toBe(false);
  });
});
