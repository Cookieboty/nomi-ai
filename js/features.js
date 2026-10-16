/* Features page: progressive-enhancement tabs (ARIA tablist). Without JS every panel is shown stacked. */
(function () {
  var root = document.getElementById("pillars");
  if (!root) return;
  var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
  var panels = tabs.map(function (t) { return document.getElementById(t.getAttribute("aria-controls")); });
  if (!tabs.length || panels.indexOf(null) !== -1) return;

  function select(i, focus, updateHash) {
    tabs.forEach(function (t, j) {
      var on = i === j;
      t.setAttribute("aria-selected", on ? "true" : "false");
      t.tabIndex = on ? 0 : -1;
      panels[j].hidden = !on;
    });
    if (focus) tabs[i].focus();
    if (updateHash && window.history && history.replaceState) {
      history.replaceState(null, "", "#" + panels[i].id.replace(/^panel-/, ""));
    }
  }

  root.classList.add("is-enhanced");
  var start = 0, hash = (location.hash || "").replace(/^#/, "");
  if (hash) panels.forEach(function (p, j) { if (p.id === "panel-" + hash) start = j; });
  select(start, false, false);

  tabs.forEach(function (t, i) {
    t.addEventListener("click", function () { select(i, false, true); });
    t.addEventListener("keydown", function (e) {
      var n = tabs.length, to = -1;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") to = (i + 1) % n;
      else if (e.key === "ArrowUp" || e.key === "ArrowLeft") to = (i - 1 + n) % n;
      else if (e.key === "Home") to = 0;
      else if (e.key === "End") to = n - 1;
      if (to < 0) return;
      e.preventDefault();
      select(to, true, true);
    });
  });
})();
