const { lookup } = require("node:dns/promises");
const net = require("node:net");

const ALLOWED_ORIGINS = new Set([
  "https://felipe6459.github.io",
  "https://cineplayerpro-m3u.vercel.app",
  "https://apkcineplayerpro-eqbav2q6q-cine-player.vercel.app",
  "https://apkcineplayerpro.vercel.app",
  "https://apkcineplayerpro-qt822df2d-cine-player.vercel.app"
]);
const TIMEOUT_MS = 30000;
const MAX_HEADER_SCAN_BYTES = 64 * 1024;

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
  try { url = new URL(value); } catch { throw new Error("URL inválida."); }
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Use uma URL HTTP ou HTTPS.");
  if (url.username || url.password) throw new Error("Não use URLs com usuário ou senha embutidos.");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Endereço local não permitido.");
  }
  const ips = net.isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!ips.length || ips.some(x => isPrivateIp(x.address))) throw new Error("Destino local ou privado não permitido.");
  return url;
}

async function readErrorExcerpt(response, limit = 1500) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      const part = Buffer.from(value).subarray(0, limit - size);
      chunks.push(part);
      size += part.length;
      if (part.length < value.length) break;
    }
  } catch {}
  try { await reader.cancel(); } catch {}
  let excerpt = Buffer.concat(chunks).toString("utf8")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  excerpt = excerpt.replace(/https?:\/\/[^\s"'<>]+/gi, value => {
    try { const u = new URL(value); return u.origin + u.pathname; } catch { return "[URL ocultada]"; }
  });
  excerpt = excerpt.replace(/([?&](?:username|password|token|auth|key|user|pass)=)[^&\s"'<>]+/gi, "$1[oculto]");
  return excerpt.slice(0, limit);
}

async function fetchUpstream(url, controller) {
  // Try distinct client identities: the same generic request was repeatedly
  // returning an empty Cloudflare 503 from the provider.
  const profiles = [
    {
      name: "browser-chrome",
      headers: {
        "Accept": "application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
        "Accept-Language": "pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7"
      }
    },
    {
      name: "vlc",
      headers: { "Accept": "*/*", "User-Agent": "VLC/3.0.21 LibVLC/3.0.21" }
    },
    {
      name: "exoplayer",
      headers: { "Accept": "*/*", "User-Agent": "ExoPlayerLib/2.19.1" }
    },
    {
      name: "android-okhttp",
      headers: {
        "Accept": "*/*",
        "User-Agent": "okhttp/4.12.0",
        "Accept-Encoding": "gzip"
      }
    },
    {
      name: "tivimate",
      headers: {
        "Accept": "*/*",
        "User-Agent": "TiviMate/5.1.6",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    },
    {
      name: "iptv-smarters",
      headers: {
        "Accept": "*/*",
        "User-Agent": "IPTVSmartersPlayer",
        "Accept-Language": "pt-BR,pt;q=0.9"
      }
    }
  ];
  let response;
  let lastProfile = profiles[0].name;
  const attempts = [];
  for (const profile of profiles) {
    lastProfile = profile.name;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(url.href, { method: "GET", redirect: "manual", signal: controller.signal, headers: profile.headers });
        response.__cinePlayerRequestProfile = profile.name;
        attempts.push({ profile: profile.name, attempt: attempt + 1, status: response.status,
          statusText: response.statusText || "", server: response.headers.get("server") || "",
          contentType: response.headers.get("content-type") || "", cfRay: response.headers.get("cf-ray") || "",
          cfMitigated: response.headers.get("cf-mitigated") || "" });
        response.__cinePlayerAttempts = attempts.slice();
        if (![502, 503, 504].includes(response.status)) return response;
        if (attempt === 1 && profile === profiles[profiles.length - 1]) return response;
        try { await response.body?.cancel(); } catch {}
        await new Promise(resolve => setTimeout(resolve, 350 * (attempt + 1)));
      } catch (error) {
        attempts.push({ profile: profile.name, attempt: attempt + 1, networkError: error?.message || String(error),
          errorName: error?.name || "Error", errorCode: error?.code || error?.cause?.code || "" });
        if (error?.name === "AbortError") throw error;
        if (attempt === 1 && profile === profiles[profiles.length - 1]) throw error;
      }
    }
  }
  if (response) { response.__cinePlayerRequestProfile = lastProfile; response.__cinePlayerAttempts = attempts; }
  return response;
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "Use POST." });
  if (origin && !ALLOWED_ORIGINS.has(origin)) return res.status(403).json({ error: "Origem não autorizada." });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    if (!body || typeof body.url !== "string" || body.url.length > 4096) {
      return res.status(400).json({ error: "Informe uma URL de playlist válida." });
    }
    let target = await validateTarget(body.url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let upstream;
    try {
      upstream = await fetchUpstream(target, controller);
      // If plain HTTP is returning a gateway/service error, test HTTPS on the
      // same host/path before reporting failure. Keep the original response if
      // the secure endpoint cannot be reached.
      if (target.protocol === "http:" && [502, 503, 504].includes(upstream.status)) {
        const originalTarget = target;
        const secureTarget = new URL(target.href);
        secureTarget.protocol = "https:";
        try {
          const validatedSecureTarget = await validateTarget(secureTarget.href);
          const secureResponse = await fetchUpstream(validatedSecureTarget, controller);
          target = validatedSecureTarget;
          upstream = secureResponse;
        } catch {
          target = originalTarget;
        }
      }
      for (let i = 0; [301, 302, 303, 307, 308].includes(upstream.status) && i < 3; i++) {
        const location = upstream.headers.get("location");
        if (!location) break;
        target = await validateTarget(new URL(location, target).href);
        upstream = await fetchUpstream(target, controller);
      }
      if (!upstream.ok) {
        const status = upstream.status;
        const excerpt = await readErrorExcerpt(upstream);
        const headers = Object.fromEntries([
          "content-type", "server", "via", "retry-after", "date", "content-length",
          "cf-ray", "cf-cache-status", "cf-mitigated", "www-authenticate",
          "x-request-id", "x-cache", "x-served-by"
        ].map(name => [name, upstream.headers.get(name) || ""]));
        const cause = status === 401 || status === 403
          ? "A origem recusou o acesso ou exige autenticação/permissão."
          : status === 404 ? "O caminho da playlist não foi encontrado."
          : status === 429 ? "A origem limitou as requisições."
          : [502, 503, 504].includes(status)
            ? "A origem retornou erro de serviço/gateway; isso não comprova, sozinho, que houve bloqueio."
            : "A origem respondeu com um status HTTP de erro.";
        // Preserve gateway/service statuses so the client sees the real failure class.
        // Other upstream HTTP errors are represented as 502 because the proxy could not obtain a playlist.
        const clientStatus = status === 503 || status === 504 ? status : 502;
        return res.status(clientStatus).json({
          error: "A origem respondeu HTTP " + status + ". O serviço auxiliar não conseguiu obter a playlist; veja o diagnóstico técnico.",
          stage: "upstream_http_response",
          diagnosis: { cause, upstreamStatus: status, upstreamStatusText: upstream.statusText || "",
            upstreamProtocol: target.protocol, upstreamHost: target.hostname, upstreamPath: target.pathname,
            requestProfile: upstream.__cinePlayerRequestProfile || "unknown",
            responseHeaders: headers, responseExcerpt: excerpt,
            attempts: upstream.__cinePlayerAttempts || [] }
        });
      }
      const reader = upstream.body.getReader();
      const prefixChunks = [];
      let prefixBytes = 0;
      let validM3U = false;

      // Validate the M3U header before sending response bytes. Keep only a small
      // prefix in memory and stream the rest instead of buffering the full playlist.
      while (!validM3U) {
        const { done, value } = await reader.read();
        if (done) {
          return res.status(422).json({ error: "A resposta não parece ser uma playlist M3U. Pode ser uma página de login ou erro." });
        }
        prefixChunks.push(Buffer.from(value));
        prefixBytes += value.byteLength;
        const prefixText = Buffer.concat(prefixChunks).toString("utf8").replace(/^\uFEFF/, "");
        const trimmed = prefixText.trimStart();
        if (trimmed.startsWith("#EXTM3U")) {
          validM3U = true;
        } else if (trimmed.length >= 7 || prefixBytes > MAX_HEADER_SCAN_BYTES) {
          await reader.cancel();
          return res.status(422).json({ error: "A resposta não parece ser uma playlist M3U. Pode ser uma página de login ou erro." });
        }
      }

      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.statusCode = 200;

      const writeChunk = async chunk => {
        if (!res.write(chunk)) {
          await new Promise(resolve => res.once("drain", resolve));
        }
      };

      for (const chunk of prefixChunks) await writeChunk(chunk);
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        await writeChunk(Buffer.from(value));
      }
      return res.end();
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const msg = error && error.name === "AbortError" ? "Tempo limite ao buscar a playlist." : (error.message || "Falha ao buscar a playlist.");
    if (res.headersSent) return res.destroy(error);
    const errorCode = error?.code || error?.cause?.code || "";
    const clientStatus = error?.name === "AbortError" ? 504
      : /URL inválida|Use uma URL|usuário ou senha|Endereço local|Destino local|privado não permitido|não permitido/i.test(msg) ? 400
      : 502;
    return res.status(clientStatus).json({ error: msg, stage: "request_or_network_error",
      diagnosis: { cause: error?.name === "AbortError" ? "timeout" : "dns_tls_network_or_validation",
        errorName: error?.name || "Error", errorCode, errorMessage: msg } });
  }
};
