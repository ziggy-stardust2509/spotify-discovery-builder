const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "the",
  "to",
  "of",
  "for",
  "with",
  "in",
  "on",
  "at",
  "by",
  "from",
  "my",
  "me",
  "that",
  "this",
  "it",
  "is",
  "are",
  "be"
]);

const LOW_SIGNAL_TOKENS = new Set([
  "music",
  "song",
  "songs",
  "track",
  "tracks",
  "vibe",
  "vibes",
  "style",
  "sound",
  "playlist",
  "mix",
  "best",
  "good",
  "new",
  "latest"
]);

const TITLE_NOISE_HINTS = [
  "karaoke",
  "nightcore",
  "sped up",
  "slowed",
  "8d",
  "tribute",
  "rehearsal",
  "radio edit",
  "clean edit",
  "instrumental"
];

const EXCLUDED_TITLE_HINTS = ["karaoke", "tribute", "8d", "nightcore"];

const TITLE_HINT_ALLOWLIST = ["live", "instrumental", "remix", "edit", "acoustic"];

export const PRESETS = {
  drumming: {
    name: "Pocket Architects",
    prompt:
      "elastic pocket grooves, ghost-note finesse, left-field fusion, broken-beat and hip hop rhythm sections",
    artists: ["Yussef Dayes", "Nate Smith", "Anderson .Paak", "Snarky Puppy", "KNOWER"],
    genres: ["broken beat", "jazz fusion", "neo soul", "alternative hip hop"],
    limit: 40,
    discoveryLevel: 52,
    maxPerArtist: 2,
    strictExplore: false,
    mode: "replace",
    isPublic: false
  },
  discovery: {
    name: "Weekly Discovery",
    prompt: "new music with strong groove, creative rhythm section, modern jazz, soul, alternative hip hop",
    artists: ["Anderson .Paak", "Robert Glasper", "Thundercat"],
    genres: ["alternative hip hop", "jazz fusion", "neo soul"],
    limit: 40,
    discoveryLevel: 80,
    maxPerArtist: 2,
    strictExplore: true,
    mode: "replace",
    isPublic: false
  },
  gym: {
    name: "Gym Rotation",
    prompt: "high energy tracks, driving rhythm, workout focus, upbeat groove",
    artists: ["Run The Jewels", "The Prodigy", "Kanye West"],
    genres: ["hip hop", "drum and bass", "electronic"],
    limit: 50,
    discoveryLevel: 35,
    maxPerArtist: 3,
    strictExplore: false,
    mode: "replace",
    isPublic: false
  }
};

function tokenize(text) {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2 && !STOPWORDS.has(token));
}

function normalizeCsv(input) {
  if (!input) return [];
  return input
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function clampInt(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const rounded = Math.trunc(parsed);
  if (rounded < min) return min;
  if (rounded > max) return max;
  return rounded;
}

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  if (parsed < 0) return 0;
  if (parsed > 1) return 1;
  return parsed;
}

function stableRandomFromString(input) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) / 4294967295;
}

function isHighSignalToken(token) {
  return token.length >= 4 && !LOW_SIGNAL_TOKENS.has(token);
}

function normalizeTrackTitle(title) {
  return String(title || "")
    .toLowerCase()
    .replace(/\([^)]*\)/g, " ")
    .replace(/\[[^\]]*\]/g, " ")
    .replace(/\s+-\s+/g, " ")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractReleaseYear(track) {
  const raw = String(track?.album?.release_date || "").trim();
  if (!raw) return null;
  const match = raw.match(/^(\d{4})/);
  if (!match) return null;
  const year = Number(match[1]);
  if (!Number.isFinite(year)) return null;
  return year;
}

function buildAllowedTitleHints(promptTokens) {
  const set = new Set();
  for (const token of promptTokens) {
    if (TITLE_HINT_ALLOWLIST.includes(token)) {
      set.add(token);
    }
  }
  return set;
}

function countPromptTokenMatches(haystack, tokens) {
  if (!tokens.length) return 0;
  let matches = 0;
  for (const token of tokens) {
    if (haystack.includes(token)) matches += 1;
  }
  return matches;
}

function classifyQuery(query, promptTokens) {
  const normalized = query.toLowerCase();
  const hasArtist = /\bartist:"/.test(normalized);
  const hasGenre = /\bgenre:"/.test(normalized);
  const promptHit = promptTokens.some((token) => normalized.includes(token));
  return {
    hasArtist,
    hasGenre,
    promptHit
  };
}

function createTrace() {
  return {
    hits: 0,
    artistHits: 0,
    genreHits: 0,
    promptHits: 0,
    querySet: new Set()
  };
}

function canonicalTrackKey(track) {
  const normalized = normalizeTrackTitle(track.name || "");
  return normalized
    .replace(/\b(remaster(ed)?|version|edit|live)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function buildSearchQueries({
  prompt,
  artists,
  genres,
  maxQueries = 12,
  discoveryLevel = 50
}) {
  const set = new Set();
  const promptTokens = tokenize(prompt);
  const novelty = clamp01(discoveryLevel / 100);
  const artistCap = novelty >= 0.8 ? Math.min(2, artists.length) : artists.length;

  for (const artist of artists.slice(0, artistCap)) {
    set.add(`artist:"${artist}"`);
    if (promptTokens.length && novelty < 0.75) {
      set.add(`artist:"${artist}" ${promptTokens.slice(0, 4).join(" ")}`);
    }
  }

  for (const genre of genres) {
    set.add(`genre:"${genre}"`);
    if (promptTokens.length) {
      set.add(`genre:"${genre}" ${promptTokens.slice(0, 3).join(" ")}`);
    }
  }

  if (promptTokens.length) {
    set.add(promptTokens.slice(0, 6).join(" "));
    for (let i = 0; i < promptTokens.length - 1 && set.size < maxQueries; i += 1) {
      const pair = `${promptTokens[i]} ${promptTokens[i + 1]}`;
      set.add(pair);
      if (i < promptTokens.length - 2) {
        const triplet = `${promptTokens[i]} ${promptTokens[i + 1]} ${promptTokens[i + 2]}`;
        set.add(triplet);
      }
    }
    if (novelty >= 0.65) {
      for (const token of promptTokens.slice(0, 6)) {
        if (set.size >= maxQueries) break;
        if (isHighSignalToken(token)) {
          set.add(token);
        }
      }
    }
  }

  if (!set.size) {
    set.add("genre:\"indie\"");
  }

  return Array.from(set).slice(0, maxQueries);
}

function trackShouldBeExcluded(track, context) {
  const artistNames = (track.artists || []).map((a) => (a.name || "").toLowerCase());
  const normalizedTitle = normalizeTrackTitle(track.name || "");

  for (const blocked of context.excludeArtistTokens) {
    if (artistNames.some((name) => name.includes(blocked))) return true;
  }
  if (context.strictExplore) {
    for (const seed of context.artistSeedsLower) {
      if (artistNames.some((name) => name.includes(seed))) return true;
    }
  }
  if (!track.name || !artistNames.length) return true;
  for (const hint of EXCLUDED_TITLE_HINTS) {
    if (normalizedTitle.includes(hint) && !context.allowedTitleHints.has(hint)) {
      return true;
    }
  }
  return false;
}

function scoreTrack(track, context) {
  const artistNames = (track.artists || []).map((a) => a.name.toLowerCase());
  const haystack = [
    track.name || "",
    track.album?.name || "",
    ...(track.artists || []).map((a) => a.name || "")
  ]
    .join(" ")
    .toLowerCase();
  const trace = context.traceByUri.get(track.uri) || createTrace();
  const title = normalizeTrackTitle(track.name || "");

  const novelty = clamp01(context.discoveryLevel / 100);
  const familiarity = 1 - novelty;
  const popularity = (track.popularity || 0) / 100;
  const promptMatches = countPromptTokenMatches(haystack, context.promptTokens);
  const promptCoverage = context.promptTokens.length
    ? promptMatches / Math.min(context.promptTokens.length, 8)
    : 0;
  const queryAgreement = Math.log2(1 + trace.hits);
  const queryFamilyCount =
    (trace.artistHits > 0 ? 1 : 0) +
    (trace.genreHits > 0 ? 1 : 0) +
    (trace.promptHits > 0 ? 1 : 0);
  const seedArtistMatches = context.artistSeedsLower.reduce((count, artist) => {
    if (artistNames.some((name) => name.includes(artist))) return count + 1;
    return count;
  }, 0);

  let score = popularity * (0.45 + 0.45 * familiarity);
  score += (1 - popularity) * (0.3 + 0.85 * novelty);
  score += queryAgreement * 0.55;
  score += queryFamilyCount * (0.34 + 0.08 * novelty);
  score += promptMatches * (0.09 + 0.05 * familiarity);
  score += promptCoverage * 0.75;

  score += seedArtistMatches * (1.5 * familiarity);
  score -= seedArtistMatches * (0.95 * novelty);

  for (const hint of TITLE_NOISE_HINTS) {
    if (title.includes(hint) && !context.allowedTitleHints.has(hint)) {
      score -= 0.22;
    }
  }

  const year = extractReleaseYear(track);
  if (year) {
    const recentness = clamp01((year - (context.currentYear - 25)) / 25);
    score += recentness * (0.12 + 0.44 * novelty);
  }

  const durationMs = Number(track.duration_ms || 0);
  if (durationMs > 0) {
    if (durationMs < 90_000) score -= 0.8;
    if (durationMs > 9 * 60_000) score -= 0.16;
  }

  if (track.explicit === false) score += 0.03;
  const randomNudge = stableRandomFromString(track.id || track.uri || track.name || "");
  score += randomNudge * (0.14 * novelty);
  return score;
}

function selectWithDiversity(
  scored,
  limit,
  maxPerArtist,
  { maxPerAlbum = 2, dedupeTitle = true } = {}
) {
  const selected = [];
  const byArtist = new Map();
  const byAlbum = new Map();
  const byTitle = new Set();

  for (const item of scored) {
    const primaryArtist = item.track.artists?.[0]?.id || item.track.artists?.[0]?.name;
    const albumKey = item.track.album?.id || item.track.album?.name || item.track.uri;
    const titleKey = canonicalTrackKey(item.track);
    const count = byArtist.get(primaryArtist) || 0;
    if (count >= maxPerArtist) continue;
    const albumCount = byAlbum.get(albumKey) || 0;
    if (albumCount >= maxPerAlbum) continue;
    if (dedupeTitle && titleKey && byTitle.has(titleKey)) continue;
    selected.push(item.track);
    byArtist.set(primaryArtist, count + 1);
    byAlbum.set(albumKey, albumCount + 1);
    if (titleKey) byTitle.add(titleKey);
    if (selected.length >= limit) return selected;
  }

  for (const item of scored) {
    if (selected.length >= limit) break;
    const titleKey = canonicalTrackKey(item.track);
    if (dedupeTitle && titleKey && byTitle.has(titleKey)) continue;
    if (selected.some((track) => track.uri === item.track.uri)) continue;
    selected.push(item.track);
    if (titleKey) byTitle.add(titleKey);
  }

  return selected;
}

function nowIsoMinute() {
  return new Date().toISOString().replace(/:\d{2}\.\d{3}Z$/, "Z");
}

function defaultDescription(prompt) {
  return `AI-managed playlist. Sync source: "${prompt}". Last sync: ${nowIsoMinute()}`;
}

export function parseArtistsAndGenres({ artists, genres }) {
  return {
    artistList: normalizeCsv(artists),
    genreList: normalizeCsv(genres)
  };
}

export async function buildTrackSelection(client, options) {
  const prompt = options.prompt?.trim() || "groove-focused discovery";
  const artistList = options.artistList || [];
  const genreList = options.genreList || [];
  const excludeArtistList = options.excludeArtistList || [];
  const discoveryLevel = clampInt(options.discoveryLevel, 0, 100, 60);
  const strictExplore = options.strictExplore === true;
  const limit = clampInt(options.limit, 1, 200, 30);
  const perQuery = clampInt(options.perQuery, 1, 50, 10);
  const maxPerArtist = clampInt(
    options.maxPerArtist,
    1,
    10,
    discoveryLevel >= 70 ? 2 : 3
  );

  const queries = buildSearchQueries({
    prompt,
    artists: artistList,
    genres: genreList,
    maxQueries: Number(options.maxQueries || 12),
    discoveryLevel
  });

  const promptTokens = tokenize(prompt);
  const candidateMap = new Map();
  const candidates = [];
  for (const query of queries) {
    const queryKind = classifyQuery(query, promptTokens);
    const result = await client.searchTracks(query, perQuery, 0);
    for (const track of result?.tracks?.items || []) {
      if (!track?.uri) continue;
      candidates.push(track);
      if (!candidateMap.has(track.uri)) {
        candidateMap.set(track.uri, {
          track,
          trace: createTrace()
        });
      }
      const entry = candidateMap.get(track.uri);
      if ((track.popularity || 0) > (entry.track.popularity || 0)) {
        entry.track = track;
      }
      entry.trace.hits += 1;
      if (queryKind.hasArtist) entry.trace.artistHits += 1;
      if (queryKind.hasGenre) entry.trace.genreHits += 1;
      if (queryKind.promptHit || (!queryKind.hasArtist && !queryKind.hasGenre)) {
        entry.trace.promptHits += 1;
      }
      entry.trace.querySet.add(query);
    }
  }

  const deduped = Array.from(candidateMap.values()).map((entry) => entry.track);
  const traceByUri = new Map(
    Array.from(candidateMap.entries()).map(([uri, value]) => [uri, value.trace])
  );
  const context = {
    promptTokens,
    artistSeedsLower: artistList.map((artist) => artist.toLowerCase()),
    excludeArtistTokens: excludeArtistList.map((artist) => artist.toLowerCase()),
    allowedTitleHints: buildAllowedTitleHints(promptTokens),
    traceByUri,
    currentYear: new Date().getUTCFullYear(),
    discoveryLevel,
    strictExplore
  };

  const scored = deduped
    .filter((track) => !trackShouldBeExcluded(track, context))
    .map((track) => ({ track, score: scoreTrack(track, context) }))
    .sort((a, b) => b.score - a.score);

  const selected = selectWithDiversity(scored, limit, maxPerArtist, {
    maxPerAlbum: discoveryLevel >= 70 ? 1 : 2,
    dedupeTitle: true
  });
  return { queries, selected, candidates: scored };
}

export async function syncPlaylist(client, rawOptions) {
  const options = { ...rawOptions };
  const prompt = options.prompt?.trim() || "groove-focused discovery";
  const name = options.name?.trim() || "AI Playlist";
  const limit = Number(options.limit || 30);
  const mode = (options.mode || "replace").toLowerCase();
  const reuseExisting = options.reuseExisting !== false;
  const isPublic = options.isPublic === true;
  const description = options.description || defaultDescription(prompt);

  const { selected, queries } = await buildTrackSelection(client, {
    prompt,
    artistList: options.artistList || [],
    genreList: options.genreList || [],
    excludeArtistList: options.excludeArtistList || [],
    discoveryLevel: options.discoveryLevel,
    maxPerArtist: options.maxPerArtist,
    strictExplore: options.strictExplore,
    limit,
    perQuery: options.perQuery,
    maxQueries: options.maxQueries
  });

  if (!selected.length) {
    throw new Error("No tracks found for the given prompt/artists/genres.");
  }

  if (options.dryRun) {
    return {
      dryRun: true,
      name,
      prompt,
      mode,
      isPublic,
      description,
      queries,
      selected
    };
  }

  const me = await client.getCurrentUser();
  let playlist = null;
  let reusedExisting = false;
  if (reuseExisting) {
    playlist = await client.findPlaylistByName(me.id, name);
  }
  if (!playlist) {
    playlist = await client.createPlaylist(me.id, { name, description, isPublic });
  } else {
    reusedExisting = true;
    await client.updatePlaylistDetails(playlist.id, { name, description, isPublic });
  }

  const uris = selected.map((track) => track.uri);
  let added = 0;

  if (mode === "append") {
    const existing = new Set(await client.getPlaylistTrackUris(playlist.id));
    const toAdd = uris.filter((uri) => !existing.has(uri));
    await client.addTracksToPlaylist(playlist.id, toAdd);
    added = toAdd.length;
  } else {
    await client.replacePlaylistTracks(playlist.id, uris);
    added = uris.length;
  }

  return {
    dryRun: false,
    playlistId: playlist.id,
    playlistUrl: playlist.external_urls?.spotify,
    reusedExisting,
    name,
    prompt,
    mode,
    queries,
    selected,
    added
  };
}
