'use strict';

// The corner pop-up: a small live card for the bottom-right of the screen.
// Shows today's totals, the current AI session and the latest activity, across
// every repo on this machine. No outside requests.

function popupPage(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';">
<title>AI Guard</title>
<style>
/* A compact card: status line, today's headline, the live session, a short feed. */
:root {
  --bg: #FBFBFA; --fg: #1B1D21; --muted: #6C7078; --line: #E6E6E3; --soft: #F1F1EE;
  --kept: #3555D8; --stop: #C8312F; --ask: #A96B0F; --back: #2D8A47;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #18191C; --fg: #E3E4E7; --muted: #8E919A; --line: #2A2C31; --soft: #212327;
    --kept: #8EA6FF; --stop: #FF8A86; --ask: #F2C55C; --back: #74D48F; color-scheme: dark; }
}
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 13px/1.45 var(--font); display: flex; flex-direction: column; overflow: hidden; }
header { display: flex; align-items: center; gap: 8px; padding: 12px 14px 10px; }
header svg { width: 15px; height: 15px; flex: none; }
header b { font-weight: 600; }
.live { margin-left: auto; display: inline-flex; align-items: center; gap: 6px; color: var(--muted); font-size: 11.5px; }
.live i { width: 7px; height: 7px; border-radius: 50%; background: var(--back); }
.live.off i { background: var(--stop); }
@media (prefers-reduced-motion: no-preference) { .live:not(.off) i { animation: p 2s infinite; } @keyframes p { 50% { opacity: .35; } } }
.hero { padding: 0 14px 12px; border-bottom: 1px solid var(--line); }
.big { font-size: 26px; font-weight: 650; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; line-height: 1.1; }
.big small { font-size: 13px; font-weight: 400; color: var(--muted); letter-spacing: 0; }
.row { display: flex; gap: 12px; margin-top: 6px; color: var(--muted); font-size: 12px; flex-wrap: wrap; }
.row b { color: var(--fg); font-variant-numeric: tabular-nums; }
.session { padding: 10px 14px; background: var(--soft); border-bottom: 1px solid var(--line); }
.session .t { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
.session .s { margin-top: 2px; }
.session .s b { font-weight: 600; }
ul { list-style: none; margin: 0; padding: 4px 14px; overflow: auto; flex: 1; }
li { display: grid; grid-template-columns: 3px minmax(0, 1fr) auto; gap: 9px; padding: 7px 0; border-bottom: 1px solid var(--line); }
li:last-child { border-bottom: 0; }
.bar { border-radius: 2px; }
.kept { background: var(--kept); } .stop { background: var(--stop); } .ask { background: var(--ask); } .back { background: var(--back); }
.d { min-width: 0; overflow-wrap: anywhere; }
.d .r { color: var(--muted); font-size: 11.5px; }
code { font-family: var(--mono); font-size: 12px; }
.when { color: var(--muted); font-size: 11px; white-space: nowrap; }
.empty { color: var(--muted); padding: 16px 0; border: 0; display: block; }
footer { display: flex; justify-content: space-between; align-items: center; gap: 8px; padding: 9px 14px; border-top: 1px solid var(--line); font-size: 11.5px; color: var(--muted); }
footer a { color: var(--kept); text-decoration: none; }
footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.2 2.5 3.2v4.1c0 3.4 2.3 6.1 5.5 7.4 3.2-1.3 5.5-4 5.5-7.4V3.2L8 1.2Z" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M5.6 8.1 7.2 9.7l3.2-3.3" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
  <b>AI Guard</b>
  <span class="live" id="live"><i></i><span>Protecting</span></span>
</header>
<section class="hero">
  <div class="big" id="kept">0 <small>values kept from AI today</small></div>
  <div class="row" id="row"></div>
</section>
<section class="session" id="session" hidden><div class="t" id="stitle"></div><div class="s" id="ssum"></div></section>
<ul id="feed"></ul>
<footer><span>On this machine only · nothing stored by us</span><a id="full" href="#" target="_blank" rel="noopener">Open sessions</a></footer>
<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var last = "";
  var LABEL = { EMAIL: "email", PHONE: "phone", TFN: "TFN", ABN: "ABN", MEDICARE: "Medicare number", CARD: "card", BSB: "BSB", ACCOUNT: "account", ADDRESS: "address", DOB: "birth date", NAME: "name", SECRET: "secret", PRIVATE_KEY: "private key" };
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function words(f) { return Object.keys(f || {}).map(function (k) { return plural(f[k], LABEL[k] || k.toLowerCase()); }).join(", "); }
  function kind(e) { return e === "redacted" || e === "gateway_redacted" ? "kept" : e === "blocked" || e === "read_blocked" ? "stop" : e === "asked" || e === "warned" ? "ask" : "back"; }
  function line(e) {
    var f = e.path ? " <code>" + esc(e.path) + "</code>" : "";
    switch (e.event) {
      case "redacted": return "Swapped " + esc(words(e.found)) + " in" + f;
      case "gateway_redacted": return "Swapped " + esc(words(e.found)) + " in a message";
      case "read_blocked": return "Stopped a read of" + f;
      case "blocked": return "Stopped an edit to" + f;
      case "asked": return "Needs your approval:" + f;
      case "warned": return "Flagged an edit to" + f;
      case "restored": case "gateway_restored": return "Put back " + plural(e.count || 0, "real value");
      default: return esc(e.event);
    }
  }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : new Date(ts).toLocaleDateString();
  }
  function render(d) {
    var t = d.today;
    $("kept").innerHTML = t.kept + " <small>" + (t.kept === 1 ? "value" : "values") + " kept from AI today</small>";
    $("row").innerHTML = "<span><b>" + t.stopped + "</b> stopped</span><span><b>" + t.asked + "</b> " + (t.asked === 1 ? "approval" : "approvals") + "</span><span><b>" + t.restored + "</b> put back</span><span><b>" + t.sessions + "</b> " + (t.sessions === 1 ? "session" : "sessions") + "</span>";
    var s = d.current;
    $("session").hidden = !s;
    if (s) {
      $("stitle").textContent = "Now · " + s.repo + (s.session ? " · " + s.session.slice(0, 8) : "");
      var bits = [];
      if (s.kept) bits.push("kept <b>" + plural(s.kept, "value") + "</b> from the AI");
      if (s.stopped) bits.push("stopped <b>" + s.stopped + "</b>");
      if (s.asked) bits.push("asked about <b>" + s.asked + "</b>");
      $("ssum").innerHTML = bits.length ? "This session: " + bits.join(", ") + "." : "Nothing needed guarding in this session yet.";
      $("full").href = "/full?t=" + encodeURIComponent(TOKEN) + "&root=" + encodeURIComponent(s.root);
    }
    $("feed").innerHTML = d.events.length ? d.events.map(function (e) {
      return '<li><span class="bar ' + kind(e.event) + '"></span><span class="d">' + line(e) + '<div class="r">' + esc(e.repo) + '</div></span><span class="when">' + ago(e.ts) + "</span></li>";
    }).join("") : '<li class="empty">Nothing yet. Use your AI tools as normal; AI Guard shows what it does here.</li>';
  }
  function refresh() {
    fetch("/api/feed", { headers: { "x-aiguard-token": TOKEN } })
      .then(function (r) { return r.text(); })
      .then(function (txt) { $("live").className = "live"; $("live").lastChild.textContent = "Protecting"; if (txt !== last) { last = txt; render(JSON.parse(txt)); } })
      .catch(function () { $("live").className = "live off"; $("live").lastChild.textContent = "Not running"; });
  }
  try { if (window.outerWidth > 500) { window.resizeTo(380, 520); window.moveTo(screen.availWidth - 400, screen.availHeight - 540); } } catch (e) {}
  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;
}

module.exports = { popupPage };
