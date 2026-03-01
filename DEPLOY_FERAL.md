# Deploy On Feral Hosting

This app can be hosted on Feral so multiple users can sign in with their own Spotify accounts.

## 1. Prepare Spotify app settings

In Spotify Developer Dashboard, add an exact redirect URI for your hosted app:

- `https://YOUR_PUBLIC_HOST/spotifried/callback`

Example if your app is exposed on `oceanus.feralhosting.com`:

- `https://oceanus.feralhosting.com/spotifried/callback`

## 2. Upload project to Feral

From your local machine:

```bash
cd "/Users/charlesbono/Documents/Spotify Playlist Manager"
rsync -az --delete --exclude node_modules --exclude .git --exclude .env --exclude .sessions --exclude .spotify-auth.json ./ daffadillion@oceanus.feralhosting.com:/media/sdq1/daffadillion/apps/spotify-playlist-manager/
```

## 3. Install Node.js runtime in `/media/sdq1/daffadillion/apps/`

Feral nodes can require an older glibc; Node 16 is a safe baseline.

```bash
cd /media/sdq1/daffadillion/apps
curl -fsSLO https://nodejs.org/dist/latest-v16.x/node-v16.20.2-linux-x64.tar.xz
tar -xf node-v16.20.2-linux-x64.tar.xz
ln -sfn /media/sdq1/daffadillion/apps/node-v16.20.2-linux-x64 /media/sdq1/daffadillion/apps/node-current
export PATH="/media/sdq1/daffadillion/apps/node-current/bin:$PATH"
node -v
npm -v
```

## 4. Configure environment on Feral

SSH to the server:

```bash
ssh daffadillion@oceanus.feralhosting.com
```

Create `/media/sdq1/daffadillion/apps/spotify-playlist-manager/.env`:

```env
SPOTIFY_CLIENT_ID=YOUR_SPOTIFY_CLIENT_ID
SPOTIFY_AUTH_MODE=pkce
SPOTIFY_REDIRECT_URI=https://YOUR_PUBLIC_HOST/spotifried/callback
SPM_WEB_REDIRECT_URI=https://YOUR_PUBLIC_HOST/spotifried/callback
SPM_BASE_PATH=/spotifried
SPM_REDIRECT_ROOT_TO_BASE=false
HOST=0.0.0.0
PORT=3000
SPM_SESSION_DIR=.sessions
SPM_COOKIE_SECURE=true
SPOTIFY_SEARCH_MARKET=US
SPOTIFY_SEARCH_LIMIT_MAX=10
```

If you prefer standard OAuth instead of PKCE, set:

```env
SPOTIFY_AUTH_MODE=standard
SPOTIFY_CLIENT_SECRET=YOUR_SPOTIFY_CLIENT_SECRET
```

## 5. Start app on Feral

```bash
export PATH="/media/sdq1/daffadillion/apps/node-current/bin:$PATH"
cd /media/sdq1/daffadillion/apps/spotify-playlist-manager
mkdir -p .sessions
npm install
tmux new -s spotify-playlist-manager -d "export PATH=/media/sdq1/daffadillion/apps/node-current/bin:\$PATH && cd /media/sdq1/daffadillion/apps/spotify-playlist-manager && npm run start"
tmux ls
```

## 6. Expose port 3000 over your public host

Set up your existing web server / reverse proxy to forward:

- `https://YOUR_PUBLIC_HOST/spotifried/*` -> `http://APP_SERVER_IP:3000/spotifried/*`

Optional:
- block `https://YOUR_PUBLIC_HOST/` or redirect it somewhere else (but not to this app)

On your Feral box, find `APP_SERVER_IP` with:

```bash
hostname -I
```

Your proxy must preserve:

- path `/spotifried/callback`
- `X-Forwarded-Proto: https` (recommended for secure cookies)
- `X-Forwarded-Host` (recommended so callback origin stays correct)

## 7. Validate

1. Open `https://YOUR_PUBLIC_HOST/spotifried`
2. Click **Connect Spotify**
3. Complete consent and return to `/spotifried/callback`
4. Confirm status says connected
5. Run a playlist sync

## Operational notes

- Session token files are in `.sessions/` on the server.
- Rotating `SPOTIFY_CLIENT_SECRET` requires updating `.env` and restarting the process.
- Restart command:

```bash
tmux kill-session -t spotify-playlist-manager
tmux new -s spotify-playlist-manager -d "export PATH=/media/sdq1/daffadillion/apps/node-current/bin:\$PATH && cd /media/sdq1/daffadillion/apps/spotify-playlist-manager && npm run start"
```
