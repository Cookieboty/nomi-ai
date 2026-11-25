/*
 * withnomi.app 前端交互脚本：
 * - 按访问者系统自动预选主下载按钮与高亮下载卡片；
 * - 从 GitHub Latest Release 刷新直链与版本号；
 * - 窄屏导航抽屉、吸顶页头滚动状态、截图 Lightbox；
 * - 首页交互式 Showcase Tabs 与下载页命令行一键复制。
 */
(function () {
  "use strict";
  var REPO = "Cookieboty/nomi-ai";
  var lang = /^zh/i.test(document.documentElement.lang) ? "zh" : "en";

  var PATTERNS = {
    "mac-arm": /^Nomi-\d+\.\d+\.\d+-arm64\.dmg$/,
    "mac-intel": /^Nomi-\d+\.\d+\.\d+\.dmg$/,
    win: /^Nomi-Setup-\d+\.\d+\.\d+\.exe$/,
    appimage: /^Nomi-\d+\.\d+\.\d+\.AppImage$/,
    deb: /^nomi_\d+\.\d+\.\d+_amd64\.deb$/,
  };

  var LABELS = {
    zh: { mac: "下载 macOS 版", win: "下载 Windows 版", linux: "下载 Linux 版" },
    en: { mac: "Download for macOS", win: "Download for Windows", linux: "Download for Linux" },
  };

  function detectOS() {
    var p = ((navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "").toLowerCase();
    var ua = navigator.userAgent.toLowerCase();
    if (/win/.test(p) || /windows/.test(ua)) return "win";
    if (/mac/.test(p) || /mac os/.test(ua)) return /iphone|ipad/.test(ua) ? "" : "mac";
    if (/linux/.test(p) || /linux/.test(ua)) return /android/.test(ua) ? "" : "linux";
    return "";
  }

  var os = detectOS();
  var primaryAsset = { mac: "mac-arm", win: "win", linux: "appimage" }[os];

  function preselect() {
    document.querySelectorAll("[data-download-primary]").forEach(function (btn) {
      if (!primaryAsset) return;
      var src = document.querySelector('[data-asset="' + primaryAsset + '"]');
      if (!src) return;
      btn.href = src.href;
      var label = btn.querySelector("[data-download-label]");
      if (label) label.textContent = LABELS[lang][os];
    });
    document.querySelectorAll("[data-os]").forEach(function (card) {
      card.classList.toggle("is-current", card.getAttribute("data-os") === os);
    });
    var grid = document.querySelector("[data-os-grid]");
    var cur = os && grid && grid.querySelector('[data-os="' + os + '"]');
    if (cur) grid.insertBefore(cur, grid.firstChild);
  }

  function refreshLatest() {
    if (!window.fetch) return;
    fetch("https://api.github.com/repos/" + REPO + "/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) {
        return r.ok ? r.json() : null;
      })
      .then(function (rel) {
        if (!rel || !rel.tag_name || !rel.assets) return;
        var version = rel.tag_name.replace(/^v/, "");
        document.querySelectorAll("[data-asset]").forEach(function (a) {
          var re = PATTERNS[a.getAttribute("data-asset")];
          if (!re) return;
          for (var i = 0; i < rel.assets.length; i++) {
            if (re.test(rel.assets[i].name)) {
              a.href = rel.assets[i].browser_download_url;
              break;
            }
          }
        });
        document.querySelectorAll("[data-version]").forEach(function (el) {
          el.textContent = version;
        });
        document.querySelectorAll("[data-release-link]").forEach(function (a) {
          a.href = rel.html_url;
        });
        preselect();
      })
      .catch(function () {});
  }

  /* 窄屏菜单 */
  var toggle = document.querySelector(".nav-toggle");
  var nav = document.getElementById("site-nav");
  if (toggle && nav) {
    toggle.addEventListener("click", function () {
      var open = nav.classList.toggle("is-open");
      toggle.setAttribute("aria-expanded", open ? "true" : "false");
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && nav.classList.contains("is-open")) {
        nav.classList.remove("is-open");
        toggle.setAttribute("aria-expanded", "false");
        toggle.focus();
      }
    });
  }

  /* 页头滚动 */
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* 截图点开看大图 */
  var box;
  document.querySelectorAll("a.zoom").forEach(function (a) {
    a.addEventListener("click", function (e) {
      e.preventDefault();
      if (!box) {
        box = document.createElement("div");
        box.className = "lightbox";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");
        box.tabIndex = -1;
        box.innerHTML = '<img alt="">';
        box.addEventListener("click", function () {
          box.classList.remove("is-open");
        });
        document.addEventListener("keydown", function (ev) {
          if (ev.key === "Escape") box.classList.remove("is-open");
        });
        document.body.appendChild(box);
      }
      var img = box.querySelector("img");
      img.src = a.href;
      img.alt = (a.querySelector("img") || {}).alt || "";
      box.classList.add("is-open");
      box.focus();
    });
  });

  /* Showcase Tabs */
  document.querySelectorAll("[data-showcase]").forEach(function (root) {
    var tabs = Array.prototype.slice.call(root.querySelectorAll('[role="tab"]'));
    var panels = Array.prototype.slice.call(root.querySelectorAll('[role="tabpanel"]'));
    function activate(tab) {
      var id = tab.getAttribute("aria-controls");
      tabs.forEach(function (t) {
        var on = t === tab;
        t.setAttribute("aria-selected", on ? "true" : "false");
        t.tabIndex = on ? 0 : -1;
      });
      panels.forEach(function (p) {
        p.hidden = p.id !== id;
      });
    }
    tabs.forEach(function (tab, idx) {
      tab.addEventListener("click", function () {
        activate(tab);
      });
      tab.addEventListener("keydown", function (e) {
        if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
        e.preventDefault();
        var next = tabs[(idx + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
        activate(next);
        next.focus();
      });
    });
  });

  /* 一键复制命令 */
  document.querySelectorAll("[data-copy-cmd]").forEach(function (btn) {
    var originText = btn.textContent;
    btn.addEventListener("click", function () {
      var target = btn.parentElement && btn.parentElement.querySelector("code");
      var text = target ? target.textContent : "";
      if (!text || !navigator.clipboard) return;
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = btn.getAttribute("data-copied-label") || (lang === "en" ? "Copied" : "已复制");
        setTimeout(function () {
          btn.textContent = originText;
        }, 1600);
      }).catch(function () {});
    });
  });

  preselect();
  refreshLatest();
})();
