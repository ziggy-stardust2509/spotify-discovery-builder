import fs from "node:fs";
import http from "node:http";
import { URL } from "node:url";
import { exec } from "node:child_process";
import crypto from "node:crypto";
import fetch from "node-fetch";

const SPOTIFY_AUTH_BASE = "https://accounts.spotify.com";
const SPOTIFY_API_BASE = "https://api.spotify.com/v1";

function clampInt(value, { min, max, fallback }) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function encodeForm(data) {
  return new URLSearchParams(data).toString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function openBrowser(url) {
  const platform = process.platform;
  const cmd =
    platform === "darwin"
      ? `open "${url}"`
      : platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

function toBase64Url(buffer) {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

export class SpotifyClient {
  constructor(config) {
    this.clientId = config.clientId;
    this.clientSecret = config.clientSecret;
    this.authMode = config.authMode || "pkce";
    this.redirectUri = config.redirectUri;
    this.scopes = config.scopes;
    this.searchMarket = config.searchMarket || "US";
    this.searchLimitMax = Number(config.searchLimitMax || 10);
    this.authFile = config.authFile;
    this.auth = this.readAuthFromDisk();
  }

  readAuthFromDisk() {
    try {
      if (!fs.existsSync(this.authFile)) return null;
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

  setAuth(auth) {
    this.writeAuthToDisk(auth);
  }

  isAuthorized() {
    return Boolean(this.auth?.access_token || this.auth?.refresh_token);
  }

  hasValidAccessToken() {
    if (!this.auth?.access_token || !this.auth?.expires_at) return false;
    const now = Date.now();
    return now < this.auth.expires_at - 30_000;
  }

  async authorize() {
    const state = crypto.randomBytes(16).toString("hex");
    let codeVerifier = null;
    let authUrl;
    if (this.authMode === "pkce") {
      const pair = this.createPkcePair();
      codeVerifier = pair.codeVerifier;
      authUrl = this.getAuthorizationUrl({
        state,
        codeChallenge: pair.codeChallenge
      });
    } else {
      authUrl = this.getAuthorizationUrl(state);
    }

    console.log(`Opening Spotify login: ${authUrl}`);
    openBrowser(authUrl);

    const code = await this.waitForCode(state);
    await this.authenticateWithCode(code, { codeVerifier });
    return this.auth;
  }

  createPkcePair() {
    const codeVerifier = toBase64Url(crypto.randomBytes(64));
    const codeChallenge = toBase64Url(
      crypto.createHash("sha256").update(codeVerifier).digest()
    );
    return { codeVerifier, codeChallenge };
  }

  getAuthorizationUrl(input) {
    const options =
      typeof input === "string" ? { state: input } : input || {};
    const { state, codeChallenge, showDialog } = options;

    const authUrl = new URL(`${SPOTIFY_AUTH_BASE}/authorize`);
    authUrl.searchParams.set("client_id", this.clientId);
    authUrl.searchParams.set("response_type", "code");
    authUrl.searchParams.set("redirect_uri", this.redirectUri);
    authUrl.searchParams.set("scope", this.scopes);
    if (state) {
      authUrl.searchParams.set("state", state);
    }
    if (codeChallenge) {
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("code_challenge", codeChallenge);
    }
    if (showDialog) {
      authUrl.searchParams.set("show_dialog", "true");
    }
    return authUrl.toString();
  }

  async waitForCode(expectedState) {
    const redirect = new URL(this.redirectUri);
    const timeoutMs = 180_000;

    return new Promise((resolve, reject) => {
      const server = http.createServer((req, res) => {
        try {
          const reqUrl = new URL(req.url, `${redirect.protocol}//${redirect.host}`);
          if (reqUrl.pathname !== redirect.pathname) {
            res.writeHead(404);
            res.end("Not found");
            return;
          }

          const code = reqUrl.searchParams.get("code");
          const state = reqUrl.searchParams.get("state");
          const error = reqUrl.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end(`Spotify authorization failed: ${error}`);
            server.close();
            reject(new Error(`Spotify authorization failed: ${error}`));
            return;
          }

          if (!code || !state || state !== expectedState) {
            res.writeHead(400, { "Content-Type": "text/plain" });
            res.end("Invalid callback parameters.");
            return;
          }

          res.writeHead(200, { "Content-Type": "text/plain" });
          res.end("Spotify authorization complete. You can close this tab.");
          server.close();
          resolve(code);
        } catch (err) {
          server.close();
          reject(err);
        }
      });

      server.listen(Number(redirect.port || 80), redirect.hostname, () => {
        console.log(
          `Waiting for Spotify callback on ${redirect.hostname}:${redirect.port || 80}${redirect.pathname}`
        );
      });

      const timer = setTimeout(() => {
        server.close();
        reject(new Error("Authorization timed out. Try again."));
      }, timeoutMs);

      server.on("close", () => clearTimeout(timer));
      server.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  buildTokenRequestHeaders() {
    const headers = {
      "Content-Type": "application/x-www-form-urlencoded"
    };
    if (this.clientSecret) {
      headers.Authorization = `Basic ${Buffer.from(
        `${this.clientId}:${this.clientSecret}`
      ).toString("base64")}`;
    }
    return headers;
  }

  async exchangeCodeForToken(code, { codeVerifier } = {}) {
    const body = {
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri
    };
    if (!this.clientSecret) {
      body.client_id = this.clientId;
    }
    if (codeVerifier) {
      body.code_verifier = codeVerifier;
    }
    const response = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
      method: "POST",
      headers: this.buildTokenRequestHeaders(),
      body: encodeForm(body)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token exchange failed (${response.status}): ${body}`);
    }

    return response.json();
  }

  saveTokenResponse(token) {
    const normalized = {
      ...this.auth,
      ...token,
      refresh_token: token.refresh_token || this.auth?.refresh_token,
      expires_at: Date.now() + token.expires_in * 1000
    };
    this.writeAuthToDisk(normalized);
    return normalized;
  }

  async authenticateWithCode(code, { codeVerifier } = {}) {
    const token = await this.exchangeCodeForToken(code, { codeVerifier });
    return this.saveTokenResponse(token);
  }

  async refreshToken() {
    if (!this.auth?.refresh_token) {
      throw new Error("No refresh token found. Run auth first.");
    }

    const body = {
      grant_type: "refresh_token",
      refresh_token: this.auth.refresh_token
    };
    if (!this.clientSecret) {
      body.client_id = this.clientId;
    }
    const response = await fetch(`${SPOTIFY_AUTH_BASE}/api/token`, {
      method: "POST",
      headers: this.buildTokenRequestHeaders(),
      body: encodeForm(body)
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Token refresh failed (${response.status}): ${body}`);
    }

    const refreshed = await response.json();
    const merged = {
      ...this.auth,
      ...refreshed,
      refresh_token: refreshed.refresh_token || this.auth.refresh_token,
      expires_at: Date.now() + refreshed.expires_in * 1000
    };
    this.writeAuthToDisk(merged);
    return merged.access_token;
  }

  async getAccessToken() {
    if (this.hasValidAccessToken()) {
      return this.auth.access_token;
    }
    if (this.auth?.refresh_token) {
      return this.refreshToken();
    }
    throw new Error("Not authorized. Run `npm run auth` or open /auth/login in the web app.");
  }

  async api(method, path, { query, body, retry = true } = {}) {
    const accessToken = await this.getAccessToken();
    const url = new URL(`${SPOTIFY_API_BASE}${path}`);
    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        url.searchParams.set(key, String(value));
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(body ? { "Content-Type": "application/json" } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });

    if (response.status === 401 && retry) {
      await this.refreshToken();
      return this.api(method, path, { query, body, retry: false });
    }

    if (response.status === 429 && retry) {
      const retryAfter = Number(response.headers.get("retry-after") || 1);
      await sleep((retryAfter + 1) * 1000);
      return this.api(method, path, { query, body, retry: false });
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `Spotify API ${method} ${path} failed (${response.status}) [${url.toString()}]: ${text}`
      );
    }

    if (response.status === 204) return null;
    const text = await response.text();
    if (!text.trim()) return null;
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async getCurrentUser() {
    return this.api("GET", "/me");
  }

  async getSavedTracks({ pageLimit = 4, pageSize = 50 } = {}) {
    const safePageSize = clampInt(pageSize, { min: 1, max: 50, fallback: 50 });
    const safePageLimit = clampInt(pageLimit, { min: 1, max: 20, fallback: 4 });
    const tracks = [];
    let offset = 0;
    for (let page = 0; page < safePageLimit; page += 1) {
      const result = await this.api("GET", "/me/tracks", {
        query: {
          limit: safePageSize,
          offset,
          market: this.searchMarket
        }
      });
      const items = result?.items || [];
      for (const item of items) {
        if (item?.track?.uri) {
          tracks.push(item.track);
        }
      }
      if (!result?.next) break;
      offset += safePageSize;
    }
    return tracks;
  }

  async searchTracks(q, limit = 20, offset = 0) {
    const safeLimit = clampInt(limit, {
      min: 1,
      max: this.searchLimitMax,
      fallback: Math.min(10, this.searchLimitMax)
    });
    const safeOffset = clampInt(offset, { min: 0, max: 10_000, fallback: 0 });
    try {
      return await this.api("GET", "/search", {
        query: {
          q,
          type: "track",
          limit: safeLimit,
          offset: safeOffset,
          market: this.searchMarket
        }
      });
    } catch (err) {
      const message = String(err?.message || "");
      if (!/invalid limit/i.test(message)) {
        throw err;
      }
      const fallbackLimits = Array.from(
        new Set([Math.min(10, this.searchLimitMax), 5, 1])
      ).filter((value) => value >= 1);
      let lastError = err;
      for (const fallbackLimit of fallbackLimits) {
        try {
          return await this.api("GET", "/search", {
            query: {
              q,
              type: "track",
              limit: fallbackLimit,
              offset: 0
            }
          });
        } catch (retryErr) {
          lastError = retryErr;
          if (!/invalid limit/i.test(String(retryErr?.message || ""))) {
            throw retryErr;
          }
        }
      }
      throw lastError;
    }
  }

  async getCurrentUserPlaylists() {
    const all = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const page = await this.api("GET", "/me/playlists", {
        query: { limit, offset }
      });
      all.push(...page.items);
      if (!page.next) break;
      offset += limit;
    }
    return all;
  }

  async findPlaylistByName(ownerId, name) {
    const normalized = name.trim().toLowerCase();
    const playlists = await this.getCurrentUserPlaylists();
    return (
      playlists.find(
        (p) =>
          p.owner?.id === ownerId &&
          p.name.trim().toLowerCase() === normalized
      ) || null
    );
  }

  async createPlaylist(_userId, { name, description, isPublic }) {
    // Use current-user endpoint for broader compatibility.
    return this.api("POST", "/me/playlists", {
      body: {
        name,
        description,
        public: isPublic
      }
    });
  }

  async updatePlaylistDetails(playlistId, { name, description, isPublic }) {
    return this.api("PUT", `/playlists/${playlistId}`, {
      body: {
        name,
        description,
        public: isPublic
      }
    });
  }

  async getPlaylistTrackUris(playlistId) {
    const uris = [];
    let offset = 0;
    const limit = 100;

    while (true) {
      const page = await this.api("GET", `/playlists/${playlistId}/items`, {
        query: { limit, offset, fields: "items(track(uri)),next" }
      });
      uris.push(
        ...page.items.map((item) => item.track?.uri).filter((uri) => Boolean(uri))
      );
      if (!page.next) break;
      offset += limit;
    }
    return uris;
  }

  async replacePlaylistTracks(playlistId, uris) {
    if (!uris.length) {
      await this.api("PUT", `/playlists/${playlistId}/items`, {
        body: { uris: [] }
      });
      return;
    }

    const first = uris.slice(0, 100);
    await this.api("PUT", `/playlists/${playlistId}/items`, {
      body: { uris: first }
    });

    for (let i = 100; i < uris.length; i += 100) {
      const chunk = uris.slice(i, i + 100);
      await this.api("POST", `/playlists/${playlistId}/items`, {
        body: { uris: chunk }
      });
    }
  }

  async addTracksToPlaylist(playlistId, uris) {
    for (let i = 0; i < uris.length; i += 100) {
      const chunk = uris.slice(i, i + 100);
      await this.api("POST", `/playlists/${playlistId}/items`, {
        body: { uris: chunk }
      });
    }
  }
}
