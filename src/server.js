#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { getConfig } from "./config.js";
import { PRESETS, parseArtistsAndGenres, syncPlaylist } from "./playlistManager.js";
import { SpotifyClient } from "./spotify.js";

const config = getConfig();
const redirectTarget = new URL(config.redirectUri);

const HOST = process.env.HOST || redirectTarget.hostname || "127.0.0.1";
const PORT = Number(process.env.PORT || redirectTarget.port || 3000);
const CALLBACK_PATH = redirectTarget.pathname || "/callback";
const SEARCH_LIMIT_MAX = Number(config.searchLimitMax || 10);
const WEB_ROOT = path.resolve(process.cwd(), "web");
const SESSION_DIR = path.resolve(
  process.cwd(),
  process.env.SPM_SESSION_DIR || ".sessions"
);
const STATE_TTL_MS = 10 * 60 * 1000;
const SESSION_COOKIE_NAME = "spm_sid";
const SESSION_COOKIE_TTL_SECONDS = 60 * 60 * 24 * 30;
const stateStore = new Map();
const rateLimitStore = new Map();
const RATE_LIMIT_WINDOW_MS = 5 * 60 * 1000;
const RATE_LIMIT_CLEANUP_MS = 60 * 1000;
let lastRateLimitCleanupAt = 0;
fs.mkdirSync(SESSION_DIR, { recursive: true, mode: 0o700 });
try {
  fs.chmodSync(SESSION_DIR, 0o700);
} catch {
  // Ignore platform/filesystem permission limitations.
}

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8"
};

function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "connect-src 'self' https://api.spotify.com https://accounts.spotify.com",
      "img-src 'self' data: https:",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://accounts.spotify.com"
    ].join("; ")
  );
}

function applyTransportSecurityHeaders(req, res) {
  if (requestProto(req) === "https") {
    res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
  }
}

function sendJson(res, statusCode, body) {
  applySecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function sendText(res, statusCode, body) {
  applySecurityHeaders(res);
  res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(body);
}

function redirect(res, location) {
  applySecurityHeaders(res);
  res.writeHead(302, { Location: location });
  res.end();
}

function redirectToApp(res, params = {}) {
  const search = new URLSearchParams(params);
  const suffix = search.toString();
  const target = suffix ? `/?${suffix}` : "/";
  redirect(res, target);
}

function parseCookies(cookieHeader) {
  if (!cookieHeader) return {};
  return cookieHeader.split(";").reduce((acc, part) => {
    const idx = part.indexOf("=");
    if (idx === -1) return acc;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) return acc;
    acc[key] = decodeURIComponent(value);
    return acc;
  }, {});
}

function appendSetCookie(res, cookie) {
  const existing = res.getHeader("Set-Cookie");
  if (!existing) {
    res.setHeader("Set-Cookie", cookie);
    return;
  }
  if (Array.isArray(existing)) {
    res.setHeader("Set-Cookie", [...existing, cookie]);
    return;
  }
  res.setHeader("Set-Cookie", [existing, cookie]);
}

function requestIsSecure(req) {
  if (req.socket?.encrypted) return true;
  const forwarded = req.headers["x-forwarded-proto"];
  if (!forwarded) return false;
  const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return String(value).split(",")[0].trim() === "https";
}

function firstForwardedHeaderValue(value) {
  if (!value) return "";
  const raw = Array.isArray(value) ? value[0] : value;
  return String(raw).split(",")[0].trim();
}

function requestHost(req) {
  const forwarded = firstForwardedHeaderValue(req.headers["x-forwarded-host"]);
  if (forwarded) return forwarded;
  return String(req.headers.host || "").trim();
}

function hostToHostname(host) {
  if (!host) return "";
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return String(host).split(":")[0].trim().toLowerCase();
  }
}

function requestProto(req) {
  const forwarded = firstForwardedHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase();
  if (forwarded === "https" || forwarded === "http") {
    return forwarded;
  }
  return req.socket?.encrypted ? "https" : "http";
}

function isLoopbackHost(hostname) {
  const normalized = String(hostname || "").trim().toLowerCase();
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

function buildWebRedirectUri(req) {
  const forced = String(process.env.SPM_WEB_REDIRECT_URI || "").trim();
  if (forced) return forced;

  const host = requestHost(req);
  if (!host) return config.redirectUri;
  const proto = requestProto(req);
  const candidate = `${proto}://${host}${CALLBACK_PATH}`;
  const isPublicHttp = proto !== "https" && !isLoopbackHost(hostToHostname(host));
  if (isPublicHttp) {
    // If proxy headers are missing, prefer configured secure callback over rejecting auth.
    try {
      const configured = new URL(config.redirectUri);
      if (configured.protocol === "https:") {
        return config.redirectUri;
      }
    } catch {
      // Ignore parse failure and use candidate.
    }
  }
  return candidate;
}

function assertSafeRedirectUri(redirectUri) {
  let parsed;
  try {
    parsed = new URL(redirectUri);
  } catch {
    throw new Error(`Invalid redirect URI: ${redirectUri}`);
  }

  if (parsed.protocol === "https:") return;
  if (isLoopbackHost(parsed.hostname)) return;
  throw new Error(
    `Redirect URI must use HTTPS for public hosts. Current value: ${redirectUri}`
  );
}

function buildCookie(name, value, { maxAge, secure }) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAge}`
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function clearCookie(name, { secure }) {
  const parts = [
    `${name}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0"
  ];
  if (secure) {
    parts.push("Secure");
  }
  return parts.join("; ");
}

function normalizeSessionId(value) {
  if (!value) return null;
  if (!/^[a-f0-9]{32,64}$/i.test(value)) return null;
  return value.toLowerCase();
}

function readSessionHeaderId(req) {
  const headerValue = req.headers["x-spm-session-id"];
  const rawHeader = Array.isArray(headerValue) ? headerValue[0] : headerValue;
  return normalizeSessionId(rawHeader);
}

function readSessionId(req) {
  const headerSessionId = readSessionHeaderId(req);
  if (headerSessionId) return headerSessionId;

  const cookies = parseCookies(req.headers.cookie);
  return normalizeSessionId(cookies[SESSION_COOKIE_NAME]);
}

function requireSessionHeader(req, res) {
  const sessionId = readSessionHeaderId(req);
  if (!sessionId) {
    sendJson(res, 400, {
      error: "Missing session header. Reload the page and try again."
    });
    return null;
  }
  return sessionId;
}

function setSessionCookie(req, res, sessionId) {
  const secure =
    process.env.SPM_COOKIE_SECURE === "true" ||
    (process.env.SPM_COOKIE_SECURE !== "false" && requestIsSecure(req));
  appendSetCookie(
    res,
    buildCookie(SESSION_COOKIE_NAME, sessionId, {
      maxAge: SESSION_COOKIE_TTL_SECONDS,
      secure
    })
  );
}

function clearSessionCookie(req, res) {
  const secure =
    process.env.SPM_COOKIE_SECURE === "true" ||
    (process.env.SPM_COOKIE_SECURE !== "false" && requestIsSecure(req));
  appendSetCookie(res, clearCookie(SESSION_COOKIE_NAME, { secure }));
}

function ensureSessionId(req, res) {
  const existing = readSessionId(req);
  if (existing) return existing;
  const sessionId = crypto.randomBytes(24).toString("hex");
  setSessionCookie(req, res, sessionId);
  return sessionId;
}

function clientIp(req) {
  const forwardedFor = firstForwardedHeaderValue(req.headers["x-forwarded-for"]);
  if (forwardedFor) return forwardedFor.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function cleanupRateLimits(now = Date.now()) {
  if (now - lastRateLimitCleanupAt < RATE_LIMIT_CLEANUP_MS) return;
  for (const [key, value] of rateLimitStore.entries()) {
    if (now - value.startedAt > RATE_LIMIT_WINDOW_MS) {
      rateLimitStore.delete(key);
    }
  }
  lastRateLimitCleanupAt = now;
}

function enforceRateLimit(req, res, { bucket, max, windowMs = RATE_LIMIT_WINDOW_MS }) {
  const now = Date.now();
  cleanupRateLimits(now);
  const sessionId = readSessionId(req);
  const identity = sessionId ? `sid:${sessionId}` : `ip:${clientIp(req)}`;
  const key = `${bucket}:${identity}`;
  const entry = rateLimitStore.get(key);
  if (!entry || now - entry.startedAt > windowMs) {
    rateLimitStore.set(key, { startedAt: now, count: 1 });
    return true;
  }
  if (entry.count >= max) {
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((windowMs - (now - entry.startedAt)) / 1000)
    );
    res.setHeader("Retry-After", String(retryAfterSeconds));
    sendJson(res, 429, { error: "Too many requests. Please wait and try again." });
    return false;
  }
  entry.count += 1;
  return true;
}

function sessionAuthFile(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.json`);
}

function sessionClientConfigFile(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.client.json`);
}

function normalizeAuthMode(value, fallback = config.authMode) {
  const candidate = String(value || "").trim().toLowerCase();
  if (candidate === "pkce" || candidate === "standard") {
    return candidate;
  }
  return fallback;
}

function readSessionClientConfig(sessionId) {
  const filePath = sessionClientConfigFile(sessionId);
  try {
    if (!fs.existsSync(filePath)) return null;
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const clientId = String(parsed.clientId || "").trim();
    const clientSecret = String(parsed.clientSecret || "").trim();
    const authMode = normalizeAuthMode(parsed.authMode);
    if (!clientId) return null;
    return { clientId, clientSecret, authMode };
  } catch {
    return null;
  }
}

function removeFileIfExists(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // Ignore cleanup failure.
  }
}

function buildSessionSpotifyConfig(sessionId) {
  const sessionConfig = readSessionClientConfig(sessionId);
  const merged = {
    ...config,
    ...(sessionConfig || {}),
    authFile: sessionAuthFile(sessionId)
  };
  if (merged.authMode === "standard" && !merged.clientSecret) {
    merged.authMode = "pkce";
  }
  return merged;
}

function getClientConfigSummary(sessionId, req) {
  const effective = buildSessionSpotifyConfig(sessionId);
  const hasCustom = Boolean(readSessionClientConfig(sessionId));
  const webRedirectUri = buildWebRedirectUri(req);
  return {
    source: hasCustom ? "session" : "server",
    clientId: effective.clientId,
    authMode: effective.authMode,
    hasClientSecret: Boolean(effective.clientSecret),
    redirectUri: webRedirectUri,
    configuredRedirectUri: effective.redirectUri
  };
}

function getSpotifyClientForSession(sessionId, overrides = {}) {
  return new SpotifyClient({
    ...buildSessionSpotifyConfig(sessionId),
    ...overrides
  });
}

function normalizePathname(pathname) {
  if (!pathname) return "/";
  if (pathname.length > 1 && pathname.endsWith("/")) {
    return pathname.slice(0, -1);
  }
  return pathname;
}

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, value] of stateStore.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      stateStore.delete(state);
    }
  }
}

function createAuthorizationUrlForSession(req, sessionId) {
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = buildWebRedirectUri(req);
  assertSafeRedirectUri(redirectUri);

  const spotify = getSpotifyClientForSession(sessionId, { redirectUri });
  let codeVerifier = null;
  let authorizationUrl;
  if (spotify.authMode === "pkce") {
    const pair = spotify.createPkcePair();
    codeVerifier = pair.codeVerifier;
    authorizationUrl = spotify.getAuthorizationUrl({
      state,
      codeChallenge: pair.codeChallenge
    });
  } else {
    authorizationUrl = spotify.getAuthorizationUrl(state);
  }

  stateStore.set(state, {
    createdAt: Date.now(),
    sessionId,
    codeVerifier,
    redirectUri
  });
  return authorizationUrl;
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  const maxSize = 1_000_000;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxSize) {
      throw new Error("Request body too large.");
    }
    chunks.push(chunk);
  }

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  return JSON.parse(raw);
}

function pickPreset(name) {
  if (!name) return null;
  return PRESETS[String(name).toLowerCase()] || null;
}

function parseCsv(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  return fallback;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function mergeUnique(items = []) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const value = String(item || "").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(value);
  }
  return result;
}

function explainSpotifyIntegrationError(errorMessage) {
  const text = String(errorMessage || "");
  const lower = text.toLowerCase();

  if (
    lower.includes("access_denied") &&
    (lower.includes("developer dashboard") ||
      lower.includes("user not registered") ||
      lower.includes("user not approved") ||
      lower.includes("not allowed"))
  ) {
    return "This Spotify account is not enabled for this app yet. In Development Mode, the app owner must add users in Spotify Dashboard > Users and Access.";
  }

  if (lower.includes("invalid redirect uri") || lower.includes("redirect uri")) {
    return "Spotify redirect URI mismatch. Use the exact same HTTPS callback URL in app settings and this server config.";
  }

  if (lower.includes("insufficient client scope") || lower.includes("insufficient scope")) {
    return "Spotify permission scope is missing. Re-authorize and approve all requested permissions.";
  }

  if (lower.includes("spotify api") && lower.includes("failed (403)")) {
    const hint =
      "This Spotify account is not enabled for this app in Spotify Developer Dashboard (Users and Access), or this endpoint is restricted in Development Mode.";
    const next =
      "Use hosted default app access by adding the user to allowlist, or let the user save their own app keys.";
    return `${hint} ${next}`;
  }

  if (lower.includes("token exchange failed") || lower.includes("token refresh failed")) {
    return "Spotify authorization failed. Reconnect Spotify and confirm redirect URI/scopes are correct.";
  }

  return text || "Spotify request failed.";
}

function buildSyncOptions(body) {
  const preset = pickPreset(body.preset);
  const { artistList, genreList } = parseArtistsAndGenres({
    artists: body.artists,
    genres: body.genres
  });
  const excludeArtistList = parseCsv(body.excludeArtists);

  const limit = Number(body.limit ?? preset?.limit ?? 30);
  const perQuery = Number(body.perQuery ?? 25);
  const maxQueries = Number(body.maxQueries ?? 12);
  const mode = String(body.mode || preset?.mode || "replace").toLowerCase();
  const discoveryLevel = clampInteger(
    body.discoveryLevel ?? preset?.discoveryLevel ?? 60,
    0,
    100,
    60
  );
  const maxPerArtist = clampInteger(
    body.maxPerArtist ?? preset?.maxPerArtist ?? (discoveryLevel >= 70 ? 2 : 3),
    1,
    10,
    discoveryLevel >= 70 ? 2 : 3
  );
  const strictExplore = parseBoolean(
    body.strictExplore,
    Boolean(preset?.strictExplore)
  );
  const seedSong = String(body.seedSong || "").trim();

  return {
    name: body.name || preset?.name || "AI Playlist",
    prompt: body.prompt || preset?.prompt || "groove-focused discovery",
    seedSong,
    artistList: mergeUnique([...(preset?.artists || []), ...artistList]),
    genreList: mergeUnique([...(preset?.genres || []), ...genreList]),
    excludeArtistList: mergeUnique(excludeArtistList),
    limit: Number.isFinite(limit) ? limit : 30,
    mode: mode === "append" ? "append" : "replace",
    discoveryLevel,
    maxPerArtist,
    strictExplore,
    reuseExisting: parseBoolean(body.reuseExisting, true),
    isPublic: parseBoolean(body.isPublic, Boolean(preset?.isPublic)),
    description: body.description,
    perQuery: Number.isFinite(perQuery)
      ? Math.max(1, Math.min(SEARCH_LIMIT_MAX, Math.trunc(perQuery)))
      : Math.min(10, SEARCH_LIMIT_MAX),
    maxQueries: Number.isFinite(maxQueries)
      ? Math.max(1, Math.min(30, Math.trunc(maxQueries)))
      : 12,
    dryRun: body.dryRun === true
  };
}

async function handleStatus(req, res) {
  const sessionId = readSessionId(req);
  if (!sessionId) {
    sendJson(res, 200, { authenticated: false });
    return;
  }
  const spotify = getSpotifyClientForSession(sessionId);
  if (!spotify.isAuthorized()) {
    sendJson(res, 200, { authenticated: false });
    return;
  }

  try {
    const me = await spotify.getCurrentUser();
    sendJson(res, 200, {
      authenticated: true,
      user: {
        id: me.id,
        displayName: me.display_name || me.id
      }
    });
  } catch (err) {
    sendJson(res, 200, {
      authenticated: false,
      error: `Auth invalid: ${explainSpotifyIntegrationError(err.message)}`
    });
  }
}

function handlePresets(_req, res) {
  sendJson(res, 200, { presets: PRESETS });
}

function handleClientConfigGet(req, res) {
  const sessionId = ensureSessionId(req, res);
  setSessionCookie(req, res, sessionId);
  sendJson(res, 200, getClientConfigSummary(sessionId, req));
}

async function handleClientConfigSave(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "client-config-save", max: 30 })) {
    return;
  }
  try {
    const body = await readJsonBody(req);
    const sessionId = requireSessionHeader(req, res);
    if (!sessionId) return;
    setSessionCookie(req, res, sessionId);
    const clientId = String(body.clientId || "").trim();
    const clientSecret = String(body.clientSecret || "").trim();
    const authMode = normalizeAuthMode(body.authMode, config.authMode);

    if (!clientId) {
      sendJson(res, 400, { error: "Client ID is required." });
      return;
    }
    if (authMode === "standard" && !clientSecret) {
      sendJson(res, 400, { error: "Client secret is required for standard mode." });
      return;
    }

    const filePath = sessionClientConfigFile(sessionId);
    const payload = {
      clientId,
      clientSecret,
      authMode,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      // Ignore platform/filesystem permission limitations.
    }

    // Credentials changed; force re-auth with fresh token for this session config.
    removeFileIfExists(sessionAuthFile(sessionId));
    sendJson(res, 200, getClientConfigSummary(sessionId, req));
  } catch (err) {
    sendJson(res, 400, { error: explainSpotifyIntegrationError(err.message) });
  }
}

function handleClientConfigClear(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "client-config-clear", max: 30 })) {
    return;
  }
  const sessionId = requireSessionHeader(req, res);
  if (!sessionId) return;
  setSessionCookie(req, res, sessionId);
  removeFileIfExists(sessionClientConfigFile(sessionId));
  removeFileIfExists(sessionAuthFile(sessionId));
  sendJson(res, 200, getClientConfigSummary(sessionId, req));
}

async function handleSync(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "sync", max: 24 })) {
    return;
  }
  const sessionId = requireSessionHeader(req, res);
  if (!sessionId) return;
  setSessionCookie(req, res, sessionId);
  const spotify = getSpotifyClientForSession(sessionId);
  if (!spotify.isAuthorized()) {
    sendJson(res, 401, { error: "Not authorized. Connect Spotify first." });
    return;
  }

  try {
    const body = await readJsonBody(req);
    const options = buildSyncOptions(body);
    const result = await syncPlaylist(spotify, options);

    sendJson(res, 200, {
      ...result,
      selected: result.selected.slice(0, 50).map((track) => ({
        id: track.id,
        uri: track.uri,
        name: track.name,
        artists: (track.artists || []).map((a) => a.name),
        url: track.external_urls?.spotify
      }))
    });
  } catch (err) {
    sendJson(res, 400, { error: explainSpotifyIntegrationError(err.message) });
  }
}

async function handleAuthLogin(_req, res) {
  cleanupExpiredStates();
  const req = _req;
  if (!enforceRateLimit(req, res, { bucket: "auth-login", max: 18 })) {
    return;
  }
  const sessionId = ensureSessionId(req, res);
  setSessionCookie(req, res, sessionId);
  try {
    const authorizationUrl = createAuthorizationUrlForSession(req, sessionId);
    redirect(res, authorizationUrl);
  } catch (err) {
    sendText(res, 400, `${err.message}. Use https://YOUR_HOST/callback in Spotify app settings.`);
  }
}

async function handleAuthLoginUrl(req, res) {
  cleanupExpiredStates();
  if (!enforceRateLimit(req, res, { bucket: "auth-login", max: 18 })) {
    return;
  }
  const sessionId = requireSessionHeader(req, res);
  if (!sessionId) return;
  setSessionCookie(req, res, sessionId);

  try {
    const authorizationUrl = createAuthorizationUrlForSession(req, sessionId);
    sendJson(res, 200, { authorizationUrl });
  } catch (err) {
    sendJson(res, 400, {
      error: `${err.message}. Use https://YOUR_HOST/callback in Spotify app settings.`
    });
  }
}

async function handleAuthCallback(req, reqUrl, res) {
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  const error = reqUrl.searchParams.get("error");
  const errorDescription = reqUrl.searchParams.get("error_description");

  if (error) {
    const description = String(errorDescription || "").replace(/\+/g, " ").trim();
    const combined = description ? `${error}: ${description}` : error;
    redirectToApp(res, {
      auth_error: explainSpotifyIntegrationError(combined)
    });
    return;
  }

  const stateValue = state ? stateStore.get(state) : null;
  const stateExpired = stateValue
    ? Date.now() - stateValue.createdAt > STATE_TTL_MS
    : true;
  if (!code || !state || !stateValue || stateExpired) {
    if (state) {
      stateStore.delete(state);
    }
    redirectToApp(res, {
      auth_error: "Spotify login expired or is invalid. Click Authorize Spotify and try again."
    });
    return;
  }

  stateStore.delete(state);
  const sessionId = stateValue.sessionId;
  const spotify = getSpotifyClientForSession(sessionId, {
    redirectUri: stateValue.redirectUri || config.redirectUri
  });

  try {
    await spotify.authenticateWithCode(code, {
      codeVerifier: stateValue.codeVerifier || undefined
    });
    setSessionCookie(req, res, sessionId);
    redirectToApp(res, { connected: "1" });
  } catch (err) {
    redirectToApp(res, {
      auth_error: explainSpotifyIntegrationError(err.message)
    });
  }
}

function handleAuthLogout(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "auth-logout", max: 20 })) {
    return;
  }
  const sessionId = readSessionId(req);
  if (sessionId) {
    removeFileIfExists(sessionAuthFile(sessionId));
    removeFileIfExists(sessionClientConfigFile(sessionId));
  }
  clearSessionCookie(req, res);
  redirect(res, "/?logged_out=1");
}

function handleAuthLogoutApi(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "auth-logout", max: 20 })) {
    return;
  }
  const sessionId = requireSessionHeader(req, res);
  if (!sessionId) return;
  removeFileIfExists(sessionAuthFile(sessionId));
  removeFileIfExists(sessionClientConfigFile(sessionId));
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}

function serveStatic(reqUrl, res) {
  const pathname = reqUrl.pathname === "/" ? "/index.html" : reqUrl.pathname;
  const requestedPath = path.normalize(path.join(WEB_ROOT, pathname));
  if (!requestedPath.startsWith(WEB_ROOT)) {
    sendText(res, 403, "Forbidden");
    return;
  }

  if (!fs.existsSync(requestedPath) || fs.statSync(requestedPath).isDirectory()) {
    sendText(res, 404, "Not found");
    return;
  }

  const ext = path.extname(requestedPath);
  const contentType = MIME_TYPES[ext] || "application/octet-stream";
  applySecurityHeaders(res);
  const cacheControl =
    ext === ".html"
      ? "no-store"
      : "public, max-age=3600";
  res.writeHead(200, {
    "Content-Type": contentType,
    "Cache-Control": cacheControl
  });
  fs.createReadStream(requestedPath).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);
  const normalizedPath = normalizePathname(reqUrl.pathname);
  applyTransportSecurityHeaders(req, res);

  const proto = requestProto(req);
  const host = requestHost(req);
  if (proto === "http" && host && !isLoopbackHost(hostToHostname(host))) {
    const httpsLocation = `https://${host}${reqUrl.pathname}${reqUrl.search}`;
    redirect(res, httpsLocation);
    return;
  }

  // Hard cap early to reduce abuse surface.
  if (!enforceRateLimit(req, res, { bucket: "all-requests", max: 600 })) {
    return;
  }

  if (req.method === "GET" && normalizedPath === "/api/status") {
    await handleStatus(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/api/presets") {
    handlePresets(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/api/client-config") {
    handleClientConfigGet(req, res);
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/client-config") {
    await handleClientConfigSave(req, res);
    return;
  }

  if (req.method === "DELETE" && normalizedPath === "/api/client-config") {
    handleClientConfigClear(req, res);
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/sync") {
    await handleSync(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/api/auth/login-url") {
    await handleAuthLoginUrl(req, res);
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/auth/logout") {
    handleAuthLogoutApi(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/auth/login") {
    await handleAuthLogin(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/auth/logout") {
    handleAuthLogout(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/auth/callback") {
    await handleAuthCallback(req, reqUrl, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === normalizePathname(CALLBACK_PATH)) {
    await handleAuthCallback(req, reqUrl, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(reqUrl, res);
    return;
  }

  sendText(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Spotify Playlist Manager running at http://${HOST}:${PORT}`);
  console.log(`Spotify redirect URI in use: ${config.redirectUri}`);
  console.log(`Session storage: ${SESSION_DIR}`);
  if (CALLBACK_PATH !== "/auth/callback") {
    console.log(`Callback path mapped to: ${CALLBACK_PATH}`);
  }
});
