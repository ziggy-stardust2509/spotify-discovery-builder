import fs from "node:fs";

const GOOGLE_AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
let fetchImpl = globalThis.fetch ? globalThis.fetch.bind(globalThis) : null;

async function httpFetch(url, options) {
  if (fetchImpl) {
    return fetchImpl(url, options);
  }
  try {
    const mod = await import("node-fetch");
    fetchImpl = mod.default;
    return fetchImpl(url, options);
  } catch (err) {
    throw new Error(
      `No fetch implementation available. Use Node 18+ or install node-fetch. (${err.message})`
    );
  }
}

function clampInt(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function splitTokens(value) {
  return normalize(value).split(" ").filter(Boolean);
}

function scoreCandidate(video, track) {
  const title = String(video?.snippet?.title || "");
  const channel = String(video?.snippet?.channelTitle || "");
  const haystack = `${title} ${channel}`;
  const haystackNorm = normalize(haystack);
  const trackNameNorm = normalize(track.name);
  const artistNorm = normalize((track.artists || []).join(" "));

  let score = 0;
  if (!trackNameNorm) return score;
  if (haystackNorm.includes(trackNameNorm)) score += 8;

  for (const token of splitTokens(trackNameNorm)) {
    if (token.length < 3) continue;
    if (haystackNorm.includes(token)) score += 1.2;
  }
  for (const token of splitTokens(artistNorm)) {
    if (token.length < 3) continue;
    if (haystackNorm.includes(token)) score += 1.4;
  }

  const titleLower = title.toLowerCase();
  if (/\bofficial\b/.test(titleLower)) score += 2;
  if (/\baudio\b/.test(titleLower)) score += 2;
  if (/\blyrics?\b/.test(titleLower)) score += 1;
  if (/\btopic\b/.test(channel.toLowerCase())) score += 1.5;
  if (/\blive\b/.test(titleLower)) score -= 3;
  if (/\bremix\b/.test(titleLower)) score -= 1.5;
  if (/\bsped up\b/.test(titleLower) || /\bslowed\b/.test(titleLower)) score -= 3;
  return score;
}

function buildSearchQuery(track) {
  const artists = Array.isArray(track.artists) ? track.artists.join(" ") : "";
  return `${track.name || ""} ${artists} official audio`.trim();
}

function buildTrackInput(input) {
  const name = String(input?.name || "").trim();
  const artists = Array.isArray(input?.artists)
    ? input.artists.map((value) => String(value || "").trim()).filter(Boolean)
    : String(input?.artists || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  return { name, artists };
}

export class YouTubeOAuthClient {
  constructor(config) {
    this.clientId = String(config.youtubeClientId || "").trim();
    this.clientSecret = String(config.youtubeClientSecret || "").trim();
    this.redirectUri = String(config.redirectUri || "").trim();
    this.scopes = String(config.youtubeAuthScopes || "").trim();
    this.authFile = String(config.authFile || "").trim();
    this.region = String(config.youtubeRegion || "US").trim().toUpperCase();
    this.maxSearchResults = clampInt(config.youtubeMaxSearchResults, {
      min: 1,
      max: 10,
      fallback: 5
    });
    this.auth = this.readAuthFromDisk();
  }

  isConfigured() {
    return Boolean(this.clientId && this.clientSecret && this.redirectUri && this.authFile);
  }

  readAuthFromDisk() {
    try {
      if (!this.authFile || !fs.existsSync(this.authFile)) return null;
      return JSON.parse(fs.readFileSync(this.authFile, "utf8"));
    } catch {
      return null;
    }
  }

  writeAuthToDisk(auth) {
    this.auth = auth;
    fs.writeFileSync(this.authFile, JSON.stringify(auth, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(this.authFile, 0o600);
    } catch {
      // Ignore platform/filesystem permission limitations.
    }
  }

  isAuthorized() {
    return Boolean(this.auth?.refresh_token || this.auth?.access_token);
  }

  hasValidAccessToken() {
    if (!this.auth?.access_token || !this.auth?.expires_at) return false;
    return Date.now() < this.auth.expires_at - 30_000;
  }

  getAuthorizationUrl(state) {
    const url = new URL(GOOGLE_AUTH_BASE);
    url.searchParams.set("client_id", this.clientId);
    url.searchParams.set("redirect_uri", this.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", this.scopes);
    url.searchParams.set("access_type", "offline");
    url.searchParams.set("prompt", "consent");
    if (state) {
      url.searchParams.set("state", state);
    }
    return url.toString();
  }

  async exchangeCodeForToken(code) {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });
    const response = await httpFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error_description || data?.error || text || "Unknown Google token error";
      throw new Error(`Google token exchange failed (${response.status}): ${message}`);
    }
    const token = data || {};
    const merged = {
      ...this.auth,
      ...token,
      refresh_token: token.refresh_token || this.auth?.refresh_token,
      expires_at: Date.now() + Number(token.expires_in || 3600) * 1000
    };
    this.writeAuthToDisk(merged);
    return merged;
  }

  async refreshToken() {
    if (!this.auth?.refresh_token) {
      throw new Error("No YouTube refresh token found. Connect YouTube first.");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: this.auth.refresh_token,
      client_id: this.clientId,
      client_secret: this.clientSecret
    });
    const response = await httpFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: body.toString()
    });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error_description || data?.error || text || "Unknown Google token error";
      throw new Error(`Google token refresh failed (${response.status}): ${message}`);
    }
    const refreshed = data || {};
    const merged = {
      ...this.auth,
      ...refreshed,
      refresh_token: refreshed.refresh_token || this.auth.refresh_token,
      expires_at: Date.now() + Number(refreshed.expires_in || 3600) * 1000
    };
    this.writeAuthToDisk(merged);
    return merged.access_token;
  }

  async getAccessToken() {
    if (this.hasValidAccessToken()) {
      return this.auth.access_token;
    }
    return this.refreshToken();
  }

  async api(method, path, { query, body } = {}) {
    const token = await this.getAccessToken();
    const url = new URL(`${YOUTUBE_API_BASE}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }
    const response = await httpFetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
    const text = await response.text();
    let data = null;
    try {
      data = text.trim() ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message || text || "Unknown YouTube API error";
      throw new Error(`YouTube API ${method} ${path} failed (${response.status}): ${message}`);
    }
    return data;
  }

  async searchVideos(query, maxResults = this.maxSearchResults) {
    const safeMax = clampInt(maxResults, { min: 1, max: 10, fallback: this.maxSearchResults });
    return this.api("GET", "/search", {
      query: {
        part: "snippet",
        type: "video",
        q: query,
        maxResults: safeMax,
        regionCode: this.region
      }
    });
  }

  pickBestVideo(items, track) {
    let best = null;
    let bestScore = Number.NEGATIVE_INFINITY;
    for (const item of items || []) {
      const score = scoreCandidate(item, track);
      if (score > bestScore) {
        best = item;
        bestScore = score;
      }
    }
    if (!best || bestScore < 3) return null;
    return best;
  }

  async createPlaylist({ title, description }) {
    return this.api("POST", "/playlists", {
      query: { part: "snippet,status" },
      body: {
        snippet: {
          title: String(title || "Discovery Mix").trim(),
          description: String(description || "Generated by Spotify Discovery Builder").trim()
        },
        status: {
          privacyStatus: "unlisted"
        }
      }
    });
  }

  async addVideoToPlaylist(playlistId, videoId) {
    return this.api("POST", "/playlistItems", {
      query: { part: "snippet" },
      body: {
        snippet: {
          playlistId,
          resourceId: {
            kind: "youtube#video",
            videoId
          }
        }
      }
    });
  }

  async createPlaylistFromTracks(rawTracks, { name } = {}) {
    const tracks = Array.isArray(rawTracks)
      ? rawTracks.map(buildTrackInput).filter((track) => Boolean(track.name))
      : [];
    if (!tracks.length) {
      throw new Error("No tracks were provided for YouTube playlist creation.");
    }

    const matched = [];
    const skipped = [];
    for (const track of tracks.slice(0, 50)) {
      const query = buildSearchQuery(track);
      try {
        const search = await this.searchVideos(query);
        const best = this.pickBestVideo(search?.items || [], track);
        if (!best?.id?.videoId) {
          skipped.push({
            name: track.name,
            artists: track.artists
          });
          continue;
        }
        matched.push({
          track,
          videoId: best.id.videoId
        });
      } catch {
        skipped.push({
          name: track.name,
          artists: track.artists
        });
      }
    }

    const uniqueVideoIds = Array.from(new Set(matched.map((item) => item.videoId))).slice(0, 50);
    if (!uniqueVideoIds.length) {
      throw new Error("No high-confidence YouTube matches were found for this selection.");
    }

    const created = await this.createPlaylist({
      title: String(name || "Discovery Mix").trim(),
      description: "Generated by Spotify Discovery Builder"
    });
    const playlistId = created?.id;
    if (!playlistId) {
      throw new Error("YouTube playlist was not created.");
    }
    for (const videoId of uniqueVideoIds) {
      await this.addVideoToPlaylist(playlistId, videoId);
    }
    return {
      mode: "saved_playlist",
      playlistId,
      youtubeUrl: `https://www.youtube.com/playlist?list=${playlistId}`,
      videoCount: uniqueVideoIds.length,
      skippedCount: skipped.length
    };
  }
}
