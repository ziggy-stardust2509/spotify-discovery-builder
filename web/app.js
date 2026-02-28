const state = {
  presets: {},
  sessionId: null
};

const els = {
  form: document.querySelector("#sync-form"),
  preset: document.querySelector("#preset"),
  name: document.querySelector("#name"),
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
  saveClientConfig: document.querySelector("#save-client-config"),
  clearClientConfig: document.querySelector("#clear-client-config"),
  connectLink: document.querySelector("#connect-link"),
  disconnectLink: document.querySelector("#disconnect-link"),
  statusPill: document.querySelector("#status-pill"),
  statusText: document.querySelector("#status-text"),
  resultSummary: document.querySelector("#result-summary"),
  trackList: document.querySelector("#track-list"),
  refreshStatus: document.querySelector("#refresh-status")
};

function parseIntOr(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? parsed : fallback;
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
  const storageKey = "spm_session_id";
  const existing = localStorage.getItem(storageKey);
  if (existing && /^[a-f0-9]{32,64}$/i.test(existing)) {
    state.sessionId = existing.toLowerCase();
    return state.sessionId;
  }
  const created = randomHex(24);
  localStorage.setItem(storageKey, created);
  state.sessionId = created;
  return created;
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
  headers.set("x-spm-session-id", sid);
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

async function handleAuthorizeClick(event) {
  event.preventDefault();
  const originalText = els.connectLink.textContent;
  els.connectLink.textContent = "Opening Spotify...";
  els.connectLink.setAttribute("aria-disabled", "true");
  els.connectLink.style.pointerEvents = "none";
  try {
    const response = await apiFetch("/api/auth/login-url");
    const data = await response.json();
    if (!response.ok || !data.authorizationUrl) {
      throw new Error(data.error || "Could not start Spotify authorization.");
    }
    window.location.assign(data.authorizationUrl);
  } catch (err) {
    els.connectLink.textContent = originalText;
    els.connectLink.removeAttribute("aria-disabled");
    els.connectLink.style.pointerEvents = "";
    setStatus("error", `Authorization failed: ${err.message}`);
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
  els.clientSecret.required = requiresSecret;
  els.clientSecret.placeholder = requiresSecret
    ? "Required for standard mode"
    : "Optional in PKCE mode";
}

function applyPresetToForm(name) {
  const preset = state.presets[name];
  if (!preset) return;

  els.name.value = preset.name || "";
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
  updateDiscoveryUI();
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
    } else if (data.error) {
      setStatus("error", data.error);
    } else {
      setStatus("neutral", "Not connected to Spotify yet.");
    }
  } catch (err) {
    setStatus("error", `Status check failed: ${err.message}`);
  }
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
  applyAuthModeUI();

  const sourceText =
    data.source === "session"
      ? "Using credentials saved in this browser session."
      : "Using server default credentials.";
  const warning = isPublicNonHttpsUrl(data.redirectUri)
    ? " Warning: callback is not HTTPS; Spotify auth may appear unsafe or fail."
    : "";
  setClientConfigNote(`${sourceText} Redirect URI: ${data.redirectUri}.${warning}`);
  if (els.advancedCredentials) {
    els.advancedCredentials.open = data.source === "session";
  }
}

async function saveClientConfig(event) {
  event.preventDefault();
  els.saveClientConfig.disabled = true;
  els.saveClientConfig.textContent = "Saving...";

  const payload = {
    clientId: els.clientId.value.trim(),
    clientSecret: els.clientSecret.value.trim(),
    authMode: els.authMode.value
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
    setStatus("neutral", "App keys saved. Click Authorize Spotify.");
  } catch (err) {
    setClientConfigNote(`Credential save failed: ${err.message}`);
  } finally {
    els.saveClientConfig.disabled = false;
    els.saveClientConfig.textContent = "Save App Keys";
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
    setStatus("neutral", "Using server defaults. Click Authorize Spotify.");
  } catch (err) {
    setClientConfigNote(`Could not clear credentials: ${err.message}`);
  } finally {
    els.clearClientConfig.disabled = false;
  }
}

function renderResult(result) {
  if (result.error) {
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
  els.resultSummary.textContent = summaryBits.join(" | ");
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

async function submitForm(event) {
  event.preventDefault();
  els.submit.disabled = true;
  els.submit.textContent = "Generating...";

  const payload = {
    preset: els.preset.value || undefined,
    name: els.name.value.trim(),
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
  if (els.callbackUri) {
    els.callbackUri.textContent = `${window.location.origin}/callback`;
  }
  els.preset.addEventListener("change", () => {
    if (!els.preset.value) return;
    applyPresetToForm(els.preset.value);
  });
  els.form.addEventListener("submit", submitForm);
  els.refreshStatus.addEventListener("click", loadStatus);
  els.clientConfigForm.addEventListener("submit", saveClientConfig);
  els.clearClientConfig.addEventListener("click", clearClientConfig);
  els.authMode.addEventListener("change", applyAuthModeUI);
  els.discoveryLevel.addEventListener("input", updateDiscoveryUI);
  els.connectLink.addEventListener("click", handleAuthorizeClick);
  els.disconnectLink.addEventListener("click", handleLogoutClick);

  loadPresets()
    .then(() => loadClientConfig())
    .then(() => {
      const connected = new URLSearchParams(window.location.search).get("connected");
      const loggedOut = new URLSearchParams(window.location.search).get("logged_out");
      if (connected === "1") {
        els.resultSummary.textContent = "Spotify authorized. You can now generate playlists.";
      }
      if (loggedOut === "1") {
        els.resultSummary.textContent = "Spotify session disconnected for this browser.";
      }
      if (!els.name.value) {
        els.preset.value = "drumming";
        applyPresetToForm("drumming");
      }
      updateDiscoveryUI();
      return loadStatus();
    })
    .catch((err) => {
      setStatus("error", `Initialization failed: ${err.message}`);
    });
}

init();
