#!/usr/bin/env node
import { getConfig } from "./config.js";
import { SpotifyClient } from "./spotify.js";
import { PRESETS, parseArtistsAndGenres, syncPlaylist } from "./playlistManager.js";

function parseArgs(argv) {
  const result = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      result._.push(token);
      continue;
    }

    const hasInline = token.includes("=");
    if (hasInline) {
      const [rawKey, ...rest] = token.slice(2).split("=");
      result[rawKey] = rest.join("=");
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      result[key] = next;
      i += 1;
    } else {
      result[key] = true;
    }
  }
  return result;
}

function parseBoolean(value, defaultValue = false) {
  if (value === undefined || value === null) return defaultValue;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  return ["1", "true", "yes", "y", "on"].includes(normalized);
}

function parseNumber(value, fallback) {
  if (value === undefined || value === null) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function printHelp() {
  console.log(`
Spotify Playlist Manager

Usage:
  npm run auth
  npm run sync -- --preset drumming
  npm run sync -- --name "Pocket Architects" --prompt "elastic pocket grooves and left-field fusion" --artists "Yussef Dayes,Nate Smith,Anderson .Paak" --genres "broken beat,jazz fusion,alternative hip hop" --limit 40 --mode replace

Commands:
  auth
    Authorize this app with Spotify and save tokens to .spotify-auth.json.

  sync
    Create or update an AI-managed playlist.

sync options:
  --preset <drumming|discovery|gym>
  --name <playlist name>
  --seed-song <track name|spotify url|spotify uri>
  --prompt <description of vibe/style>
  --artists "Artist A,Artist B"
  --genres "genre1,genre2"
  --limit <number of tracks>
  --mode <replace|append>               default: replace
  --public <true|false>                 default: false
  --description "<playlist description>"
  --per-query <1-50>                    default: 25
  --max-queries <number>                default: 12
  --dry-run                             preview only, no Spotify writes
`);
}

function formatTrack(track) {
  const artists = (track.artists || []).map((a) => a.name).join(", ");
  return `${track.name} - ${artists}`;
}

async function runAuth() {
  const config = getConfig();
  const client = new SpotifyClient(config);
  await client.authorize();
  console.log(`Authorization complete. Token file: ${config.authFile}`);
}

async function runSync(args) {
  const config = getConfig();
  const client = new SpotifyClient(config);

  const presetName = args.preset ? String(args.preset).toLowerCase() : null;
  const preset = presetName ? PRESETS[presetName] : null;
  if (presetName && !preset) {
    throw new Error(
      `Unknown preset "${presetName}". Available presets: ${Object.keys(PRESETS).join(", ")}`
    );
  }

  const { artistList, genreList } = parseArtistsAndGenres({
    artists: args.artists,
    genres: args.genres
  });

  const options = {
    name: args.name || preset?.name || "AI Playlist",
    seedSong: args["seed-song"] || args.song || "",
    prompt: args.prompt || preset?.prompt || "groove-focused discovery",
    artistList: [...(preset?.artists || []), ...artistList],
    genreList: [...(preset?.genres || []), ...genreList],
    limit: parseNumber(args.limit, preset?.limit || 30),
    mode: args.mode || preset?.mode || "replace",
    isPublic: parseBoolean(args.public, preset?.isPublic || false),
    description: args.description,
    perQuery: parseNumber(args["per-query"], 25),
    maxQueries: parseNumber(args["max-queries"], 12),
    dryRun: parseBoolean(args["dry-run"], false)
  };

  const result = await syncPlaylist(client, options);

  console.log(`\nPlaylist: ${result.name}`);
  console.log(`Prompt: ${result.prompt}`);
  console.log(`Mode: ${result.mode}`);
  console.log(`Queries used: ${result.queries.join(" | ")}`);
  if (result.seedTrack?.name) {
    const seedArtists = (result.seedTrack.artists || []).join(", ");
    console.log(`Seed track used: ${result.seedTrack.name}${seedArtists ? ` - ${seedArtists}` : ""}`);
  }

  if (result.dryRun) {
    console.log("\nDry run only (no Spotify writes).");
  } else {
    console.log(`Tracks written: ${result.added}`);
    if (result.playlistUrl) {
      console.log(`Playlist URL: ${result.playlistUrl}`);
    }
  }

  console.log("\nTop selected tracks:");
  for (const track of result.selected.slice(0, 10)) {
    console.log(`- ${formatTrack(track)}`);
  }
}

async function main() {
  const [, , command, ...rest] = process.argv;
  const args = parseArgs(rest);

  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "auth") {
    await runAuth();
    return;
  }

  if (command === "sync") {
    await runSync(args);
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
