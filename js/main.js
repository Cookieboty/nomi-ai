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
      /* Until v2.0.0 is formally released, keep static v2.0.0 package labels;
         only rewrite hrefs/names when the latest tag is v2.x. */
      var tag = String(rel.tag_name || rel.name || "");
      if (!/^v?2\./.test(tag)) {
        var rl0 = document.getElementById("dl-release");
        if (rl0 && rel.html_url) rl0.setAttribute("href", rel.html_url);
        return;
      }
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
      set("dl-mac", names(["dl-mac-arm64", "dl-mac-x64"]));
      set("dl-linux", names(["dl-linux"]));
      var rl = document.getElementById("dl-release");
      if (rl && rel.html_url) rl.setAttribute("href", rel.html_url);
    })
    .catch(function () {});
})();

/* Contact popover (desktop) / bottom sheet (mobile); home page scrolls to #contact. Links fall back to index.html#contact without JS. */
(function () {
  var triggers = document.querySelectorAll("[data-contact-open]");
  if (!triggers.length) return;
  var section = document.getElementById("contact");

  var tr = function (k, fb) { try { return (window.NomiI18n && window.NomiI18n.t) ? window.NomiI18n.t(k) : fb; } catch (e) { return fb; } };
  if (section) {
    triggers.forEach(function (a) {
      a.setAttribute("href", "#contact");
      a.addEventListener("click", function (e) {
        e.preventDefault();
        var nav = document.querySelector(".nav"), tg = document.querySelector(".nav-toggle");
        if (nav) nav.classList.remove("is-open"); if (tg) tg.setAttribute("aria-expanded", "false");
        section.scrollIntoView({ behavior: "smooth", block: "start" });
        /* lazy images above may grow the page during the smooth scroll; settle on the section afterwards */
        var tries = 0, settle = function () {
          var top = section.getBoundingClientRect().top, hh = parseInt(getComputedStyle(document.documentElement).getPropertyValue("--header-h"), 10) || 72;
          var atEnd = Math.abs(window.innerHeight + window.scrollY - document.documentElement.scrollHeight) < 4;
          if (Math.abs(top - hh - 12) > 24 && !atEnd && tries++ < 4) { section.scrollIntoView({ behavior: "smooth", block: "start" }); setTimeout(settle, 700); }
        };
        setTimeout(settle, 900);
        if (history.replaceState) history.replaceState(null, "", "#contact");
      });
    });
    return;
  }
  var V = "20261019c", pop, backdrop, built = false, opener = null;
  function card(name, altKey) {
    return '<picture><source type="image/webp" data-srcset="assets/contact/' + name + '.webp?v=' + V + '" />' +
      '<img width="360" height="480" decoding="async" data-src="assets/contact/' + name + '.png?v=' + V + '" alt="" data-i18n-alt="' + altKey + '" /></picture>';
  }
  function build() {
    backdrop = document.createElement("div"); backdrop.className = "cpop-backdrop"; backdrop.hidden = true;
    pop = document.createElement("div"); pop.className = "cpop"; pop.id = "contact-pop"; pop.hidden = true;
    pop.setAttribute("role", "dialog"); pop.setAttribute("aria-modal", "true"); pop.setAttribute("aria-labelledby", "contact-pop-title");
    pop.innerHTML = '<div class="cpop-head"><h2 id="contact-pop-title" data-i18n="contactPop.title">联系我们</h2>' +
      '<button type="button" class="cpop-close" data-i18n-aria-label="contactPop.close" aria-label="关闭">&times;</button></div>' +
      '<div class="cpop-grid">' + card("qr-author", "contactPop.author") + card("qr-group", "contactPop.group") + '</div>' +
      '<p class="cpop-hint" data-i18n="contactPop.hint">长按识别二维码</p>' +
      '<a class="cpop-issues" href="https://github.com/Cookieboty/nomi-ai/issues" target="_blank" rel="noopener noreferrer" data-i18n="contactPop.issues">遇到问题或有新想法？去 GitHub Issues 反馈</a>';
    document.body.appendChild(backdrop); document.body.appendChild(pop);
    backdrop.addEventListener("click", close);
    pop.querySelector(".cpop-close").addEventListener("click", close);
    pop.addEventListener("keydown", function (e) {
      if (e.key !== "Tab") return;
      var f = pop.querySelectorAll("button, a[href]"), first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    });
  }
  function localize() {
    pop.querySelectorAll("[data-i18n]").forEach(function (el) { el.textContent = tr(el.getAttribute("data-i18n"), el.textContent); });
    pop.querySelectorAll("[data-i18n-alt]").forEach(function (el) { el.alt = tr(el.getAttribute("data-i18n-alt"), el.alt); });
    pop.querySelectorAll("[data-i18n-aria-label]").forEach(function (el) { el.setAttribute("aria-label", tr(el.getAttribute("data-i18n-aria-label"), el.getAttribute("aria-label"))); });
  }
  function open(t) {
    if (!pop) build();
    if (!built) {
      pop.querySelectorAll("source[data-srcset]").forEach(function (s) { s.srcset = s.getAttribute("data-srcset"); });
      pop.querySelectorAll("img[data-src]").forEach(function (i) { i.src = i.getAttribute("data-src"); });
      built = true;
    }
    localize();
    opener = t;
    var nav = document.querySelector(".nav"), tg = document.querySelector(".nav-toggle");
    if (nav) nav.classList.remove("is-open"); if (tg) tg.setAttribute("aria-expanded", "false");
    pop.hidden = false; backdrop.hidden = false;
    triggers.forEach(function (x) { x.setAttribute("aria-expanded", "true"); });
    pop.querySelector(".cpop-close").focus();
  }
  function close() {
    if (!pop || pop.hidden) return;
    pop.hidden = true; backdrop.hidden = true;
    triggers.forEach(function (x) { x.setAttribute("aria-expanded", "false"); });
    var tg = document.querySelector(".nav-toggle");
    var target = opener && opener.offsetParent !== null ? opener : tg;
    if (target) target.focus();
  }
  triggers.forEach(function (a) {
    a.setAttribute("role", "button");
    a.setAttribute("aria-haspopup", "dialog");
    a.setAttribute("aria-expanded", "false");
    a.setAttribute("aria-controls", "contact-pop");
    a.addEventListener("click", function (e) {
      e.preventDefault(); e.stopPropagation();
      if (pop && !pop.hidden) close(); else open(a);
    });
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
})();
