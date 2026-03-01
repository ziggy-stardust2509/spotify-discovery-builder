const state = {
  presets: {},
  sessionId: null,
  sessionStorageReady: true,
  loadedClientConfig: null,
  lastSelectedTracks: [],
  lastPlaylistName: ""
};

const PREFILL_CLEAR_IDS = ["name", "seedSong", "prompt", "artists", "genres"];

const els = {
  form: document.querySelector("#sync-form"),
  preset: document.querySelector("#preset"),
  name: document.querySelector("#name"),
  seedSong: document.querySelector("#seedSong"),
  prompt: document.querySelector("#prompt"),
  artists: document.querySelector("#artists"),
  genres: document.querySelector("#genres"),
  discoveryLevel: document.querySelector("#discoveryLevel"),
  discoveryLevelText: document.querySelector("#discovery-level-text"),
  discoveryLevelBadge: document.querySelector("#discovery-level-badge"),
  maxPerArtist: document.querySelector("#maxPerArtist"),
  excludeArtists: document.querySelector("#excludeArtists"),
  strictExplore: document.querySelector("#strictExplore"),
  limit: document.querySelector("#limit"),
  mode: document.querySelector("#mode"),
  reuseExisting: document.querySelector("#reuseExisting"),
  isPublic: document.querySelector("#isPublic"),
  description: document.querySelector("#description"),
  dryRun: document.querySelector("#dryRun"),
  submit: document.querySelector("#submit-btn"),
  clientConfigForm: document.querySelector("#client-config-form"),
  clientId: document.querySelector("#clientId"),
  clientSecret: document.querySelector("#clientSecret"),
  authMode: document.querySelector("#authMode"),
  callbackUri: document.querySelector("#callback-uri"),
  advancedCredentials: document.querySelector("#advanced-credentials"),
  clientConfigNote: document.querySelector("#client-config-note"),
  keyImportNote: document.querySelector("#key-import-note"),
  keyFile: document.querySelector("#key-file"),
  keyPaste: document.querySelector("#key-paste"),
  importKeyFile: document.querySelector("#import-key-file"),
  importKeyPaste: document.querySelector("#import-key-paste"),
  copyCallback: document.querySelector("#copy-callback"),
  callbackCopyStatus: document.querySelector("#callback-copy-status"),
  saveClientConfig: document.querySelector("#save-client-config"),
  saveAndConnect: document.querySelector("#save-and-connect"),
  clearClientConfig: document.querySelector("#clear-client-config"),
  useHostedDefaults: document.querySelector("#use-hosted-defaults"),
  connectLink: document.querySelector("#connect-link"),
  disconnectLink: document.querySelector("#disconnect-link"),
  statusPill: document.querySelector("#status-pill"),
  statusText: document.querySelector("#status-text"),
  resultSummary: document.querySelector("#result-summary"),
  saveYouTubePlaylist: document.querySelector("#save-youtube-playlist"),
  makeYouTubePlaylist: document.querySelector("#make-youtube-playlist"),
  youtubeStatus: document.querySelector("#youtube-status"),
  youtubeLinkList: document.querySelector("#youtube-link-list"),
  trackList: document.querySelector("#track-list"),
  refreshStatus: document.querySelector("#refresh-status")
};

function parseIntOr(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clearPrefillFlag(element) {
  if (!element) return;
  delete element.dataset.prefilled;
}

function clearStarterPrefillFlags() {
  for (const id of PREFILL_CLEAR_IDS) {
    clearPrefillFlag(els[id]);
  }
}

function bindPrefillClearOnType(element) {
  if (!element) return;
  const clearNow = () => {
    if (element.dataset.prefilled !== "true") return;
    element.value = "";
    clearPrefillFlag(element);
  };
  element.addEventListener("beforeinput", (event) => {
    if (element.dataset.prefilled !== "true") return;
    const inputType = String(event.inputType || "");
    if (!inputType || inputType.startsWith("insert") || inputType.startsWith("delete")) {
      clearNow();
    }
  });
  element.addEventListener("paste", clearNow);
}

function safeSpotifyUrl(value) {
  try {
    const parsed = new URL(String(value || ""));
    if (parsed.protocol !== "https:") return null;
    if (parsed.hostname !== "open.spotify.com") return null;
    return parsed.toString();
  } catch {
    return null;
  }
}

function isPublicNonHttpsUrl(value) {
  try {
    const parsed = new URL(value);
    if (parsed.protocol === "https:") return false;
    const host = parsed.hostname.toLowerCase();
    return !["localhost", "127.0.0.1", "::1", "[::1]"].includes(host);
  } catch {
    return false;
  }
}

function randomHex(bytes = 24) {
  const values = new Uint8Array(bytes);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(values);
  } else {
    for (let i = 0; i < values.length; i += 1) {
      values[i] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(values, (value) => value.toString(16).padStart(2, "0")).join("");
}

function ensureSessionId() {
  if (state.sessionId && /^[a-f0-9]{32,64}$/i.test(state.sessionId)) {
    return state.sessionId;
  }
  if (!state.sessionStorageReady) {
    return null;
  }
  const storageKey = "spm_session_id";
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && /^[a-f0-9]{32,64}$/i.test(existing)) {
      state.sessionId = existing.toLowerCase();
      return state.sessionId;
    }
    const created = randomHex(24);
    localStorage.setItem(storageKey, created);
    state.sessionId = created;
    return created;
  } catch {
    state.sessionStorageReady = false;
    state.sessionId = null;
    return null;
  }
}

function updateAuthLinks() {
  if (els.connectLink) {
    els.connectLink.href = "/auth/login";
  }
  if (els.disconnectLink) {
    els.disconnectLink.href = "/auth/logout";
  }
}

function apiFetch(url, options = {}) {
  const sid = ensureSessionId();
  const headers = new Headers(options.headers || {});
  if (sid) {
    headers.set("x-spm-session-id", sid);
  }
  return fetch(url, {
    ...options,
    credentials: "include",
    headers
  });
}

function getDiscoverySummary(level) {
  if (level >= 85) {
    return {
      badge: "Far Outside",
      detail: "Strong novelty pull beyond your normal recommendations"
    };
  }
  if (level >= 65) {
    return {
      badge: "Balanced Mix",
      detail: "Blend of trusted taste and new territory"
    };
  }
  if (level >= 40) {
    return {
      badge: "Familiar Lean",
      detail: "Mostly in your lane with a few exploratory picks"
    };
  }
  return {
    badge: "In Bubble",
    detail: "Stays close to your current Spotify pattern"
  };
}

function updateDiscoveryUI() {
  const level = Math.max(0, Math.min(100, parseIntOr(els.discoveryLevel.value, 60)));
  const summary = getDiscoverySummary(level);
  els.discoveryLevel.value = String(level);
  els.discoveryLevelText.textContent = `${summary.detail} | ${level}`;
  els.discoveryLevelBadge.textContent = summary.badge;
}

function setStatus(kind, text) {
  els.statusPill.className = `pill ${kind}`;
  els.statusPill.textContent = kind === "ok" ? "Connected" : kind === "error" ? "Error" : "Not Connected";
  els.statusText.textContent = text;
}

function setClientConfigNote(text) {
  els.clientConfigNote.textContent = text;
}

function setCallbackCopyStatus(text, kind = "neutral") {
  if (!els.callbackCopyStatus) return;
  els.callbackCopyStatus.textContent = text;
  els.callbackCopyStatus.classList.remove("state-error", "state-ok");
  if (kind === "error") {
    els.callbackCopyStatus.classList.add("state-error");
  } else if (kind === "ok") {
    els.callbackCopyStatus.classList.add("state-ok");
  }
}

function setYouTubeStatus(text, kind = "neutral", linkUrl = null, linkLabel = "Open YouTube playlist") {
  if (!els.youtubeStatus) return;
  els.youtubeStatus.textContent = text;
  els.youtubeStatus.classList.remove("state-error", "state-ok");
  if (kind === "error") {
    els.youtubeStatus.classList.add("state-error");
  } else if (kind === "ok") {
    els.youtubeStatus.classList.add("state-ok");
  }
  if (linkUrl) {
    els.youtubeStatus.append(document.createTextNode(" "));
    const link = document.createElement("a");
    link.href = linkUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = linkLabel;
    els.youtubeStatus.append(link);
  }
}

function setYouTubeActionDisabled(disabled) {
  const value = Boolean(disabled);
  if (els.makeYouTubePlaylist) {
    els.makeYouTubePlaylist.disabled = value;
  }
  if (els.saveYouTubePlaylist) {
    els.saveYouTubePlaylist.disabled = value;
  }
}

function renderYouTubeLinks(links = []) {
  if (!els.youtubeLinkList) return;
  els.youtubeLinkList.innerHTML = "";
  for (const item of links.slice(0, 20)) {
    const li = document.createElement("li");
    const artistText = Array.isArray(item?.artists) ? item.artists.join(", ") : "";
    const link = document.createElement("a");
    link.href = item.youtubeUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = item.name || "Open YouTube search";
    li.append(link, document.createTextNode(artistText ? ` — ${artistText}` : ""));
    els.youtubeLinkList.append(li);
  }
}

function buildClientConfigPayload() {
  const authMode = els.authMode?.value || "pkce";
  return {
    clientId: String(els.clientId?.value || "").trim(),
    clientSecret: authMode === "standard" ? String(els.clientSecret?.value || "").trim() : "",
    authMode
  };
}

function shouldSaveClientConfig(payload) {
  const baseline = state.loadedClientConfig;
  if (!payload.clientId) return false;
  if (!baseline) return true;
  if (payload.clientId !== baseline.clientId) return true;
  if (payload.authMode !== baseline.authMode) return true;
  if (payload.authMode === "standard" && payload.clientSecret) return true;
  return false;
}

async function saveClientConfigIfNeeded() {
  const payload = buildClientConfigPayload();
  if (!shouldSaveClientConfig(payload)) return;
  const response = await apiFetch("/api/client-config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to save credentials.");
  }
  if (els.clientSecret) {
    els.clientSecret.value = "";
  }
  await loadClientConfig();
}

function setKeyImportNote(text, kind = "neutral") {
  if (!els.keyImportNote) return;
  els.keyImportNote.textContent = text;
  els.keyImportNote.classList.remove("state-error", "state-ok");
  if (kind === "error") {
    els.keyImportNote.classList.add("state-error");
  } else if (kind === "ok") {
    els.keyImportNote.classList.add("state-ok");
  }
}

function stripWrappingQuotes(value) {
  const text = String(value ?? "").trim();
  if (!text) return "";
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'")) ||
    (text.startsWith("`") && text.endsWith("`"))
  ) {
    return text.slice(1, -1).trim();
  }
  return text;
}

function parseEnvLikeText(text) {
  const result = {};
  const lines = String(text || "").split(/\r?\n/);
  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const line = trimmed.startsWith("export ") ? trimmed.slice(7).trim() : trimmed;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    if (!key) continue;
    let value = line.slice(eq + 1).trim();
    value = stripWrappingQuotes(value);
    result[key] = value;
  }
  return result;
}

function flattenObjectEntries(value, output = {}) {
  if (!value || typeof value !== "object") return output;
  for (const [key, entry] of Object.entries(value)) {
    if (entry === null || entry === undefined) continue;
    if (typeof entry === "object" && !Array.isArray(entry)) {
      flattenObjectEntries(entry, output);
      continue;
    }
    output[key] = String(entry).trim();
  }
  return output;
}

function normalizeImportedCredentials(parsed) {
  const lower = new Map(
    Object.entries(parsed || {})
      .map(([key, value]) => [String(key || "").toLowerCase(), String(value || "").trim()])
      .filter(([, value]) => Boolean(value))
  );
  const pick = (...keys) => {
    for (const key of keys) {
      const found = lower.get(key.toLowerCase());
      if (found) return found;
    }
    return "";
  };

  const clientId = pick("spotify_client_id", "client_id", "clientid", "spotifyclientid");
  const clientSecret = pick(
    "spotify_client_secret",
    "client_secret",
    "clientsecret",
    "spotifyclientsecret"
  );
  const rawAuthMode = pick("spotify_auth_mode", "auth_mode", "authmode").toLowerCase();
  const authMode = rawAuthMode === "standard" || rawAuthMode === "pkce"
    ? rawAuthMode
    : clientSecret
      ? "standard"
      : "pkce";

  if (!clientId) {
    throw new Error("No Spotify Client ID found. Include SPOTIFY_CLIENT_ID or clientId.");
  }

  return {
    clientId,
    clientSecret,
    authMode
  };
}

function parseImportedCredentialsText(text) {
  const rawText = String(text || "").trim();
  if (!rawText) {
    throw new Error("No key data found.");
  }

  const envParsed = parseEnvLikeText(rawText);
  let jsonParsed = {};
  try {
    const parsedJson = JSON.parse(rawText);
    jsonParsed = flattenObjectEntries(parsedJson);
  } catch {
    jsonParsed = {};
  }

  return normalizeImportedCredentials({
    ...jsonParsed,
    ...envParsed
  });
}

function applyImportedCredentials(credentials, sourceLabel) {
  els.clientId.value = credentials.clientId;
  els.clientSecret.value = credentials.clientSecret || "";
  els.authMode.value = credentials.authMode;
  applyAuthModeUI();
  if (els.advancedCredentials) {
    els.advancedCredentials.open = true;
  }
  setKeyImportNote(
    `Imported Client ID${credentials.clientSecret ? " + secret" : ""} from ${sourceLabel}.`,
    "ok"
  );
  setClientConfigNote(`Imported from ${sourceLabel}. Click Save + Connect Spotify.`);
  setStatus("neutral", "Keys loaded. Save + Connect Spotify.");
}

async function copyTextToClipboard(text) {
  if (globalThis.navigator?.clipboard?.writeText) {
    await globalThis.navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "true");
  area.style.position = "absolute";
  area.style.left = "-9999px";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(area);
  if (!copied) {
    throw new Error("Clipboard write was blocked by browser permissions.");
  }
}

async function handleCopyCallbackClick(event) {
  event.preventDefault();
  const callback = String(els.callbackUri?.textContent || "").trim();
  const originalText = els.copyCallback?.textContent || "Copy Callback URL";
  if (els.copyCallback) {
    els.copyCallback.disabled = true;
    els.copyCallback.textContent = "Copying...";
  }
  if (!callback) {
    setCallbackCopyStatus("Callback URL unavailable on this page.", "error");
    if (els.copyCallback) {
      els.copyCallback.disabled = false;
      els.copyCallback.textContent = originalText;
    }
    return;
  }
  try {
    await copyTextToClipboard(callback);
    setCallbackCopyStatus("Callback URL copied.", "ok");
  } catch (err) {
    try {
      window.prompt("Copy this callback URL:", callback);
      setCallbackCopyStatus("Clipboard blocked. Callback URL opened in prompt for manual copy.", "ok");
    } catch {
      setCallbackCopyStatus(`Could not copy callback URL: ${err.message}`, "error");
    }
  } finally {
    if (els.copyCallback) {
      els.copyCallback.disabled = false;
      els.copyCallback.textContent = originalText;
    }
  }
}

async function handleImportKeyFileClick(event) {
  event.preventDefault();
  const file = els.keyFile?.files?.[0];
  if (!file) {
    setKeyImportNote("Select a file first (.env, .txt, or .json).", "error");
    return;
  }
  try {
    const text = await file.text();
    const imported = parseImportedCredentialsText(text);
    applyImportedCredentials(imported, `file "${file.name}"`);
  } catch (err) {
    setKeyImportNote(`Import failed: ${err.message}`, "error");
  }
}

function handleImportKeyPasteClick(event) {
  event.preventDefault();
  const text = els.keyPaste?.value || "";
  try {
    const imported = parseImportedCredentialsText(text);
    applyImportedCredentials(imported, "pasted text");
  } catch (err) {
    setKeyImportNote(`Import failed: ${err.message}`, "error");
  }
}

async function handleAuthorizeClick(event) {
  event.preventDefault();
  const originalText = els.connectLink.textContent;
  els.connectLink.textContent = "Opening Spotify...";
  els.connectLink.setAttribute("aria-disabled", "true");
  els.connectLink.style.pointerEvents = "none";
  try {
    await saveClientConfigIfNeeded();
    const response = await apiFetch("/api/auth/login-url");
    const data = await response.json();
    if (!response.ok || !data.authorizationUrl) {
      throw new Error(data.error || "Could not start Spotify authorization.");
    }
    window.location.assign(data.authorizationUrl);
  } catch (err) {
    const message = String(err?.message || "");
    const lower = message.toLowerCase();
    const shouldFallbackToDirectLogin =
      lower.includes("missing session") ||
      lower.includes("failed to fetch") ||
      lower.includes("networkerror");
    if (shouldFallbackToDirectLogin) {
      // Fallback path does not depend on client-side session header support.
      window.location.assign("/auth/login");
      return;
    }
    els.connectLink.textContent = originalText;
    els.connectLink.removeAttribute("aria-disabled");
    els.connectLink.style.pointerEvents = "";
    setStatus("error", `Authorization failed: ${message || "Unknown error."}`);
  }
}

async function handleLogoutClick(event) {
  event.preventDefault();
  try {
    const response = await apiFetch("/api/auth/logout", { method: "POST" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not sign out.");
    }
    setStatus("neutral", "Disconnected. Authorize Spotify to reconnect.");
    els.resultSummary.textContent = "Spotify session disconnected for this browser.";
    await loadStatus();
  } catch (err) {
    setStatus("error", `Logout failed: ${err.message}`);
  }
}

function applyAuthModeUI() {
  const mode = els.authMode.value;
  const requiresSecret = mode === "standard";
  if (!requiresSecret) {
    // Prevent stale/wrong secrets from breaking PKCE token exchange.
    els.clientSecret.value = "";
  }
  els.clientSecret.required = requiresSecret;
  els.clientSecret.disabled = !requiresSecret;
  els.clientSecret.placeholder = requiresSecret
    ? "Required for standard mode"
    : "Not used in PKCE mode";
}

function applyPresetToForm(name) {
  const preset = state.presets[name];
  if (!preset) return;

  els.name.value = preset.name || "";
  els.seedSong.value = "";
  els.prompt.value = preset.prompt || "";
  els.artists.value = (preset.artists || []).join(", ");
  els.genres.value = (preset.genres || []).join(", ");
  els.limit.value = String(preset.limit || 40);
  els.mode.value = preset.mode || "replace";
  els.reuseExisting.value = "true";
  els.isPublic.value = String(Boolean(preset.isPublic));
  els.discoveryLevel.value = String(
    Number.isFinite(Number(preset.discoveryLevel)) ? preset.discoveryLevel : 60
  );
  els.maxPerArtist.value = String(
    Number.isFinite(Number(preset.maxPerArtist))
      ? preset.maxPerArtist
      : Number(els.discoveryLevel.value) >= 70
        ? 2
        : 3
  );
  els.excludeArtists.value = "";
  els.strictExplore.checked = preset.strictExplore === true;
  clearStarterPrefillFlags();
  updateDiscoveryUI();
}

function clearCustomTemplateTextFields() {
  const textFieldIds = [
    "name",
    "seedSong",
    "prompt",
    "artists",
    "genres",
    "excludeArtists",
    "description"
  ];
  for (const id of textFieldIds) {
    const element = els[id];
    if (!element) continue;
    element.value = "";
    clearPrefillFlag(element);
  }
}

async function loadPresets() {
  const response = await apiFetch("/api/presets");
  const data = await response.json();
  state.presets = data.presets || {};

  const options = Object.keys(state.presets);
  for (const key of options) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = state.presets[key]?.name || key[0].toUpperCase() + key.slice(1);
    els.preset.appendChild(option);
  }
}

async function loadStatus() {
  try {
    const response = await apiFetch("/api/status");
    const data = await response.json();
    if (data.authenticated) {
      setStatus("ok", `Logged in as ${data.user.displayName}`);
      return { ok: true, authenticated: true };
    } else if (data.error) {
      setStatus("error", data.error);
      return { ok: false, authenticated: false, error: data.error };
    } else {
      setStatus("neutral", "Not connected to Spotify yet.");
      return { ok: true, authenticated: false };
    }
  } catch (err) {
    setStatus("error", `Status check failed: ${err.message}`);
    return { ok: false, authenticated: false, error: err.message };
  }
}

async function handleRefreshStatusClick(event) {
  event.preventDefault();
  const originalText = els.refreshStatus.textContent;
  els.refreshStatus.disabled = true;
  els.refreshStatus.textContent = "Checking...";
  setStatus("neutral", "Checking Spotify connection...");

  const result = await loadStatus();

  const checkedAt = new Date().toLocaleTimeString([], {
    hour: "numeric",
    minute: "2-digit"
  });
  if (result.ok) {
    els.resultSummary.textContent = result.authenticated
      ? `Connection confirmed at ${checkedAt}.`
      : `Checked at ${checkedAt}: not connected yet.`;
  } else {
    els.resultSummary.textContent = `Connection check failed at ${checkedAt}.`;
  }

  els.refreshStatus.disabled = false;
  els.refreshStatus.textContent = originalText;
}

async function loadClientConfig() {
  const response = await apiFetch("/api/client-config");
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || "Failed to load client config.");
  }

  els.clientId.value = data.clientId || "";
  els.authMode.value = data.authMode || "pkce";
  els.clientSecret.value = "";
  state.loadedClientConfig = {
    clientId: data.clientId || "",
    authMode: data.authMode || "pkce",
    source: data.source || "server"
  };
  applyAuthModeUI();

  const sourceText =
    data.source === "session"
      ? "Using your saved app keys for this browser session."
      : "Using hosted app (no key required).";
  const warning = isPublicNonHttpsUrl(data.redirectUri)
    ? " Warning: callback is not HTTPS; Spotify auth may appear unsafe or fail."
    : "";
  const hostedHint =
    data.source === "server"
      ? " If hosted login fails, open advanced settings and enter your own Client ID."
      : "";
  const storageHint = !state.sessionStorageReady
    ? " Browser storage is unavailable, so this tab is using a cookie-based session."
    : "";
  setClientConfigNote(
    `${sourceText} Redirect URI: ${data.redirectUri}.${warning}${hostedHint}${storageHint}`
  );
  if (els.advancedCredentials) {
    els.advancedCredentials.open = false;
  }
}

async function saveClientConfig(event) {
  event.preventDefault();
  const submitterId = String(event.submitter?.id || "");
  const shouldConnect = submitterId === "save-and-connect";
  const saveOriginalText = els.saveClientConfig.textContent;
  const saveAndConnectOriginalText = els.saveAndConnect?.textContent || "Save + Connect Spotify";
  els.saveClientConfig.disabled = true;
  if (els.saveAndConnect) {
    els.saveAndConnect.disabled = true;
  }
  if (shouldConnect && els.saveAndConnect) {
    els.saveAndConnect.textContent = "Saving + Connecting...";
  } else {
    els.saveClientConfig.textContent = "Saving...";
  }

  const authMode = els.authMode.value;
  const payload = {
    clientId: els.clientId.value.trim(),
    clientSecret: authMode === "standard" ? els.clientSecret.value.trim() : "",
    authMode
  };

  try {
    const response = await apiFetch("/api/client-config", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to save credentials.");
    }
    els.clientSecret.value = "";
    await loadClientConfig();
    if (els.clientId.value.trim() !== payload.clientId) {
      throw new Error("Session did not persist. Open app over HTTPS and allow cookies.");
    }
    if (shouldConnect) {
      window.location.assign("/auth/login");
      return;
    }
    setStatus("neutral", "Keys saved. Click Authorize Spotify.");
  } catch (err) {
    setClientConfigNote(`Credential save failed: ${err.message}`);
  } finally {
    els.saveClientConfig.disabled = false;
    if (els.saveAndConnect) {
      els.saveAndConnect.disabled = false;
      els.saveAndConnect.textContent = saveAndConnectOriginalText;
    }
    els.saveClientConfig.textContent = saveOriginalText;
  }
}

async function clearClientConfig() {
  els.clearClientConfig.disabled = true;
  try {
    const response = await apiFetch("/api/client-config", { method: "DELETE" });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Failed to clear credentials.");
    }
    await loadClientConfig();
    setStatus("neutral", "Using hosted app (no keys). Click Authorize Spotify.");
  } catch (err) {
    setClientConfigNote(`Could not clear credentials: ${err.message}`);
  } finally {
    els.clearClientConfig.disabled = false;
  }
}

async function handleUseHostedDefaultsClick(event) {
  event.preventDefault();
  await clearClientConfig();
  if (els.advancedCredentials) {
    els.advancedCredentials.open = true;
  }
}

function applyAuthResultFromQuery() {
  const params = new URLSearchParams(window.location.search);
  const connected = params.get("connected");
  const loggedOut = params.get("logged_out");
  const authError = params.get("auth_error");
  const youtubeConnected = params.get("youtube_connected");
  const youtubeAuthError = params.get("youtube_auth_error");

  if (authError) {
    setStatus("error", authError);
    els.resultSummary.textContent = `Spotify login failed: ${authError}`;
  } else if (connected === "1") {
    els.resultSummary.textContent = "Spotify authorized. You can now generate playlists.";
  } else if (loggedOut === "1") {
    els.resultSummary.textContent = "Spotify session disconnected for this browser.";
  }

  if (youtubeAuthError) {
    setYouTubeStatus(`YouTube login failed: ${youtubeAuthError}`, "error");
  } else if (youtubeConnected === "1") {
    setYouTubeStatus("YouTube connected. Click Save To YouTube Account to create a playlist.", "ok");
  }

  if (connected || loggedOut || authError || youtubeConnected || youtubeAuthError) {
    params.delete("connected");
    params.delete("logged_out");
    params.delete("auth_error");
    params.delete("youtube_connected");
    params.delete("youtube_auth_error");
    const query = params.toString();
    const next = `${window.location.pathname}${query ? `?${query}` : ""}`;
    window.history.replaceState({}, "", next);
  }
}

function renderResult(result) {
  if (result.error) {
    state.lastSelectedTracks = [];
    state.lastPlaylistName = "";
    setYouTubeActionDisabled(true);
    renderYouTubeLinks([]);
    setYouTubeStatus("Generate a Spotify playlist first, then save to YouTube or open quick links.");
    els.resultSummary.textContent = `Error: ${result.error}`;
    els.trackList.innerHTML = "";
    return;
  }

  const summaryBits = [
    `Playlist: ${result.name}`,
    `Mode: ${result.mode}`,
    result.dryRun
      ? "Dry run"
      : result.reusedExisting
        ? "Updated existing"
        : "Created new",
    result.dryRun ? `Preview tracks: ${(result.selected || []).length}` : `Tracks written: ${result.added ?? 0}`
  ];
  if (Number.isFinite(Number(result.tasteProfile?.likedTracksAnalyzed))) {
    summaryBits.push(`Liked tracks analyzed: ${Number(result.tasteProfile.likedTracksAnalyzed)}`);
  }
  if (result.tasteProfile?.eraTarget) {
    summaryBits.push(`Era: ${result.tasteProfile.eraTarget}`);
  }
  if (result.seedTrack?.name) {
    const seedArtists = Array.isArray(result.seedTrack.artists)
      ? result.seedTrack.artists.join(", ")
      : "";
    summaryBits.push(`Seed: ${result.seedTrack.name}${seedArtists ? ` (${seedArtists})` : ""}`);
  }
  els.resultSummary.textContent = summaryBits.join(" | ");
  state.lastSelectedTracks = Array.isArray(result.selected)
    ? result.selected
        .map((track) => ({
          name: String(track?.name || "").trim(),
          artists: Array.isArray(track?.artists) ? track.artists : []
        }))
        .filter((track) => Boolean(track.name))
    : [];
  state.lastPlaylistName = String(result?.name || "").trim();
  setYouTubeActionDisabled(state.lastSelectedTracks.length === 0);
  if (state.lastSelectedTracks.length > 0) {
    setYouTubeStatus(
      `Ready to export ${state.lastSelectedTracks.length} tracks to YouTube.`
    );
  } else {
    setYouTubeStatus("No tracks were selected for YouTube export.");
  }
  renderYouTubeLinks([]);
  if (result.playlistUrl) {
    els.resultSummary.append(document.createTextNode(" | Spotify: "));
    const link = document.createElement("a");
    link.href = result.playlistUrl;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = "Open playlist";
    els.resultSummary.append(link);
  }

  els.trackList.innerHTML = "";
  for (const track of result.selected || []) {
    const li = document.createElement("li");
    const artistText = (track.artists || []).join(", ");
    const url = safeSpotifyUrl(track.url);
    if (url) {
      const link = document.createElement("a");
      link.href = url;
      link.target = "_blank";
      link.rel = "noreferrer";
      link.textContent = track.name;
      li.append(link, document.createTextNode(` — ${artistText}`));
    } else {
      li.textContent = `${track.name} — ${artistText}`;
    }
    els.trackList.appendChild(li);
  }
}

async function handleMakeYouTubePlaylistClick(event) {
  event.preventDefault();
  if (!state.lastSelectedTracks.length) {
    setYouTubeStatus("Generate a Spotify playlist first.", "error");
    return;
  }
  const originalText = els.makeYouTubePlaylist?.textContent || "Get YouTube Links (No Login)";
  if (els.makeYouTubePlaylist) {
    els.makeYouTubePlaylist.textContent = "Building quick links...";
  }
  if (els.saveYouTubePlaylist) {
    els.saveYouTubePlaylist.disabled = true;
  }
  if (els.makeYouTubePlaylist) {
    els.makeYouTubePlaylist.disabled = true;
  }
  setYouTubeStatus("Matching tracks on YouTube...");
  try {
    const response = await apiFetch("/api/youtube/playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.lastPlaylistName || "Discovery Mix",
        tracks: state.lastSelectedTracks
      })
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || "Could not build YouTube playlist.");
    }
    if (data.mode === "search_links") {
      const links = Array.isArray(data.searchLinks) ? data.searchLinks : [];
      renderYouTubeLinks(links);
      const count = links.length;
      setYouTubeStatus(
        `YouTube API key is not configured, so we generated ${count} search links you can open manually.`,
        "ok",
        links[0]?.youtubeUrl || data.youtubeUrl,
        "Open first link"
      );
      return;
    }
    renderYouTubeLinks([]);
    if (!data.youtubeUrl) {
      setYouTubeStatus("No high-confidence YouTube matches found.", "error");
      return;
    }
    const unmatched = Array.isArray(data.unmatched) ? data.unmatched.length : 0;
    const suffix = unmatched > 0 ? ` (${unmatched} tracks skipped)` : "";
    setYouTubeStatus(
      `YouTube playlist ready with ${Number(data.videoCount || 0)} videos${suffix}.`,
      "ok",
      data.youtubeUrl
    );
    window.open(data.youtubeUrl, "_blank", "noopener,noreferrer");
  } catch (err) {
    setYouTubeStatus(`YouTube export failed: ${err.message}`, "error");
  } finally {
    if (els.makeYouTubePlaylist) {
      els.makeYouTubePlaylist.textContent = originalText;
    }
    setYouTubeActionDisabled(state.lastSelectedTracks.length === 0);
  }
}

async function handleSaveYouTubePlaylistClick(event) {
  event.preventDefault();
  if (!state.lastSelectedTracks.length) {
    setYouTubeStatus("Generate a Spotify playlist first.", "error");
    return;
  }
  const originalText = els.saveYouTubePlaylist?.textContent || "Save To YouTube Account";
  if (els.saveYouTubePlaylist) {
    els.saveYouTubePlaylist.textContent = "Saving...";
  }
  if (els.makeYouTubePlaylist) {
    els.makeYouTubePlaylist.disabled = true;
  }
  if (els.saveYouTubePlaylist) {
    els.saveYouTubePlaylist.disabled = true;
  }
  setYouTubeStatus("Saving playlist to your YouTube account...");
  try {
    const response = await apiFetch("/api/youtube/create-playlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: state.lastPlaylistName || "Discovery Mix",
        tracks: state.lastSelectedTracks
      })
    });
    const data = await response.json();
    if (response.status === 401 && data?.authUrl) {
      window.location.assign(data.authUrl);
      return;
    }
    if (!response.ok) {
      throw new Error(data.error || "Could not create YouTube playlist.");
    }
    if (!data.youtubeUrl) {
      setYouTubeStatus("Playlist created, but no YouTube URL was returned.", "error");
      return;
    }
    const skipped = Number(data.skippedCount || 0);
    const suffix = skipped > 0 ? ` (${skipped} tracks skipped)` : "";
    setYouTubeStatus(
      `YouTube playlist saved with ${Number(data.videoCount || 0)} videos${suffix}.`,
      "ok",
      data.youtubeUrl
    );
    window.open(data.youtubeUrl, "_blank", "noopener,noreferrer");
  } catch (err) {
    setYouTubeStatus(`YouTube save failed: ${err.message}`, "error");
  } finally {
    if (els.saveYouTubePlaylist) {
      els.saveYouTubePlaylist.textContent = originalText;
    }
    setYouTubeActionDisabled(state.lastSelectedTracks.length === 0);
  }
}

async function submitForm(event) {
  event.preventDefault();
  els.submit.disabled = true;
  els.submit.textContent = "Generating...";

  const payload = {
    preset: els.preset.value || undefined,
    name: els.name.value.trim(),
    seedSong: els.seedSong.value.trim(),
    prompt: els.prompt.value.trim(),
    artists: els.artists.value.trim(),
    genres: els.genres.value.trim(),
    discoveryLevel: parseIntOr(els.discoveryLevel.value, 60),
    maxPerArtist: parseIntOr(els.maxPerArtist.value, 2),
    excludeArtists: els.excludeArtists.value.trim(),
    strictExplore: els.strictExplore.checked,
    limit: parseIntOr(els.limit.value, 40),
    mode: els.mode.value,
    reuseExisting: els.reuseExisting.value === "true",
    isPublic: els.isPublic.value === "true",
    description: els.description.value.trim() || undefined,
    dryRun: els.dryRun.checked
  };

  try {
    const response = await apiFetch("/api/sync", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const data = await response.json();
    renderResult(data);
    if (response.ok) {
      await loadStatus();
    }
  } catch (err) {
    renderResult({ error: err.message });
  } finally {
    els.submit.disabled = false;
    els.submit.textContent = "Generate Playlist";
  }
}

function init() {
  ensureSessionId();
  updateAuthLinks();
  bindPrefillClearOnType(els.name);
  bindPrefillClearOnType(els.seedSong);
  bindPrefillClearOnType(els.prompt);
  bindPrefillClearOnType(els.artists);
  bindPrefillClearOnType(els.genres);
  if (els.callbackUri) {
    els.callbackUri.textContent = `${window.location.origin}/callback`;
  }
  setKeyImportNote("No key data imported yet.");
  els.preset.addEventListener("change", () => {
    if (!els.preset.value) {
      clearCustomTemplateTextFields();
      clearStarterPrefillFlags();
      return;
    }
    applyPresetToForm(els.preset.value);
  });
  els.form.addEventListener("submit", submitForm);
  els.refreshStatus.addEventListener("click", handleRefreshStatusClick);
  if (els.clientConfigForm) {
    els.clientConfigForm.addEventListener("submit", (event) => event.preventDefault());
  }
  if (els.clearClientConfig) {
    els.clearClientConfig.addEventListener("click", clearClientConfig);
  }
  if (els.copyCallback) {
    els.copyCallback.addEventListener("click", handleCopyCallbackClick);
  }
  if (els.importKeyFile) {
    els.importKeyFile.addEventListener("click", handleImportKeyFileClick);
  }
  if (els.importKeyPaste) {
    els.importKeyPaste.addEventListener("click", handleImportKeyPasteClick);
  }
  if (els.useHostedDefaults) {
    els.useHostedDefaults.addEventListener("click", handleUseHostedDefaultsClick);
  }
  els.authMode.addEventListener("change", applyAuthModeUI);
  els.discoveryLevel.addEventListener("input", updateDiscoveryUI);
  els.connectLink.addEventListener("click", handleAuthorizeClick);
  els.disconnectLink.addEventListener("click", handleLogoutClick);
  if (els.saveYouTubePlaylist) {
    els.saveYouTubePlaylist.addEventListener("click", handleSaveYouTubePlaylistClick);
  }
  if (els.makeYouTubePlaylist) {
    els.makeYouTubePlaylist.addEventListener("click", handleMakeYouTubePlaylistClick);
  }

  loadPresets()
    .then(() => loadClientConfig())
    .then(async () => {
      updateDiscoveryUI();
      await loadStatus();
      applyAuthResultFromQuery();
    })
    .catch((err) => {
      setStatus("error", `Initialization failed: ${err.message}`);
    });
}

init();
