// Disk cache for MakeCode requests, so a game played once keeps working offline.
//
// Every https request from the app goes through handle(). MakeCode hosts are cached:
// content-addressed CDN files (/blob/, /commit/) are cache-first because they never change,
// everything else (run page, simulator page, project source, config) is network-first with
// the cache as fallback. Other hosts pass straight through.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { net } = require("electron");

const CACHED_HOSTS = [/(^|\.)makecode\.com$/, /(^|\.)userpxt\.io$/, /(^|\.)pxt\.io$/];
const IMMUTABLE = /^https:\/\/cdn\.makecode\.com\/(blob|commit)\//;
const NETWORK_TIMEOUT_MS = 8000;
// Headers that describe the wire encoding, not the body we store.
const DROP_HEADERS = new Set(["content-encoding", "content-length", "transfer-encoding", "set-cookie", "connection"]);

class RequestCache {
  constructor(dir, { offline = false } = {}) {
    this.dir = dir;
    this.offline = offline;
    fs.mkdirSync(dir, { recursive: true });
  }

  shouldCache(request) {
    if (request.method !== "GET") return false;
    let host;
    try { host = new URL(request.url).hostname; } catch (e) { return false; }
    return CACHED_HOSTS.some(re => re.test(host));
  }

  async handle(request) {
    if (!this.shouldCache(request)) {
      return net.fetch(request, { bypassCustomProtocolHandlers: true });
    }
    const url = request.url;

    if (this.offline || IMMUTABLE.test(url)) {
      const hit = this.read(url);
      if (hit) return hit;
      if (this.offline) return notCached();
    }

    let res;
    try {
      res = await net.fetch(request, {
        bypassCustomProtocolHandlers: true,
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS)
      });
    } catch (err) {
      return this.read(url) || notCached();
    }
    if (res.status !== 200) return res;

    const body = Buffer.from(await res.arrayBuffer());
    const headers = {};
    res.headers.forEach((value, name) => { if (!DROP_HEADERS.has(name)) headers[name] = value; });
    this.write(url, headers, body);
    return new Response(body, { status: 200, headers });
  }

  // Exact URL first, then the URL without its query string. The runner adds
  // cache-busting params such as ?cdn=<date>, which would otherwise miss offline.
  read(url) {
    for (const key of [keyFor(url), keyFor(stripQuery(url))]) {
      const metaPath = path.join(this.dir, key + ".json");
      const bodyPath = path.join(this.dir, key + ".bin");
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
        const body = fs.readFileSync(bodyPath);
        return new Response(body, { status: 200, headers: meta.headers });
      } catch (e) { /* miss: try the next key */ }
    }
    return null;
  }

  has(url) {
    return [keyFor(url), keyFor(stripQuery(url))].some(key => fs.existsSync(path.join(this.dir, key + ".bin")));
  }

  write(url, headers, body) {
    const meta = JSON.stringify({ url, headers, savedAt: new Date().toISOString() });
    for (const key of new Set([keyFor(url), keyFor(stripQuery(url))])) {
      try {
        fs.writeFileSync(path.join(this.dir, key + ".bin"), body);
        fs.writeFileSync(path.join(this.dir, key + ".json"), meta);
      } catch (e) {
        console.warn("cache write failed for", url, e.message);
      }
    }
  }
}

function keyFor(url) {
  return crypto.createHash("sha1").update(url).digest("hex");
}

function stripQuery(url) {
  const i = url.indexOf("?");
  return i < 0 ? url : url.slice(0, i);
}

// 404 rather than a network error: the runner already treats a missing
// precompiled /js as "compile from source", which is the path we want offline.
function notCached() {
  return new Response("Not available offline", { status: 404, headers: { "content-type": "text/plain" } });
}

module.exports = { RequestCache };
