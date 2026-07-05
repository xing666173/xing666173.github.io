const NOTE_PATH = "./notes.md";
const HIGHLIGHT_CLASS = "search-hit";

let appState = {
  markdown: "",
  sections: [],
  query: "",
};

export function slugifyHeading(title) {
  const withoutCode = title.replace(/`([^`]+)`/g, "$1");
  const ascii = withoutCode
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  if (ascii) {
    return ascii.slice(0, 80).replace(/-+$/g, "");
  }

  const readable = withoutCode
    .trim()
    .replace(/\s+/g, "-")
    .replace(/[^\p{L}\p{N}-]+/gu, "")
    .slice(0, 40)
    .replace(/-+$/g, "");

  return readable || "section";
}

export function parseMarkdownSections(markdown) {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const sections = [];
  const seenIds = new Map();
  let current = null;

  const uniqueId = (title) => {
    const base = slugifyHeading(title);
    const count = seenIds.get(base) || 0;
    seenIds.set(base, count + 1);
    return count === 0 ? base : `${base}-${count + 1}`;
  };

  const pushCurrent = () => {
    if (!current) return;
    current.raw = current.raw.join("\n").trim();
    current.text = stripMarkdown(current.raw);
    sections.push(current);
  };

  for (const line of lines) {
    const heading = line.match(/^(#{1,4})\s+(.+?)\s*$/);
    if (heading) {
      pushCurrent();
      const title = stripInlineMarkdown(heading[2]);
      current = {
        id: uniqueId(title),
        level: heading[1].length,
        title,
        raw: [],
        text: "",
      };
      continue;
    }

    if (current) {
      current.raw.push(line);
    }
  }

  pushCurrent();
  return sections;
}

export function searchSections(sections, query) {
  const terms = tokenize(query);
  if (!terms.length) return [];

  return sections
    .map((section) => {
      const title = normalizeText(section.title);
      const body = normalizeText(section.text);
      const matched = terms.every((term) => title.includes(term) || body.includes(term));
      if (!matched) return null;

      let score = 0;
      for (const term of terms) {
        score += title.includes(term) ? 8 : 0;
        score += countOccurrences(body, term);
      }

      return {
        ...section,
        score,
        snippet: createSnippet(section.text || section.title, terms),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title, "zh-Hans-CN"));
}

export function createSnippet(text, terms) {
  const clean = stripMarkdown(text).replace(/\s+/g, " ").trim();
  if (!clean) return "";

  const lower = normalizeText(clean);
  let firstIndex = -1;
  for (const term of terms) {
    const index = lower.indexOf(term);
    if (index >= 0 && (firstIndex < 0 || index < firstIndex)) {
      firstIndex = index;
    }
  }

  const start = Math.max(0, firstIndex < 0 ? 0 : firstIndex - 54);
  const end = Math.min(clean.length, start + 180);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < clean.length ? "..." : "";
  let snippet = escapeHtml(prefix + clean.slice(start, end) + suffix);

  for (const term of terms.filter(Boolean).sort((a, b) => b.length - a.length)) {
    const safeTerm = escapeRegExp(escapeHtml(term));
    snippet = snippet.replace(new RegExp(safeTerm, "gi"), (match) => `<mark>${match}</mark>`);
  }

  return snippet;
}

function tokenize(query) {
  return normalizeText(query)
    .split(/[\s,，。；;:：、]+/)
    .map((term) => term.trim())
    .filter(Boolean);
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function countOccurrences(text, term) {
  if (!term) return 0;
  let count = 0;
  let index = 0;
  while ((index = text.indexOf(term, index)) !== -1) {
    count += 1;
    index += term.length;
  }
  return count;
}

function stripMarkdown(markdown) {
  return stripInlineMarkdown(
    markdown
      .replace(/```[\s\S]*?```/g, " ")
      .replace(/^\s{0,3}#{1,6}\s+/gm, "")
      .replace(/^\s{0,3}>\s?/gm, "")
      .replace(/^\s*[-*+]\s+/gm, "")
      .replace(/^\s*\d+\.\s+/gm, "")
      .replace(/\|/g, " ")
      .replace(/[-:]{3,}/g, " ")
  ).trim();
}

function stripInlineMarkdown(value) {
  return String(value || "")
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[`*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function renderMarkdown(markdown, sections) {
  const idQueue = [...sections];
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let listType = null;
  let inCode = false;
  let codeBuffer = [];

  const closeParagraph = () => {
    if (!paragraph.length) return;
    html.push(`<p>${renderInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const closeList = () => {
    if (!listType) return;
    html.push(`</${listType}>`);
    listType = null;
  };

  const closeBlocks = () => {
    closeParagraph();
    closeList();
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeBuffer.join("\n"))}</code></pre>`);
        codeBuffer = [];
        inCode = false;
      } else {
        closeBlocks();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeBuffer.push(line);
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+?)\s*$/);
    if (heading) {
      closeBlocks();
      const level = Math.min(6, heading[1].length);
      const title = stripInlineMarkdown(heading[2]);
      const section = idQueue.find((item) => item.title === title && item.level === level);
      if (section) idQueue.splice(idQueue.indexOf(section), 1);
      const id = section ? section.id : slugifyHeading(title);
      html.push(`<h${level} id="${escapeHtml(id)}">${renderInline(heading[2])}</h${level}>`);
      continue;
    }

    if (!line.trim()) {
      closeBlocks();
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      closeBlocks();
      html.push("<hr>");
      continue;
    }

    const table = collectTable(lines, i);
    if (table) {
      closeBlocks();
      html.push(renderTable(table.rows));
      i = table.endIndex;
      continue;
    }

    const quote = line.match(/^\s{0,3}>\s?(.*)$/);
    if (quote) {
      closeBlocks();
      html.push(`<blockquote>${renderInline(quote[1])}</blockquote>`);
      continue;
    }

    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (unordered || ordered) {
      closeParagraph();
      const nextType = unordered ? "ul" : "ol";
      if (listType && listType !== nextType) closeList();
      if (!listType) {
        listType = nextType;
        html.push(`<${listType}>`);
      }
      html.push(`<li>${renderInline((unordered || ordered)[1])}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  closeBlocks();
  return html.join("\n");
}

function collectTable(lines, startIndex) {
  const current = lines[startIndex];
  const next = lines[startIndex + 1] || "";
  if (!current.includes("|") || !/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(next)) {
    return null;
  }

  const rows = [current, next];
  let index = startIndex + 2;
  while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
    rows.push(lines[index]);
    index += 1;
  }

  return { rows, endIndex: index - 1 };
}

function renderTable(rows) {
  const cells = rows.map((row) =>
    row
      .trim()
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell) => cell.trim())
  );
  const header = cells[0] || [];
  const body = cells.slice(2);

  return [
    "<div class=\"table-wrap\"><table>",
    "<thead><tr>",
    ...header.map((cell) => `<th>${renderInline(cell)}</th>`),
    "</tr></thead>",
    "<tbody>",
    ...body.map((row) => `<tr>${row.map((cell) => `<td>${renderInline(cell)}</td>`).join("")}</tr>`),
    "</tbody></table></div>",
  ].join("");
}

function renderInline(value) {
  let html = escapeHtml(value);
  const codeParts = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    codeParts.push(`<code>${code}</code>`);
    return `@@CODE${codeParts.length - 1}@@`;
  });
  html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
  html = html.replace(/@@CODE(\d+)@@/g, (_, index) => codeParts[Number(index)]);
  return html;
}

function byId(id) {
  return document.getElementById(id);
}

function renderToc(sections) {
  const toc = byId("toc");
  toc.innerHTML = sections
    .filter((section) => section.level <= 3)
    .map(
      (section) =>
        `<a class="toc-link level-${section.level}" href="#${escapeHtml(section.id)}">${escapeHtml(section.title)}</a>`
    )
    .join("");
}

function renderStats(sections) {
  byId("sectionCount").textContent = String(sections.length);
  byId("termCount").textContent = String((appState.markdown.match(/专业说法/g) || []).length);
}

function renderResults(query) {
  const results = searchSections(appState.sections, query);
  const resultsEl = byId("results");
  const countEl = byId("resultCount");
  countEl.textContent = query.trim() ? `${results.length} 条结果` : "输入关键词开始搜索";

  if (!query.trim()) {
    resultsEl.innerHTML = `
      <div class="empty-state">
        <strong>试试这些关键词</strong>
        <button data-query="ZKP">ZKP</button>
        <button data-query="PTU">PTU</button>
        <button data-query="1829x">1829x</button>
        <button data-query="Batch Modular Inversion">Batch Modular Inversion</button>
      </div>
    `;
    return;
  }

  if (!results.length) {
    resultsEl.innerHTML = `<p class="empty-state">没有找到匹配内容。可以换成英文缩写，比如 zkVM、MTU、PTU、MMAC。</p>`;
    return;
  }

  resultsEl.innerHTML = results
    .slice(0, 30)
    .map(
      (result) => `
        <a class="result-item" href="#${escapeHtml(result.id)}">
          <span class="result-title">${escapeHtml(result.title)}</span>
          <span class="result-snippet">${result.snippet}</span>
        </a>
      `
    )
    .join("");
}

function highlightArticle(query) {
  const article = byId("article");
  article.querySelectorAll(`.${HIGHLIGHT_CLASS}`).forEach((node) => {
    const parent = node.parentNode;
    parent.replaceChild(document.createTextNode(node.textContent), node);
    parent.normalize();
  });

  const terms = tokenize(query).filter((term) => term.length >= 2 || /[\u4e00-\u9fff]/.test(term));
  if (!terms.length) return;

  const pattern = new RegExp(terms.map(escapeRegExp).join("|"), "gi");
  const walker = document.createTreeWalker(article, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      if (!node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
      if (node.parentElement.closest("script, style, code, pre")) return NodeFilter.FILTER_REJECT;
      return pattern.test(node.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });

  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  nodes.forEach((node) => {
    const frag = document.createDocumentFragment();
    const parts = node.nodeValue.split(pattern);
    const matches = node.nodeValue.match(pattern) || [];
    parts.forEach((part, index) => {
      if (part) frag.appendChild(document.createTextNode(part));
      if (matches[index]) {
        const mark = document.createElement("mark");
        mark.className = HIGHLIGHT_CLASS;
        mark.textContent = matches[index];
        frag.appendChild(mark);
      }
    });
    node.parentNode.replaceChild(frag, node);
  });
}

function setupInteractions() {
  const search = byId("search");
  const clear = byId("clearSearch");

  const runSearch = () => {
    appState.query = search.value;
    renderResults(appState.query);
    highlightArticle(appState.query);
  };

  search.addEventListener("input", runSearch);
  clear.addEventListener("click", () => {
    search.value = "";
    runSearch();
    search.focus();
  });

  byId("results").addEventListener("click", (event) => {
    const preset = event.target.closest("[data-query]");
    if (preset) {
      search.value = preset.dataset.query;
      runSearch();
      return;
    }
  });

  byId("expandToc").addEventListener("click", () => {
    document.body.classList.toggle("toc-compact");
  });
}

async function loadNotes() {
  const response = await fetch(NOTE_PATH, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`无法加载 ${NOTE_PATH}: ${response.status}`);
  }
  return response.text();
}

async function init() {
  const article = byId("article");
  try {
    appState.markdown = await loadNotes();
    appState.sections = parseMarkdownSections(appState.markdown);
    article.innerHTML = renderMarkdown(appState.markdown, appState.sections);
    renderToc(appState.sections);
    renderStats(appState.sections);
    setupInteractions();
    renderResults("");
  } catch (error) {
    article.innerHTML = `
      <section class="load-error">
        <h2>讲义加载失败</h2>
        <p>${escapeHtml(error.message)}</p>
        <p>如果你是直接双击打开 HTML，请改用本地服务器或 GitHub Pages 访问，这样浏览器才能读取 <code>notes.md</code>。</p>
      </section>
    `;
  }
}

if (typeof document !== "undefined") {
  init();
}
