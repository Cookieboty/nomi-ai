/*
 * withnomi.app 的脚本（2.3.10 改版）：
 * - 按访问者的系统预选下载（主按钮指向对应安装包，下载卡片标「推荐」），其他系统照样能选；
 * - 页面里写死的是当前版本的直链；加载后问 GitHub 最新 Release，按文件名换成最新的（问不到就保持原样）；
 * - 窄屏菜单、页头滚动后的分割线、截图点开看大图。
 * 文案都已经写在 HTML 里（中文页与 en/ 英文页各自静态），这里不做翻译，不会闪。
 */
(function () {
  "use strict";
  var REPO = "Cookieboty/nomi-ai";
  var lang = document.documentElement.lang === "en" ? "en" : "zh";

  /* 安装包：data-asset 的名字 → 文件名规则 */
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

  /* 主按钮：指向当前系统的安装包；看不出系统就去下载页 */
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
    // 下载页：当前系统那张排到最前（其他系统照样在）
    var grid = document.querySelector("[data-os-grid]");
    var cur = os && grid && grid.querySelector('[data-os="' + os + '"]');
    if (cur) grid.insertBefore(cur, grid.firstChild);
  }

  /* 最新 Release：换直链与版本号 */
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

  /* 页头：滚动后显示分割线 */
  var header = document.querySelector(".site-header");
  if (header) {
    var onScroll = function () {
      header.classList.toggle("is-scrolled", window.scrollY > 8);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    onScroll();
  }

  /* 截图点开看大图（Esc 或点空白关闭） */
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
        box.innerHTML = "<img alt=\"\">";
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

  preselect();
  refreshLatest();
})();
