const KEY = "md";
const source = document.getElementById("source");
const preview = document.getElementById("preview");
const mode = document.getElementById("mode");
const themeBtn = document.getElementById("theme");
const canFieldSize = CSS.supports("field-sizing", "content");

const alias = {
  sh: "bash",
  shell: "bash",
  zsh: "bash",
  py: "python",
  js: "javascript",
  ts: "typescript",
  yml: "yaml",
  rs: "rust",
};

let saveTimer = 0;
let paintGen = 0;
let previewReady;
let shikiReady;
const scripts = new Map();

source.value = localStorage.getItem(KEY) || "";
fit();
source.focus();
labelTheme();
warm();

source.addEventListener("input", () => {
  fit();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persist, 300);
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") persist();
});
window.addEventListener("pagehide", persist);
window.addEventListener("resize", fit);

source.addEventListener("keydown", onTab);
source.addEventListener("keydown", (e) => {
  if (e.key === "Escape") mode.focus();
});
mode.addEventListener("pointerenter", warmNow);

mode.addEventListener("click", async () => {
  if (document.body.classList.contains("read")) {
    paintGen += 1;
    document.body.classList.remove("read");
    preview.inert = true;
    source.tabIndex = 0;
    source.focus();
    mode.setAttribute("aria-label", "Preview");
    return;
  }

  const n = ++paintGen;
  mode.disabled = true;
  try {
    await paint();
    if (n !== paintGen) return;
    source.blur();
    source.tabIndex = -1;
    preview.inert = false;
    document.body.classList.add("read");
    mode.setAttribute("aria-label", "Edit");
  } catch {
    if (n === paintGen) mode.setAttribute("aria-label", "Preview");
  } finally {
    mode.disabled = false;
  }
});

themeBtn.addEventListener("click", async () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  localStorage.setItem("theme", next);
  labelTheme();
  if (!document.body.classList.contains("read")) return;
  const n = ++paintGen;
  try {
    await paint();
  } catch {
    /* keep the last good preview */
  }
  if (n !== paintGen) return;
});

async function paint() {
  await loadPreview();
  const { text, slots } = stashMath(source.value);
  let html = marked.parse(text);
  html = DOMPurify.sanitize(html);
  html = html.replace(/%%MATH(\d+)%%/g, (_, i) => escapeHtml(slots[+i]));

  const tree = document.createElement("div");
  tree.innerHTML = html;

  const fences = [...tree.querySelectorAll("pre code")];
  if (fences.length) {
    const done = await Promise.all(
      fences.map(async (block) => {
        const lang = [...block.classList].find((c) => c.startsWith("language-"))?.slice("language-".length);
        return { pre: block.parentElement, html: await colorize(block.textContent, lang) };
      })
    );
    for (const { pre, html } of done) pre.outerHTML = html;
  }

  renderMathInElement(tree, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
      { left: "\\[", right: "\\]", display: true },
      { left: "\\(", right: "\\)", display: false },
    ],
    throwOnError: false,
  });

  retargetLinks(tree);
  preview.replaceChildren(...tree.childNodes);
}

async function colorize(text, lang) {
  const codeToHtml = await getShiki();
  const theme = document.documentElement.dataset.theme === "dark" ? "github-dark" : "github-light";
  const id = alias[lang] || lang || "text";
  const code = text.replace(/\n$/, "");
  try {
    return await codeToHtml(code, { lang: id, theme });
  } catch {
    return await codeToHtml(code, { lang: "text", theme });
  }
}

function getShiki() {
  if (!shikiReady) shikiReady = import("https://esm.sh/shiki@3.9.2").then((m) => m.codeToHtml);
  return shikiReady;
}

function loadPreview() {
  if (previewReady) return previewReady;
  previewReady = (async () => {
    await Promise.all([
      loadCss("https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.css"),
      loadCss("https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:ital@0;1&display=swap"),
      loadScript("https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.umd.js"),
      loadScript("https://cdn.jsdelivr.net/npm/dompurify@3.2.4/dist/purify.min.js"),
      loadScript("https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/katex.min.js"),
    ]);
    await loadScript("https://cdn.jsdelivr.net/npm/katex@0.16.21/dist/contrib/auto-render.min.js");
    marked.use({ gfm: true, breaks: false });
  })();
  return previewReady;
}

function warm() {
  const idle = window.requestIdleCallback || ((fn) => setTimeout(fn, 1));
  idle(warmNow, { timeout: 2000 });
}

function warmNow() {
  loadPreview().catch(() => {});
  if (/```/.test(source.value)) getShiki().catch(() => {});
}

function persist() {
  localStorage.setItem(KEY, source.value);
}

window.addEventListener("beforeprint", () => {
  if (preview.childNodes.length) return;
  const fallback = document.createElement("pre");
  fallback.className = "print-fallback";
  fallback.textContent = source.value;
  preview.replaceChildren(fallback);
});

function retargetLinks(root) {
  root.querySelectorAll("a[href]").forEach((a) => {
    a.target = "_blank";
    a.rel = "noopener noreferrer";
  });
}

function stashMath(md) {
  const slots = [];
  const pieces = [];
  const code = /(```[\s\S]*?```|`[^`\n]+`)/g;
  let last = 0;
  let m;
  while ((m = code.exec(md))) {
    pieces.push(stashTex(md.slice(last, m.index), slots));
    pieces.push(m[0]);
    last = m.index + m[0].length;
  }
  pieces.push(stashTex(md.slice(last), slots));
  return { text: pieces.join(""), slots };
}

function stashTex(chunk, slots) {
  return chunk
    .replace(/\$\$([\s\S]+?)\$\$/g, (raw) => hold(slots, raw))
    .replace(/\$([^$\s](?:[^$\n]*[^$\s])?)\$/g, (raw, body) => {
      if (/^\d/.test(body) && !/[a-zA-Z\\]/.test(body)) return raw;
      return hold(slots, raw);
    });
}

function hold(slots, raw) {
  slots.push(raw);
  return `%%MATH${slots.length - 1}%%`;
}

function onTab(e) {
  if (e.key !== "Tab") return;
  e.preventDefault();
  const val = source.value;
  let start = source.selectionStart;
  let end = source.selectionEnd;
  if (end > start && val[end - 1] === "\n") end -= 1;
  const from = val.lastIndexOf("\n", start - 1) + 1;
  const nl = val.indexOf("\n", end);
  const to = nl === -1 ? val.length : start === end ? start : nl;

  if (start === end) {
    if (e.shiftKey) {
      const n = leadingIndent(val, from);
      if (!n) return;
      source.setRangeText("", from, from + n, "end");
      const caret = Math.max(from, start - n);
      source.setSelectionRange(caret, caret);
    } else {
      source.setRangeText("  ", start, end, "end");
    }
  } else {
    const block = val.slice(from, to);
    const next = block
      .split("\n")
      .map((line) => (e.shiftKey ? line.replace(/^( {2}|\t)/, "") : "  " + line))
      .join("\n");
    source.setRangeText(next, from, to, "select");
    source.setSelectionRange(from, from + next.length);
  }
  source.dispatchEvent(new Event("input"));
}

function leadingIndent(val, from) {
  if (val.startsWith("  ", from)) return 2;
  if (val[from] === "\t") return 1;
  return 0;
}

function loadScript(src) {
  if (scripts.has(src)) return scripts.get(src);
  const done = new Promise((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });
  scripts.set(src, done);
  return done;
}

function loadCss(href) {
  const existing = document.querySelector(`link[href="${href}"]`);
  if (existing) {
    if (existing.sheet) return Promise.resolve();
    return new Promise((resolve, reject) => {
      existing.addEventListener("load", resolve, { once: true });
      existing.addEventListener("error", reject, { once: true });
    });
  }
  return new Promise((resolve, reject) => {
    const el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = href;
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  });
}

function escapeHtml(value) {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function labelTheme() {
  const dark = document.documentElement.dataset.theme === "dark";
  themeBtn.setAttribute("aria-label", dark ? "Light mode" : "Dark mode");
}

function fit() {
  if (canFieldSize) return;
  source.style.height = "auto";
  source.style.height = source.scrollHeight + "px";
}
