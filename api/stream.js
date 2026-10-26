const { lookup } = require("node:dns/promises");
const net = require("node:net");

const ALLOWED_ORIGINS = new Set([
  "https://apkcineplayerpro.vercel.app",
  "https://apkcineplayerpro-eqbav2q6q-cine-player.vercel.app",
  "https://apkcineplayerpro-qt822df2d-cine-player.vercel.app",
  "https://cineplayerpro-m3u.vercel.app",
  "https://felipe6459.github.io"
]);
const TIMEOUT_MS = 25000;
const MAX_MANIFEST_BYTES = 2 * 1024 * 1024;

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) ||
      (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || p[0] >= 224;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === "::" || v === "::1" || v.startsWith("fc") ||
      v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") ||
      v.startsWith("fea") || v.startsWith("feb") || v.startsWith("::ffff:");
  }
  return true;
}

async function validateTarget(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("URL de mídia inválida."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use um endereço HTTP ou HTTPS.");
  if (url.username || url.password) throw new Error("URLs com usuário/senha embutidos não são aceitas.");
  if (url.hostname === "localhost" || url.hostname.endsWith(".localhost") || url.hostname.endsWith(".local")) {
    throw new Error("Destino local não permitido.");
  }
  const ips = net.isIP(url.hostname) ? [{ address: url.hostname }] : await lookup(url.hostname, { all: true });
  if (!ips.length || ips.some(x => isPrivateIp(x.address))) throw new Error("Destino local ou privado não permitido.");
  return url;
}

function proxyUrl(target) {
  return "/api/stream?url=" + encodeURIComponent(target.href);
}

function rewriteManifest(text, baseUrl) {
  const lines = text.split(/\r?\n/).map(line => {
    const trimmed = line.trim();
    if (!trimmed) return line;
    if (trimmed.startsWith("#")) {
      return line.replace(/URI="([^"]+)"/g, (_, uri) => {
        try { return 'URI="' + proxyUrl(new URL(uri, baseUrl)) + '"'; } catch { return 'URI="' + uri + '"'; }
      });
    }
    try { return proxyUrl(new URL(trimmed, baseUrl)); } catch { return line; }
  });
  return lines.join("\n");
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Range, Content-Type");
  res.setHeader("Access-Control-Expose-Headers", "Accept-Ranges, Content-Length, Content-Range, Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (!["GET", "HEAD"].includes(req.method)) return res.status(405).json({ error: "Use GET." });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "Origem não autorizada." });

  const rawUrl = typeof req.query.url === "string" ? req.query.url : "";
  if (!rawUrl || rawUrl.length > 8192) return res.status(400).json({ error: "Parâmetro url ausente ou muito longo." });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let target = await validateTarget(rawUrl);
    let upstream;
    for (let redirects = 0; redirects <= 4; redirects++) {
      const headers = {
        "Accept": "*/*",
        // A browser-like UA avoids origins that drop or reject the default Node/Undici client.
        "User-Agent": "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.8"
      };
      if (req.headers.range) headers.Range = req.headers.range;
      upstream = await fetch(target.href, {
        method: req.method,
        headers,
        redirect: "manual",
        signal: controller.signal
      });
      if (![301, 302, 303, 307, 308].includes(upstream.status)) break;
      const location = upstream.headers.get("location");
      if (!location || redirects === 4) break;
      try { await upstream.body?.cancel(); } catch {}
      target = await validateTarget(new URL(location, target).href);
    }

    if ([301, 302, 303, 307, 308].includes(upstream.status)) {
      try { await upstream.body?.cancel(); } catch {}
      return res.status(502).json({ error: "A origem manteve um redirecionamento que não pôde ser seguido com segurança." });
    }

    const contentType = (upstream.headers.get("content-type") || "").toLowerCase();
    const pathLooksManifest = /\.m3u8?(?:$|[?#])/i.test(target.pathname);
    const maybeManifest = pathLooksManifest || contentType.includes("mpegurl") || contentType.includes("vnd.apple");
    if (maybeManifest && req.method !== "HEAD" && upstream.ok) {
      const chunks = [];
      let total = 0;
      const reader = upstream.body?.getReader();
      if (!reader) return res.status(502).json({ error: "A origem não devolveu conteúdo de mídia." });
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_MANIFEST_BYTES) {
          await reader.cancel();
          return res.status(413).json({ error: "O manifesto excede o limite de segurança de 2 MB." });
        }
        chunks.push(Buffer.from(value));
      }
      const body = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      if (body.trimStart().startsWith("#EXTM3U")) {
        const rewritten = rewriteManifest(body, target.href);
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
        res.setHeader("Access-Control-Allow-Origin", origin && ALLOWED_ORIGINS.has(origin) ? origin : "*");
        return res.end(rewritten);
      }
      // If a .m3u8 URL returned an error page or another format, preserve
      // the upstream status and content type so the client can diagnose it.
      res.statusCode = upstream.status;
      res.setHeader("Content-Type", upstream.headers.get("content-type") || "application/octet-stream");
      return res.end(body);
    }

    res.statusCode = upstream.status;
    for (const name of ["content-type", "content-length", "content-range", "accept-ranges", "last-modified", "etag"]) {
      const value = upstream.headers.get(name);
      if (value) res.setHeader(name, value);
    }
    if (req.method === "HEAD" || !upstream.body) return res.end();
    const reader = upstream.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!res.write(Buffer.from(value))) await new Promise(resolve => res.once("drain", resolve));
    }
    return res.end();
  } catch (error) {
    if (res.headersSent) return res.destroy(error);
    const timeout = error?.name === "AbortError";
    const cause = error?.cause;
    // Expose only network error identifiers, never the requested URL or credentials.
    const tlsNameMismatch = cause?.code === "ERR_TLS_CERT_ALTNAME_INVALID";
    const certNames = cause?.cert?.subjectaltname;
    const diagnostic = {
      name: String(error?.name || "Error").slice(0, 80),
      code: String(error?.code || "").slice(0, 80) || undefined,
      causeName: String(cause?.name || "").slice(0, 80) || undefined,
      causeCode: String(cause?.code || "").slice(0, 80) || undefined,
      // Safe TLS details: hostname and certificate names only, never URL path/query.
      tlsHost: tlsNameMismatch ? String(cause?.host || "").slice(0, 255) || undefined : undefined,
      tlsReason: tlsNameMismatch ? String(cause?.reason || "").slice(0, 500) || undefined : undefined,
      certificateNames: tlsNameMismatch ? String(certNames || "").slice(0, 500) || undefined : undefined
    };
    return res.status(timeout ? 504 : 502).json({
      error: timeout
        ? "Tempo limite ao buscar a mídia."
        : tlsNameMismatch
          ? "O certificado HTTPS da origem não corresponde ao domínio solicitado. Use o domínio correto da origem ou peça ao provedor para corrigir o certificado."
          : (error?.message || "Falha ao buscar a mídia."),
      stage: timeout ? "upstream_timeout" : "upstream_fetch",
      diagnostic
    });
  } finally {
    clearTimeout(timer);
  }
};
