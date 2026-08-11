import * as katex from "katex";

/**
 * 本地中文 Markdown 文档视图。
 *
 * 一个 Markdown 文件对应一个独立页面：左栏切换页面，中栏渲染正文，右栏只展示
 * 当前页面的二、三级标题。所有正文先转义再应用有限 Markdown 语法，避免执行 HTML。
 */

interface DocumentationPage {
  slug: string;
  title: string;
  group: string;
  order: number;
  description?: string;
  markdown: string;
}

interface DocumentationDocument {
  schemaVersion: number;
  pages: DocumentationPage[];
}

interface DocumentationResponse {
  ok: boolean;
  document?: DocumentationDocument;
  error?: string;
}

interface DocumentationHeading {
  id: string;
  level: number;
  text: string;
}

interface RenderedMarkdown {
  html: string;
  headings: DocumentationHeading[];
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function safeHref(rawHref: string): string {
  const href = rawHref.trim();
  return /^(?:https?:\/\/|mailto:|\/|#)/i.test(href) ? href : "#";
}

/** 将受控 LaTeX 片段转换为同时包含可视公式与无障碍 MathML 的 HTML。 */
function renderMath(source: string, displayMode: boolean): string {
  const formula = source.trim();
  if (!formula) return "";
  try {
    return katex.renderToString(formula, {
      displayMode,
      output: "htmlAndMathml",
      strict: "ignore",
      throwOnError: true,
      trust: false,
    });
  } catch {
    return `<span class="documentation-math-error" title="公式语法无法解析">${escapeHtml(formula)}</span>`;
  }
}

/** 渲染常用行内 Markdown；占位符确保代码与公式内容不会再次参与格式匹配。 */
function renderInline(source: string): string {
  const tokens: string[] = [];
  const withCode = source.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = tokens.push(`<code>${escapeHtml(code)}</code>`) - 1;
    return `\u0000${index}\u0000`;
  });
  const tokenized = withCode.replace(/\\\((.+?)\\\)/g, (_match, formula: string) => {
    const index = tokens.push(renderMath(formula, false)) - 1;
    return `\u0000${index}\u0000`;
  });
  const escaped = escapeHtml(tokenized)
    .replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;([^&]*)&quot;)?\)/g, (_match, label: string, href: string, title: string | undefined) => {
      const safe = escapeHtml(safeHref(href));
      const external = /^https?:\/\//i.test(href);
      const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
      const externalAttributes = external ? ' target="_blank" rel="noreferrer"' : "";
      return `<a href="${safe}"${titleAttribute}${externalAttributes}>${label}</a>`;
    })
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<em>$1</em>");
  return escaped.replace(/\u0000(\d+)\u0000/g, (_match, index: string) => tokens[Number(index)] || "");
}

function headingId(text: string, counts: Map<string, number>): string {
  const base = text
    .replace(/[`*_~]/g, "")
    .trim()
    .toLocaleLowerCase("zh-CN")
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "section";
  const count = counts.get(base) || 0;
  counts.set(base, count + 1);
  return count ? `${base}-${count + 1}` : base;
}

function splitTableRow(line: string): string[] {
  return line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function startsBlock(lines: string[], index: number): boolean {
  const line = lines[index] || "";
  return /^#{1,3}\s+/.test(line)
    || /^\s*\\\[/.test(line)
    || /^```/.test(line)
    || /^>\s?/.test(line)
    || /^\s*(?:[-+*]|\d+\.)\s+/.test(line)
    || /^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)
    || (line.includes("|") && isTableSeparator(lines[index + 1] || ""));
}

/** 将受控 Markdown 子集转换为语义化 HTML，同时生成当前页目录。 */
function renderMarkdown(markdown: string): RenderedMarkdown {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const html: string[] = [];
  const headings: DocumentationHeading[] = [];
  const headingCounts = new Map<string, number>();
  let index = 0;

  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }

    const heading = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const text = heading[2].replace(/\s+#+\s*$/, "").trim();
      const id = headingId(text, headingCounts);
      if (level > 1) headings.push({ id, level, text });
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInline(text)}</h${level}>`);
      index += 1;
      continue;
    }

    const blockMath = /^\s*\\\[(.*)$/.exec(line);
    if (blockMath) {
      const formulaLines: string[] = [];
      let remainder = blockMath[1];
      const closesOnFirstLine = /\\\]\s*$/.test(remainder);
      if (closesOnFirstLine) {
        formulaLines.push(remainder.replace(/\\\]\s*$/, ""));
        index += 1;
      } else {
        if (remainder.trim()) formulaLines.push(remainder);
        index += 1;
        while (index < lines.length && !/\\\]\s*$/.test(lines[index])) {
          formulaLines.push(lines[index]);
          index += 1;
        }
        if (index < lines.length) {
          const closingLine = lines[index].replace(/\\\]\s*$/, "");
          if (closingLine.trim()) formulaLines.push(closingLine);
          index += 1;
        }
      }
      html.push(`<div class="documentation-math-block">${renderMath(formulaLines.join("\n"), true)}</div>`);
      continue;
    }

    const fence = /^```\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !/^```\s*$/.test(lines[index])) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) index += 1;
      const language = fence[1] || "text";
      html.push(`<figure class="documentation-code"><figcaption>${escapeHtml(language)}</figcaption><pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre></figure>`);
      continue;
    }

    if (line.includes("|") && isTableSeparator(lines[index + 1] || "")) {
      const headers = splitTableRow(line);
      index += 2;
      const rows: string[][] = [];
      while (index < lines.length && lines[index].trim() && lines[index].includes("|")) {
        rows.push(splitTableRow(lines[index]));
        index += 1;
      }
      html.push(`<div class="documentation-table-wrap"><table><thead><tr>${headers.map((cell) => `<th scope="col">${renderInline(cell)}</th>`).join("")}</tr></thead><tbody>${rows.map((row) => `<tr>${headers.map((_header, cellIndex) => `${cellIndex === 0 ? '<th scope="row">' : "<td>"}${renderInline(row[cellIndex] || "")}${cellIndex === 0 ? "</th>" : "</td>"}`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quoted: string[] = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) {
        quoted.push(lines[index].replace(/^>\s?/, ""));
        index += 1;
      }
      const callout = /^\[!(NOTE|TIP|IMPORTANT|WARNING)\]\s*(.*)$/i.exec(quoted[0] || "");
      if (callout) {
        const tone = callout[1].toLocaleLowerCase();
        const body = [callout[2], ...quoted.slice(1)].filter(Boolean).join(" ");
        const labels: Record<string, string> = { note: "说明", tip: "提示", important: "重要", warning: "注意" };
        html.push(`<aside class="documentation-callout is-${tone}" role="note"><strong>${labels[tone]}</strong><p>${renderInline(body)}</p></aside>`);
      } else {
        html.push(`<blockquote>${renderInline(quoted.join(" "))}</blockquote>`);
      }
      continue;
    }

    const listMatch = /^\s*([-+*]|\d+\.)\s+(.+)$/.exec(line);
    if (listMatch) {
      const ordered = /\d+\./.test(listMatch[1]);
      const items: string[] = [];
      const listPattern = ordered ? /^\s*\d+\.\s+(.+)$/ : /^\s*[-+*]\s+(.+)$/;
      while (index < lines.length) {
        const item = listPattern.exec(lines[index]);
        if (!item) break;
        items.push(item[1]);
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      html.push(`<${tag}>${items.map((item) => `<li>${renderInline(item)}</li>`).join("")}</${tag}>`);
      continue;
    }

    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) {
      html.push("<hr>");
      index += 1;
      continue;
    }

    const paragraph: string[] = [line.trim()];
    index += 1;
    while (index < lines.length && lines[index].trim() && !startsBlock(lines, index)) {
      paragraph.push(lines[index].trim());
      index += 1;
    }
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
  }
  return { html: html.join("\n"), headings };
}

function groupedPages(pages: DocumentationPage[]): Array<[string, DocumentationPage[]]> {
  const groups = new Map<string, DocumentationPage[]>();
  pages.forEach((page) => groups.set(page.group, [...(groups.get(page.group) || []), page]));
  return Array.from(groups.entries());
}

function documentationHash(slug: string, heading = ""): string {
  return `#documentation/${encodeURIComponent(slug)}${heading ? `/${encodeURIComponent(heading)}` : ""}`;
}

function hashLocation(): { slug: string; heading: string } | null {
  const match = /^#documentation\/([^/]+)(?:\/(.+))?$/.exec(window.location.hash);
  if (!match) return null;
  return {
    slug: decodeURIComponent(match[1]),
    heading: match[2] ? decodeURIComponent(match[2]) : "",
  };
}

class DocumentationView {
  private readonly root: HTMLElement;
  private document: DocumentationDocument | null = null;
  private activeSlug = "";
  private loadingPromise: Promise<void> | null = null;
  private observer: IntersectionObserver | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    this.root.addEventListener("click", (event) => this.handleClick(event));
    window.addEventListener("hashchange", () => this.syncFromHash());
  }

  load(force = false): Promise<void> {
    if (this.document && !force) {
      this.syncFromHash();
      return Promise.resolve();
    }
    if (this.loadingPromise && !force) return this.loadingPromise;
    this.renderLoading();
    this.loadingPromise = this.fetchAndRender().finally(() => {
      this.loadingPromise = null;
    });
    return this.loadingPromise;
  }

  private async fetchAndRender(): Promise<void> {
    try {
      const response = await fetch("/api/documentation", { cache: "no-store" });
      const payload = await response.json() as DocumentationResponse;
      if (!response.ok || !payload.ok || !payload.document?.pages.length) {
        throw new Error(payload.error || "文档接口未返回 Markdown 页面");
      }
      this.document = payload.document;
      const requested = hashLocation();
      this.activeSlug = payload.document.pages.some((page) => page.slug === requested?.slug)
        ? requested!.slug
        : payload.document.pages[0].slug;
      this.renderPage(requested?.heading || "");
    } catch (error) {
      this.document = null;
      this.renderError(error instanceof Error ? error.message : "文档加载失败");
    }
  }

  private renderLoading(): void {
    this.root.setAttribute("aria-busy", "true");
    this.root.innerHTML = `<div class="documentation-state" role="status"><span class="documentation-spinner" aria-hidden="true"></span><strong>正在读取本地 Markdown</strong><p>内容来自 realtime_scheduler/data/documentation，不会进入 Git。</p></div>`;
  }

  private renderError(message: string): void {
    this.root.removeAttribute("aria-busy");
    this.root.innerHTML = `<div class="documentation-state is-error" role="alert"><span aria-hidden="true">!</span><strong>文档暂不可用</strong><p>${escapeHtml(message)}</p><button class="btn primary" type="button" data-documentation-retry>重新读取</button></div>`;
  }

  private renderPage(pendingHeading = ""): void {
    if (!this.document) return;
    const pageIndex = this.document.pages.findIndex((page) => page.slug === this.activeSlug);
    const page = this.document.pages[Math.max(0, pageIndex)];
    const rendered = renderMarkdown(page.markdown);
    const previous = pageIndex > 0 ? this.document.pages[pageIndex - 1] : null;
    const next = pageIndex < this.document.pages.length - 1 ? this.document.pages[pageIndex + 1] : null;

    this.root.removeAttribute("aria-busy");
    this.root.innerHTML = `<div class="documentation-layout">
      <nav class="documentation-navigation" aria-label="文档页面">
        ${groupedPages(this.document.pages).map(([group, pages]) => `<section><strong>${escapeHtml(group)}</strong>${pages.map((item) => `<a href="${documentationHash(item.slug)}" data-documentation-page="${escapeHtml(item.slug)}"${item.slug === page.slug ? ' aria-current="page"' : ""}>${escapeHtml(item.title)}</a>`).join("")}</section>`).join("")}
      </nav>
      <main class="documentation-content" data-documentation-content>
        <p class="documentation-breadcrumb">使用文档 <span aria-hidden="true">/</span> ${escapeHtml(page.group)}</p>
        <article class="documentation-markdown">${rendered.html}</article>
        <nav class="documentation-pagination" aria-label="相邻文档页面">
          ${previous ? `<a href="${documentationHash(previous.slug)}" data-documentation-page="${escapeHtml(previous.slug)}"><small>上一页</small><strong>← ${escapeHtml(previous.title)}</strong></a>` : "<span></span>"}
          ${next ? `<a href="${documentationHash(next.slug)}" data-documentation-page="${escapeHtml(next.slug)}"><small>下一页</small><strong>${escapeHtml(next.title)} →</strong></a>` : ""}
        </nav>
      </main>
      <aside class="documentation-on-page" aria-label="当前页面目录">
        <strong><span aria-hidden="true">☰</span> 本页内容</strong>
        ${rendered.headings.length ? rendered.headings.map((heading) => `<a class="is-level-${heading.level}" href="${documentationHash(page.slug, heading.id)}" data-documentation-heading="${escapeHtml(heading.id)}">${escapeHtml(heading.text)}</a>`).join("") : "<span>本页暂无小节</span>"}
      </aside>
    </div>`;
    this.observeHeadings();
    requestAnimationFrame(() => {
      const target = pendingHeading
        ? this.root.querySelector<HTMLElement>(`#${CSS.escape(pendingHeading)}`)
        : this.root.querySelector<HTMLElement>(".documentation-markdown h1");
      target?.scrollIntoView({ block: "start" });
    });
  }

  private handleClick(event: Event): void {
    const target = event.target as Element | null;
    if (target?.closest("[data-documentation-retry]")) {
      void this.load(true);
      return;
    }
    const pageLink = target?.closest<HTMLElement>("[data-documentation-page]");
    if (pageLink?.dataset.documentationPage) {
      event.preventDefault();
      this.showPage(pageLink.dataset.documentationPage);
      return;
    }
    const headingLink = target?.closest<HTMLElement>("[data-documentation-heading]");
    if (headingLink?.dataset.documentationHeading) {
      event.preventDefault();
      const heading = headingLink.dataset.documentationHeading;
      history.replaceState(null, "", documentationHash(this.activeSlug, heading));
      this.root.querySelectorAll<HTMLElement>("[data-documentation-heading]").forEach((link) => {
        if (link.dataset.documentationHeading === heading) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
      this.root.querySelector<HTMLElement>(`#${CSS.escape(heading)}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }

  private showPage(slug: string): void {
    if (!this.document?.pages.some((page) => page.slug === slug)) return;
    this.activeSlug = slug;
    history.replaceState(null, "", documentationHash(slug));
    this.renderPage();
  }

  private syncFromHash(): void {
    const requested = hashLocation();
    if (!requested || !this.document?.pages.some((page) => page.slug === requested.slug)) return;
    if (requested.slug !== this.activeSlug) {
      this.activeSlug = requested.slug;
      this.renderPage(requested.heading);
      return;
    }
    if (requested.heading) {
      this.root.querySelector<HTMLElement>(`#${CSS.escape(requested.heading)}`)?.scrollIntoView({ block: "start" });
    }
  }

  private observeHeadings(): void {
    this.observer?.disconnect();
    if (!("IntersectionObserver" in window)) return;
    this.observer = new IntersectionObserver((entries) => {
      const current = entries
        .filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (!current) return;
      const id = (current.target as HTMLElement).id;
      this.root.querySelectorAll<HTMLElement>("[data-documentation-heading]").forEach((link) => {
        if (link.dataset.documentationHeading === id) link.setAttribute("aria-current", "location");
        else link.removeAttribute("aria-current");
      });
    }, { rootMargin: "-2% 0px -82% 0px", threshold: 0 });
    this.root.querySelectorAll<HTMLElement>(".documentation-markdown h2, .documentation-markdown h3").forEach((heading) => this.observer?.observe(heading));
  }
}

export function createDocumentationView(root: HTMLElement): DocumentationView {
  return new DocumentationView(root);
}
