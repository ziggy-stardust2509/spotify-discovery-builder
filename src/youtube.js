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

function buildYouTubeTrackInput(input) {
  const name = String(input?.name || "").trim();
  const artists = Array.isArray(input?.artists)
    ? input.artists.map((value) => String(value || "").trim()).filter(Boolean)
    : String(input?.artists || "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
  return { name, artists };
}

export class YouTubeClient {
  constructor(config) {
    this.apiKey = String(config.youtubeApiKey || "").trim();
    this.region = String(config.youtubeRegion || "US").trim().toUpperCase();
    this.maxSearchResults = clampInt(config.youtubeMaxSearchResults, {
      min: 1,
      max: 10,
      fallback: 5
    });
  }

  isConfigured() {
    return Boolean(this.apiKey);
  }

  async searchVideos(query, maxResults = this.maxSearchResults) {
    if (!this.isConfigured()) {
      throw new Error("YouTube export is not configured. Missing YOUTUBE_API_KEY on server.");
    }
    const safeMax = clampInt(maxResults, { min: 1, max: 10, fallback: this.maxSearchResults });
    const url = new URL(`${YOUTUBE_API_BASE}/search`);
    url.searchParams.set("part", "snippet");
    url.searchParams.set("type", "video");
    url.searchParams.set("maxResults", String(safeMax));
    url.searchParams.set("q", String(query || "").trim());
    url.searchParams.set("key", this.apiKey);
    url.searchParams.set("regionCode", this.region);

    const response = await httpFetch(url, { method: "GET" });
    const text = await response.text();
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
    if (!response.ok) {
      const message = data?.error?.message || text || "Unknown YouTube error";
      throw new Error(`YouTube search failed (${response.status}): ${message}`);
    }
    return data || { items: [] };
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

  async createInstantPlaylist(rawTracks, { name } = {}) {
    const tracks = Array.isArray(rawTracks)
      ? rawTracks.map(buildYouTubeTrackInput).filter((track) => Boolean(track.name))
      : [];
    if (!tracks.length) {
      throw new Error("No tracks were provided for YouTube export.");
    }

    const matches = [];
    const unmatched = [];
    const videoIds = [];
    for (const track of tracks.slice(0, 50)) {
      const query = buildSearchQuery(track);
      try {
        const data = await this.searchVideos(query);
        const best = this.pickBestVideo(data?.items || [], track);
        if (!best?.id?.videoId) {
          unmatched.push({
            name: track.name,
            artists: track.artists,
            reason: "No high-confidence YouTube match."
          });
          continue;
        }
        const videoId = best.id.videoId;
        videoIds.push(videoId);
        matches.push({
          name: track.name,
          artists: track.artists,
          youtubeUrl: `https://www.youtube.com/watch?v=${videoId}`,
          videoTitle: best?.snippet?.title || "",
          channelTitle: best?.snippet?.channelTitle || ""
        });
      } catch (err) {
        unmatched.push({
          name: track.name,
          artists: track.artists,
          reason: String(err?.message || "Lookup failed.")
        });
      }
    }

    const uniqueIds = Array.from(new Set(videoIds)).slice(0, 50);
    return {
      name: String(name || "YouTube Discovery Mix").trim(),
      videoCount: uniqueIds.length,
      youtubeUrl: uniqueIds.length
        ? `https://www.youtube.com/watch_videos?video_ids=${uniqueIds.join(",")}`
        : null,
      matches,
      unmatched
    };
  }
}
