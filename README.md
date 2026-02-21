# Texting Mafia

Realtime browser game inspired by Mafia, played through public and private text chat.

This repo is set up for:

- Frontend: GitHub Pages (`public/`)
- Backend: Cloudflare Worker + Durable Object (`worker/`)

## Gameplay Implemented

- Menu screen with create/join flow
- 5-character lobby codes
- Host-only game start
- Name stored locally in the browser (no account)
- Minimum 4 players
- One mafia + one guardian angel per game
- 2-minute rounds
- Mafia skull action (`💀`) with 60-second cooldown
- Mafia can only choose one kill target per round
- Guardian save action (`🙏`)
- End-of-round reveal of killed + saved targets
- Eliminated players cannot chat or act, and they can see mafia/guardian identities

## Deploy Backend (Cloudflare Workers)

1. Install Wrangler:

```bash
npm install --save-dev wrangler
```

2. Authenticate with Cloudflare:

```bash
npx wrangler login
```

3. Deploy:

```bash
npx wrangler deploy --config worker/wrangler.jsonc
```

4. Copy the deployed Worker URL (for example `https://texting-mafia-backend.<subdomain>.workers.dev`).

## Deploy Frontend (GitHub Pages)

This repo includes a GitHub Actions workflow at:

- `.github/workflows/deploy-pages.yml`

Steps:

1. Push this repository to GitHub.
2. In GitHub repo settings, open `Pages`.
3. Set source to `GitHub Actions`.
4. Push to `main` (or `master`) to trigger deployment.
5. Open your Pages site URL.

## Connect Frontend To Backend

On the menu screen:

1. Paste your Worker URL into `Backend URL`.
2. Click `Save`.
3. Create or join a lobby.

The frontend saves this backend URL in local browser storage.

## Project Layout

- `public/`: static frontend files for GitHub Pages
- `worker/wrangler.jsonc`: Worker + Durable Object config
- `worker/src/worker.js`: backend API + WebSocket game engine
- `server.js`: legacy local Node backend (not used in the Cloudflare + GitHub Pages deployment path)
