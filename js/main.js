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
        var card = el.closest(".platform-card"), pkg = card && card.querySelector(".pkg");
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
  var V = "20261027qr2", pop, backdrop, built = false, opener = null;
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
      '<div class="cpop-grid">' + card("qr-author-yxf", "contactPop.yxf") + card("qr-author", "contactPop.author") + '</div>' +
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
    place();
    triggers.forEach(function (x) { x.setAttribute("aria-expanded", "true"); });
    pop.querySelector(".cpop-close").focus();
  }
  /* desktop: drop down right under the link that opened it; mobile keeps the bottom sheet */
  function place() {
    var t = opener && opener.offsetParent !== null ? opener : null;
    if (!t || !window.matchMedia("(min-width: 861px)").matches) {
      pop.style.left = pop.style.right = pop.style.top = ""; pop.style.removeProperty("--caret-x"); pop.classList.remove("cpop--anchored");
      return;
    }
    var r = t.getBoundingClientRect(), w = pop.offsetWidth, gap = 16;
    var left = Math.min(Math.max(r.left + r.width / 2 - w / 2, gap), window.innerWidth - w - gap);
    pop.classList.add("cpop--anchored");
    pop.style.left = left + "px"; pop.style.right = "auto"; pop.style.top = (r.bottom + 12) + "px";
    pop.style.setProperty("--caret-x", (r.left + r.width / 2 - left) + "px");
  }
  window.addEventListener("resize", function () { if (pop && !pop.hidden) place(); });

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

/* Lead with the visitor's own platform: its card gets the primary button, the others step back.
   Unknown platforms (phones, odd UAs) keep all three primary. */
(function () {
  var nav = window.navigator || {};
  var p = ((nav.userAgentData && nav.userAgentData.platform) || nav.platform || "").toLowerCase();
  var ua = (nav.userAgent || "").toLowerCase();
  if (/android|iphone|ipad|ipod/.test(ua)) return;
  var os = /mac/.test(p) ? "mac" : /win/.test(p) ? "win" : /linux|x11/.test(p) ? "linux" : "";
  if (!os) return;
  document.querySelectorAll("[data-dl-cards]").forEach(function (grid) {
    var card = grid.querySelector('[data-os="' + os + '"]');
    if (!card) return;
    grid.classList.add("has-current");
    card.classList.add("is-current");
    var tag = document.createElement("span");
    tag.className = "dl-yours";
    tag.setAttribute("data-i18n", "dl.yours");
    var fb = document.documentElement.lang.indexOf("en") === 0 ? "Your system" : "你的系统";
    try { tag.textContent = (window.NomiI18n && window.NomiI18n.t) ? window.NomiI18n.t("dl.yours") : fb; } catch (e) { tag.textContent = fb; }
    if (tag.textContent === "dl.yours") tag.textContent = fb;
    card.appendChild(tag);
  });
  if (os === "mac" || os === "linux") detectArch(os);
})();

/* Which chip: Chromium reports the CPU architecture; Safari / Firefox only via the WebGL renderer name
   ("Apple M2…" vs "Intel Iris…" / "AMD Radeon…" on Intel Macs; Safari often masks it as "Apple GPU",
   which tells nothing). Mac: an Intel Mac gets the Intel build as the primary button; when unsure we
   don't guess, the card says how to check. Linux: only x64 is built, so ARM machines are told up front. */
function detectArch(os) {
  var nav = window.navigator || {};
  var fromGpu = function () {
    try {
      var gl = document.createElement("canvas").getContext("webgl");
      var ext = gl && gl.getExtension("WEBGL_debug_renderer_info");
      var r = String((gl && gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)) || "");
      if (/apple m\d|apple a\d/i.test(r)) return "arm";
      if (/intel|amd|radeon|nvidia/i.test(r)) return "x86";
    } catch (e) {}
    return "";
  };
  var apply = function (arch) { os === "mac" ? applyMac(arch) : applyLinux(arch); };
  var uad = nav.userAgentData;
  if (uad && uad.getHighEntropyValues) {
    uad.getHighEntropyValues(["architecture"]).then(function (v) {
      apply(v && /arm/i.test(v.architecture) ? "arm" : v && /x86/i.test(v.architecture) ? "x86" : fromGpu());
    }, function () { apply(fromGpu()); });
  } else apply(fromGpu());
}
function chipNote(card, key, fb) {
  if (!card || card.querySelector(".dl-chip")) return;
  var p = document.createElement("p");
  p.className = "dl-chip";
  var text = fb;
  try { if (window.NomiI18n && window.NomiI18n.t) text = window.NomiI18n.t(key); } catch (e) {}
  p.textContent = text === key ? fb : text;
  var req = card.querySelector(".req");
  if (req) req.insertAdjacentElement("afterend", p); else card.appendChild(p);
}
function applyMac(arch) {
  var en = document.documentElement.lang.indexOf("en") === 0;
  var arm = document.getElementById("dl-mac-arm64"), x64 = document.getElementById("dl-mac-x64");
  if (!arm || !x64) return;
  var card = arm.closest("[data-os]");
  if (arch === "x86") {
    arm.className = "dl-alt";
    x64.className = "btn btn-primary";
    arm.parentNode.insertBefore(x64, arm);
    chipNote(card, "dl.chip.intel", en ? "Detected an Intel Mac" : "已识别为 Intel 芯片的 Mac");
  } else if (arch === "arm") {
    chipNote(card, "dl.chip.arm", en ? "Detected Apple silicon" : "已识别为 Apple 芯片的 Mac");
  } else {
    chipNote(card, "dl.chip.unknown", en
      ? "Not sure? Apple menu → About This Mac: \"Chip: Apple M…\" takes the Apple silicon build, \"Processor: Intel\" the Intel build."
      : "不确定选哪个？苹果菜单 →「关于本机」：写着「芯片 Apple M…」选 Apple 芯片版，写着「处理器 Intel」选 Intel 芯片版。");
  }
}
function applyLinux(arch) {
  if (arch !== "arm") return;
  var en = document.documentElement.lang.indexOf("en") === 0;
  var a = document.getElementById("dl-linux");
  chipNote(a && a.closest("[data-os]"), "dl.chip.linuxArm", en ? "Only an x64 build is available for now; ARM devices aren't supported yet." : "目前只提供 x64 版，ARM 设备暂不支持。");
}

/* Motion: header shadow, hero parallax, staggered reveal on scroll. Skipped entirely for reduced motion. */
(function () {
  var header = document.querySelector(".site-header");
  var onScrollHeader = function () { if (header) header.classList.toggle("is-scrolled", window.scrollY > 8); };
  onScrollHeader();
  window.addEventListener("scroll", onScrollHeader, { passive: true });

  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("js-motion");

  var heroMedia = document.querySelector(".hero-bleed-media");
  if (heroMedia) {
    var ticking = false;
    window.addEventListener("scroll", function () {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(function () {
        var y = Math.min(window.scrollY, 800);
        heroMedia.style.setProperty("--parallax", (y * 0.25).toFixed(1) + "px");
        ticking = false;
      });
    }, { passive: true });
  }

  /* groups reveal one after another; singles just fade up */
  var groups = [
    ".pillars--trio > .pillar", ".modes > .mode-card", ".sixcaps-grid > .sixcap-card", ".workflow-steps > li",
    "[data-dl-cards] > *", ".contact-grid > *", ".v2full-grid > *", ".v2full-shots > *", ".docs-grid > *",
    ".steps > *", ".release-list > *", ".footer-inner > *", ".bento-grid > *"
  ];
  var singles = [
    ".section-head", ".pillars-head", ".workflow-head", ".callout", ".cta-band", ".home-download-copy > h2",
    ".home-download-copy > .lead", ".home-download-stats", ".dl-hero-copy > h1", ".dl-hero-copy > .lead",
    ".page-hero .container > *", ".v2caps-more", ".cap-list", ".chip-grid", ".privacy-prose", ".pipeline"
  ];
  var targets = [];
  groups.forEach(function (sel) {
    document.querySelectorAll(sel).forEach(function (el, i, all) {
      var idx = Array.prototype.indexOf.call(el.parentNode.children, el);
      el.style.setProperty("--reveal-delay", (Math.min(idx, 6) * 0.08).toFixed(2) + "s");
      targets.push(el);
    });
  });
  singles.forEach(function (sel) { document.querySelectorAll(sel).forEach(function (el) { targets.push(el); }); });

  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (!e.isIntersecting) return;
      var el = e.target;
      el.classList.add("is-in");
      io.unobserve(el);
      /* after the entrance, hand transitions back to the element's own hover styles */
      setTimeout(function () { el.removeAttribute("data-reveal"); el.style.removeProperty("--reveal-delay"); }, 1600);
    });
  }, { rootMargin: "0px 0px -8% 0px", threshold: 0.12 });

  targets.forEach(function (el) {
    if (el.hasAttribute("data-reveal")) return;
    el.setAttribute("data-reveal", "");
    io.observe(el);
  });
})();

/* Home hero: a short scripted scene on the fake desktop, looped while it is on screen.
   Without JS or with reduced motion the markup already shows the final frame. */
(function () {
  var desk = document.querySelector("[data-desk]");
  if (!desk) return;
  var reduce = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (reduce || !("IntersectionObserver" in window)) return;
  desk.classList.add("is-live");

  var $ = function (k) { return desk.querySelector('[data-step="' + k + '"]'); };
  var steps = ["b1", "win", "ask", "reply", "tool", "b2"].map($);
  var tool = $("tool");
  var timers = [], run = 0, visible = false, playing = false;
  var later = function (ms, fn) { timers.push(setTimeout(fn, ms)); };
  var clear = function () { timers.forEach(clearTimeout); timers = []; };

  function type(stepEl) {
    var el = stepEl.querySelector("[data-type]");
    if (!el) return;
    var key = el.getAttribute("data-i18n");
    var full = (window.NomiI18n && key) ? window.NomiI18n.t(key) : el.textContent;
    if (!full || full === key) full = el.getAttribute("data-full") || el.textContent;
    el.setAttribute("data-full", full);
    var chars = Array.from(full), i = 0, my = run;
    el.textContent = "";
    el.classList.add("typing");
    (function tick() {
      if (my !== run) return;
      el.textContent = chars.slice(0, ++i).join("");
      if (i < chars.length) timers.push(setTimeout(tick, 34));
      else timers.push(setTimeout(function () { el.classList.remove("typing"); }, 600));
    })();
  }
  function on(k) { var el = $(k); el.classList.add("on"); type(el); }
  function off(k) { $(k).classList.remove("on"); }

  function play() {
    clear(); run++; playing = true;
    steps.forEach(function (el) { el.classList.remove("on"); });
    tool.classList.remove("done");
    later(500, function () { on("b1"); });
    later(3000, function () { off("b1"); on("win"); });
    later(3700, function () { on("ask"); });
    later(4600, function () { on("reply"); });
    later(6600, function () { on("tool"); });
    later(9200, function () { tool.classList.add("done"); });
    later(9900, function () { on("b2"); });
    later(14500, function () { steps.forEach(function (el) { el.classList.remove("on"); }); });
    later(15400, function () { if (visible) play(); else playing = false; });
  }
  new IntersectionObserver(function (es) {
    visible = es[0].isIntersecting;
    if (visible && !playing) play();
  }, { threshold: 0.25 }).observe(desk);

  /* a gentle tilt toward the pointer */
  if (window.matchMedia("(hover: hover) and (pointer: fine)").matches) {
    var hero = desk.closest(".hero") || desk;
    /* 每帧最多算一次（pointermove 一帧能来好几次），并且不在每次移动时读布局 */
    var pending = null, rect = null;
    hero.addEventListener("pointerenter", function () { rect = desk.getBoundingClientRect(); });
    window.addEventListener("scroll", function () { rect = null; }, { passive: true });
    hero.addEventListener("pointermove", function (e) {
      var first = pending === null;
      pending = e;
      if (!first) return;
      requestAnimationFrame(function () {
        var ev = pending; pending = null;
        var r = rect || (rect = desk.getBoundingClientRect());
        var x = (ev.clientX - (r.left + r.width / 2)) / r.width, y = (ev.clientY - (r.top + r.height / 2)) / r.height;
        desk.style.setProperty("--ry", (x * 6).toFixed(2) + "deg");
        desk.style.setProperty("--rx", (-y * 5).toFixed(2) + "deg");
      });
    });
    hero.addEventListener("pointerleave", function () { desk.style.setProperty("--ry", "0deg"); desk.style.setProperty("--rx", "0deg"); });
  }
})();

/* 首屏滚出视口时暂停它的循环动画（.is-offscreen，见 styles.css） */
(function () {
  var hero = document.querySelector(".hero--stage");
  if (!hero || !("IntersectionObserver" in window)) return;
  new IntersectionObserver(function (es) {
    hero.classList.toggle("is-offscreen", !es[0].isIntersecting);
  }).observe(hero);
})();

/* Bento demos only animate while their card is on screen. */
(function () {
  var cards = document.querySelectorAll(".bento");
  if (!cards.length || !("IntersectionObserver" in window)) {
    cards.forEach(function (c) { c.classList.add("is-playing"); });
    return;
  }
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) { e.target.classList.toggle("is-playing", e.isIntersecting); });
  }, { threshold: 0.15 });
  cards.forEach(function (c) { io.observe(c); });
})();

/* Header: one pill slides under the hovered link and rests on the current page. */
(function () {
  var nav = document.querySelector(".site-header .nav");
  var pill = nav && nav.querySelector(".nav-pill");
  if (!pill) return;
  var wide = window.matchMedia("(min-width: 861px)");
  var current = nav.querySelector('a[aria-current="page"]');
  nav.classList.add("has-pill");
  function moveTo(el) {
    if (!el || !wide.matches) { pill.style.opacity = "0"; return; }
    pill.style.width = el.offsetWidth + "px";
    pill.style.transform = "translateX(" + el.offsetLeft + "px)";
    pill.style.opacity = "1";
  }
  var contact = nav.querySelector(".nav-contact");
  function rest() { moveTo(contact && contact.getAttribute("aria-expanded") === "true" ? contact : current); }
  if (contact && "MutationObserver" in window) new MutationObserver(rest).observe(contact, { attributes: true, attributeFilter: ["aria-expanded"] });
  rest();
  requestAnimationFrame(function () { requestAnimationFrame(function () { nav.classList.add("pill-ready"); }); });
  nav.querySelectorAll("a").forEach(function (a) {
    a.addEventListener("mouseenter", function () { moveTo(a); });
    a.addEventListener("focus", function () { moveTo(a); });
  });
  nav.addEventListener("mouseleave", rest);
  nav.addEventListener("focusout", function (e) { if (!nav.contains(e.relatedTarget)) rest(); });
  /* link widths change once the web font lands */
  var again = function () { nav.classList.remove("pill-ready"); rest(); requestAnimationFrame(function () { nav.classList.add("pill-ready"); }); };
  window.addEventListener("resize", again);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(again);
  /* follow any later change in link sizes */
  if ("ResizeObserver" in window) {
    var first = true;
    new ResizeObserver(function () { if (first) { first = false; return; } again(); }).observe(nav);
  }
  window.addEventListener("load", again);
})();

/* 文档页：按标题 / 说明 / 路径过滤，没有匹配的分组整个隐藏 */
(function () {
  var input = document.querySelector("[data-docs-search]");
  if (!input) return;
  var empty = document.querySelector("[data-docs-empty]");
  input.addEventListener("input", function () {
    var q = input.value.trim().toLowerCase();
    var any = false;
    document.querySelectorAll(".docs-group").forEach(function (g) {
      var shown = 0;
      g.querySelectorAll(".doc-card").forEach(function (c) {
        var hit = !q || c.textContent.toLowerCase().indexOf(q) >= 0;
        c.hidden = !hit;
        if (hit) shown++;
      });
      g.hidden = shown === 0;
      if (shown) any = true;
    });
    if (empty) empty.hidden = any;
  });
})();

/* 更新日志：左侧版本时间线由页面里的各版本生成（加新版本不用改这里），滚动时高亮当前版本 */
(function () {
  var nav = document.querySelector("[data-cl-nav]");
  if (!nav) return;
  var releases = Array.prototype.slice.call(document.querySelectorAll(".changelog .release[id]"));
  var links = {};
  releases.forEach(function (r, i) {
    var h = r.querySelector(".release-head h2");
    var time = r.querySelector(".release-head time");
    var ver = h ? h.textContent.split(/\s+[—–-]\s+/)[0].trim() : r.id;
    var a = document.createElement("a");
    a.href = "#" + r.id;
    a.innerHTML = '<span class="cl-nav-ver"></span><span class="cl-nav-date"></span>';
    a.firstChild.textContent = ver;
    a.lastChild.textContent = time ? time.textContent : "";
    if (i === 0) a.classList.add("is-latest");
    nav.appendChild(a);
    links[r.id] = a;
  });
  if (!("IntersectionObserver" in window)) return;
  var current = null;
  var io = new IntersectionObserver(function (es) {
    es.forEach(function (e) {
      if (!e.isIntersecting) return;
      if (current) current.removeAttribute("aria-current");
      current = links[e.target.id];
      if (current) {
        current.setAttribute("aria-current", "true");
        var box = nav.getBoundingClientRect(), r = current.getBoundingClientRect();
        if (r.top < box.top || r.bottom > box.bottom) nav.scrollTop += r.top - box.top - box.height / 2;
      }
    });
  }, { rootMargin: "-20% 0px -70% 0px" });
  releases.forEach(function (r) { io.observe(r); });
})();

/* 截图：点开看大图（原生 <dialog>，Esc / 点背景关闭） */
(function () {
  var gallery = document.querySelector("[data-lightbox]");
  if (!gallery || typeof HTMLDialogElement !== "function") return;
  var dlg = document.createElement("dialog");
  dlg.className = "lightbox";
  dlg.innerHTML = '<button type="button" class="lightbox-close" data-i18n-aria-label="lightbox.close" aria-label="关闭">×</button><img alt="" /><p class="lightbox-cap"></p>';
  document.body.appendChild(dlg);
  var img = dlg.querySelector("img"), cap = dlg.querySelector(".lightbox-cap");
  dlg.querySelector(".lightbox-close").addEventListener("click", function () { dlg.close(); });
  dlg.addEventListener("click", function (e) { if (e.target === dlg) dlg.close(); });
  gallery.querySelectorAll("figure").forEach(function (fig) {
    var thumb = fig.querySelector("img");
    if (!thumb) return;
    fig.tabIndex = 0;
    fig.setAttribute("role", "button");
    var open = function () {
      var set = thumb.getAttribute("srcset") || "";
      var big = set.split(",").map(function (x) { return x.trim().split(/\s+/)[0]; }).pop() || thumb.currentSrc || thumb.src;
      img.src = big;
      img.alt = thumb.alt;
      var fc = fig.querySelector("figcaption");
      cap.textContent = fc ? fc.textContent : "";
      var close = dlg.querySelector(".lightbox-close");
      if (window.NomiI18n) close.setAttribute("aria-label", window.NomiI18n.t("lightbox.close"));
      dlg.showModal();
    };
    fig.addEventListener("click", open);
    fig.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
  });
})();
