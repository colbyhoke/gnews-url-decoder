// api/gnews-article.js
// One call from Power Automate: Google News link in, publisher URL + article text out.
//   1) Decode the Google News link (same logic as /api/gnews-decode).
//      If decoding fails, ask Jina to open the Google link itself; its browser can
//      often follow the redirect when our decoder can't.
//   2) Fetch the article text through Jina Reader.
// Non-Google URLs are passed straight to step 2, so you can send any article URL.
//
// POST { "url": "<google news or article url>",
//        "format": "markdown" | "text",      (optional, default "markdown")
//        "maxChars": 20000 }                 (optional, default no limit)
// Header: x-api-key: <FLOW_SECRET>
// Env:    FLOW_SECRET (required), JINA_API_KEY (optional but recommended — higher rate limit)
//
// Always answers 200 with a JSON body (except auth/input errors) so a bad article
// never halts an Apply to each loop. Check `ok` / `status` in the flow:
//   status "extracted"      → ok: true, text is filled
//   status "extract_failed" → decoded fine but Jina couldn't get the text; sourceUrl is filled
//   status "decode_failed"  → couldn't find the publisher URL at all

import { decodeGoogleNewsUrl, isAuthorized, isGoogleNewsUrl } from "../lib/gnews.js";

export const config = { maxDuration: 60 };

// Jina gets up to 20s to render the page server-side; we give the HTTP call a little more.
const JINA_RENDER_TIMEOUT_S = 20;
const JINA_FETCH_TIMEOUT_MS = 25000;

async function fetchViaJina(targetUrl, format) {
  const headers = {
    Accept: "application/json",
    "X-Return-Format": format,
    "X-Timeout": String(JINA_RENDER_TIMEOUT_S),
    "X-Retain-Images": "none",
  };
  if (process.env.JINA_API_KEY) {
    headers.Authorization = `Bearer ${process.env.JINA_API_KEY}`;
  }

  let resp;
  try {
    resp = await fetch(`https://r.jina.ai/${targetUrl}`, {
      headers,
      signal: AbortSignal.timeout(JINA_FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new Error(timedOut ? "jina timed out" : `jina request failed: ${err.message || err}`);
  }

  const raw = await resp.text();
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error(`jina returned non-JSON (HTTP ${resp.status}): ${raw.slice(0, 200)}`);
  }

  if (!resp.ok || !body?.data) {
    const msg = body?.readableMessage || body?.message || body?.name || "no data";
    throw new Error(`jina HTTP ${resp.status}: ${String(msg).slice(0, 300)}`);
  }

  const d = body.data;
  return {
    url: d.url || targetUrl,
    title: d.title || null,
    description: d.description || null,
    publishedTime: d.publishedTime || null,
    text: typeof d.content === "string" ? d.content.trim() : "",
  };
}

export default async function handler(req, res) {
  if (!isAuthorized(req)) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }

  const input = (req.method === "POST" ? req.body : req.query) || {};
  const inputUrl = String(input.url || "").trim();
  if (!inputUrl) {
    return res.status(400).json({ ok: false, error: "missing url" });
  }
  let parsed;
  try {
    parsed = new URL(inputUrl);
  } catch {
    return res.status(400).json({ ok: false, error: "url is not a valid URL" });
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    return res.status(400).json({ ok: false, error: "url must be http or https" });
  }

  const format = input.format === "text" ? "text" : "markdown";
  const maxChars = Math.max(0, parseInt(input.maxChars, 10) || 0);

  const result = {
    ok: false,
    status: null,
    inputUrl,
    sourceUrl: null,
    decodedBy: null, // "decoder" | "jina" | "none" (input wasn't a Google News link)
    title: null,
    description: null,
    publishedTime: null,
    text: null,
    chars: 0,
    truncated: false,
    error: null,
  };

  // ---- Step 1: find the publisher URL --------------------------------------
  let article = null; // set early if the Jina fallback already fetched the page
  if (isGoogleNewsUrl(inputUrl)) {
    try {
      result.sourceUrl = await decodeGoogleNewsUrl(inputUrl);
      result.decodedBy = "decoder";
    } catch (decodeErr) {
      // Fallback: let Jina's browser follow Google's JavaScript redirect.
      try {
        const viaJina = await fetchViaJina(inputUrl, format);
        if (isGoogleNewsUrl(viaJina.url) || !viaJina.text) {
          throw new Error("jina stayed on news.google.com");
        }
        result.sourceUrl = viaJina.url;
        result.decodedBy = "jina";
        article = viaJina;
      } catch (fallbackErr) {
        result.status = "decode_failed";
        result.error =
          `decoder: ${decodeErr.message || decodeErr}; ` +
          `jina fallback: ${fallbackErr.message || fallbackErr}`;
        return res.status(200).json(result);
      }
    }
  } else {
    result.sourceUrl = inputUrl;
    result.decodedBy = "none";
  }

  // ---- Step 2: get the article text ----------------------------------------
  if (!article) {
    try {
      article = await fetchViaJina(result.sourceUrl, format);
    } catch (err) {
      result.status = "extract_failed";
      result.error = String(err.message || err);
      return res.status(200).json(result);
    }
  }

  if (!article.text) {
    result.status = "extract_failed";
    result.error = "jina returned no text (paywall, consent wall, or blocked site?)";
    result.title = article.title;
    return res.status(200).json(result);
  }

  let text = article.text;
  if (maxChars && text.length > maxChars) {
    text = text.slice(0, maxChars);
    result.truncated = true;
  }

  Object.assign(result, {
    ok: true,
    status: "extracted",
    title: article.title,
    description: article.description,
    publishedTime: article.publishedTime,
    text,
    chars: text.length,
  });
  return res.status(200).json(result);
}
