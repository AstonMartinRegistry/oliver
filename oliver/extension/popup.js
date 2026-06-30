const DEFAULTS = { enabled: true, threshold: 0.45 };
const DEFAULT_BASE = "http://localhost:8787";
const $ = (id) => document.getElementById(id);

const localGet = (k) => new Promise((res) => chrome.storage.local.get(k, res));
const localSet = (v) => new Promise((res) => chrome.storage.local.set(v, res));
const syncGet = (k) => new Promise((res) => chrome.storage.sync.get(k, res));

function showError(msg) {
  const el = $("connect-error");
  el.textContent = msg || "";
  el.classList.toggle("hidden", !msg);
}

function render(connected) {
  $("connect-view").classList.toggle("hidden", connected);
  $("account-view").classList.toggle("hidden", !connected);
}

function apiBase() {
  return ($("apiBase").value.trim() || DEFAULT_BASE).replace(/\/+$/, "");
}

// store the token + server, flip to the account view, and load live stats
async function activate(token, base) {
  await localSet({ token, apiBase: base });
  render(true);
  refreshAccount();
}

function refreshAccount() {
  chrome.runtime.sendMessage({ type: "health" }, (resp) => {
    const d = resp && resp.ok && resp.data;
    if (d && d.ok) {
      const building = d.status && d.status !== "ready";
      $("stat-num").textContent = d.matches;
      $("stat-meta").innerHTML =
        `<span class="dot ${building ? "building" : ""}"></span>` +
        `${d.email} · ${d.highlights} highlights${building ? " · learning…" : ""}`;
    } else {
      $("stat-meta").innerHTML = `<span class="dot building"></span>connected, but server unreachable`;
    }
  });
}

async function init() {
  const { token, apiBase: base } = await localGet({ token: "", apiBase: DEFAULT_BASE });
  const s = await syncGet(DEFAULTS);
  $("apiBase").value = base || DEFAULT_BASE;
  $("enabled").checked = s.enabled;
  $("threshold").value = s.threshold;
  $("threshold-val").textContent = Number(s.threshold).toFixed(2);
  render(!!token);
  if (token) refreshAccount();
}

// ── connect via email + password ──────────────────────────────────────────────
$("connect").addEventListener("click", async () => {
  showError("");
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || !password) return showError("Enter your email and password.");
  const base = apiBase();
  $("connect").textContent = "Connecting…";
  try {
    const r = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error(data.error || "Login failed.");
    await activate(data.token, base);
  } catch (e) {
    showError(String(e.message || e));
  } finally {
    $("connect").textContent = "Connect";
  }
});

// ── connect via pasted token ──────────────────────────────────────────────────
$("connect-token").addEventListener("click", async () => {
  showError("");
  const token = $("token").value.trim();
  if (!token) return showError("Paste the token from your dashboard.");
  const base = apiBase();
  $("connect-token").textContent = "Checking…";
  try {
    const r = await fetch(`${base}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await r.json();
    if (!r.ok || !data.ok) throw new Error("That token didn't work.");
    await activate(token, base);
  } catch (e) {
    showError(String(e.message || e));
  } finally {
    $("connect-token").textContent = "Use token";
  }
});

$("disconnect").addEventListener("click", async () => {
  await localSet({ token: "" });
  render(false);
});

$("enabled").addEventListener("change", () => {
  chrome.storage.sync.set({ enabled: $("enabled").checked });
});

$("threshold").addEventListener("input", () => {
  $("threshold-val").textContent = Number($("threshold").value).toFixed(2);
  chrome.storage.sync.set({ threshold: Number($("threshold").value) });
});

init();
