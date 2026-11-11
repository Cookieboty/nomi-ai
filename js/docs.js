/*
 * 文档页的脚本：窄屏目录抽屉、本页目录高亮、代码块复制、站内搜索（「/」或 Ctrl/⌘+K 打开，索引按需加载）。
 * 页面内容都在 HTML 里（scripts/docs.mjs 生成），这里只加交互，没有脚本也能读。
 */
(function () {
  "use strict";
  var sidebar = document.getElementById("docs-sidebar");
  if (!sidebar) return;
  var ui = {};
  try {
    ui = JSON.parse(sidebar.getAttribute("data-ui") || "{}");
  } catch (e) {}

  /* ---------- 窄屏目录抽屉 ---------- */
  var openBtn = document.querySelector("[data-docs-open]");
  var scrim;
  function setDrawer(open) {
    sidebar.classList.toggle("is-open", open);
    if (openBtn) openBtn.setAttribute("aria-expanded", open ? "true" : "false");
    if (open) {
      scrim = document.createElement("div");
      scrim.className = "docs-scrim";
      scrim.addEventListener("click", function () {
        setDrawer(false);
      });
      document.body.appendChild(scrim);
      var current = sidebar.querySelector('[aria-current="page"]') || sidebar.querySelector("a, button");
      if (current) current.focus();
    } else if (scrim) {
      scrim.remove();
      scrim = null;
      if (openBtn) openBtn.focus();
    }
  }
  if (openBtn) openBtn.addEventListener("click", function () {
    setDrawer(true);
  });
  var closeBtn = sidebar.querySelector("[data-docs-close]");
  if (closeBtn) closeBtn.addEventListener("click", function () {
    setDrawer(false);
  });
  // 当前页滚到侧栏可见处
  var active = sidebar.querySelector('[aria-current="page"]');
  if (active && active.scrollIntoView) {
    var box = active.getBoundingClientRect();
    if (box.bottom > window.innerHeight - 40) sidebar.scrollTop = active.offsetTop - sidebar.clientHeight / 3;
  }

  /* ---------- 本页目录高亮 ---------- */
  var tocLinks = Array.prototype.slice.call(document.querySelectorAll(".docs-toc li a"));
  var targets = tocLinks
    .map(function (a) {
      return document.getElementById(decodeURIComponent(a.getAttribute("href").slice(1)));
    })
    .filter(Boolean);
  if (targets.length) {
    var ticking = false;
    var update = function () {
      ticking = false;
      var y = 96;
      var current = targets[0];
      for (var i = 0; i < targets.length; i++) {
        if (targets[i].getBoundingClientRect().top - y <= 0) current = targets[i];
        else break;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) current = targets[targets.length - 1];
      tocLinks.forEach(function (a) {
        a.classList.toggle("is-active", a.getAttribute("href") === "#" + current.id);
      });
    };
    window.addEventListener(
      "scroll",
      function () {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true }
    );
    update();
  }

  /* ---------- 代码块复制 ---------- */
  document.querySelectorAll(".doc .code").forEach(function (block) {
    if (!navigator.clipboard) return;
    var btn = document.createElement("button");
    btn.type = "button";
    btn.className = "code-copy";
    btn.textContent = ui.copy || "Copy";
    btn.addEventListener("click", function () {
      navigator.clipboard.writeText(block.querySelector("code").textContent).then(function () {
        btn.textContent = ui.copied || "Copied";
        setTimeout(function () {
          btn.textContent = ui.copy || "Copy";
        }, 1500);
      });
    });
    block.appendChild(btn);
  });

  /* ---------- 搜索 ---------- */
  var dialog = document.querySelector(".docs-search");
  var input = dialog && dialog.querySelector("input");
  var list = dialog && dialog.querySelector(".docs-search-results");
  var base = sidebar.getAttribute("data-search-base") || "";
  var index = null;
  var results = [];
  var selected = 0;
  var lastFocus = null;

  function load() {
    if (index || !window.fetch) return Promise.resolve(index);
    return fetch(sidebar.getAttribute("data-search-url"))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        index = data;
        return index;
      })
      .catch(function () {
        index = [];
        return index;
      });
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }
  function mark(text, terms) {
    var html = escapeHtml(text);
    terms.forEach(function (term) {
      if (!term) return;
      var re = new RegExp("(" + escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
      html = html.replace(re, "<mark>$1</mark>");
    });
    return html;
  }
  function snippet(text, term) {
    var at = text.toLowerCase().indexOf(term);
    if (at < 0) return "";
    var start = Math.max(0, at - 24);
    return (start ? "…" : "") + text.slice(start, at + 80);
  }

  function search(query) {
    var q = query.trim().toLowerCase();
    if (!q || !index) return [];
    var terms = q.split(/\s+/);
    var out = [];
    index.forEach(function (page) {
      var title = page.t.toLowerCase();
      var hay = (page.t + " " + page.d + " " + page.x).toLowerCase();
      if (!terms.every(function (t) { return hay.indexOf(t) >= 0; })) return;
      var score = 0;
      terms.forEach(function (t) {
        if (title.indexOf(t) >= 0) score += 10;
        if (page.d.toLowerCase().indexOf(t) >= 0) score += 3;
      });
      // 命中的小节标题直接跳过去
      var heading = null;
      for (var i = 0; i < page.h.length; i++) {
        if (page.h[i][1].toLowerCase().indexOf(terms[0]) >= 0) {
          heading = page.h[i];
          score += 5;
          break;
        }
      }
      out.push({
        score: score,
        href: base + page.u + (heading ? "#" + heading[0] : ""),
        group: page.g + (heading ? " › " + page.t : ""),
        title: heading ? heading[1] : page.t,
        text: title.indexOf(terms[0]) >= 0 ? page.d : snippet(page.x, terms[0]) || page.d,
        terms: terms,
      });
    });
    return out.sort(function (a, b) { return b.score - a.score; }).slice(0, 12);
  }

  function render() {
    results = search(input.value);
    selected = 0;
    if (!input.value.trim()) {
      list.innerHTML = "";
      return;
    }
    if (!results.length) {
      list.innerHTML = '<li class="docs-search-empty">' + escapeHtml(ui.noResults || "No results") + "</li>";
      return;
    }
    list.innerHTML = results
      .map(function (r, i) {
        return (
          '<li><a role="option" href="' + r.href + '" aria-selected="' + (i === 0) + '"><small>' + escapeHtml(r.group) +
          "</small><strong>" + mark(r.title, r.terms) + "</strong><span>" + mark(r.text, r.terms) + "</span></a></li>"
        );
      })
      .join("");
  }
  function select(n) {
    var links = list.querySelectorAll("a");
    if (!links.length) return;
    selected = (n + links.length) % links.length;
    links.forEach(function (a, i) {
      a.setAttribute("aria-selected", i === selected ? "true" : "false");
    });
    links[selected].scrollIntoView({ block: "nearest" });
  }

  function openSearch() {
    if (!dialog) return;
    lastFocus = document.activeElement;
    if (sidebar.classList.contains("is-open")) setDrawer(false);
    dialog.hidden = false;
    input.value = "";
    list.innerHTML = "";
    input.focus();
    load().then(render);
  }
  function closeSearch() {
    if (!dialog || dialog.hidden) return;
    dialog.hidden = true;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  document.querySelectorAll("[data-search-open]").forEach(function (btn) {
    btn.addEventListener("click", openSearch);
  });
  if (dialog) {
    dialog.addEventListener("click", function (e) {
      if (e.target === dialog) closeSearch();
    });
    input.addEventListener("input", render);
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown") { e.preventDefault(); select(selected + 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); select(selected - 1); }
      else if (e.key === "Enter") {
        var link = list.querySelectorAll("a")[selected];
        if (link) { e.preventDefault(); window.location.href = link.href; closeSearch(); }
      }
    });
  }

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if (dialog && !dialog.hidden) closeSearch();
      else if (sidebar.classList.contains("is-open")) setDrawer(false);
      return;
    }
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || document.activeElement.isContentEditable;
    if ((e.key === "/" && !typing) || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k")) {
      e.preventDefault();
      openSearch();
    }
  });
})();
