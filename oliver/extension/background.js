// Oliver — background service worker.
// Content scripts run in the page's origin, where calling the Oliver API from an
// https page can be blocked as mixed content. The worker has its own origin + the
// host_permissions grant, so it makes the authenticated calls and relays results.
//
// Auth: every account has an API token (shown in the dashboard). It's stored in
// chrome.storage.local and sent as `Authorization: Bearer <token>` on every call,
// so each installed extension scores against its own account's taste.

const DEFAULT_BASE = "http://localhost:8787";

function config() {
  return new Promise((res) =>
    chrome.storage.local.get({ apiBase: DEFAULT_BASE, token: "" }, (c) =>
      res({ apiBase: (c.apiBase || DEFAULT_BASE).replace(/\/+$/, ""), token: c.token || "" })
    )
  );
}

function authHeaders(token, extra) {
  const h = Object.assign({ "Content-Type": "application/json" }, extra || {});
  if (token) h["Authorization"] = `Bearer ${token}`;
  return h;
}

// ── Redirect web PDFs to our PDF.js viewer (native viewer exposes no text DOM).
const PDF_RE = /^https?:\/\/[^#?]+\.pdf(\?[^#]*)?(#.*)?$/i;
const isOurViewer = (url) => url.startsWith(chrome.runtime.getURL("viewer.html"));

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (details.frameId !== 0) return;
  const url = details.url || "";
  if (!PDF_RE.test(url) || isOurViewer(url)) return;
  chrome.storage.sync.get({ enabled: true }, (s) => {
    if (!s.enabled) return;
    const viewer = chrome.runtime.getURL("viewer.html") + "?file=" + encodeURIComponent(url);
    chrome.tabs.update(details.tabId, { url: viewer });
  });
});

// ── one-shot request relays ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "score") {
    config().then(({ apiBase, token }) => {
      if (!token) return sendResponse({ ok: false, error: "not-connected" });
      fetch(`${apiBase}/api/score`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ blocks: msg.blocks, url: msg.url, title: msg.title }),
      })
        .then((r) => {
          if (r.status === 401) throw new Error("unauthorized");
          if (!r.ok) throw new Error(`server ${r.status}`);
          return r.json();
        })
        .then((data) => sendResponse({ ok: true, data }))
        .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    });
    return true;
  }

  if (msg?.type === "matches") {
    config().then(({ apiBase, token }) => {
      if (!token) return sendResponse({ ok: false });
      fetch(`${apiBase}/api/matches`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ count: msg.count || 0 }),
      })
        .then((r) => r.json())
        .then((data) => sendResponse({ ok: true, data }))
        .catch(() => sendResponse({ ok: false }));
    });
    return true;
  }

  if (msg?.type === "health") {
    config().then(({ apiBase, token }) => {
      fetch(`${apiBase}/api/health`, { headers: authHeaders(token) })
        .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
        .then((res) => sendResponse(res))
        .catch((err) => sendResponse({ ok: false, error: String(err) }));
    });
    return true;
  }
});

// ── streaming parrot connections ──────────────────────────────────────────────
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "connect-stream") return;
  let closed = false;
  port.onDisconnect.addListener(() => (closed = true));
  const post = (m) => {
    if (closed) return;
    try {
      port.postMessage(m);
    } catch (e) {
      closed = true;
    }
  };

  port.onMessage.addListener(async (msg) => {
    const items = (msg && msg.items) || [];
    const { apiBase, token } = await config();
    if (!token) {
      post({ type: "error", error: "not-connected" });
      return;
    }
    try {
      const resp = await fetch(`${apiBase}/api/connections_stream`, {
        method: "POST",
        headers: authHeaders(token),
        body: JSON.stringify({ items }),
      });
      if (!resp.ok || !resp.body) {
        post({ type: "error", error: `server ${resp.status}` });
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      while (!closed) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).trim();
          buf = buf.slice(nl + 1);
          if (line) {
            try {
              post(JSON.parse(line));
            } catch (e) {}
          }
        }
      }
      const rest = buf.trim();
      if (rest) {
        try {
          post(JSON.parse(rest));
        } catch (e) {}
      }
      post({ type: "end" });
    } catch (err) {
      post({ type: "error", error: String(err) });
    }
  });
});
