// lib/gnews.js
// Shared Google News link decoding, used by api/gnews-decode.js and api/gnews-article.js.
// Resolves news.google.com/rss/articles/CBMi... (or /articles/, /read/) to the publisher URL.
// No npm dependencies: Node 18+ globals only (fetch, Buffer, URL, AbortSignal).

export const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

// Each Google round-trip gets this long. Two of them run back to back,
// so the worst case for a decode is ~2x this.
const GOOGLE_TIMEOUT_MS = 4000;

export function isGoogleNewsUrl(url) {
  try {
    return /(^|\.)news\.google\.com$/.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

export function extractId(googleUrl) {
  const u = new URL(googleUrl);
  if (!/(^|\.)news\.google\.com$/.test(u.hostname)) {
    throw new Error("not a news.google.com url");
  }
  const parts = u.pathname.split("/").filter(Boolean);
  const id = parts[parts.length - 1];
  if (!id) throw new Error("no article id in path");
  return id;
}

// Legacy CBM… links carry the target URL directly inside the base64 payload.
export function tryLegacyBase64(id) {
  if (!id.startsWith("CBM")) return null;
  try {
    const buf = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const s = buf.toString("latin1");
    const m = s.match(/https?:\/\/[^\s"'<>\\\u0000-\u001f]+/);
    if (m) return m[0];
  } catch (_) {}
  return null;
}

export function fetchWithTimeout(url, opts = {}, ms = GOOGLE_TIMEOUT_MS) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// Current AU_yqL… links require the batchexecute handshake.
export async function decodeViaBatch(id) {
  // 1) Load the article page to read the signing params.
  const page = await fetchWithTimeout(
    `https://news.google.com/rss/articles/${id}`,
    { headers: { "User-Agent": UA } }
  );
  const html = await page.text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) {
    throw new Error(
      `could not read signing params (HTTP ${page.status}; interstitial, consent page, or rate limit?)`
    );
  }

  // 2) Build the batchexecute payload (fixed boilerplate + id, timestamp, signature).
  const inner = JSON.stringify([
    "garturlreq",
    [
      ["X", "X", ["X", "X"], null, null, 1, 1, "US:en", null, 1,
        null, null, null, null, null, 0, 1],
      "X", "X", 1, [1, 1, 1], 1, 1, null, 0, 0, null, 0,
    ],
    id,
    Number(ts),
    sg,
  ]);
  const body =
    "f.req=" + encodeURIComponent(JSON.stringify([[["Fbv4je", inner]]]));

  const resp = await fetchWithTimeout(
    "https://news.google.com/_/DotsSplashUi/data/batchexecute",
    {
      method: "POST",
      headers: {
        "User-Agent": UA,
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
      },
      body,
    }
  );
  const text = await resp.text();

  // 3) Parse the XSSI-guarded, sometimes-chunked response.
  const cleaned = text.replace(/^\)\]\}'\n?/, "");
  for (const line of cleaned.split("\n")) {
    const t = line.trim();
    if (!t.startsWith("[[")) continue;
    try {
      for (const item of JSON.parse(t)) {
        if (
          Array.isArray(item) &&
          item[1] === "Fbv4je" &&
          typeof item[2] === "string"
        ) {
          const parsed = JSON.parse(item[2]);
          if (parsed && parsed[1]) return parsed[1];
        }
      }
    } catch (_) {}
  }
  throw new Error(`real url not found in batchexecute response (HTTP ${resp.status})`);
}

// Full decode: legacy base64 first (no network), then the batchexecute handshake.
export async function decodeGoogleNewsUrl(googleUrl) {
  const id = extractId(googleUrl);
  return tryLegacyBase64(id) || (await decodeViaBatch(id));
}

// Shared-secret gate so the endpoints aren't an open decoder / proxy.
// Fails closed: if FLOW_SECRET isn't set, nothing gets through.
export function isAuthorized(req) {
  const secret = process.env.FLOW_SECRET;
  return Boolean(secret) && (req.headers["x-api-key"] || "") === secret;
}
