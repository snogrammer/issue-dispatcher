// Optional Plausible analytics (PLAUSIBLE_SCRIPT_URL). The CSP allows no
// inline scripts, so the queue stub Plausible's snippet sets up inline is set
// up here instead, and the script tag is added from code. Events queued
// before the script loads are sent once it does.

/** @param {{ src: string, domain: string | null } | null | undefined} analytics */
export function loadAnalytics(analytics) {
  if (!analytics || document.querySelector("script[data-analytics]")) return;
  window.plausible =
    window.plausible ||
    function (...args) {
      (window.plausible.q = window.plausible.q || []).push(args);
    };
  window.plausible.init =
    window.plausible.init ||
    function (options) {
      window.plausible.o = options || {};
    };
  window.plausible.init();
  const script = document.createElement("script");
  script.async = true;
  script.src = analytics.src;
  script.dataset.analytics = "";
  if (analytics.domain) script.dataset.domain = analytics.domain;
  document.head.append(script);
}
