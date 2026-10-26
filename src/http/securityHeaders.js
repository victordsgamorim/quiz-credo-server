// Headers for every HTTP response: the server only answers JSON, so nothing it sends should be
// rendered, framed, sniffed as another type or allowed to load anything
export const SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-site",
  "Referrer-Policy": "no-referrer",
  // Browsers only take it over HTTPS (Render's), and ignore it over plain HTTP (development)
  "Strict-Transport-Security": "max-age=31536000",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
});
