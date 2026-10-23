// api/gnews-decode.js
// Vercel serverless function: resolves a Google News RSS redirect link
// (news.google.com/rss/articles/CBMi... or /read/... ) to its real publisher URL.
// Decode-only and fast. Request/response contract is unchanged from the original
// version, so existing flows keep working.
//
// POST { "url": "<google news url>" }  (or GET ?url=...)
// Header: x-api-key: <FLOW_SECRET>
// → 200 { ok, status: "decoded" | "failed", sourceUrl, error? }

import { decodeGoogleNewsUrl, isAuthorized } from "../lib/gnews.js";

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const googleUrl =
    (req.method === "POST" ? req.body?.url : req.query?.url) || "";
  if (!googleUrl) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }

  try {
    const sourceUrl = await decodeGoogleNewsUrl(googleUrl);
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
