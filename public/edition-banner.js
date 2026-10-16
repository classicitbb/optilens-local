// Shows how long a trial has left, or that a licence has ended. It stays out of
// the way: nothing appears for the full edition or a paid licence with time left.
(function () {
  if (window.__optilensEditionBanner) return;
  window.__optilensEditionBanner = true;

  var WARN_DAYS = 7;

  function message(edition) {
    if (edition.reason) return { text: edition.reason + " Contact your OptiLens representative to continue.", level: "ended" };
    if (!edition.trial || edition.daysLeft == null) return null;
    if (edition.daysLeft <= 0) return { text: "Your trial ends today.", level: "warn" };
    var days = edition.daysLeft === 1 ? "1 day" : edition.daysLeft + " days";
    return { text: "Trial: " + days + " left.", level: edition.daysLeft <= WARN_DAYS ? "warn" : "info" };
  }

  function dismissed() {
    try { return sessionStorage.getItem("optilens.trialBannerDismissed") === "1"; } catch (e) { return false; }
  }

  function render(info) {
    var bar = document.createElement("div");
    bar.setAttribute("role", "status");
    bar.className = "edition-banner edition-banner-" + info.level;
    bar.textContent = info.text;

    if (info.level === "info") {
      var close = document.createElement("button");
      close.type = "button";
      close.textContent = "Dismiss";
      close.setAttribute("aria-label", "Dismiss trial notice");
      close.addEventListener("click", function () {
        try { sessionStorage.setItem("optilens.trialBannerDismissed", "1"); } catch (e) { /* private window */ }
        bar.remove();
      });
      bar.appendChild(close);
    }

    var style = document.createElement("style");
    style.textContent =
      ".edition-banner{position:fixed;left:16px;bottom:16px;z-index:2147483000;max-width:min(26rem,calc(100vw - 32px));" +
      "display:flex;gap:12px;align-items:center;padding:10px 14px;border-radius:10px;border:1px solid #d9d6cf;" +
      "background:#fff;color:#1d1d1b;font:14px/1.4 system-ui,sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.12)}" +
      ".edition-banner-warn{background:#fff6e0;border-color:#e0b64a}" +
      ".edition-banner-ended{background:#fde8e6;border-color:#d6564a}" +
      ".edition-banner button{font:inherit;border:0;background:none;color:inherit;text-decoration:underline;cursor:pointer;padding:4px}" +
      "@media (prefers-color-scheme:dark){.edition-banner{background:#21211e;color:#f1efe9;border-color:#3a3935}" +
      ".edition-banner-warn{background:#3a3016;border-color:#a98425}.edition-banner-ended{background:#3d1b18;border-color:#a8453b}}";
    document.head.appendChild(style);
    document.body.appendChild(bar);
  }

  function start() {
    fetch("/api/auth/me", { credentials: "same-origin" })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (me) {
        var edition = me && me.edition;
        if (!edition || !edition.restricted) return;
        var info = message(edition);
        if (!info || (info.level === "info" && dismissed())) return;
        render(info);
      })
      .catch(function () { /* the banner is a courtesy; never break the page */ });
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();
})();
