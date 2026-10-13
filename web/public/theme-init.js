// Applies the saved theme, or the system one, before the first paint. An external file because the CSP forbids
// inline scripts. src/shared/theme.ts takes over once the app has loaded.
(function () {
  var t = null;
  try {
    t = localStorage.getItem("credoc-theme");
  } catch (e) {}
  if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  var r = document.documentElement;
  r.classList.toggle("dark", t === "dark");
  r.setAttribute("data-bs-theme", t);
  r.style.colorScheme = t;
})();
