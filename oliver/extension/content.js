// Content script: find readable blocks, ask the taste server which ones you'd
// want to read, then on each match draw green corner brackets (on the paragraph's
// own background) and inject a pixel-parrot note below it that streams a
// one-sentence explanation of how it connects to something you highlighted before.
//
// Light touch: paragraphs get only an inline `style` (no child nodes inside them);
// notes are sibling nodes keyed by text so they survive SPA re-renders. Text is
// read with textContent (no reflow), work runs in idle time, and a debounced
// MutationObserver re-scans dynamic/streamed pages (AI answers). The heavy lifting
// (embeddings, Cerebras) runs in the Python server, reached via the background worker.

(() => {
  if (window.top !== window.self) return; // top frame only

  const DEFAULTS = { enabled: true, threshold: 0.45, maxBlocks: 300 };

  let lastScores = null;
  let sentTexts = [];          // texts we sent to score, indexed as the server expects
  let running = false;
  let highlights = [];         // [{ el, text, data:{ match, source }, note, say }]

  const connCache = new Map();    // (paragraph||quote) → final generated sentence
  const noteByText = new Map();   // paragraph text → its injected note element
  const streamingKeys = new Set();// keys with an in-flight Cerebras stream
  const countedTexts = new Set(); // matched paragraphs already counted this page
  const PLACEHOLDER = "squawk… thinking…";

  const settings = () =>
    new Promise((res) =>
      chrome.storage.sync.get(DEFAULTS, (s) => res({ ...DEFAULTS, ...s }))
    );

  // ── UI host (Shadow DOM keeps the status pill isolated from the page) ────────
  let shadow, pill;

  function ensureUI() {
    if (shadow) return;
    const host = document.createElement("div");
    host.id = "taste-root";
    host.style.cssText = "all: initial;";
    document.documentElement.appendChild(host);
    shadow = host.attachShadow({ mode: "open" });

    const style = document.createElement("style");
    style.textContent = UI_CSS;
    shadow.appendChild(style);

    pill = document.createElement("div");
    pill.id = "taste-pill";
    pill.addEventListener("click", async () => {
      const s = await settings();
      chrome.storage.sync.set({ enabled: !s.enabled });
    });
    shadow.appendChild(pill);
  }

  function setPill(text, state) {
    ensureUI();
    pill.textContent = text;
    pill.dataset.state = state || "";
  }

  // ── extraction (cheap reads only) ────────────────────────────────────────────
  function collectBlocks() {
    const nodes = document.querySelectorAll("p, li, blockquote");
    const els = [];
    const seen = new Set();
    for (const el of nodes) {
      if (el.closest("nav, footer, header, aside")) continue;
      const text = (el.textContent || "").trim().replace(/\s+/g, " ");
      if (text.length < 40 || text.length > 2000) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      els.push({ el, text });
    }
    return els;
  }

  // note styling — inline, because the note is injected into the PAGE DOM (not
  // the shadow root), so our shadow CSS wouldn't reach it.
  const NOTE_CSS =
    "display:flex; align-items:center; gap:10px; margin:6px 0 14px;";
  const SAY_CSS =
    "font:500 13px/1.5 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, monospace;" +
    "color:#15803d;";

  // A little pixel-art parrot, drawn as an inline SVG (crisp, font-independent).
  // Each char in PARROT_MAP is one pixel; PARROT_PALETTE maps it to a colour.
  // Modelled on the left bird in the reference image: a green parrot facing right,
  // orange beak, black eye, red wing patch + blue wing flecks, long red tail.
  const PARROT_MAP = [
    ".....GGG......",
    "....GGGGG.....",
    "...GGGGGGG....",
    "...GGGGGGGG...",
    "..GGGGGGGGGG..",
    "..GGGGGGGGKG..",
    "..GGGGGGGGGGOO",
    ".GGGGGGGGGGGOO",
    ".GGGGGGGGGGGG.",
    ".GGGGGGGRRRGG.",
    ".GGGGGGRRRRGG.",
    ".GGGGGBBRRRG..",
    "..GGGGBRRRG...",
    "..RRGGGGRRG...",
    ".RRRGGGGRR....",
    "RRRRGGGG......",
    "RRR.OO.OO.....",
    "RR............",
  ];
  const PARROT_PALETTE = {
    G: "#3fa540", // green body
    R: "#d62828", // red wing + tail
    B: "#2b53c8", // blue wing flecks
    O: "#ef7d1a", // orange beak + feet
    K: "#101010", // eye
  };

  function buildParrot() {
    const px = 3;
    const w = PARROT_MAP[0].length * px;
    const h = PARROT_MAP.length * px;
    let rects = "";
    PARROT_MAP.forEach((row, y) => {
      for (let x = 0; x < row.length; x++) {
        const c = PARROT_PALETTE[row[x]];
        if (c) rects += `<rect x="${x * px}" y="${y * px}" width="${px}" height="${px}" fill="${c}"/>`;
      }
    });
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" ` +
      `viewBox="0 0 ${w} ${h}" shape-rendering="crispEdges" ` +
      `style="flex:0 0 auto;display:block">${rects}</svg>`;
    const wrap = document.createElement("span");
    wrap.style.cssText = "flex:0 0 auto;line-height:0";
    wrap.innerHTML = svg;
    return wrap;
  }

  // Load Geist Mono once (best-effort; falls back to system mono if blocked).
  function ensureFont() {
    if (document.getElementById("taste-font")) return;
    try {
      const l = document.createElement("link");
      l.id = "taste-font";
      l.rel = "stylesheet";
      l.href =
        "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap";
      (document.head || document.documentElement).appendChild(l);
    } catch (e) {
      /* CSP may block it; the fallback stack still applies */
    }
  }

  // ── in-page decoration ───────────────────────────────────────────────────────
  // Green corner brackets are drawn directly on the paragraph element via its own
  // inline `background` (8 tiny gradient rectangles, 2 per corner). This edits only
  // the style attribute — no child nodes inside the paragraph — which is the
  // framework-safe way to decorate the element itself instead of floating over it.
  const BRACKET_PROPS = [
    "backgroundImage",
    "backgroundRepeat",
    "backgroundSize",
    "backgroundPosition",
    "backgroundOrigin",
    "padding",
    "borderRadius",
  ];
  const styledEls = new Set();

  function styleParagraph(el, strength) {
    const a = (0.55 + 0.4 * (strength || 0)).toFixed(2);
    const col = `rgba(21,128,61,${a})`; // matches the bird text colour (#15803d)
    const g = `linear-gradient(${col},${col})`;
    const L = "16px";
    const T = "2px";
    el.style.backgroundImage = [g, g, g, g, g, g, g, g].join(",");
    el.style.backgroundRepeat = "no-repeat";
    el.style.backgroundOrigin = "border-box";
    el.style.backgroundSize = [
      `${L} ${T}`, `${T} ${L}`, // top-left  (horizontal, vertical)
      `${L} ${T}`, `${T} ${L}`, // top-right
      `${L} ${T}`, `${T} ${L}`, // bottom-left
      `${L} ${T}`, `${T} ${L}`, // bottom-right
    ].join(",");
    el.style.backgroundPosition = [
      "left top", "left top",
      "right top", "right top",
      "left bottom", "left bottom",
      "right bottom", "right bottom",
    ].join(",");
    el.style.padding = "6px 9px";
    el.style.borderRadius = "0"; // sharp corners
    styledEls.add(el);
  }

  function unstyleParagraph(el) {
    for (const p of BRACKET_PROPS) el.style[p] = "";
    styledEls.delete(el);
  }

  // Notes are injected into the PAGE DOM and PERSIST across rescans (keyed by the
  // paragraph text). This is what keeps the bird + its text from vanishing when a
  // rescan fires mid-stream — we reuse the same element instead of destroying it.
  // Drop any styled paragraph / note whose text isn't in `keepTexts`.
  function reconcile(keepTexts, keepEls) {
    for (const el of [...styledEls]) if (!keepEls.has(el)) unstyleParagraph(el);
    for (const [text, note] of noteByText) {
      if (!keepTexts.has(text)) {
        note.remove();
        noteByText.delete(text);
      }
    }
  }

  function clearHighlights() {
    highlights = [];
    reconcile(new Set(), new Set());
  }

  function updateBaseline() {
    lastTextLen = document.body ? document.body.textContent.length : 0;
  }

  function applyHighlights(threshold) {
    highlights = [];

    // Re-resolve each scored passage to a *live* element by its text. Frameworks
    // replace DOM nodes during/after streaming, so the elements we measured before
    // the network call may be detached — match against a fresh scan instead.
    const byText = new Map();
    for (const b of collectBlocks()) if (!byText.has(b.text)) byText.set(b.text, b.el);

    const keepTexts = new Set();
    const keepEls = new Set();
    for (const s of lastScores || []) {
      if (s.score < threshold) continue;
      const text = sentTexts[s.index];
      const el = text == null ? null : byText.get(text);
      if (!el) continue;
      keepTexts.add(text);
      keepEls.add(el);
      const strength = Math.min(1, (s.score - threshold) / (1 - threshold) + 0.15);
      styleParagraph(el, strength);
      highlights.push({ el, text, data: { match: s.match, source: s.source } });
    }
    reconcile(keepTexts, keepEls);
    fetchConnections();
    reportMatches(keepTexts);
    return highlights.length;
  }

  // Tell the server how many *new* passages Oliver spotted (deduped per page so
  // rescans of streamed/dynamic content don't inflate the dashboard counter).
  function reportMatches(keepTexts) {
    let fresh = 0;
    for (const t of keepTexts) {
      if (!countedTexts.has(t)) {
        countedTexts.add(t);
        fresh++;
      }
    }
    if (fresh > 0) chrome.runtime.sendMessage({ type: "matches", count: fresh });
  }

  // Get (or build) the persistent note for a paragraph and glue it right after the
  // paragraph. Reused across rescans so streamed text is never thrown away.
  function ensureNote(h) {
    let note = noteByText.get(h.text);
    if (!note) {
      ensureFont();
      note = document.createElement("div");
      note.className = "taste-note";
      note.style.cssText = NOTE_CSS;
      const say = document.createElement("span");
      say.style.cssText = SAY_CSS;
      note.appendChild(buildParrot());
      note.appendChild(say);
      note._say = say;
      noteByText.set(h.text, note);
    }
    h.note = note;
    h.say = note._say;
    if (h.el.isConnected && h.el.nextSibling !== note) {
      try {
        h.el.insertAdjacentElement("afterend", note);
      } catch (e) {
        /* a framework may reject the insert; ignore */
      }
    }
    return note;
  }

  function removeNote(h) {
    const note = noteByText.get(h.text);
    if (note) {
      note.remove();
      noteByText.delete(h.text);
    }
    h.note = null;
    h.say = null;
  }

  const connKey = (p, q) => `${p.slice(0, 200)}||${q.slice(0, 200)}`;

  // For each highlight: show its cached sentence, or stream a fresh one. Cached per
  // (paragraph, quote) so threshold tweaks / rescans don't re-bill Cerebras.
  function fetchConnections() {
    const need = [];
    for (const h of highlights) {
      ensureNote(h);
      h._key = connKey(h.text, h.data.match);
      const cached = connCache.get(h._key);
      if (cached) {
        h.say.textContent = cached;
      } else if (streamingKeys.has(h._key)) {
        // a stream is already filling this note's span — leave it alone
      } else {
        h.say.textContent = PLACEHOLDER;
        need.push(h);
      }
    }
    updateBaseline();
    if (need.length) streamConnections(need);
  }

  // Open a port to the background worker, which streams NDJSON deltas from the
  // server. We append tokens to each note's span as they arrive.
  function streamConnections(need) {
    const items = need.map((h) => ({
      paragraph: h.text,
      quote: h.data.match,
      source: h.data.source || "",
    }));
    need.forEach((h) => streamingKeys.add(h._key));

    const acc = need.map(() => "");
    const started = need.map(() => false);

    let port;
    try {
      port = chrome.runtime.connect({ name: "connect-stream" });
    } catch (e) {
      need.forEach((h) => streamingKeys.delete(h._key));
      return;
    }

    const finish = (i) => {
      const h = need[i];
      if (!h || !streamingKeys.has(h._key)) return;
      streamingKeys.delete(h._key);
      const text = (acc[i] || "").trim();
      if (text) {
        connCache.set(h._key, text);
        if (h.say) h.say.textContent = text;
      } else if (h.say && h.say.textContent === PLACEHOLDER) {
        removeNote(h);
      }
      updateBaseline();
    };

    port.onMessage.addListener((msg) => {
      if (!msg) return;
      if (msg.type === "delta") {
        const h = need[msg.i];
        if (!h || !h.say) return;
        if (!started[msg.i]) {
          started[msg.i] = true;
          acc[msg.i] = "";
          h.say.textContent = "";
        }
        acc[msg.i] += msg.delta || "";
        h.say.textContent = acc[msg.i];
      } else if (msg.type === "reset") {
        // a failed attempt is being retried — drop its partial text
        const h = need[msg.i];
        if (h && h.say) {
          started[msg.i] = false;
          acc[msg.i] = "";
          h.say.textContent = PLACEHOLDER;
        }
      } else if (msg.type === "done") {
        finish(msg.i);
      } else if (msg.type === "error" || msg.type === "end") {
        need.forEach((_, i) => finish(i));
        try {
          port.disconnect();
        } catch (e) {}
      }
    });

    port.onDisconnect.addListener(() => need.forEach((_, i) => finish(i)));
    port.postMessage({ items });
  }

  // ── main run ───────────────────────────────────────────────────────────────
  async function run() {
    if (running) return;
    running = true;

    const s = await settings();
    if (!s.enabled) {
      clearHighlights();
      setPill("Taste: off", "off");
      running = false;
      return;
    }

    sentTexts = collectBlocks().slice(0, s.maxBlocks).map((b) => b.text);
    if (sentTexts.length === 0) {
      setPill("Oliver: no text", "idle");
      running = false;
      return;
    }

    setPill("Oliver: reading…", "loading");
    chrome.runtime.sendMessage(
      { type: "score", blocks: sentTexts, url: location.href, title: document.title },
      (resp) => {
        running = false; // cleared only once the request truly resolves
        if (!resp || !resp.ok) {
          const err = resp && resp.error;
          if (err === "not-connected") setPill("Oliver: connect in dashboard", "error");
          else if (err === "unauthorized") setPill("Oliver: reconnect needed", "error");
          else setPill("Oliver: server off", "error");
          console.warn("[oliver]", err);
          return;
        }
        if (resp.data.building) {
          setPill("Oliver: learning your taste…", "loading");
          return;
        }
        lastScores = resp.data.scores || [];
        const n = applyHighlights(s.threshold);
        setPill(`Oliver: ${n} passage${n === 1 ? "" : "s"}`, "done");
      }
    );
  }

  // React to popup toggles / threshold changes without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    // connecting an account (token saved in local) should kick off a scan
    if (area === "local" && (changes.token || changes.apiBase)) {
      run();
      return;
    }
    if (area !== "sync") return;
    if (changes.enabled) {
      run();
    } else if (changes.threshold && lastScores) {
      settings().then((s) => {
        const n = applyHighlights(s.threshold);
        setPill(`Oliver: ${n} passage${n === 1 ? "" : "s"}`, "done");
      });
    }
  });

  // ── scheduling for static + dynamic pages ────────────────────────────────────
  function whenIdle(fn) {
    (window.requestIdleCallback || ((f) => setTimeout(f, 250)))(fn, { timeout: 2000 });
  }

  let rescanTimer;
  let lastTextLen = 0;

  function scheduleRescan() {
    clearTimeout(rescanTimer);
    rescanTimer = setTimeout(() => whenIdle(run), 900);
  }

  // is this node our own injected note (or inside one / our shadow host)?
  function isOurs(node) {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    while (el) {
      if (el.id === "taste-root") return true;
      if (el.classList && el.classList.contains("taste-note")) return true;
      el = el.parentElement;
    }
    return false;
  }

  function mutationIsOurs(m) {
    if (m.type === "characterData") return isOurs(m.target);
    if (isOurs(m.target)) return true;
    for (const n of m.addedNodes) if (!isOurs(n)) return false;
    for (const n of m.removedNodes) if (!isOurs(n)) return false;
    return m.addedNodes.length + m.removedNodes.length > 0;
  }

  function watchDynamic() {
    const obs = new MutationObserver((mutations) => {
      if (running) return;
      if (mutations.every(mutationIsOurs)) return; // our own note injections
      const len = document.body ? document.body.textContent.length : 0;
      if (Math.abs(len - lastTextLen) < 200) return; // ignore cosmetic churn
      lastTextLen = len;
      scheduleRescan();
    });
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });

    let lastHref = location.href;
    setInterval(() => {
      if (location.href !== lastHref) {
        lastHref = location.href;
        countedTexts.clear(); // new page → matches can be counted again
        scheduleRescan();
      }
    }, 1200);
  }

  function start() {
    const begin = () => {
      lastTextLen = document.body ? document.body.textContent.length : 0;
      whenIdle(run);
      watchDynamic();
    };
    if (document.readyState === "complete") begin();
    else window.addEventListener("load", begin, { once: true });
  }

  start();

  // ── shadow-DOM styles (isolated from the page) ───────────────────────────────
  const UI_CSS = `
    :host { all: initial; }

    #taste-pill {
      position: fixed; right: 16px; bottom: 16px; z-index: 2147483647;
      font: 600 12px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      color: #1f2937; background: #fff; border: 1px solid rgba(0,0,0,.12);
      border-radius: 999px; padding: 8px 12px; box-shadow: 0 4px 14px rgba(0,0,0,.14);
      cursor: pointer; user-select: none; opacity: .92; transition: opacity .15s ease;
      pointer-events: auto;
    }
    #taste-pill:hover { opacity: 1; }
    #taste-pill[data-state="loading"] { color: #b45309; }
    #taste-pill[data-state="error"]   { color: #b91c1c; }
    #taste-pill[data-state="off"]     { color: #6b7280; }
    #taste-pill[data-state="done"]    { color: #047857; }
  `;
})();
