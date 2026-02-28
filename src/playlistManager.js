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
const LOW_INTENT_TITLE_HINTS = ["interlude", "skit", "intro", "outro", "snippet", "demo"];

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

function tokenizeLoose(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token && token.length > 2);
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

function createTokenSet(values = []) {
  const set = new Set();
  for (const value of values) {
    for (const token of tokenizeLoose(value)) {
      if (STOPWORDS.has(token)) continue;
      if (!isHighSignalToken(token)) continue;
      set.add(token);
    }
  }
  return set;
}

function countTokenSetMatches(haystackTokens, tokenSet) {
  if (!haystackTokens?.size || !tokenSet?.size) return 0;
  let matches = 0;
  for (const token of tokenSet) {
    if (haystackTokens.has(token)) matches += 1;
  }
  return matches;
}

function buildLikedProfile(tracks = []) {
  const artistCount = new Map();
  const tokenCount = new Map();
  let trackCount = 0;

  for (const track of tracks) {
    if (!track?.uri) continue;
    trackCount += 1;
    const artists = track.artists || [];
    for (const artist of artists) {
      const key = String(artist?.name || "").trim().toLowerCase();
      if (!key) continue;
      artistCount.set(key, (artistCount.get(key) || 0) + 1);
    }
    const haystack = [track.name || "", track.album?.name || "", ...artists.map((a) => a.name || "")]
      .join(" ")
      .toLowerCase();
    for (const token of tokenizeLoose(haystack)) {
      if (STOPWORDS.has(token)) continue;
      if (!isHighSignalToken(token)) continue;
      tokenCount.set(token, (tokenCount.get(token) || 0) + 1);
    }
  }

  const likedArtistSet = new Set(
    Array.from(artistCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 70)
      .map(([name]) => name)
  );

  const likedTokenSet = new Set(
    Array.from(tokenCount.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([token]) => token)
  );

  return {
    trackCount,
    likedArtistSet,
    likedTokenSet
  };
}

async function loadLikedProfile(client) {
  try {
    const likedTracks = await client.getSavedTracks({ pageLimit: 4, pageSize: 50 });
    return buildLikedProfile(likedTracks);
  } catch {
    return buildLikedProfile([]);
  }
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

function parseSpotifyTrackId(value) {
  const input = String(value || "").trim();
  if (!input) return null;
  if (/^[A-Za-z0-9]{22}$/.test(input)) return input;
  const uriMatch = input.match(/^spotify:track:([A-Za-z0-9]{22})$/i);
  if (uriMatch) return uriMatch[1];
  try {
    const parsed = new URL(input);
    const parts = parsed.pathname.split("/").filter(Boolean);
    if (parts[0] === "track" && /^[A-Za-z0-9]{22}$/.test(parts[1] || "")) {
      return parts[1];
    }
  } catch {
    // Not a valid URL.
  }
  return null;
}

function chooseBestSeedTrack(query, tracks = []) {
  if (!tracks.length) return null;
  const queryLower = String(query || "").toLowerCase();
  const queryTokens = tokenizeLoose(queryLower).filter(isHighSignalToken);
  const scored = tracks
    .filter((track) => track?.uri)
    .map((track) => {
      const text = [track.name || "", ...(track.artists || []).map((a) => a.name || "")]
        .join(" ")
        .toLowerCase();
      const tokenHits = queryTokens.reduce(
        (count, token) => (text.includes(token) ? count + 1 : count),
        0
      );
      const exact = queryLower && text.includes(queryLower) ? 1 : 0;
      const popularity = Number(track.popularity || 0) / 100;
      const score = exact * 3 + tokenHits * 0.9 + popularity * 0.45;
      return { track, score };
    })
    .sort((a, b) => b.score - a.score);
  return scored[0]?.track || tracks[0];
}

function summarizeSeedTrack(track) {
  if (!track?.uri) return null;
  return {
    id: track.id,
    uri: track.uri,
    name: track.name,
    artists: (track.artists || []).map((artist) => artist.name).filter(Boolean),
    url: track.external_urls?.spotify
  };
}

async function resolveSeedTrack(client, seedSongInput) {
  const value = String(seedSongInput || "").trim();
  if (!value) return null;
  const trackId = parseSpotifyTrackId(value);
  if (trackId) {
    try {
      return await client.getTrack(trackId);
    } catch (err) {
      throw new Error(`Could not load seed song from Spotify link/ID: ${err.message}`);
    }
  }
  const search = await client.searchTracks(value, 12, 0);
  const best = chooseBestSeedTrack(value, search?.tracks?.items || []);
  if (!best) {
    throw new Error(`No Spotify track found for seed song "${value}".`);
  }
  return best;
}

async function fetchSeedSongRecommendations(client, seedTrack, discoveryLevel) {
  if (!seedTrack?.id) return [];
  const novelty = clamp01(discoveryLevel / 100);
  const profiles = [
    {
      limit: 100,
      minPopularity: clampInt(18 - Math.round(novelty * 12), 0, 100, 8),
      maxPopularity: clampInt(86 - Math.round(novelty * 16), 0, 100, 70)
    },
    {
      limit: 100,
      minPopularity: 0,
      maxPopularity: clampInt(68 - Math.round(novelty * 20), 0, 100, 55)
    },
    {
      limit: 100,
      minPopularity: 0,
      maxPopularity: clampInt(52 - Math.round(novelty * 18), 0, 100, 40)
    }
  ];
  const results = [];
  for (const profile of profiles) {
    try {
      const rec = await client.getRecommendations({
        seedTracks: [seedTrack.id],
        limit: profile.limit,
        minPopularity: profile.minPopularity,
        maxPopularity: profile.maxPopularity
      });
      for (const track of rec?.tracks || []) {
        if (track?.uri) {
          results.push(track);
        }
      }
    } catch {
      // Recommendation endpoint can fail for some edge inputs; keep flow resilient.
    }
  }
  return results;
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
    seedRecHits: 0,
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
  seedTrack = null,
  maxQueries = 12,
  discoveryLevel = 50
}) {
  const set = new Set();
  const promptTokens = tokenize(prompt);
  const novelty = clamp01(discoveryLevel / 100);
  const artistCap = novelty >= 0.8 ? Math.min(2, artists.length) : artists.length;

  if (seedTrack) {
    const seedArtist = seedTrack.artists?.[0]?.name || "";
    const seedTitleTokens = tokenize(seedTrack.name || "").slice(0, 4);
    const seedArtistTokens = tokenize(seedArtist).slice(0, 2);
    if (seedArtist) {
      set.add(`artist:"${seedArtist}"`);
      if (seedTitleTokens.length) {
        set.add(`artist:"${seedArtist}" ${seedTitleTokens.slice(0, 2).join(" ")}`);
      }
    }
    if (seedTitleTokens.length) {
      set.add(seedTitleTokens.join(" "));
    }
    if (seedArtistTokens.length && promptTokens.length) {
      set.add(`${seedArtistTokens.join(" ")} ${promptTokens.slice(0, 2).join(" ")}`);
    }
  }

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

  for (const artist of artists.slice(0, 2)) {
    for (const genre of genres.slice(0, 2)) {
      if (set.size >= maxQueries) break;
      set.add(`artist:"${artist}" genre:"${genre}"`);
      if (promptTokens.length && novelty < 0.8) {
        set.add(`artist:"${artist}" genre:"${genre}" ${promptTokens.slice(0, 2).join(" ")}`);
      }
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
  if (context.seedTrackUri && track.uri === context.seedTrackUri) return true;
  if (context.seedTrackTitleKey && canonicalTrackKey(track) === context.seedTrackTitleKey) {
    return true;
  }

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
  const durationMs = Number(track.duration_ms || 0);
  if (durationMs > 0 && durationMs < 95_000) {
    for (const hint of LOW_INTENT_TITLE_HINTS) {
      if (normalizedTitle.includes(hint)) {
        return true;
      }
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
  const haystackTokens = new Set(tokenizeLoose(haystack));

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
    (trace.promptHits > 0 ? 1 : 0) +
    (trace.seedRecHits > 0 ? 1 : 0);
  const seedArtistMatches = context.artistSeedsLower.reduce((count, artist) => {
    if (artistNames.some((name) => name.includes(artist))) return count + 1;
    return count;
  }, 0);
  const likedArtistMatches = artistNames.reduce((count, artist) => {
    if (context.likedArtistSet.has(artist)) return count + 1;
    return count;
  }, 0);
  const seedArtistTokenMatches = countTokenSetMatches(haystackTokens, context.seedArtistTokens);
  const seedGenreTokenMatches = countTokenSetMatches(haystackTokens, context.seedGenreTokens);
  const likedTokenMatches = countTokenSetMatches(haystackTokens, context.likedTokenSet);
  const likedTokenCoverage = context.likedTokenSet.size
    ? likedTokenMatches / Math.min(14, context.likedTokenSet.size)
    : 0;
  const seedTrackTokenMatches = countTokenSetMatches(haystackTokens, context.seedTrackTokens);
  const sameSeedArtistMatches = artistNames.reduce((count, name) => {
    if (context.seedTrackArtistSet.has(name)) return count + 1;
    return count;
  }, 0);

  const confidence =
    queryFamilyCount * 0.7 +
    Math.min(4, trace.hits) * 0.34 +
    promptCoverage * 1.8 +
    trace.seedRecHits * (0.9 + 0.35 * novelty) +
    seedArtistMatches * (1 + 0.8 * familiarity) +
    likedArtistMatches * (0.55 + 0.75 * familiarity) +
    likedTokenCoverage * (0.55 + 0.85 * familiarity) +
    seedTrackTokenMatches * (0.26 + 0.22 * familiarity) +
    seedArtistTokenMatches * (0.32 + 0.22 * familiarity) +
    seedGenreTokenMatches * (0.22 + 0.2 * novelty);

  let score = popularity * (0.45 + 0.45 * familiarity);
  score += (1 - popularity) * (0.3 + 0.85 * novelty);
  score += queryAgreement * 0.55;
  score += queryFamilyCount * (0.34 + 0.08 * novelty);
  score += promptMatches * (0.16 + 0.08 * familiarity);
  score += promptCoverage * 1.25;

  score += seedArtistMatches * (1.5 * familiarity);
  score -= seedArtistMatches * (0.95 * novelty);
  score += trace.seedRecHits * (0.45 + 0.42 * novelty);
  score += seedTrackTokenMatches * (0.18 + 0.15 * familiarity);
  score += likedArtistMatches * (0.52 + 0.6 * familiarity);
  score += likedTokenCoverage * (0.5 + 0.6 * familiarity);
  score += seedArtistTokenMatches * (0.24 + 0.12 * familiarity);
  score += seedGenreTokenMatches * (0.1 + 0.16 * novelty);
  score += confidence * (0.24 + 0.2 * familiarity);
  if (sameSeedArtistMatches > 0) {
    score -= sameSeedArtistMatches * (0.55 + 1.05 * novelty);
  }

  for (const hint of TITLE_NOISE_HINTS) {
    if (title.includes(hint) && !context.allowedTitleHints.has(hint)) {
      score -= 0.22;
    }
  }
  for (const hint of LOW_INTENT_TITLE_HINTS) {
    if (title.includes(hint) && !context.allowedTitleHints.has(hint)) {
      score -= 0.28;
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
  score += randomNudge * (0.06 * novelty);

  const minConfidence = 0.85 + (1 - novelty) * 0.55;
  if (confidence < minConfidence) {
    score -= (minConfidence - confidence) * (0.95 + 1.1 * familiarity);
  }

  return {
    score,
    confidence,
    promptCoverage,
    queryFamilyCount,
    seedRecHits: trace.seedRecHits,
    seedArtistMatches,
    likedArtistMatches,
    likedTokenCoverage
  };
}

function selectWithDiversity(
  scored,
  limit,
  maxPerArtist,
  { maxPerAlbum = 2, dedupeTitle = true, seedSelection = [] } = {}
) {
  const selected = seedSelection.slice(0, limit);
  const selectedUris = new Set(selected.map((track) => track.uri).filter(Boolean));
  const byArtist = new Map();
  const byAlbum = new Map();
  const byTitle = new Set();

  for (const track of selected) {
    const primaryArtist = track.artists?.[0]?.id || track.artists?.[0]?.name;
    const albumKey = track.album?.id || track.album?.name || track.uri;
    const titleKey = canonicalTrackKey(track);
    byArtist.set(primaryArtist, (byArtist.get(primaryArtist) || 0) + 1);
    byAlbum.set(albumKey, (byAlbum.get(albumKey) || 0) + 1);
    if (titleKey) byTitle.add(titleKey);
  }

  if (selected.length >= limit) {
    return selected.slice(0, limit);
  }

  for (const item of scored) {
    if (selectedUris.has(item.track.uri)) continue;
    const primaryArtist = item.track.artists?.[0]?.id || item.track.artists?.[0]?.name;
    const albumKey = item.track.album?.id || item.track.album?.name || item.track.uri;
    const titleKey = canonicalTrackKey(item.track);
    const count = byArtist.get(primaryArtist) || 0;
    if (count >= maxPerArtist) continue;
    const albumCount = byAlbum.get(albumKey) || 0;
    if (albumCount >= maxPerAlbum) continue;
    if (dedupeTitle && titleKey && byTitle.has(titleKey)) continue;
    selected.push(item.track);
    if (item.track.uri) selectedUris.add(item.track.uri);
    byArtist.set(primaryArtist, count + 1);
    byAlbum.set(albumKey, albumCount + 1);
    if (titleKey) byTitle.add(titleKey);
    if (selected.length >= limit) return selected;
  }

  for (const item of scored) {
    if (selected.length >= limit) break;
    if (selectedUris.has(item.track.uri)) continue;
    const titleKey = canonicalTrackKey(item.track);
    if (dedupeTitle && titleKey && byTitle.has(titleKey)) continue;
    selected.push(item.track);
    if (item.track.uri) selectedUris.add(item.track.uri);
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
  const seedSong = String(options.seedSong || "").trim();
  const discoveryLevel = clampInt(options.discoveryLevel, 0, 100, 60);
  const strictExplore = options.strictExplore === true;
  const limit = clampInt(options.limit, 1, 200, 30);
  const perQuery = clampInt(options.perQuery, 1, 50, 10);
  let maxPerArtist = clampInt(
    options.maxPerArtist,
    1,
    10,
    discoveryLevel >= 70 ? 2 : 3
  );
  const likedProfilePromise = loadLikedProfile(client);
  const seedTrack = seedSong ? await resolveSeedTrack(client, seedSong) : null;
  if (seedTrack) {
    maxPerArtist = Math.min(maxPerArtist, discoveryLevel >= 65 ? 1 : 2);
  }

  const queries = buildSearchQueries({
    prompt,
    artists: artistList,
    genres: genreList,
    seedTrack,
    maxQueries: Number(options.maxQueries || 12),
    discoveryLevel
  });

  const promptTokens = tokenize(prompt);
  const candidateMap = new Map();
  const upsertCandidate = (track, query, queryKind, { fromSeedRecommendations = false } = {}) => {
    if (!track?.uri) return;
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
    if (fromSeedRecommendations) {
      entry.trace.seedRecHits += 1;
    }
    if (queryKind?.hasArtist) entry.trace.artistHits += 1;
    if (queryKind?.hasGenre) entry.trace.genreHits += 1;
    if (queryKind?.promptHit || (!queryKind?.hasArtist && !queryKind?.hasGenre)) {
      entry.trace.promptHits += 1;
    }
    if (query) {
      entry.trace.querySet.add(query);
    }
  };

  for (const query of queries) {
    const queryKind = classifyQuery(query, promptTokens);
    const result = await client.searchTracks(query, perQuery, 0);
    for (const track of result?.tracks?.items || []) {
      upsertCandidate(track, query, queryKind);
    }
  }

  const seedRecommendations = await fetchSeedSongRecommendations(
    client,
    seedTrack,
    discoveryLevel
  );
  for (const track of seedRecommendations) {
    const queryKind = classifyQuery(
      `${seedTrack?.artists?.[0]?.name || ""} ${seedTrack?.name || ""}`.trim(),
      promptTokens
    );
    upsertCandidate(track, "seed-recommendations", queryKind, {
      fromSeedRecommendations: true
    });
  }

  const deduped = Array.from(candidateMap.values()).map((entry) => entry.track);
  const traceByUri = new Map(
    Array.from(candidateMap.entries()).map(([uri, value]) => [uri, value.trace])
  );
  const likedProfile = await likedProfilePromise;
  const seedTrackArtistsLower = (seedTrack?.artists || [])
    .map((artist) => String(artist?.name || "").trim().toLowerCase())
    .filter(Boolean);
  const seedTrackTokens = createTokenSet([
    seedTrack?.name || "",
    ...(seedTrack?.artists || []).map((artist) => artist.name || "")
  ]);
  const context = {
    promptTokens,
    artistSeedsLower: artistList.map((artist) => artist.toLowerCase()),
    excludeArtistTokens: excludeArtistList.map((artist) => artist.toLowerCase()),
    seedArtistTokens: createTokenSet(artistList),
    seedGenreTokens: createTokenSet(genreList),
    likedArtistSet: likedProfile.likedArtistSet,
    likedTokenSet: likedProfile.likedTokenSet,
    seedTrackUri: seedTrack?.uri || null,
    seedTrackTitleKey: seedTrack ? canonicalTrackKey(seedTrack) : "",
    seedTrackArtistSet: new Set(seedTrackArtistsLower),
    seedTrackTokens,
    allowedTitleHints: buildAllowedTitleHints(promptTokens),
    traceByUri,
    currentYear: new Date().getUTCFullYear(),
    discoveryLevel,
    strictExplore
  };

  const scored = deduped
    .filter((track) => !trackShouldBeExcluded(track, context))
    .map((track) => ({ track, ...scoreTrack(track, context) }))
    .sort((a, b) => b.score - a.score);

  const novelty = clamp01(discoveryLevel / 100);
  const basePromptThreshold = 0.19 - 0.06 * novelty;
  const confidenceThreshold = 1.2 - 0.35 * novelty;
  const corePool = scored.filter(
    (item) =>
      item.seedArtistMatches > 0 ||
      item.seedRecHits > 0 ||
      item.likedArtistMatches > 0 ||
      item.likedTokenCoverage >= 0.2 ||
      item.queryFamilyCount >= 2 ||
      item.promptCoverage >= basePromptThreshold ||
      item.confidence >= confidenceThreshold
  );
  const coreRatio = strictExplore
    ? 0.5 - 0.2 * novelty
    : 0.8 - 0.45 * novelty;
  const coreTarget = clampInt(
    Math.round(limit * clamp01(coreRatio)),
    1,
    limit,
    Math.max(1, Math.round(limit * 0.6))
  );

  const diversityOptions = {
    maxPerAlbum: discoveryLevel >= 70 ? 1 : 2,
    dedupeTitle: true
  };
  const coreSelected = selectWithDiversity(corePool, coreTarget, maxPerArtist, diversityOptions);
  const selected = selectWithDiversity(scored, limit, maxPerArtist, {
    ...diversityOptions,
    seedSelection: coreSelected
  });
  return {
    queries,
    selected,
    candidates: scored,
    seedTrack: summarizeSeedTrack(seedTrack),
    tasteProfile: {
      likedTracksAnalyzed: likedProfile.trackCount
    }
  };
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

  const { selected, queries, tasteProfile, seedTrack } = await buildTrackSelection(client, {
    prompt,
    seedSong: options.seedSong,
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
    throw new Error(
      options.seedSong
        ? "No tracks found for that seed song with the current filters. Try a broader prompt or higher discovery."
        : "No tracks found for the given prompt/artists/genres."
    );
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
      seedTrack,
      tasteProfile,
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
    seedTrack,
    tasteProfile,
    selected,
    added
  };
}
