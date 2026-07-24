// Theme bootstrap + toggle. Loaded synchronously in <head> so the correct
// theme is applied before first paint (no flash of wrong theme).
(function () {
  const STORAGE_KEY = "theme";
  const root = document.documentElement;
  const media = window.matchMedia("(prefers-color-scheme: dark)");

  function stored() {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch (_) {
      return null;
    }
  }

  function apply(theme) {
    root.dataset.theme = theme;
  }

  function current() {
    const saved = stored();
    if (saved === "light" || saved === "dark") return saved;
    return media.matches ? "dark" : "light";
  }

  apply(current());

  // Follow system changes while the user hasn't picked an explicit theme.
  media.addEventListener("change", function () {
    if (!stored()) apply(current());
  });

  document.addEventListener("DOMContentLoaded", function () {
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.addEventListener("click", function () {
      const next = root.dataset.theme === "dark" ? "light" : "dark";
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch (_) {}
      apply(next);
      btn.setAttribute("aria-pressed", next === "dark" ? "true" : "false");
    });
    btn.setAttribute("aria-pressed", root.dataset.theme === "dark" ? "true" : "false");
  });
})();
