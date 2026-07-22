// api/gnews-decode.js
// Vercel serverless function: resolves a Google News RSS redirect link
// (news.google.com/rss/articles/CBMi... or /read/... ) to its real publisher URL.
// Decode-only and fast, so it stays well inside Vercel's 10s Hobby limit.
// No npm dependencies — uses Node 18+ globals (fetch, Buffer, URL, AbortSignal).
//
// If your Vercel project is CommonJS, swap the final `export default` line for:
//   module.exports = async function handler(req, res) { ... }

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function extractId(googleUrl) {
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
function tryLegacyBase64(id) {
  if (!id.startsWith("CBM")) return null;
  try {
    const buf = Buffer.from(id.replace(/-/g, "+").replace(/_/g, "/"), "base64");
    const s = buf.toString("latin1");
    const m = s.match(/https?:\/\/[^\s"'<>\\\u0000-\u001f]+/);
    if (m) return m[0];
  } catch (_) {}
  return null;
}

function fetchWithTimeout(url, opts = {}, ms = 6000) {
  return fetch(url, { ...opts, signal: AbortSignal.timeout(ms) });
}

// New AU_yqL…/read/… links require the batchexecute handshake.
async function decodeViaBatch(id) {
  // 1) Load the article page to read the signing params.
  const page = await fetchWithTimeout(
    `https://news.google.com/rss/articles/${id}`,
    { headers: { "User-Agent": UA } },
    6000
  );
  const html = await page.text();
  const sg = html.match(/data-n-a-sg="([^"]+)"/)?.[1];
  const ts = html.match(/data-n-a-ts="([^"]+)"/)?.[1];
  if (!sg || !ts) {
    throw new Error("could not read signing params (interstitial/consent page?)");
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
    },
    6000
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
  throw new Error("real url not found in batchexecute response");
}

export default async function handler(req, res) {
  // Shared-secret gate so this isn't an open decoder / SSRF vector.
  if ((req.headers["x-api-key"] || "") !== process.env.FLOW_SECRET) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const googleUrl =
    (req.method === "POST" ? req.body?.url : req.query?.url) || "";
  if (!googleUrl) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    const id = extractId(googleUrl);
    let sourceUrl = tryLegacyBase64(id);
    if (!sourceUrl) sourceUrl = await decodeViaBatch(id);
    return res.status(200).json({ ok: true, status: "decoded", sourceUrl });
  } catch (err) {
    // Return 200 with ok:false so Power Automate reads the body
    // instead of throwing on a 4xx/5xx and halting the loop.
    return res.status(200).json({
      ok: false,
      status: "failed",
      sourceUrl: null,
      error: String(err.message || err),
    });
  }
}
