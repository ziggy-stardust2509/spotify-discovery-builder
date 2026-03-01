import fs from "node:fs";
import path from "node:path";

function parseIntOr(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvFile(contents) {
  const result = {};
  const lines = contents.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    const rawValue = trimmed.slice(eq + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, "");
    result[key] = value;
  }
  return result;
}

export function loadDotEnv(envPath = path.resolve(process.cwd(), ".env")) {
  if (!fs.existsSync(envPath)) return;
  const parsed = parseEnvFile(fs.readFileSync(envPath, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return value;
}

export function getConfig() {
  loadDotEnv();
  const authMode = String(process.env.SPOTIFY_AUTH_MODE || "pkce").trim().toLowerCase();
  const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || "";
  if (!["pkce", "standard"].includes(authMode)) {
    throw new Error("SPOTIFY_AUTH_MODE must be 'pkce' or 'standard'.");
  }
  if (authMode === "standard" && !clientSecret) {
    throw new Error("SPOTIFY_CLIENT_SECRET is required when SPOTIFY_AUTH_MODE=standard.");
  }

  return {
    clientId: requireEnv("SPOTIFY_CLIENT_ID"),
    clientSecret,
    authMode,
    redirectUri:
      process.env.SPOTIFY_REDIRECT_URI || "http://127.0.0.1:8888/callback",
    scopes:
      process.env.SPOTIFY_SCOPES ||
      [
        "user-read-private",
        "user-library-read",
        "playlist-modify-public",
        "playlist-modify-private",
        "playlist-read-private"
      ].join(" "),
    searchMarket: process.env.SPOTIFY_SEARCH_MARKET || "US",
    searchLimitMax: Math.max(1, Math.min(50, parseIntOr(process.env.SPOTIFY_SEARCH_LIMIT_MAX, 10))),
    youtubeApiKey: String(process.env.YOUTUBE_API_KEY || "").trim(),
    youtubeRegion: String(process.env.YOUTUBE_REGION || "US").trim().toUpperCase(),
    youtubeMaxSearchResults: Math.max(
      1,
      Math.min(10, parseIntOr(process.env.YOUTUBE_MAX_SEARCH_RESULTS, 5))
    ),
    authFile: path.resolve(
      process.cwd(),
      process.env.SPOTIFY_AUTH_FILE || ".spotify-auth.json"
    )
  };
}
