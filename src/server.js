#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { URL } from "node:url";
import { getConfig } from "./config.js";
import { PRESETS, parseArtistsAndGenres, syncPlaylist } from "./playlistManager.js";
import { SpotifyClient } from "./spotify.js";
import { YouTubeClient, buildSearchLinkFallback } from "./youtube.js";
import { YouTubeOAuthClient } from "./youtubeOAuth.js";

function parseUrlOrNull(value) {
  const text = String(value || "").trim();
  if (!text) return null;
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

function normalizeBasePath(value) {
  const text = String(value || "").trim();
  if (!text || text === "/") return "";
  const withLeadingSlash = text.startsWith("/") ? text : `/${text}`;
  const normalized = withLeadingSlash.replace(/\/+$/, "");
  return normalized || "";
}

const config = getConfig();
const redirectTarget = new URL(config.redirectUri);
const youtubeRedirectTarget = parseUrlOrNull(config.youtubeAuthRedirectUri);

const APP_BASE_PATH = normalizeBasePath(process.env.SPM_BASE_PATH || "/spotifried");
const PUBLIC_BASE_PATH = normalizeBasePath(
  process.env.SPM_PUBLIC_BASE_PATH || APP_BASE_PATH
);
const REDIRECT_ROOT_TO_BASE =
  APP_BASE_PATH &&
  String(process.env.SPM_REDIRECT_ROOT_TO_BASE || "false").trim().toLowerCase() === "true";
const HOST = process.env.HOST || redirectTarget.hostname || "127.0.0.1";
const PORT = Number(process.env.PORT || redirectTarget.port || 3000);
const CALLBACK_PATH = redirectTarget.pathname || "/callback";
const YOUTUBE_CALLBACK_PATH =
  youtubeRedirectTarget?.pathname || `${APP_BASE_PATH}/auth/youtube/callback`;
const HOSTED_SPOTIFY_APP_ENABLED =
  String(process.env.SPM_ENABLE_HOSTED_SPOTIFY_APP || "").trim().toLowerCase() === "true";
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
const youtubeStateStore = new Map();
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
      "connect-src 'self' https://api.spotify.com https://accounts.spotify.com https://www.googleapis.com https://oauth2.googleapis.com",
      "img-src 'self' data: https:",
      "style-src 'self' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com",
      "script-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self' https://accounts.spotify.com https://accounts.google.com"
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
  const target = withPublicBasePath(suffix ? `/?${suffix}` : "/");
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
  if (forced) return normalizeRedirectUriForBasePath(forced, CALLBACK_ROUTE_PATH);

  const host = requestHost(req);
  if (!host) {
    return normalizeRedirectUriForBasePath(config.redirectUri, CALLBACK_ROUTE_PATH);
  }
  const proto = requestProto(req);
  const callbackPath = withPublicBasePath(CALLBACK_ROUTE_PATH);
  const candidate = `${proto}://${host}${callbackPath}`;
  const isPublicHttp = proto !== "https" && !isLoopbackHost(hostToHostname(host));
  if (isPublicHttp) {
    // If proxy headers are missing, prefer configured secure callback over rejecting auth.
    try {
      const configured = new URL(config.redirectUri);
      if (configured.protocol === "https:") {
        return normalizeRedirectUriForBasePath(config.redirectUri, CALLBACK_ROUTE_PATH);
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

function requireSessionId(req, res) {
  const sessionId = readSessionId(req);
  if (!sessionId) {
    sendJson(res, 400, {
      error: "Missing session. Reload the page and try again."
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

function sessionYouTubeAuthFile(sessionId) {
  return path.join(SESSION_DIR, `${sessionId}.youtube.json`);
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

function assertSpotifyClientConfigForSession(sessionId) {
  if (HOSTED_SPOTIFY_APP_ENABLED) return;
  if (readSessionClientConfig(sessionId)) return;
  throw new Error(
    "Hosted Spotify app login is disabled. Enter your own Spotify Client ID in Optional Advanced connection settings."
  );
}

function getClientConfigSummary(sessionId, req) {
  const sessionConfig = readSessionClientConfig(sessionId);
  const hasCustom = Boolean(sessionConfig);
  const effective = buildSessionSpotifyConfig(sessionId);
  const webRedirectUri = buildWebRedirectUri(req);
  const source = hasCustom
    ? "session"
    : HOSTED_SPOTIFY_APP_ENABLED
      ? "server"
      : "required_user";
  return {
    source,
    clientId: hasCustom || HOSTED_SPOTIFY_APP_ENABLED ? effective.clientId : "",
    authMode: hasCustom || HOSTED_SPOTIFY_APP_ENABLED ? effective.authMode : "pkce",
    hasClientSecret: hasCustom || HOSTED_SPOTIFY_APP_ENABLED
      ? Boolean(effective.clientSecret)
      : false,
    basePath: PUBLIC_BASE_PATH,
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

function withAppBasePath(pathname) {
  const normalized = normalizePathname(pathname);
  if (!APP_BASE_PATH) return normalized;
  if (normalized === APP_BASE_PATH || normalized.startsWith(`${APP_BASE_PATH}/`)) {
    return normalized;
  }
  if (normalized === "/") return `${APP_BASE_PATH}/`;
  return `${APP_BASE_PATH}${normalized}`;
}

function withPublicBasePath(pathname) {
  const normalized = normalizePathname(pathname);
  if (!PUBLIC_BASE_PATH) return normalized;
  if (normalized === PUBLIC_BASE_PATH || normalized.startsWith(`${PUBLIC_BASE_PATH}/`)) {
    return normalized;
  }
  if (normalized === "/") return `${PUBLIC_BASE_PATH}/`;
  return `${PUBLIC_BASE_PATH}${normalized}`;
}

function stripBasePath(pathname, basePath) {
  const normalized = normalizePathname(pathname);
  const normalizedBase = normalizeBasePath(basePath);
  if (!normalizedBase) return null;
  if (normalized === normalizedBase) return "/";
  if (normalized.startsWith(`${normalizedBase}/`)) {
    return normalized.slice(normalizedBase.length) || "/";
  }
  return null;
}

function stripAppBasePath(pathname) {
  return stripBasePath(pathname, APP_BASE_PATH);
}

function stripPublicBasePath(pathname) {
  return stripBasePath(pathname, PUBLIC_BASE_PATH);
}

function callbackRoutePath(pathname) {
  const normalized = normalizePathname(pathname);
  const appStripped = stripAppBasePath(normalized);
  if (appStripped) return appStripped;
  const publicStripped = stripPublicBasePath(normalized);
  if (publicStripped) return publicStripped;
  return normalized;
}

const CALLBACK_ROUTE_PATH = callbackRoutePath(CALLBACK_PATH);
const YOUTUBE_CALLBACK_ROUTE_PATH = callbackRoutePath(YOUTUBE_CALLBACK_PATH);

function normalizeRedirectUriForBasePath(value, callbackRoutePathValue = CALLBACK_ROUTE_PATH) {
  const text = String(value || "").trim();
  if (!text || !PUBLIC_BASE_PATH) return text;
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    return text;
  }
  const currentPath = normalizePathname(parsed.pathname);
  const baseCallbackPath = withPublicBasePath(callbackRoutePathValue);
  if (currentPath === callbackRoutePathValue && currentPath !== baseCallbackPath) {
    parsed.pathname = baseCallbackPath;
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  }
  return text;
}

function cleanupExpiredStates() {
  const now = Date.now();
  for (const [state, value] of stateStore.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      stateStore.delete(state);
    }
  }
  for (const [state, value] of youtubeStateStore.entries()) {
    if (now - value.createdAt > STATE_TTL_MS) {
      youtubeStateStore.delete(state);
    }
  }
}

function buildYouTubeRedirectUri(req) {
  const configured = String(config.youtubeAuthRedirectUri || "").trim();
  if (configured) {
    return normalizeRedirectUriForBasePath(configured, YOUTUBE_CALLBACK_ROUTE_PATH);
  }

  const host = requestHost(req);
  const youtubeCallbackPath = withPublicBasePath(YOUTUBE_CALLBACK_ROUTE_PATH);
  if (!host) {
    return `http://${HOST}:${PORT}${youtubeCallbackPath}`;
  }
  const proto = requestProto(req);
  if (proto !== "https" && !isLoopbackHost(hostToHostname(host))) {
    return `https://${host}${youtubeCallbackPath}`;
  }
  return `${proto}://${host}${youtubeCallbackPath}`;
}

function createAuthorizationUrlForSession(req, sessionId) {
  assertSpotifyClientConfigForSession(sessionId);
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

function createYouTubeAuthorizationUrlForSession(req, sessionId) {
  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = buildYouTubeRedirectUri(req);
  assertSafeRedirectUri(redirectUri);
  const youtube = new YouTubeOAuthClient({
    ...config,
    redirectUri,
    authFile: sessionYouTubeAuthFile(sessionId)
  });
  if (!youtube.isConfigured()) {
    throw new Error(
      "YouTube account save is not configured on this server. Missing YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, or YOUTUBE_OAUTH_REDIRECT_URI."
    );
  }
  youtubeStateStore.set(state, {
    createdAt: Date.now(),
    sessionId,
    redirectUri
  });
  return youtube.getAuthorizationUrl(state);
}

function shouldReauthorizeYouTube(errorMessage) {
  const text = String(errorMessage || "").toLowerCase();
  return (
    text.includes("no youtube refresh token") ||
    text.includes("invalid_grant") ||
    text.includes("token refresh failed") ||
    text.includes("token exchange failed") ||
    text.includes("unauthenticated") ||
    text.includes("access token")
  );
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

function sanitizeYouTubeTracks(value) {
  if (!Array.isArray(value)) return [];
  const tracks = [];
  for (const item of value) {
    const name = String(item?.name || "").trim();
    if (!name) continue;
    const artists = Array.isArray(item?.artists)
      ? item.artists
          .map((artist) => String(artist || "").trim())
          .filter(Boolean)
          .slice(0, 5)
      : String(item?.artists || "")
          .split(",")
          .map((artist) => artist.trim())
          .filter(Boolean)
          .slice(0, 5);
    tracks.push({ name, artists });
    if (tracks.length >= 50) break;
  }
  return tracks;
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

  if (
    lower.includes("user may not be registered") ||
    lower.includes("check settings on developer.spotify.com/dashboard")
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
    const next = "Use your own Spotify app keys or ask app admin to allowlist your account.";
    return `${hint} ${next}`;
  }

  if (lower.includes("token exchange failed") || lower.includes("token refresh failed")) {
    if (lower.includes("invalid_client") || lower.includes("invalid client")) {
      return "Invalid Spotify app credentials. For PKCE, use Client ID only and leave Client Secret blank. For Standard mode, ensure Client ID and Client Secret match the same Spotify app.";
    }
    if (lower.includes("code_verifier") || lower.includes("code verifier")) {
      return "PKCE verification failed. Start authorization again from this tab and complete Spotify login without reopening old callback links.";
    }
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
    const sessionId = requireSessionId(req, res);
    if (!sessionId) return;
    setSessionCookie(req, res, sessionId);
    const clientId = String(body.clientId || "").trim();
    const authMode = normalizeAuthMode(body.authMode, config.authMode);
    const clientSecretInput = String(body.clientSecret || "").trim();
    const clientSecret = authMode === "standard" ? clientSecretInput : "";

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
  const sessionId = requireSessionId(req, res);
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
  const sessionId = requireSessionId(req, res);
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

async function handleYouTubePlaylist(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "youtube-playlist", max: 12 })) {
    return;
  }
  try {
    const body = await readJsonBody(req);
    const tracks = sanitizeYouTubeTracks(body?.tracks);
    if (!tracks.length) {
      sendJson(res, 400, { error: "No tracks available. Build a playlist first." });
      return;
    }

    const youtube = new YouTubeClient(config);
    const result = youtube.isConfigured()
      ? await youtube.createInstantPlaylist(tracks, {
          name: body?.name
        })
      : buildSearchLinkFallback(tracks, {
          name: body?.name
        });
    sendJson(res, 200, result);
  } catch (err) {
    sendJson(res, 400, { error: explainSpotifyIntegrationError(err.message) });
  }
}

async function handleYouTubeCreatePlaylist(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "youtube-save-playlist", max: 12 })) {
    return;
  }
  const sessionId = ensureSessionId(req, res);
  setSessionCookie(req, res, sessionId);

  let tracks = [];
  let requestedName = "Discovery Mix";
  try {
    const body = await readJsonBody(req);
    tracks = sanitizeYouTubeTracks(body?.tracks);
    requestedName = String(body?.name || "Discovery Mix").trim() || "Discovery Mix";
  } catch (err) {
    sendJson(res, 400, { error: explainSpotifyIntegrationError(err.message) });
    return;
  }

  if (!tracks.length) {
    sendJson(res, 400, { error: "No tracks available. Build a playlist first." });
    return;
  }

  let youtube;
  try {
    const redirectUri = buildYouTubeRedirectUri(req);
    assertSafeRedirectUri(redirectUri);
    youtube = new YouTubeOAuthClient({
      ...config,
      redirectUri,
      authFile: sessionYouTubeAuthFile(sessionId)
    });
  } catch (err) {
    sendJson(res, 400, { error: explainSpotifyIntegrationError(err.message) });
    return;
  }

  if (!youtube.isConfigured()) {
    sendJson(res, 400, {
      error:
        "YouTube account save is not configured on this server. Ask admin to set YOUTUBE_CLIENT_ID, YOUTUBE_CLIENT_SECRET, and YOUTUBE_OAUTH_REDIRECT_URI."
    });
    return;
  }

  if (!youtube.isAuthorized()) {
    try {
      const authUrl = createYouTubeAuthorizationUrlForSession(req, sessionId);
      sendJson(res, 401, {
        error: "Connect YouTube first to save playlists to your account.",
        authUrl
      });
    } catch (err) {
      sendJson(res, 400, { error: explainSpotifyIntegrationError(err.message) });
    }
    return;
  }

  try {
    const result = await youtube.createPlaylistFromTracks(tracks, {
      name: requestedName
    });
    sendJson(res, 200, result);
  } catch (err) {
    const message = explainSpotifyIntegrationError(err.message);
    if (shouldReauthorizeYouTube(err.message)) {
      removeFileIfExists(sessionYouTubeAuthFile(sessionId));
      try {
        const authUrl = createYouTubeAuthorizationUrlForSession(req, sessionId);
        sendJson(res, 401, {
          error: "YouTube session expired. Reconnect YouTube to continue.",
          authUrl
        });
        return;
      } catch {
        // Fall through and return original error.
      }
    }
    sendJson(res, 400, { error: message });
  }
}

async function handleYouTubeAuthLogin(req, res) {
  cleanupExpiredStates();
  if (!enforceRateLimit(req, res, { bucket: "youtube-auth-login", max: 18 })) {
    return;
  }
  const sessionId = ensureSessionId(req, res);
  setSessionCookie(req, res, sessionId);
  try {
    const authorizationUrl = createYouTubeAuthorizationUrlForSession(req, sessionId);
    redirect(res, authorizationUrl);
  } catch (err) {
    redirectToApp(res, {
      youtube_auth_error: explainSpotifyIntegrationError(err.message)
    });
  }
}

async function handleYouTubeAuthCallback(req, reqUrl, res) {
  const code = reqUrl.searchParams.get("code");
  const state = reqUrl.searchParams.get("state");
  const error = reqUrl.searchParams.get("error");
  const errorDescription = reqUrl.searchParams.get("error_description");

  if (error) {
    const detail = String(errorDescription || "").replace(/\+/g, " ").trim();
    const combined = detail ? `${error}: ${detail}` : error;
    redirectToApp(res, {
      youtube_auth_error: explainSpotifyIntegrationError(combined)
    });
    return;
  }

  const stateValue = state ? youtubeStateStore.get(state) : null;
  const stateExpired = stateValue
    ? Date.now() - stateValue.createdAt > STATE_TTL_MS
    : true;
  if (!code || !state || !stateValue || stateExpired) {
    if (state) youtubeStateStore.delete(state);
    redirectToApp(res, {
      youtube_auth_error: "YouTube login expired or is invalid. Try Connect YouTube again."
    });
    return;
  }

  youtubeStateStore.delete(state);
  const sessionId = stateValue.sessionId;
  const youtube = new YouTubeOAuthClient({
    ...config,
    redirectUri: stateValue.redirectUri || buildYouTubeRedirectUri(req),
    authFile: sessionYouTubeAuthFile(sessionId)
  });
  try {
    await youtube.exchangeCodeForToken(code);
    setSessionCookie(req, res, sessionId);
    redirectToApp(res, { youtube_connected: "1" });
  } catch (err) {
    redirectToApp(res, {
      youtube_auth_error: explainSpotifyIntegrationError(err.message)
    });
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
    sendText(
      res,
      400,
      `${err.message}. Use https://YOUR_HOST${withPublicBasePath("/callback")} in Spotify app settings.`
    );
  }
}

async function handleAuthLoginUrl(req, res) {
  cleanupExpiredStates();
  if (!enforceRateLimit(req, res, { bucket: "auth-login", max: 18 })) {
    return;
  }
  const sessionId = ensureSessionId(req, res);
  if (!sessionId) return;
  setSessionCookie(req, res, sessionId);

  try {
    const authorizationUrl = createAuthorizationUrlForSession(req, sessionId);
    sendJson(res, 200, { authorizationUrl });
  } catch (err) {
    sendJson(res, 400, {
      error: `${err.message}. Use https://YOUR_HOST${withPublicBasePath("/callback")} in Spotify app settings.`
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
    removeFileIfExists(sessionYouTubeAuthFile(sessionId));
  }
  clearSessionCookie(req, res);
  redirectToApp(res, { logged_out: "1" });
}

function handleAuthLogoutApi(req, res) {
  if (!enforceRateLimit(req, res, { bucket: "auth-logout", max: 20 })) {
    return;
  }
  const sessionId = requireSessionId(req, res);
  if (!sessionId) return;
  removeFileIfExists(sessionAuthFile(sessionId));
  removeFileIfExists(sessionClientConfigFile(sessionId));
  removeFileIfExists(sessionYouTubeAuthFile(sessionId));
  clearSessionCookie(req, res);
  sendJson(res, 200, { ok: true });
}

function serveStatic(pathname, res) {
  const staticPathname = pathname === "/" ? "/index.html" : pathname;
  const requestedPath = path.normalize(path.join(WEB_ROOT, staticPathname));
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
  const rawPath = normalizePathname(reqUrl.pathname);
  const pathWithinBase = stripAppBasePath(rawPath);
  const normalizedPath = pathWithinBase || rawPath;
  const spotifyCallbackPath = CALLBACK_ROUTE_PATH;
  const youtubeCallbackPath = YOUTUBE_CALLBACK_ROUTE_PATH;
  const callbackState = reqUrl.searchParams.get("state");
  const hasSpotifyState = Boolean(callbackState && stateStore.has(callbackState));
  const hasYouTubeState = Boolean(callbackState && youtubeStateStore.has(callbackState));
  const callbacksSharePath = spotifyCallbackPath === youtubeCallbackPath;
  applyTransportSecurityHeaders(req, res);

  const forceHttpsRedirect = process.env.SPM_FORCE_HTTPS_REDIRECT === "true";
  const proto = requestProto(req);
  const host = requestHost(req);
  const forwardedProto = firstForwardedHeaderValue(req.headers["x-forwarded-proto"]).toLowerCase();
  const forwardedHost = firstForwardedHeaderValue(req.headers["x-forwarded-host"]);
  const isProxiedRequest = Boolean(forwardedProto || forwardedHost);
  const canForceHttpsRedirect = !isProxiedRequest || forwardedProto === "http";

  if (
    forceHttpsRedirect &&
    proto === "http" &&
    host &&
    !isLoopbackHost(hostToHostname(host)) &&
    canForceHttpsRedirect
  ) {
    // Keep this opt-in because many shared-host proxies omit forwarded headers.
    const httpsLocation = `https://${host}${reqUrl.pathname}${reqUrl.search}`;
    redirect(res, httpsLocation);
    return;
  }

  if (APP_BASE_PATH && (rawPath === "/" || rawPath === "/index.html")) {
    if (REDIRECT_ROOT_TO_BASE) {
      redirect(res, withPublicBasePath("/"));
      return;
    }
    sendText(res, 404, `Not found. Use ${withPublicBasePath("/")}`);
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

  if (req.method === "POST" && normalizedPath === "/api/youtube/playlist") {
    await handleYouTubePlaylist(req, res);
    return;
  }

  if (req.method === "POST" && normalizedPath === "/api/youtube/create-playlist") {
    await handleYouTubeCreatePlaylist(req, res);
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

  if (req.method === "GET" && normalizedPath === "/auth/youtube/login") {
    await handleYouTubeAuthLogin(req, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === youtubeCallbackPath) {
    if (callbacksSharePath && !hasYouTubeState && hasSpotifyState) {
      await handleAuthCallback(req, reqUrl, res);
      return;
    }
    if (callbacksSharePath && !hasYouTubeState && !hasSpotifyState) {
      await handleAuthCallback(req, reqUrl, res);
      return;
    }
    await handleYouTubeAuthCallback(req, reqUrl, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === "/auth/callback") {
    await handleAuthCallback(req, reqUrl, res);
    return;
  }

  if (req.method === "GET" && normalizedPath === spotifyCallbackPath) {
    if (callbacksSharePath && hasYouTubeState && !hasSpotifyState) {
      await handleYouTubeAuthCallback(req, reqUrl, res);
      return;
    }
    await handleAuthCallback(req, reqUrl, res);
    return;
  }

  if (req.method === "GET") {
    serveStatic(normalizedPath, res);
    return;
  }

  sendText(res, 404, "Not found");
});

server.listen(PORT, HOST, () => {
  console.log(`Spotify Playlist Manager running at http://${HOST}:${PORT}`);
  if (APP_BASE_PATH) {
    console.log(`App URL base path: ${APP_BASE_PATH}`);
  }
  if (PUBLIC_BASE_PATH && PUBLIC_BASE_PATH !== APP_BASE_PATH) {
    console.log(`Public URL base path: ${PUBLIC_BASE_PATH}`);
  }
  console.log(`Spotify redirect URI in use: ${config.redirectUri}`);
  console.log(`Expected Spotify callback path: ${withPublicBasePath(CALLBACK_ROUTE_PATH)}`);
  console.log(`Hosted Spotify app login enabled: ${HOSTED_SPOTIFY_APP_ENABLED ? "yes" : "no"}`);
  console.log(`Session storage: ${SESSION_DIR}`);
  if (CALLBACK_PATH !== "/auth/callback") {
    console.log(`Callback path mapped to: ${CALLBACK_PATH}`);
  }
  if (YOUTUBE_CALLBACK_PATH !== "/auth/youtube/callback") {
    console.log(`YouTube callback path mapped to: ${YOUTUBE_CALLBACK_PATH}`);
  }
  if (REDIRECT_ROOT_TO_BASE) {
    console.log(`Root path redirects to: ${withPublicBasePath("/")}`);
  } else if (APP_BASE_PATH) {
    console.log(`Root path is disabled. Use: ${withPublicBasePath("/")}`);
  }
});
