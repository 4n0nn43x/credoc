// First-party page views (see server/analytics.ts): path, referrer, time zone and screen width, nothing else.
// No cookie, no third party; skipped in dev, for Do Not Track browsers and on the admin pages.
export function trackPageView() {
  if (import.meta.env.DEV || navigator.doNotTrack === "1") return;
  const path = location.pathname + (location.hash.startsWith("#/") ? location.hash : "");
  if (path.includes("#/admin")) return;
  const body = JSON.stringify({
    p: path,
    r: document.referrer,
    tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
    w: screen.width,
    s: new URLSearchParams(location.search).get("utm_source") ?? "",
  });
  try {
    navigator.sendBeacon("/api/hit", new Blob([body], { type: "application/json" }));
  } catch {
    /* analytics never breaks the page */
  }
}
