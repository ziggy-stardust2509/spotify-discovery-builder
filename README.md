# Spotify AI Playlist Manager (Web App)

Web app to create and update Spotify playlists from prompts, artists, genres, and seed songs.

## What it does

- Connects each user to Spotify via OAuth.
- Supports multiple users: each browser session stores its own token file.
- Discovery-first controls:
  - `discoveryLevel` slider (familiar -> exploratory)
  - `maxPerArtist` cap
  - optional strict explore mode and exclude artist list
- Playlist behavior control:
  - update existing playlist with same name, or
  - force create a new playlist each run
- Updates playlists in `replace` or `append` mode.
- Seed-song mode:
  - start from one song (name, URL, or URI)
  - expands with diversified recommendations instead of repeating the same obvious tracks
- Optional YouTube export:
  - takes selected Spotify tracks
  - with `YOUTUBE_API_KEY`: finds matches and builds a YouTube watch playlist link
  - without `YOUTUBE_API_KEY`: still works by generating per-track YouTube search links
- Supports presets:
  - `drumming`
  - `discovery`
  - `gym`

## Requirements

- Node.js 16+
- Spotify developer app with redirect URI matching your public app URL:
  - local example: `http://127.0.0.1:8888/callback`
  - hosted example: `https://YOUR_PUBLIC_HOST/callback`
  - for public hosting, use HTTPS redirect URI only

## Do users need their own API keys?

- No, not by default.
- If your server has `SPOTIFY_CLIENT_ID` configured, users can click **Authorize Spotify** without entering keys.
- If your Spotify app is still in **Development Mode**, Spotify only allows explicitly approved users in Dashboard **Users and Access**.
- Users blocked by Development Mode can either:
  - be added to your allowlist, or
  - use the app's optional **Use your own Spotify app keys** fallback.

## Environment

`.env` in project root:

```env
SPOTIFY_CLIENT_ID=...
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback
SPOTIFY_AUTH_MODE=pkce
```

If you use `SPOTIFY_AUTH_MODE=standard`, add:

```env
SPOTIFY_CLIENT_SECRET=...
```

Optional:

```env
PORT=8888
HOST=127.0.0.1
SPOTIFY_AUTH_FILE=.spotify-auth.json
SPOTIFY_SEARCH_MARKET=US
SPOTIFY_SEARCH_LIMIT_MAX=10
SPM_SESSION_DIR=.sessions
SPM_COOKIE_SECURE=true
SPM_WEB_REDIRECT_URI=https://YOUR_PUBLIC_HOST/callback
YOUTUBE_API_KEY=...
YOUTUBE_REGION=US
YOUTUBE_MAX_SEARCH_RESULTS=5
```

`SPM_WEB_REDIRECT_URI` is recommended in hosted deployments so OAuth always uses your trusted HTTPS callback.

## Run the web app

```bash
npm run start
```

Open:

- [http://127.0.0.1:3000](http://127.0.0.1:3000)
- if your redirect URI uses port `8888`, open [http://127.0.0.1:8888](http://127.0.0.1:8888)

## Web flow

1. Click **Authorize Spotify** (hosted app mode, no key needed).
2. Approve OAuth.
3. If Spotify blocks access, either get allowlisted in Dashboard **Users and Access** or open **Optional fallback** and save your own app keys.
4. Pick a preset or enter your own prompt/artists/genres.
5. Set discovery controls (how far outside your bubble to search).
6. Click **Build Playlist**.

## Per-user credentials

- Credentials saved in **Connection** are stored per browser session in `SPM_SESSION_DIR`.
- Changing credentials clears that session’s Spotify token and requires reconnect.
- `Auth Mode`:
  - `PKCE` uses `Client ID` (secret optional)
  - `Standard` requires `Client Secret`

## Spotify developer setup (for end users)

1. Go to [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) and create an app.
2. In that app settings, add redirect URI: `https://YOUR_APP_HOST/callback`.
3. Copy `Client ID` (and `Client Secret` for Standard mode).
4. Paste those values in this app’s **Connection** section and click **Save Credentials**.
5. Click **Connect Spotify**.

## Previous quick flow

1. Click **Connect Spotify**.
2. Approve OAuth.
3. Pick a preset or enter your own prompt/artists/genres.
4. Click **Create / Update Playlist**.

## Multi-user behavior

- Tokens are stored per browser session in `SPM_SESSION_DIR` (default `.sessions/`).
- Use **Disconnect** in the UI to clear the current browser session and token.

## Deploying on Feral

See [DEPLOY_FERAL.md](DEPLOY_FERAL.md) for deployment steps.

## CLI still available

```bash
npm run auth
npm run sync -- --preset drumming
npm run sync -- --seed-song "https://open.spotify.com/track/..." --name "Off One Song" --prompt "left-field groove, modern rhythm section"
```
