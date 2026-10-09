const { lookup } = require("node:dns/promises");
const net = require("node:net");

const ALLOWED_ORIGINS = new Set([
  "https://felipe6459.github.io",
  "https://cineplayerpro-m3u.vercel.app",
  "https://apkcineplayerpro-eqbav2q6q-cine-player.vercel.app",
  "https://apkcineplayerpro.vercel.app"
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
      upstream = await fetch(target.href, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "Accept": "application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*" }
      });
      for (let i = 0; [301, 302, 303, 307, 308].includes(upstream.status) && i < 3; i++) {
        const location = upstream.headers.get("location");
        if (!location) break;
        target = await validateTarget(new URL(location, target).href);
        upstream = await fetch(target.href, {
          method: "GET", redirect: "manual", signal: controller.signal,
          headers: { "Accept": "application/vnd.apple.mpegurl, audio/x-mpegurl, text/plain, */*" }
        });
      }
      if (!upstream.ok) return res.status(502).json({ error: "Servidor da playlist respondeu HTTP " + upstream.status + "." });
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
    if (res.headersSent) {
      return res.destroy(error);
    }
    return res.status(400).json({ error: msg });
  }
};
