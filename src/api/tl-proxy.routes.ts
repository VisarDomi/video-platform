import { Router } from "express";
import { Readable } from "stream";
import logger from "../core/logger.js";
import { getTokens } from "../services/tango/tokenManager.js";

const router = Router();

interface ProxySession {
  liveUrl: string;
  origin: string;
  segmentMap: Map<string, string>;
  lastAccess: number;
}

const sessions = new Map<string, ProxySession>();

// Cleanup idle sessions every 30s
setInterval(() => {
  const now = Date.now();
  for (const [alias, session] of sessions) {
    if (now - session.lastAccess > 120_000) {
      logger.info(`[TL:proxy] cleanup idle session: ${alias}`);
      sessions.delete(alias);
    }
  }
}, 30_000);

function getStreamCookie(): string | null {
  const tokens = getTokens();
  if (!tokens?.tt || !tokens?.ttu || !tokens?.tte) return null;
  return `tt=${tokens.tt};ttu=${tokens.ttu};tte=${tokens.tte}`;
}

async function resolveLiveUrl(
  masterPlaylistUrl: string,
): Promise<string | null> {
  const cookie = getStreamCookie();
  if (!cookie) return null;

  const res = await fetch(masterPlaylistUrl, {
    headers: { Cookie: cookie },
  });
  if (!res.ok) return null;

  const body = await res.text();
  const lines = body.split("\n").filter((l) => l.trim() !== "");

  let relativeLiveUrl: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes("RESOLUTION=1280x720")) {
      relativeLiveUrl = lines[i + 1];
      break;
    }
  }

  if (!relativeLiveUrl) {
    // Fallback: take the first non-comment line after any #EXT line
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("#") && lines[i].includes("/")) {
        relativeLiveUrl = lines[i];
        break;
      }
    }
  }

  if (!relativeLiveUrl) return null;

  const cinemaApiUrl = masterPlaylistUrl.split("/v2/")[0];
  let liveUrl = `${cinemaApiUrl}${relativeLiveUrl}`;
  if (liveUrl.endsWith("&")) {
    liveUrl = liveUrl.slice(0, -1);
  }
  return liveUrl;
}

// POST /tl/resolve-live-url — lightweight resolution without creating a proxy session
router.post("/tl/resolve-live-url", async (req, res) => {
  const { masterPlaylistUrl } = req.body;
  if (!masterPlaylistUrl) {
    return res.status(400).json({ error: "masterPlaylistUrl required" });
  }

  try {
    const liveUrl = await resolveLiveUrl(masterPlaylistUrl);
    if (!liveUrl) {
      return res.status(502).json({ error: "Failed to resolve live URL" });
    }
    res.json({ liveUrl });
  } catch (error: any) {
    logger.error("[TL:resolve] resolve-live-url failed", {
      error: error.message,
    });
    res.status(502).json({ error: "Resolution failed" });
  }
});

// POST /tl/check-live-url — HEAD check to see if a liveUrl still serves segments
router.post("/tl/check-live-url", async (req, res) => {
  const { liveUrl } = req.body;
  if (!liveUrl) {
    return res.status(400).json({ error: "liveUrl required" });
  }

  const cookie = getStreamCookie();
  if (!cookie) {
    return res.json({ alive: false });
  }

  try {
    const headRes = await fetch(liveUrl, {
      method: "HEAD",
      headers: { Cookie: cookie },
    });
    res.json({ alive: headRes.ok });
  } catch {
    res.json({ alive: false });
  }
});

// POST /tl/proxy/start
router.post("/tl/proxy/start", async (req, res) => {
  const { masterPlaylistUrl, alias } = req.body;
  if (!masterPlaylistUrl || !alias) {
    return res
      .status(400)
      .json({ error: "masterPlaylistUrl and alias required" });
  }

  // Return immediately if session already exists
  const existing = sessions.get(alias);
  if (existing) {
    existing.lastAccess = Date.now();
    return res.json({
      proxyPlaylistUrl: `/api/tl/proxy/${encodeURIComponent(alias)}/live.m3u8`,
    });
  }

  try {
    const liveUrl = await resolveLiveUrl(masterPlaylistUrl);
    if (!liveUrl) {
      return res
        .status(502)
        .json({ error: "Failed to resolve live playlist URL" });
    }

    const origin = new URL(liveUrl).origin;
    sessions.set(alias, {
      liveUrl,
      origin,
      segmentMap: new Map(),
      lastAccess: Date.now(),
    });

    logger.info(`[TL:proxy] started session: ${alias}`);
    res.json({
      proxyPlaylistUrl: `/api/tl/proxy/${encodeURIComponent(alias)}/live.m3u8`,
    });
  } catch (error: any) {
    logger.error(`[TL:proxy] start failed for ${alias}`, {
      error: error.message,
    });
    res.status(500).json({ error: "Proxy start failed" });
  }
});

// GET /tl/proxy/:alias/live.m3u8
router.get("/tl/proxy/:alias/live.m3u8", async (req, res) => {
  const { alias } = req.params;
  const session = sessions.get(alias);
  if (!session) {
    return res.status(404).json({ error: "No proxy session for this alias" });
  }
  session.lastAccess = Date.now();

  const cookie = getStreamCookie();
  if (!cookie) {
    return res.status(500).json({ error: "Stream cookies not available" });
  }

  try {
    const playlistRes = await fetch(session.liveUrl, {
      headers: { Cookie: cookie },
    });

    if (!playlistRes.ok) {
      return res.status(playlistRes.status).end();
    }

    const body = await playlistRes.text();
    const liveBase = session.liveUrl.substring(
      0,
      session.liveUrl.lastIndexOf("/") + 1,
    );

    // Rewrite segment URLs
    const rewritten = body
      .split("\n")
      .map((line) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) return line;

        // This is a segment URI line
        let fullUrl: string;
        let filename: string;

        if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
          // Absolute URL
          fullUrl = trimmed;
          const urlPath = new URL(trimmed).pathname;
          filename = urlPath.substring(urlPath.lastIndexOf("/") + 1);
        } else if (trimmed.startsWith("/")) {
          // Absolute path — resolve against origin
          fullUrl = session.origin + trimmed;
          const pathOnly = trimmed.split("?")[0];
          filename = pathOnly.substring(pathOnly.lastIndexOf("/") + 1);
        } else {
          // Relative
          fullUrl = liveBase + trimmed;
          const pathOnly = trimmed.split("?")[0];
          filename = pathOnly.substring(pathOnly.lastIndexOf("/") + 1);
        }

        session.segmentMap.set(filename, fullUrl);
        return filename;
      })
      .join("\n");

    res.set({
      "Content-Type": "application/vnd.apple.mpegurl",
      "Cache-Control": "no-cache, no-store, must-revalidate",
    });
    res.send(rewritten);
  } catch (error: any) {
    logger.error(`[TL:proxy] playlist fetch failed for ${alias}`, {
      error: error.message,
    });
    res.status(502).json({ error: "Failed to fetch live playlist" });
  }
});

// GET /tl/proxy/:alias/:segmentFile
router.get("/tl/proxy/:alias/:segmentFile", async (req, res) => {
  const { alias, segmentFile } = req.params;
  const session = sessions.get(alias);
  if (!session) {
    return res.status(404).end();
  }
  session.lastAccess = Date.now();

  const cdnUrl = session.segmentMap.get(segmentFile);
  if (!cdnUrl) {
    return res.status(404).json({ error: "Segment not found in session" });
  }

  try {
    const segRes = await fetch(cdnUrl);
    if (!segRes.ok || !segRes.body) {
      return res.status(segRes.status).end();
    }

    res.set({ "Content-Type": "video/mp2t" });
    const readable = Readable.fromWeb(segRes.body as any);
    readable.pipe(res);
  } catch (error: any) {
    logger.error(`[TL:proxy] segment fetch failed: ${segmentFile}`, {
      error: error.message,
    });
    res.status(502).end();
  }
});

// POST /tl/proxy/stop
router.post("/tl/proxy/stop", async (req, res) => {
  const { alias } = req.body;
  if (!alias) return res.status(400).json({ error: "alias required" });

  const deleted = sessions.delete(alias);
  if (deleted) {
    logger.info(`[TL:proxy] stopped session: ${alias}`);
  }
  res.json({ ok: true });
});

export default router;
