(function () {
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.querySelector(".nav");
  if (!toggle || !nav) return;

  toggle.addEventListener("click", function () {
    var open = nav.classList.toggle("is-open");
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
  });

  nav.querySelectorAll("a").forEach(function (link) {
    link.addEventListener("click", function () {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && nav.classList.contains("is-open")) {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
      toggle.focus();
    }
  });
})();

/* Point download buttons at the newest GitHub Release (static links are the fallback). */
(function () {
  if (!window.fetch) return;
  fetch("https://api.github.com/repos/Cookieboty/nomi-ai/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (rel) {
      if (!rel || !rel.assets) return;
      var byName = {};
      rel.assets.forEach(function (a) { byName[a.name] = a.browser_download_url; });
      function find(re) {
        for (var n in byName) if (re.test(n)) return { name: n, url: byName[n] };
      }
      var picks = {
        "dl-win": find(/^Nomi-Setup-.*\.exe$/),
        "dl-mac-arm64": find(/arm64\.dmg$/),
        "dl-mac-x64": find(/^Nomi-(?!.*arm64)[\d.]+\.dmg$/),
        "dl-linux": find(/\.AppImage$/)
      };
      Object.keys(picks).forEach(function (id) {
        var el = document.getElementById(id), p = picks[id];
        if (el && p) el.setAttribute("href", p.url);
      });
      var names = function (ids) { return ids.map(function (i) { return picks[i] && picks[i].name; }).filter(Boolean); };
      var win = document.querySelector("#dl-win"), set = function (id, list) {
        var el = document.getElementById(id); if (!el || !list.length) return;
        var pkg = el.closest(".platform-card").querySelector(".pkg");
        if (pkg) pkg.innerHTML = list.join("<br />");
      };
      set("dl-win", names(["dl-win"]));
      set("dl-mac-arm64", names(["dl-mac-arm64", "dl-mac-x64"]));
      set("dl-linux", names(["dl-linux"]));
      var rl = document.getElementById("dl-release");
      if (rl && rel.html_url) rl.setAttribute("href", rel.html_url);
    })
    .catch(function () {});
})();
