// PDF viewer with taste highlighting.
// Renders a web PDF with PDF.js, groups its text into paragraph-ish blocks,
// scores them with the same /score backend, and tints the spans you'd likely
// want to read.

const DEFAULTS = { enabled: true, threshold: 0.45 };
const MAX_PAGES = 40;   // cap so huge PDFs don't hang the tab
const SCALE = 1.4;

const params = new URLSearchParams(location.search);
const fileUrl = params.get("file");

const statusEl = document.getElementById("status") || document.getElementById("taste-status");
const openEl = document.getElementById("taste-open");
const pagesEl = document.getElementById("pages");
const cardEl = document.getElementById("taste-card");

if (openEl && fileUrl) openEl.href = fileUrl;

const pdfjsLib = window["pdfjsLib"];
pdfjsLib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdf.worker.min.js");

function setStatus(text) {
  if (statusEl) statusEl.textContent = text;
}

function getSettings() {
  return new Promise((res) =>
    chrome.storage.sync.get(DEFAULTS, (s) => res({ ...DEFAULTS, ...s }))
  );
}

// Group a page's text items into paragraph blocks.
// Returns [{ text, indices: [itemIndex, ...] }] where itemIndex maps 1:1 to the
// textDivs produced by renderTextLayer (same order as textContent.items).
function buildBlocks(items) {
  // 1) items → lines (same baseline y)
  const lines = [];
  let cur = null;
  const yOf = (it) => (it.transform ? it.transform[5] : 0);
  const hOf = (it) => it.height || (it.transform ? Math.abs(it.transform[3]) : 10);

  items.forEach((it, i) => {
    const str = it.str || "";
    if (cur && Math.abs(yOf(it) - cur.y) <= Math.max(2, hOf(it) * 0.5)) {
      cur.text += str;
      cur.indices.push(i);
    } else {
      if (cur) lines.push(cur);
      cur = { text: str, y: yOf(it), h: hOf(it), indices: [i] };
    }
    if (it.hasEOL) cur.text += " ";
  });
  if (cur) lines.push(cur);

  // typical line height → paragraph-gap threshold
  const heights = lines.map((l) => l.h).filter(Boolean).sort((a, b) => a - b);
  const medianH = heights[Math.floor(heights.length / 2)] || 10;

  // 2) lines → paragraphs (break on big vertical gap)
  const blocks = [];
  let para = null;
  let prevY = null;
  for (const ln of lines) {
    const gap = prevY === null ? 0 : Math.abs(prevY - ln.y);
    if (!para || gap > medianH * 1.8) {
      if (para) blocks.push(para);
      para = { text: "", indices: [] };
    }
    para.text += (para.text ? " " : "") + ln.text.trim();
    para.indices.push(...ln.indices);
    prevY = ln.y;
  }
  if (para) blocks.push(para);

  return blocks
    .map((b) => ({ text: b.text.replace(/\s+/g, " ").trim(), indices: b.indices }))
    .filter((b) => b.text.length >= 40);
}

async function renderPage(pdf, pageNum) {
  const page = await pdf.getPage(pageNum);
  const viewport = page.getViewport({ scale: SCALE });

  const pageDiv = document.createElement("div");
  pageDiv.className = "page";
  pageDiv.style.width = `${viewport.width}px`;
  pageDiv.style.height = `${viewport.height}px`;

  const canvas = document.createElement("canvas");
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  pageDiv.appendChild(canvas);

  const textLayer = document.createElement("div");
  textLayer.className = "textLayer";
  pageDiv.appendChild(textLayer);
  pagesEl.appendChild(pageDiv);

  await page.render({ canvasContext: ctx, viewport }).promise;

  const textContent = await page.getTextContent();
  const textDivs = [];
  await pdfjsLib.renderTextLayer({
    textContent,
    container: textLayer,
    viewport,
    textDivs,
  }).promise;

  const blocks = buildBlocks(textContent.items);
  // resolve each block's item indices to the actual span elements
  for (const b of blocks) {
    b.spans = b.indices.map((i) => textDivs[i]).filter(Boolean);
  }
  return blocks;
}

// ── hover card ────────────────────────────────────────────────────────────────
let hideTimer;
function showCard(span, d, evt) {
  clearTimeout(hideTimer);
  const pct = (d.score * 100) | 0;
  const link = d.url
    ? `<a class="taste-card-src" href="${d.url}" target="_blank" rel="noopener">${escapeHtml(d.source)} ↗</a>`
    : `<span class="taste-card-src">${escapeHtml(d.source)}</span>`;
  cardEl.innerHTML =
    `<div class="taste-card-pct">${pct}% your taste</div>` +
    `<div class="taste-card-why">Echoes a passage you highlighted:</div>` +
    `<div class="taste-card-quote">“${escapeHtml(d.match)}”</div>` +
    `<div class="taste-card-from">from ${link}</div>`;
  cardEl.style.display = "block";
  const top = window.scrollY + evt.clientY - cardEl.offsetHeight - 12;
  const left = Math.min(
    window.scrollX + window.innerWidth - cardEl.offsetWidth - 12,
    window.scrollX + evt.clientX
  );
  cardEl.style.top = `${Math.max(8, top)}px`;
  cardEl.style.left = `${Math.max(8, left)}px`;
}
function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => (cardEl.style.display = "none"), 220);
}
cardEl.addEventListener("mouseenter", () => clearTimeout(hideTimer));
cardEl.addEventListener("mouseleave", scheduleHide);

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function applyScores(blocks, scores, threshold) {
  let n = 0;
  for (const s of scores) {
    if (s.score < threshold) continue;
    const block = blocks[s.index];
    if (!block || !block.spans) continue;
    const strength = Math.min(1, (s.score - threshold) / (1 - threshold) + 0.15);
    const data = { score: s.score, match: s.match, source: s.source, url: s.url || "" };
    for (const span of block.spans) {
      span.classList.add("taste-hl");
      span.style.setProperty("--taste-strength", strength.toFixed(3));
      span.addEventListener("mouseenter", (e) => showCard(span, data, e));
      span.addEventListener("mouseleave", scheduleHide);
    }
    n++;
  }
  return n;
}

async function main() {
  if (!fileUrl) {
    setStatus("No PDF specified.");
    return;
  }
  const settings = await getSettings();

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ url: fileUrl }).promise;
  } catch (e) {
    setStatus("Could not load PDF.");
    console.error("[taste] pdf load failed", e);
    return;
  }

  const total = Math.min(pdf.numPages, MAX_PAGES);
  setStatus(`Rendering ${total} page${total === 1 ? "" : "s"}…`);

  const allBlocks = [];
  for (let p = 1; p <= total; p++) {
    try {
      const blocks = await renderPage(pdf, p);
      allBlocks.push(...blocks);
    } catch (e) {
      console.warn("[taste] page", p, "failed", e);
    }
  }

  const truncated = pdf.numPages > MAX_PAGES ? ` (first ${MAX_PAGES} of ${pdf.numPages} pages)` : "";

  if (!settings.enabled) {
    setStatus(`Taste off${truncated}`);
    return;
  }
  if (allBlocks.length === 0) {
    setStatus(`No selectable text — this PDF may be scanned images${truncated}`);
    return;
  }

  setStatus(`Scoring ${allBlocks.length} passages…`);
  chrome.runtime.sendMessage(
    {
      type: "score",
      blocks: allBlocks.map((b) => b.text),
      url: fileUrl,
      title: document.title,
    },
    (resp) => {
      if (!resp || !resp.ok) {
        setStatus("Taste server off — run: python3 serve.py");
        return;
      }
      const n = applyScores(allBlocks, resp.data.scores || [], settings.threshold);
      setStatus(`${n} passage${n === 1 ? "" : "s"} worth reading${truncated}`);
    }
  );
}

main();
