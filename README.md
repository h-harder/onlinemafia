# Texting Mafia

Realtime browser game inspired by Mafia, but played through main chat and private text-style DMs.

## Features

- Menu screen with create/join flow
- 5-character join codes
- Host-controlled lobby start
- Name prompt stored in browser storage (no login/account)
- Minimum 4 players required
- One Mafia + one Guardian Angel per game
- 2-minute rounds
- Mafia skull action (`💀`) with 60s cooldown
- Guardian save action (`🙏`)
- End-of-round reveal of killed + saved player
- Eliminated players cannot chat or act, and they can see who Mafia/Guardian are

## Run Locally

1. Install dependencies:

```bash
npm install
```

2. Start the app:

```bash
npm start
```

3. Open:

`http://localhost:3000`

To test multiplayer on one machine, open multiple browser tabs or private windows.
