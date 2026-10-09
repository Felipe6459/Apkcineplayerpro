const { lookup } = require("node:dns/promises");
const net = require("node:net");

const ALLOWED_ORIGINS = new Set([
  "https://felipe6459.github.io",
  "https://cineplayerpro-m3u.vercel.app",
  "https://apkcineplayerpro-eqbav2q6q-cine-player.vercel.app"
]);
const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10000;

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
      const length = Number(upstream.headers.get("content-length") || 0);
      if (length > MAX_BYTES) return res.status(413).json({ error: "Playlist maior que o limite de 5 MB." });
      const reader = upstream.body.getReader();
      const chunks = [];
      let total = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > MAX_BYTES) {
          await reader.cancel();
          return res.status(413).json({ error: "Playlist maior que o limite de 5 MB." });
        }
        chunks.push(Buffer.from(value));
      }
      const text = Buffer.concat(chunks).toString("utf8").replace(/^\uFEFF/, "");
      if (!text.trimStart().startsWith("#EXTM3U")) {
        return res.status(422).json({ error: "A resposta não parece ser uma playlist M3U. Pode ser uma página de login ou erro." });
      }
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      return res.status(200).send(text);
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    const msg = error && error.name === "AbortError" ? "Tempo limite ao buscar a playlist." : (error.message || "Falha ao buscar a playlist.");
    return res.status(400).json({ error: msg });
  }
};
