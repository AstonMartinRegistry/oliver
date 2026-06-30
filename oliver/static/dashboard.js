// Poll build status + live match count. While Oliver is fetching/embedding the
// Curius library, reload once it's ready so the link list appears.
function copyToken() {
  const t = document.getElementById("token");
  navigator.clipboard.writeText(t.textContent.trim());
}

(function () {
  const pill = document.getElementById("build-status");
  const statusText = document.getElementById("status-text");
  const countEl = document.getElementById("match-count");
  let lastStatus = pill ? pill.dataset.status : "ready";

  async function tick() {
    try {
      const r = await fetch("/status", { credentials: "same-origin" });
      if (!r.ok) return;
      const s = await r.json();
      if (countEl) countEl.textContent = s.matches;
      if (pill) {
        pill.dataset.status = s.status;
        statusText.textContent = s.message || s.status;
      }
      // when the build finishes, reload to render the freshly-fetched links
      if (lastStatus === "building" && s.status === "ready") {
        location.reload();
        return;
      }
      lastStatus = s.status;
    } catch (e) {
      /* ignore transient errors */
    }
  }

  // poll faster while building, slower once ready
  setInterval(tick, 3000);
  tick();
})();
