// Theme bootstrap + toggle. Loaded synchronously in <head> so the correct
// theme is applied before first paint (no flash of wrong theme).
(function () {
  var STORAGE_KEY = "theme";
  var root = document.documentElement;
  var media = window.matchMedia("(prefers-color-scheme: dark)");

  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  function apply(theme) {
    root.setAttribute("data-theme", theme);
  }

  function current() {
    var saved = stored();
    if (saved === "light" || saved === "dark") return saved;
    return media.matches ? "dark" : "light";
  }

  apply(current());

  // Follow system changes while the user hasn't picked an explicit theme.
  media.addEventListener("change", function () {
    if (!stored()) apply(current());
  });

  document.addEventListener("DOMContentLoaded", function () {
    var btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (_) {}
      apply(next);
      btn.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
    });
    btn.setAttribute("aria-pressed", root.getAttribute("data-theme") === "dark" ? "true" : "false");
  });
})();
