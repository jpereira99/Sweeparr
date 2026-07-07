/**
 * Sweeparr Jellyfin web-client injection (§8.2).
 *
 * Add this to Jellyfin via Dashboard → General → Custom CSS is not enough;
 * use the "custom JavaScript" index.html injection or a small plugin that
 * loads this file from:  {sweeparr}/static/inject/sweeparr.js
 *
 * It observes SPA navigation, batches item ids to the public /flags endpoint,
 * and renders "Leaving <date>" pills on cards + a dismissible banner with a
 * "Request to keep" deep-link on detail pages.
 *
 * Doctrine: it must fail SILENTLY and COMPLETELY. A broken selector across a
 * Jellyfin release must never break playback UI.
 */
(function () {
  "use strict";

  // Point this at your Sweeparr origin (through the Cloudflare Tunnel).
  var SWEEPARR_ORIGIN = (window.SWEEPARR_ORIGIN || "").replace(/\/$/, "");
  if (!SWEEPARR_ORIGIN) {
    // Best-effort: same host, assume reverse-proxied. Users can override.
    SWEEPARR_ORIGIN = "";
  }

  var cache = {};
  var STYLE_ID = "sweeparr-style";

  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      ".swp-pill{position:absolute;left:6px;bottom:6px;z-index:5;font:600 10px/1 monospace;" +
      "color:#fff;background:#E5484D;border-radius:4px;padding:3px 6px;pointer-events:none}" +
      ".swp-banner{display:flex;gap:12px;align-items:center;margin:12px 0;padding:10px 14px;" +
      "border:1px solid rgba(229,72,77,.4);background:rgba(229,72,77,.12);border-radius:8px;" +
      "color:#FF7B80;font:500 13px/1.4 sans-serif}" +
      ".swp-banner a{color:#5FC08D;font-weight:600;text-decoration:none;margin-left:auto}";
    var el = document.createElement("style");
    el.id = STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function extractIds() {
    var ids = {};
    try {
      // Detail page id from the URL hash (?id=...).
      var m = (location.hash || "").match(/[?&]id=([a-f0-9]{32})/i);
      if (m) ids[m[1]] = true;
      // Card grid: elements carry data-id.
      document.querySelectorAll("[data-id]").forEach(function (n) {
        var id = n.getAttribute("data-id");
        if (id && /^[a-f0-9]{32}$/i.test(id)) ids[id] = true;
      });
    } catch (e) {}
    return Object.keys(ids);
  }

  function fetchFlags(ids, cb) {
    var need = ids.filter(function (id) {
      return cache[id] === undefined;
    });
    if (!need.length) return cb();
    var url = SWEEPARR_ORIGIN + "/flags?jellyfin_ids=" + need.join(",");
    fetch(url, { credentials: "omit" })
      .then(function (r) {
        return r.ok ? r.json() : { items: [] };
      })
      .then(function (data) {
        need.forEach(function (id) {
          cache[id] = null;
        });
        (data.items || []).forEach(function (it) {
          cache[it.jellyfin_id] = it;
        });
        cb();
      })
      .catch(function () {
        need.forEach(function (id) {
          cache[id] = null;
        });
        cb();
      });
  }

  function fmt(dateStr) {
    try {
      var d = new Date(dateStr + "T00:00:00");
      return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    } catch (e) {
      return dateStr;
    }
  }

  function render() {
    try {
      injectStyle();
      document.querySelectorAll("[data-id]").forEach(function (card) {
        var id = card.getAttribute("data-id");
        var flag = cache[id];
        if (!flag || card.querySelector(".swp-pill")) return;
        var pill = document.createElement("div");
        pill.className = "swp-pill";
        pill.textContent = "Leaving " + fmt(flag.delete_at);
        var host = card.querySelector(".cardImageContainer") || card;
        if (getComputedStyle(host).position === "static") host.style.position = "relative";
        host.appendChild(pill);
      });

      var m = (location.hash || "").match(/[?&]id=([a-f0-9]{32})/i);
      if (m && cache[m[1]] && !document.querySelector(".swp-banner")) {
        var flag = cache[m[1]];
        var detail = document.querySelector(".detailPagePrimaryContainer, .detailSectionContent");
        if (detail) {
          var banner = document.createElement("div");
          banner.className = "swp-banner";
          var keepUrl = SWEEPARR_ORIGIN + "/keep/" + (flag.token || "");
          banner.innerHTML =
            "<span>Leaving " + fmt(flag.delete_at) + " — " + (flag.reason_public || "") + "</span>" +
            '<a href="' + keepUrl + '" target="_blank" rel="noopener">Request to keep</a>';
          detail.insertBefore(banner, detail.firstChild);
        }
      }
    } catch (e) {}
  }

  function tick() {
    var ids = extractIds();
    if (!ids.length) return;
    fetchFlags(ids, render);
  }

  try {
    var obs = new MutationObserver(function () {
      window.clearTimeout(tick._t);
      tick._t = window.setTimeout(tick, 250);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    window.addEventListener("hashchange", tick);
    tick();
  } catch (e) {}
})();
