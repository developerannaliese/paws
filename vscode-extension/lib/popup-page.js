'use strict';

// The corner pop-up: PawsOff companion. Black, white, Soft Indigo.

function popupPage(token) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self';">
<title>PawsOff</title>
<style>
:root {
  --bg: #FFFFFF; --fg: #111111; --muted: #888888; --line: #E8E8E8; --soft: #F5F5F5;
  --accent: #6366F1; --accent2: #4F46E5; --accent-soft: #EEF2FF;
  --stop: #DC2626; --ask: #D4943A; --back: #4A9B62; --kept: #6366F1;
  --font: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #111111; --fg: #F0F0F0; --muted: #777777; --line: #262626; --soft: #1A1A1A;
    --accent: #818CF8; --accent2: #A5B4FC; --accent-soft: #1E1B4B;
    --stop: #F87171; --ask: #E8B86D; --back: #6CC485; --kept: #818CF8; color-scheme: dark; }
}
* { box-sizing: border-box; margin: 0; }
html, body { height: 100%; }
body { background: var(--bg); color: var(--fg); font: 13px/1.5 var(--font); display: flex; flex-direction: column; overflow: hidden; -webkit-font-smoothing: antialiased; }

header { display: flex; align-items: center; gap: 10px; padding: 14px 16px 12px; border-bottom: 1px solid var(--line); }
.logo { width: 20px; height: 20px; flex: none; }
.logo-text { font-size: 15px; font-weight: 700; letter-spacing: -0.02em; }
.hdr-right { margin-left: auto; display: flex; align-items: center; gap: 10px; }
.status { display: inline-flex; align-items: center; gap: 5px; font-size: 11px; color: var(--muted); }
.status .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--back); }
.status.off .dot { background: var(--stop); }
@media (prefers-reduced-motion: no-preference) { .status:not(.off) .dot { animation: pulse 2s infinite; } }
@keyframes pulse { 50% { opacity: .3; } }
.gear { background: none; border: none; padding: 2px; cursor: pointer; color: var(--muted); display: flex; }
.gear:hover { color: var(--fg); }
.gear svg { width: 15px; height: 15px; }

.hero { padding: 16px 16px 14px; }
.big-num { font-size: 36px; font-weight: 800; letter-spacing: -0.04em; line-height: 1; font-variant-numeric: tabular-nums; color: var(--accent); }
.big-label { font-size: 11.5px; color: var(--muted); margin-top: 3px; text-transform: uppercase; letter-spacing: .04em; }
.stats { display: flex; gap: 6px; margin-top: 12px; }
.stat { flex: 1; border: 1px solid var(--line); border-radius: 8px; padding: 8px 0; text-align: center; }
.stat .n { font-size: 17px; font-weight: 700; font-variant-numeric: tabular-nums; line-height: 1; }
.stat .l { font-size: 9.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .05em; margin-top: 3px; }
.stat.stop .n { color: var(--stop); } .stat.ask .n { color: var(--ask); } .stat.back .n { color: var(--back); }

.tabs { display: flex; border-top: 1px solid var(--line); border-bottom: 1px solid var(--line); }
.tab { flex: 1; background: none; border: none; padding: 8px 0; font: inherit; font-size: 11px; font-weight: 600; color: var(--muted); cursor: pointer; text-transform: uppercase; letter-spacing: .05em; border-bottom: 2px solid transparent; text-align: center; }
.tab:hover { color: var(--fg); }
.tab.on { color: var(--fg); border-bottom-color: var(--accent); }

.session { padding: 10px 16px; background: var(--accent-soft); border-bottom: 1px solid var(--line); }
.session .label { font-size: 9.5px; color: var(--accent); text-transform: uppercase; letter-spacing: .06em; font-weight: 700; }
.session .detail { margin-top: 2px; font-size: 12px; }
.session .detail b { font-weight: 700; }

.panel { flex: 1; overflow: auto; }
.feed { list-style: none; padding: 4px 16px; }
.feed li { padding: 10px 0; border-bottom: 1px solid var(--line); }
.feed li:last-child { border-bottom: 0; }
.ev-top { display: flex; align-items: center; gap: 8px; }
.ev-tag { font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; padding: 2px 7px; border-radius: 3px; flex: none; }
.ev-tag.kept { background: var(--accent); color: white; }
.ev-tag.stop { background: var(--fg); color: var(--bg); }
.ev-tag.ask { background: var(--ask); color: white; }
.ev-tag.back { background: var(--soft); color: var(--fg); border: 1px solid var(--line); }
.ev-time { margin-left: auto; font-size: 10px; color: var(--muted); white-space: nowrap; }
.ev-msg { font-size: 12px; margin-top: 4px; line-height: 1.4; overflow-wrap: anywhere; }
.ev-msg code { font-family: var(--mono); font-size: 11px; background: var(--soft); padding: 1px 4px; border-radius: 3px; }
.ev-repo { font-size: 10px; color: var(--muted); margin-top: 2px; }
.empty { color: var(--muted); padding: 24px 0; text-align: center; font-size: 12px; }

.settings { padding: 14px 16px; display: none; flex-direction: column; gap: 12px; overflow: auto; }
.settings.show { display: flex; }
.sgroup { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.sgroup .stitle { font-size: 9.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); font-weight: 700; margin-bottom: 6px; }
.srow { display: flex; justify-content: space-between; align-items: center; padding: 3px 0; font-size: 12px; }
.srow .sval { font-size: 11.5px; font-family: var(--mono); }
.srow .sval.on { color: var(--back); }
.srow .sval.off { color: var(--stop); }
.rules-list { margin-top: 4px; }
.rule { display: flex; gap: 8px; align-items: center; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--line); }
.rule:last-child { border-bottom: 0; }
.rule .rpath { font-family: var(--mono); font-size: 11px; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.badge { display: inline-block; font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 3px; text-transform: uppercase; letter-spacing: .03em; }
.badge.block { background: var(--fg); color: var(--bg); }
.badge.review { background: var(--ask); color: white; }
.badge.warn { border: 1px solid var(--line); color: var(--muted); }
.badge.redact { background: var(--accent); color: white; }
.badge.allow { border: 1px solid var(--line); color: var(--muted); }

.toggle { background: none; border: 1px solid var(--line); border-radius: 4px; padding: 2px 10px; font: inherit; font-size: 11px; font-family: var(--mono); cursor: pointer; color: var(--fg); }
.toggle:hover { border-color: var(--accent); }
.toggle.on { color: var(--back); border-color: var(--back); }
.toggle.off { color: var(--stop); border-color: var(--stop); }
.add-row { display: flex; gap: 4px; margin-top: 8px; align-items: center; }
.sinput { background: var(--bg); border: 1px solid var(--line); border-radius: 4px; padding: 4px 8px; font: inherit; font-size: 11px; font-family: var(--mono); color: var(--fg); outline: none; }
.sinput:focus { border-color: var(--accent); }
.sbtn { background: var(--fg); color: var(--bg); border: none; border-radius: 4px; padding: 4px 10px; font: inherit; font-size: 11px; font-weight: 600; cursor: pointer; }
.sbtn:hover { opacity: 0.8; }
.sbtn-x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 14px; padding: 0 4px; }
.sbtn-x:hover { color: var(--stop); }
.custom-item { display: flex; align-items: center; gap: 6px; padding: 4px 0; font-size: 12px; border-bottom: 1px solid var(--line); }
.custom-item:last-child { border-bottom: 0; }
.custom-item .clabel { font-weight: 700; font-size: 10px; text-transform: uppercase; color: var(--accent); }
.custom-item .cpattern { font-family: var(--mono); font-size: 11px; flex: 1; color: var(--muted); overflow-wrap: anywhere; }

footer { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px; border-top: 1px solid var(--line); font-size: 10.5px; color: var(--muted); }
footer a { color: var(--accent); text-decoration: none; font-weight: 600; }
footer a:hover { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <svg class="logo" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <ellipse cx="8.5" cy="6" rx="2.2" ry="2.7" fill="var(--fg)"/>
    <ellipse cx="15.5" cy="6" rx="2.2" ry="2.7" fill="var(--fg)"/>
    <ellipse cx="5" cy="11.5" rx="1.9" ry="2.4" fill="var(--fg)"/>
    <ellipse cx="19" cy="11.5" rx="1.9" ry="2.4" fill="var(--fg)"/>
    <path d="M12 11c-3.5 0-6 2.5-6 5.2 0 2.8 2.2 5.3 6 5.3s6-2.5 6-5.3C18 13.5 15.5 11 12 11Z" fill="var(--fg)"/>
  </svg>
  <span class="logo-text">PawsOff</span>
  <span class="hdr-right">
    <span class="status" id="live"><span class="dot"></span><span>Active</span></span>
    <button class="gear" id="gear-btn" title="Settings"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v1.3M8 13.2v1.3M1.5 8h1.3M13.2 8h1.3M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9"/></svg></button>
  </span>
</header>

<section class="hero">
  <div class="big-num" id="kept">0</div>
  <div class="big-label" id="kept-label">values kept from AI today</div>
  <div class="stats">
    <div class="stat stop"><div class="n" id="st-stop">0</div><div class="l">Blocked</div></div>
    <div class="stat ask"><div class="n" id="st-ask">0</div><div class="l">Reviews</div></div>
    <div class="stat back"><div class="n" id="st-back">0</div><div class="l">Restored</div></div>
  </div>
</section>

<div class="tabs" id="tabs">
  <button class="tab on" data-tab="activity">Activity</button>
  <button class="tab" data-tab="settings">Settings</button>
</div>

<section class="session" id="session" hidden>
  <div class="label" id="stitle"></div>
  <div class="detail" id="ssum"></div>
</section>

<div class="panel" id="panel-activity">
  <ul class="feed" id="feed"></ul>
</div>

<div class="settings panel" id="panel-settings">
  <div class="sgroup">
    <div class="stitle">Protection</div>
    <div class="srow"><span>Redaction</span><button class="toggle" id="s-redact-btn" data-key="enabled">-</button></div>
    <div class="srow"><span>Mode</span><button class="toggle" id="s-mode-btn" data-key="mode">-</button></div>
    <div class="srow"><span>Local model</span><span class="sval" id="s-model">-</span></div>
    <div class="srow"><span>Shell output</span><span class="sval" id="s-shell">-</span></div>
  </div>
  <div class="sgroup">
    <div class="stitle">Custom labels</div>
    <div id="s-custom"></div>
    <div class="add-row" id="add-custom">
      <input type="text" id="cl-label" placeholder="SALARY" class="sinput" style="width:30%">
      <input type="text" id="cl-pattern" placeholder="\\$[\\d,]+\\.\\d{2}" class="sinput" style="width:45%">
      <button class="sbtn" id="cl-add">Add</button>
    </div>
  </div>
  <div class="sgroup">
    <div class="stitle">Rules</div>
    <div class="rules-list" id="s-rules"></div>
  </div>
  <div class="sgroup">
    <div class="stitle">Info</div>
    <div class="srow"><span>Policy</span><span class="sval" id="s-file">-</span></div>
    <div class="srow"><span>Repo</span><span class="sval" id="s-repo">-</span></div>
    <div class="srow"><span>Sessions today</span><span class="sval" id="s-sessions">0</span></div>
  </div>
</div>

<footer>
  <span>Local only \u00b7 nothing leaves this machine</span>
  <a id="full" href="#" target="_blank" rel="noopener">Sessions \u2197</a>
</footer>

<script>
(function () {
  var TOKEN = ${JSON.stringify(token)};
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var last = "";
  var currentTab = "activity";

  document.querySelectorAll(".tab").forEach(function (btn) {
    btn.addEventListener("click", function () {
      currentTab = btn.dataset.tab;
      document.querySelectorAll(".tab").forEach(function (b) { b.className = "tab" + (b.dataset.tab === currentTab ? " on" : ""); });
      $("panel-activity").style.display = currentTab === "activity" ? "" : "none";
      $("panel-settings").className = "settings panel" + (currentTab === "settings" ? " show" : "");
      $("session").style.display = currentTab === "activity" ? "" : "none";
      if (currentTab === "settings") loadSettings();
    });
  });
  $("gear-btn").addEventListener("click", function () {
    document.querySelector('.tab[data-tab="settings"]').click();
  });

  var LABEL = { EMAIL: "email", PHONE: "phone", TFN: "TFN", ABN: "ABN", MEDICARE: "Medicare", CARD: "card", BSB: "BSB", ACCOUNT: "account", ADDRESS: "address", DOB: "DOB", NAME: "name", SECRET: "secret", PRIVATE_KEY: "key" };
  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }
  function words(f) { return Object.keys(f || {}).map(function (k) { return plural(f[k], LABEL[k] || k.toLowerCase()); }).join(", "); }
  function kind(e) { return e === "redacted" || e === "gateway_redacted" ? "kept" : e === "blocked" || e === "read_blocked" ? "stop" : e === "asked" || e === "warned" || e === "uncertain" || e === "image_warning" ? "ask" : "back"; }
  function tagLabel(e) {
    switch (e) {
      case "redacted": case "gateway_redacted": return "Redacted";
      case "read_blocked": case "blocked": return "Blocked";
      case "asked": return "Review";
      case "warned": return "Flagged";
      case "uncertain": return "Unsure";
      case "image_warning": return "Warning";
      case "restored": case "gateway_restored": return "Restored";
      default: return e;
    }
  }
  function line(e) {
    var f = e.path ? "<code>" + esc(e.path) + "</code>" : "";
    switch (e.event) {
      case "redacted": return esc(words(e.found)) + " in " + f;
      case "gateway_redacted": return esc(words(e.found)) + " in outgoing prompt";
      case "read_blocked": return f;
      case "blocked": return f;
      case "asked": return f;
      case "warned": return f;
      case "uncertain": return "Possible PII in " + f;
      case "image_warning": return f + " may contain personal data";
      case "restored": case "gateway_restored": return plural(e.count || 0, "value") + " back to real data";
      default: return esc(e.event);
    }
  }
  function ago(ts) {
    var s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
    return s < 60 ? "now" : s < 3600 ? Math.floor(s / 60) + "m" : s < 86400 ? Math.floor(s / 3600) + "h" : new Date(ts).toLocaleDateString();
  }

  function render(d) {
    var t = d.today;
    $("kept").textContent = t.kept;
    $("kept-label").textContent = (t.kept === 1 ? "value" : "values") + " kept from AI today";
    $("st-stop").textContent = t.stopped;
    $("st-ask").textContent = t.asked;
    $("st-back").textContent = t.restored;

    var s = d.current;
    $("session").hidden = !s || currentTab !== "activity";
    if (s) {
      $("stitle").textContent = s.repo + (s.session ? " \u00b7 " + s.session.slice(0, 8) : "");
      var bits = [];
      if (s.kept) bits.push("<b>" + s.kept + "</b> redacted");
      if (s.stopped) bits.push("<b>" + s.stopped + "</b> blocked");
      if (s.asked) bits.push("<b>" + s.asked + "</b> pending");
      $("ssum").innerHTML = bits.length ? bits.join(" \u00b7 ") : "Session clean \u2014 nothing flagged";
      $("full").href = "/full?t=" + encodeURIComponent(TOKEN) + "&root=" + encodeURIComponent(s.root);
    }

    if (currentTab === "activity") {
      $("feed").innerHTML = d.events.length ? d.events.map(function (e) {
        var k = kind(e.event);
        return '<li>'
          + '<div class="ev-top"><span class="ev-tag ' + k + '">' + tagLabel(e.event) + '</span><span class="ev-time">' + ago(e.ts) + '</span></div>'
          + '<div class="ev-msg">' + line(e) + '</div>'
          + '<div class="ev-repo">' + esc(e.repo) + '</div>'
          + '</li>';
      }).join("") : '<li class="empty">No activity yet.<br>PawsOff watches quietly until something needs catching.</li>';
    }
  }

  var currentSettings = {};

  function postSettings(changes) {
    fetch("/api/settings", { method: "POST", headers: { "x-pawsoff-token": TOKEN, "content-type": "application/json" }, body: JSON.stringify(changes) })
      .then(function () { loadSettings(); })
      .catch(function () {});
  }

  $("s-redact-btn").addEventListener("click", function () { postSettings({ enabled: !currentSettings.redactEnabled }); });
  $("s-mode-btn").addEventListener("click", function () { postSettings({ mode: currentSettings.mode === "fake" ? "placeholder" : "fake" }); });
  $("cl-add").addEventListener("click", function () {
    var label = $("cl-label").value.trim();
    var pattern = $("cl-pattern").value.trim();
    if (!label || !pattern) return;
    postSettings({ addCustom: { label: label, pattern: pattern } });
    $("cl-label").value = "";
    $("cl-pattern").value = "";
  });

  function loadSettings() {
    fetch("/api/settings", { headers: { "x-pawsoff-token": TOKEN } })
      .then(function (r) { return r.json(); })
      .then(function (s) {
        currentSettings = s;
        $("s-redact-btn").textContent = s.redactEnabled ? "On" : "Off";
        $("s-redact-btn").className = "toggle " + (s.redactEnabled ? "on" : "off");
        $("s-mode-btn").textContent = s.mode || "placeholder";
        $("s-mode-btn").className = "toggle";
        $("s-model").textContent = s.localModel || "None";
        $("s-model").className = "sval " + (s.localModel ? "on" : "");
        $("s-shell").textContent = s.shellOutput ? "On" : "Off";
        $("s-shell").className = "sval " + (s.shellOutput ? "on" : "off");
        $("s-file").textContent = s.policyFile || "-";
        $("s-repo").textContent = s.repo || "-";
        $("s-sessions").textContent = s.sessions || "0";
        $("s-rules").innerHTML = (s.rules || []).map(function (r) {
          var action = r.ai_read === "block" ? "block" : r.ai_read === "redact" ? "redact" : r.ai_edit || "allow";
          return '<div class="rule"><span class="badge ' + esc(action) + '">' + esc(action) + '</span><span class="rpath">' + esc(r.path) + '</span></div>';
        }).join("") || '<div style="font-size:12px;color:var(--muted)">No rules</div>';
        $("s-custom").innerHTML = (s.custom || []).map(function (c) {
          return '<div class="custom-item"><span class="clabel">' + esc(c.label) + '</span><span class="cpattern">' + esc(c.pattern || c.columns.join(", ")) + '</span><button class="sbtn-x" data-remove="' + esc(c.label) + '">\u00d7</button></div>';
        }).join("") || '<div style="font-size:11px;color:var(--muted);padding:4px 0">No custom labels. Add one below.</div>';
        document.querySelectorAll(".sbtn-x[data-remove]").forEach(function (btn) {
          btn.addEventListener("click", function () { postSettings({ removeCustom: btn.dataset.remove }); });
        });
      })
      .catch(function () {});
  }

  function refresh() {
    fetch("/api/feed", { headers: { "x-pawsoff-token": TOKEN } })
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        $("live").className = "status";
        $("live").lastElementChild.textContent = "Active";
        if (txt !== last) { last = txt; render(JSON.parse(txt)); }
      })
      .catch(function () {
        $("live").className = "status off";
        $("live").lastElementChild.textContent = "Offline";
      });
  }

  try { if (window.outerWidth > 500) { window.resizeTo(360, 540); window.moveTo(screen.availWidth - 380, screen.availHeight - 560); } } catch (e) {}
  refresh();
  setInterval(refresh, 2000);
})();
</script>
</body>
</html>`;
}

module.exports = { popupPage };
