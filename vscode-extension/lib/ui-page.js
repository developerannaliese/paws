'use strict';

// The session view. One page used two ways:
//  - inside VS Code / Cursor / Windsurf as a panel (webview), where it takes the
//    editor's own colours and fonts, so it looks native;
//  - in a browser via `paws ui`, with an editor-like theme of its own.
// No outside requests: no web fonts, no scripts from the internet.

function page({ token = '', webview = false, cspSource = '', nonce = '', root = '' } = {}) {
  const csp = webview
    ? `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">`
    : `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';">`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${csp}
<title>Paws</title>
<style>
/* Layout: a slim header with the session picker, a one-line summary of the session,
   then tabs (Activity / What the AI saw / Rules). Wide windows get a session list on the left. */
:root {
  --bg: var(--vscode-editor-background, #FAFAF9);
  --side: var(--vscode-sideBar-background, #F1F1EF);
  --fg: var(--vscode-foreground, #1D1F23);
  --muted: var(--vscode-descriptionForeground, #6B6F76);
  --line: var(--vscode-panel-border, var(--vscode-widget-border, #E3E3E0));
  --hover: var(--vscode-list-hoverBackground, #ECECE9);
  --active: var(--vscode-list-activeSelectionBackground, #1D1F23);
  --active-fg: var(--vscode-list-activeSelectionForeground, #FAFAF9);
  --accent: var(--vscode-textLink-foreground, #3B5BDB);
  --chip: var(--vscode-badge-background, #E6E6E3);
  --chip-fg: var(--vscode-badge-foreground, #1D1F23);
  --kept: var(--vscode-charts-blue, #3B5BDB);
  --stop: var(--vscode-charts-red, #C92A2A);
  --ask: var(--vscode-charts-yellow, #B7791F);
  --back: var(--vscode-charts-green, #2B8A3E);
  --code-bg: var(--vscode-textCodeBlock-background, #ECECE9);
  --font: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif);
  --size: var(--vscode-font-size, 13px);
  --mono: var(--vscode-editor-font-family, ui-monospace, "SF Mono", Menlo, Consolas, monospace);
}
@media (prefers-color-scheme: dark) {
  :root:not(.vscode-light) {
    --bg: var(--vscode-editor-background, #17181B); --side: var(--vscode-sideBar-background, #1C1D21);
    --fg: var(--vscode-foreground, #D9DADD); --muted: var(--vscode-descriptionForeground, #8B8E95);
    --line: var(--vscode-panel-border, var(--vscode-widget-border, #2A2C31)); --hover: var(--vscode-list-hoverBackground, #24262B);
    --active: var(--vscode-list-activeSelectionBackground, #D9DADD); --active-fg: var(--vscode-list-activeSelectionForeground, #17181B);
    --accent: var(--vscode-textLink-foreground, #8AA4FF); --chip: var(--vscode-badge-background, #2C2E34); --chip-fg: var(--vscode-badge-foreground, #D9DADD);
    --kept: var(--vscode-charts-blue, #8AA4FF); --stop: var(--vscode-charts-red, #FF8787); --ask: var(--vscode-charts-yellow, #F2C94C); --back: var(--vscode-charts-green, #69DB7C);
    --code-bg: var(--vscode-textCodeBlock-background, #24262B); color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: var(--size)/1.5 var(--font); }
.app { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100%; }
aside { background: var(--side); border-right: 1px solid var(--line); padding: 14px 10px; display: flex; flex-direction: column; gap: 10px; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 600; padding: 0 6px; }
.brand svg, .top svg { width: 16px; height: 16px; flex: none; }
.brand .repo { color: var(--muted); font-weight: 400; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.label { color: var(--muted); font-size: 11px; text-transform: uppercase; letter-spacing: .06em; padding: 6px 6px 0; }
.slist { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; overflow: auto; }
.slist button { all: unset; box-sizing: border-box; width: 100%; display: grid; gap: 2px; padding: 7px 8px; border-radius: 5px; cursor: pointer; }
.slist button:hover { background: var(--hover); }
.slist button[aria-current="true"] { background: var(--active); color: var(--active-fg); }
.slist button[aria-current="true"] .sm { color: inherit; opacity: .75; }
.slist button:focus-visible, button:focus-visible, select:focus-visible { outline: 1px solid var(--accent); outline-offset: 1px; }
.slist .t { font-weight: 600; font-variant-numeric: tabular-nums; }
.sm { color: var(--muted); font-size: 11.5px; }
.foot { margin-top: auto; color: var(--muted); font-size: 11.5px; padding: 0 6px; display: grid; gap: 2px; }
main { padding: 16px 20px 28px; min-width: 0; display: flex; flex-direction: column; gap: 14px; }
.top { display: none; align-items: center; gap: 8px; }
.top select { flex: 1; min-width: 0; font: inherit; color: var(--fg); background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 3px 6px; }
h1 { margin: 0; font-size: 1.15em; font-weight: 600; display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 10px; }
h1 .sm { font-weight: 400; }
.summary { margin: 2px 0 0; color: var(--muted); max-width: 70ch; }
.summary b { color: var(--fg); font-weight: 600; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: baseline; gap: 6px; padding: 2px 9px; border-radius: 999px; background: var(--chip); color: var(--chip-fg); font-size: 12px; }
.chip b { font-variant-numeric: tabular-nums; }
.chip i { width: 7px; height: 7px; border-radius: 50%; display: inline-block; align-self: center; font-style: normal; }
.tabs { display: flex; gap: 18px; border-bottom: 1px solid var(--line); }
.tabs button { all: unset; cursor: pointer; padding: 6px 0; color: var(--muted); border-bottom: 2px solid transparent; margin-bottom: -1px; }
.tabs button[aria-selected="true"] { color: var(--fg); border-color: var(--fg); }
.feed, .map, .rules { list-style: none; margin: 0; padding: 0; }
.feed li { display: grid; grid-template-columns: 3px minmax(0, 1fr) auto; gap: 10px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.feed li:last-child, .map li:last-child, .rules li:last-child { border-bottom: 0; }
.bar { border-radius: 2px; }
.k-kept { background: var(--kept); } .k-stop { background: var(--stop); } .k-ask { background: var(--ask); } .k-back { background: var(--back); }
.when { color: var(--muted); font-size: 11.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
code, .mono { font-family: var(--mono); font-size: .95em; }
code { background: var(--code-bg); padding: 0 4px; border-radius: 3px; overflow-wrap: anywhere; }
.map li { display: grid; grid-template-columns: 84px minmax(0, 1fr) auto; gap: 4px 12px; align-items: baseline; padding: 8px 0; border-bottom: 1px solid var(--line); }
.type { color: var(--muted); font-size: 11px; letter-spacing: .05em; text-transform: uppercase; }
.pair { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 8px; min-width: 0; }
.real.shown { color: var(--ask); }
.arrow { color: var(--muted); }
.saw { color: var(--kept); }
.files { grid-column: 2 / -1; color: var(--muted); font-size: 11.5px; overflow-wrap: anywhere; }
.link { all: unset; cursor: pointer; color: var(--accent); font-size: 12px; }
.rules li { display: flex; justify-content: space-between; gap: 12px; padding: 7px 0; border-bottom: 1px solid var(--line); }
.tag { font-size: 11.5px; white-space: nowrap; }
.tag.hidden, .tag.block { color: var(--stop); } .tag.review, .tag.warn { color: var(--ask); } .tag.redact { color: var(--kept); }
.empty { color: var(--muted); padding: 18px 0; }
.note { color: var(--muted); font-size: 11.5px; margin: 10px 0 0; }
[hidden] { display: none !important; }
@media (max-width: 720px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  aside { display: none; }
  .top { display: flex; }
  main { padding: 12px 14px 24px; }
  .map li { grid-template-columns: minmax(0, 1fr) auto; }
  .map .type { grid-column: 1 / -1; }
  .files { grid-column: 1 / -1; }
}
</style>
</head>
<body>
<div class="app">
  <aside aria-label="Sessions">
    <div class="brand">${shield()}Paws <span class="repo" id="repo"></span></div>
    <div class="label">Sessions</div>
    <ul class="slist" id="slist"></ul>
    <div class="foot"><span id="mode"></span><span id="logline"></span><span>On this machine only · nothing stored by us</span></div>
  </aside>
  <main>
    <div class="top">${shield()}<strong>Paws</strong><select id="spick" aria-label="Session"></select></div>
    <section>
      <h1 id="title"></h1>
      <p class="summary" id="summary"></p>
    </section>
    <div class="chips" id="chips"></div>
    <div class="tabs" role="tablist">
      <button role="tab" aria-selected="true" data-tab="activity">Activity</button>
      <button role="tab" aria-selected="false" data-tab="saw">What the AI saw</button>
      <button role="tab" aria-selected="false" data-tab="rules">Rules</button>
    </div>
    <section data-panel="activity"><ul class="feed" id="feed"></ul></section>
    <section data-panel="saw" hidden><ul class="map" id="map"></ul><p class="note">Real values are masked and stay on this machine. Reveal shows one for 10 seconds.</p></section>
    <section data-panel="rules" hidden><ul class="rules" id="rules"></ul><p class="note" id="lognote"></p></section>
  </main>
</div>
<script${nonce ? ` nonce="${nonce}"` : ''}>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var Q = ${JSON.stringify(root)} ? "?root=" + encodeURIComponent(${JSON.stringify(root)}) : "";
  var vscode = typeof acquireVsCodeApi === "function" ? acquireVsCodeApi() : null;
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var state = null, current = null, tab = "activity", last = "", revealed = {}, pending = {};

  var LABEL = { EMAIL: "Email", PHONE: "Phone", TFN: "TFN", ABN: "ABN", MEDICARE: "Medicare", CARD: "Card", BSB: "BSB", ACCOUNT: "Account", ADDRESS: "Address", DOB: "Birth date", NAME: "Name", SECRET: "Secret", PRIVATE_KEY: "Private key", CONFIDENTIAL: "Confidential" };
  var ACR = { TFN: 1, ABN: 1, BSB: 1 };
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function words(f) { return Object.keys(f || {}).map(function (k) { return plural(f[k], ACR[k] ? k : (LABEL[k] || k).toLowerCase()); }).join(", "); }
  function kind(e) {
    if (e === "redacted" || e === "gateway_redacted") return "kept";
    if (e === "blocked" || e === "read_blocked") return "stop";
    if (e === "asked" || e === "warned") return "ask";
    return "back";
  }
  function describe(e) {
    var f = e.path ? "<code>" + esc(e.path) + "</code>" : "";
    switch (e.event) {
      case "redacted": return "Swapped " + esc(words(e.found)) + " in " + f + " before the AI read it";
      case "gateway_redacted": return "Swapped " + esc(words(e.found)) + " in a message to the AI";
      case "read_blocked": return "Stopped the AI reading " + f;
      case "blocked": return "Stopped an AI edit to " + f;
      case "asked": return "Asked you to approve an AI edit to " + f;
      case "warned": return "Flagged an AI edit to " + f;
      case "edited": return "AI edited protected file " + f;
      case "restored": return "Put back " + plural(e.count || 0, "real value") + " before saving " + f;
      case "gateway_restored": return "Put back " + plural(e.count || 0, "real value") + " in the reply";
      default: return esc(e.event) + " " + f;
    }
  }
  function time(ts) { var d = new Date(ts); return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
  function day(ts) {
    var d = new Date(ts), now = new Date();
    if (d.toDateString() === now.toDateString()) return "Today";
    var y = new Date(now); y.setDate(now.getDate() - 1);
    if (d.toDateString() === y.toDateString()) return "Yesterday";
    return d.toLocaleDateString([], { day: "numeric", month: "short" });
  }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.floor(s / 60) + "m ago";
    if (s < 86400) return Math.floor(s / 3600) + "h ago";
    return day(ts);
  }

  function sessionTitle(s) { return s.id === "none" ? "Outside a session" : "Session " + s.short; }
  function summary(s) {
    var st = s.stats, parts = [];
    if (st.replaced) parts.push("kept <b>" + plural(st.replaced, "value") + "</b> away from the AI");
    if (st.restored) parts.push("put <b>" + st.restored + "</b> back for your tools");
    var stops = st.readsBlocked + st.editsBlocked;
    if (stops) parts.push("stopped <b>" + plural(stops, "action") + "</b>");
    if (st.asked) parts.push("asked you to approve <b>" + st.asked + "</b>");
    if (!parts.length) return "Nothing needed guarding in this session.";
    var text = parts.join(", ");
    return "Paws " + text.replace(/, ([^,]*)$/, " and $1") + ".";
  }

  function render() {
    if (!state) return;
    $("repo").textContent = state.repo;
    var r = state.policy && state.policy.redact;
    $("mode").textContent = state.policyError ? "Policy has problems" : !r || !r.enabled ? "Redaction off" : r.mode === "fake" ? "Swapping in realistic fakes" : "Swapping in placeholders";
    $("logline").textContent = state.log.intact ? "Log intact · " + plural(state.log.entries, "entry").replace("entrys", "entries") : "Log broken: " + state.log.reason;

    var ss = state.sessions;
    if (!current || !ss.some(function (s) { return s.id === current; })) current = ss.length ? ss[0].id : null;
    $("slist").innerHTML = ss.length ? ss.map(function (s) {
      var n = s.stats.replaced + s.stats.readsBlocked + s.stats.editsBlocked + s.stats.asked;
      return '<li><button data-id="' + esc(s.id) + '" aria-current="' + (s.id === current) + '"><span class="t">' + esc(day(s.end)) + ", " + esc(time(s.start)) + '</span><span class="sm">' + esc(sessionTitle(s)) + " · " + n + " guarded" + (s.viaAgent ? " · agent" : "") + "</span></button></li>";
    }).join("") : '<li class="empty sm">No sessions yet.</li>';
    $("spick").innerHTML = ss.map(function (s) { return '<option value="' + esc(s.id) + '"' + (s.id === current ? " selected" : "") + ">" + esc(day(s.end) + ", " + time(s.start) + " · " + sessionTitle(s)) + "</option>"; }).join("");

    var s = ss.find(function (x) { return x.id === current; });
    if (!s) {
      $("title").textContent = "No AI sessions yet";
      $("summary").textContent = "Use your AI tool as normal. Each session shows up here.";
      $("chips").innerHTML = ""; $("feed").innerHTML = ""; $("map").innerHTML = "";
    } else {
      $("title").innerHTML = esc(sessionTitle(s)) + ' <span class="sm">' + esc(day(s.start)) + " " + esc(time(s.start)) + "–" + esc(time(s.end)) + (s.viaAgent ? " · through the local agent" : "") + "</span>";
      $("summary").innerHTML = summary(s);
      var st = s.stats;
      var chip = function (cls, n, w) { return n ? '<span class="chip"><i class="' + cls + '"></i><b>' + n + "</b> " + w + "</span>" : ""; };
      $("chips").innerHTML = chip("k-kept", st.replaced, "swapped") + chip("k-back", st.restored, "put back") + chip("k-stop", st.readsBlocked, "reads stopped") + chip("k-stop", st.editsBlocked, "edits stopped") + chip("k-ask", st.asked, "approvals") + (s.files.length ? '<span class="chip">' + plural(s.files.length, "file") + "</span>" : "");
      $("feed").innerHTML = s.events.length ? s.events.map(function (e) {
        return '<li><span class="bar k-' + kind(e.event) + '"></span><span>' + describe(e) + '</span><span class="when" title="' + esc(e.ts) + '">' + esc(ago(e.ts)) + "</span></li>";
      }).join("") : '<li class="empty">Nothing in this session.</li>';
      $("map").innerHTML = s.mapping.length ? s.mapping.map(function (m) {
        var shown = revealed[m.standIn];
        var can = m.label !== "PRIVATE_KEY" && m.label !== "SECRET";
        return '<li><span class="type">' + esc(LABEL[m.label] || m.label) + '</span><span class="pair"><span class="mono real' + (shown ? " shown" : "") + '">' + esc(shown || m.masked) + '</span><span class="arrow">→</span><span class="mono saw">' + esc(m.standIn) + "</span></span>"
          + (can ? '<button class="link" data-s="' + esc(m.standIn) + '">' + (shown ? "Hide" : "Reveal") + "</button>" : "<span></span>")
          + (m.seenIn.length ? '<span class="files">' + esc(m.seenIn.join(", ")) + "</span>" : "") + "</li>";
      }).join("") : '<li class="empty">Nothing was swapped in this session.</li>';
    }

    var rules = state.policy ? state.policy.rules : [];
    $("rules").innerHTML = state.policyError ? '<li class="empty">' + esc(state.policyError) + "</li>" : rules.length ? rules.map(function (ru) {
      var k = ru.ai_read === "block" ? "hidden" : ru.ai_read === "redact" ? "redact" : ru.ai_edit;
      var t = { hidden: "Hidden from AI", redact: "Always swapped", block: "No AI edits", review: "Needs " + (ru.reviewers || 1) + " approval" + ((ru.reviewers || 1) === 1 ? "" : "s"), warn: "Flagged", allow: "Allowed" }[k];
      return '<li><code>' + esc(ru.path) + '</code><span class="tag ' + esc(k) + '">' + esc(t) + "</span></li>";
    }).join("") : '<li class="empty">No rules yet. Run paws init.</li>';
    $("lognote").textContent = (state.log.intact ? "The edit log is intact" : "The edit log is broken") + " (" + plural(state.log.entries, "entry").replace("entrys", "entries") + "). Each entry is chained by hash, so changing a past one shows up here and fails the pull request check.";
  }

  function received(text) {
    if (text === last) return;
    last = text;
    state = JSON.parse(text);
    render();
  }
  function refresh() {
    if (vscode) { vscode.postMessage({ type: "state" }); return; }
    fetch("/api/state" + Q, { headers: { "x-paws-token": TOKEN } }).then(function (r) { return r.text(); }).then(received).catch(function () {});
  }
  function askReveal(standIn) {
    if (vscode) { vscode.postMessage({ type: "reveal", standIn: standIn }); return; }
    fetch("/api/reveal" + Q, { method: "POST", headers: { "x-paws-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify({ standIn: standIn }) })
      .then(function (r) { return r.ok ? r.json() : null; }).then(function (j) { if (j) showRevealed(j.standIn, j.value); });
  }
  function showRevealed(standIn, value) {
    revealed[standIn] = value;
    render();
    clearTimeout(pending[standIn]);
    pending[standIn] = setTimeout(function () { delete revealed[standIn]; render(); }, 10000);
  }
  window.addEventListener("message", function (ev) {
    var m = ev.data || {};
    if (m.type === "state") received(m.json);
    if (m.type === "revealed") showRevealed(m.standIn, m.value);
    if (m.type === "focus" && m.session) { current = m.session; render(); }
  });
  $("slist").addEventListener("click", function (e) { var b = e.target.closest("button"); if (b) { current = b.dataset.id; render(); } });
  $("spick").addEventListener("change", function (e) { current = e.target.value; render(); });
  document.querySelector(".tabs").addEventListener("click", function (e) {
    var b = e.target.closest("button"); if (!b) return;
    tab = b.dataset.tab;
    document.querySelectorAll(".tabs button").forEach(function (x) { x.setAttribute("aria-selected", String(x === b)); });
    document.querySelectorAll("[data-panel]").forEach(function (p) { p.hidden = p.dataset.panel !== tab; });
  });
  $("map").addEventListener("click", function (e) {
    var b = e.target.closest("button[data-s]"); if (!b) return;
    var s = b.dataset.s;
    if (revealed[s]) { delete revealed[s]; render(); } else askReveal(s);
  });
  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`;
}

function shield() {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2 2.5 3.2v4.1c0 3.4 2.3 6.1 5.5 7.4 3.2-1.3 5.5-4 5.5-7.4V3.2L8 1.2Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 8.1 7.2 9.7l3.2-3.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

module.exports = { page };
