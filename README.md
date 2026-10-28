# Taste Heist

**Good taste. Great accomplices.** A cooperative cultural-discovery game for two to four people. Bring the films, books and artists you love, combine your private clues, and escape a miniature archive with something new to explore.

<img src="public/assets/archive.webp" alt="Taste Heist’s miniature cultural archive" width="520">

Taste Heist uses the official **Qloo harness** for live entity search and independent recommendations. The clay crew and puzzles are authored game fiction; the cultural discoveries come from actual provider results.

## Play locally

You need **Node 24+**, npm, a Qloo hackathon API key, internet access, and at least two human players. Node 24 is selected by `.nvmrc`.

From the cloned repository:

```bash
npm ci --ignore-scripts
cp .env.example .env
```

Set `QLOO_API_KEY` in `.env` using your editor, then start:

```bash
npm start
```

Open **http://127.0.0.1:3100**, assemble a crew and share its invite. Use separate browser profiles or separate devices for different players: tabs in one browser profile share a session. `npm run dev` enables server watching.

For devices on the same LAN, run `HOST=0.0.0.0 npm start` and open the host machine’s LAN address. For public hosting, configure HTTPS and `PUBLIC_ORIGIN` as described below.

The key stays on the server. `.env` and runtime data are excluded from Git. Never put credentials in frontend files or command arguments. `.env.example` contains empty/example values only.

## The heist

1. **Bring your taste.** Search Qloo, choose the correct identities, and submit two to four favourites. Each person privately marks the shortlist as known, new or skipped.
2. **Choose the adventure together.** A new-favourite route needs an item returned for every player and explicitly new to everyone. “Pass it on” needs one item that fits every profile, known to some and new to the others, with nobody skipping it. A selected favourite establishes its owner’s interest; every other member still needs an actual Qloo return or their own selected favourite. Everyone must agree on the route.
3. **Connect the clues.** Solve a four-symbol lock, find common cultural ground and arrange the escape sequence. Each person holds information the crew needs. Clues stay private until deliberately shared. Every player checks their own answer and readies up before the crew advances.

In the common-ground room, the server offers only discoveries that already fit every profile and the chosen route. Cards explain the group fit and known/new counts. Players choose what they want to experience together and confirm their proposal; there is no hidden recommendation puzzle to guess. Different proposals keep the room open until everyone agrees on the same item. The server then locks one canonical crew discovery. Every member receives the same downloadable dossier and actual recommendation/familiarity evidence. There are no invented compatibility percentages or novelty inferred from missing favourites.

The interface includes original animated characters, sunlight and midnight themes, optional sound, keyboard controls and reduced-motion support. Theme preferences are saved. Every page load opens on the homepage, including after a server restart. **Resume saved heist** and **View last dossier** are explicit choices. Starting a new crew creates a fresh room without deleting another crew’s progress. SQLite retains identities and progress for recovery; restarting the server does not erase games. Saves from the former individual-result flow return to shared agreement with their tastes preserved.

## How it works

| Layer | Implementation |
| --- | --- |
| Browser | HTML, CSS and native JavaScript modules; self-hosted fonts and original clay artwork |
| Server | Node HTTP, SQLite persistence, authenticated cookies and personalized WebSocket updates |
| Cultural research | Official `@qloo/qloo-harness` CLI search and a persistent, schema-discovered MCP recommendation connection |
| Live cards | Normalized provider metadata and authenticated same-origin artwork with URL, redirect, size and image validation |
| Agent access | The `research_taste_crew` MCP tool, using the same research service |

Each profile is researched independently across films, books and artists. The server compares actual returned entity IDs, retaining real cross-profile returns of favourites for “Pass it on”. A favourite is never treated as new to its owner or as evidence for an unsupported friend. A bounded second pass can widen the search. Default server limits allow two concurrent provider operations, 24 uncached recommendation workflows per research job and 30 harness operations per minute; the harness can issue additional internal UUID-resolution requests. Configure the limits to fit your API allowance. Durable daily ceilings apply across rooms and restarts: 1,000 harness operations globally and 120 per room/player by default. Cache hits do not consume allowance. Workflows may issue additional internal API requests. Provider queues, image downloads and WebSocket connections/buffers are bounded.

When a route has no qualifying recommendation, a wider search preserves favourites and completed familiarity reviews. Further batches use unreviewed results from the retained research pool. If that pool is exhausted, players can revisit their cards or adjust favourites with the same crew. Provider errors offer retry and editing options. No unrelated pick or all-familiar revisit can substitute for the route’s actual requirements. Missing artwork keeps the real title and category visible. Player names, chat and session identifiers are not sent to Qloo.

SQLite stores rooms, hashed session tokens and command receipts. Transactional updates, idempotent commands, private projections, WebSocket reconnect and polling support shared play. Sessions expire after 24 hours; rooms expire after 24 hours of inactivity. Expired records are rejected immediately and physically cleaned up every five minutes. Use one Node instance with a persistent database volume; multiple instances would require shared coordination.

## Verify

```bash
npm test
npm run check
npm run build
npm run verify:network
```

These checks need **no Qloo key**. Tests use controlled provider inputs isolated under `tests/`, including the actual installed harness/SDK contract. The network verifier starts the production HTTP/WebSocket transport with isolated mechanical state and rejects cultural requests. GitHub Actions is configured to run these checks on Node 24 and 26.

Provider checks are separate and explicit:

```bash
npm run doctor
npm run verify:live
```

`doctor` checks configuration, installation, DNS and harness readiness. `verify:live` makes bounded real provider requests, validates live artwork and completes all three rooms through separate authenticated sessions. It writes only a redacted report under ignored `data/`. Automated familiarity marks in that check are test inputs, not human evidence.

Recommendation workflows have a 60-second deadline (`QLOO_WORKFLOW_TIMEOUT_MS`, at most 120 seconds). Timeout and closed-connection failures are reported separately. A failed MCP connection is replaced on the next retry; calls are not automatically repeated. Completed requests remain cached for five minutes within the running service.

## Deploy

The application requires a **Node-capable VM or container** that can run the official harness and persist SQLite. `dist/` contains frontend assets only; GitHub Pages cannot host the complete game.

```bash
docker build -t taste-heist .
docker run --env-file .env -e PUBLIC_ORIGIN=https://your-domain.example -p 3100:3100 -v taste-heist-data:/app/data taste-heist
```

Inject `QLOO_API_KEY` at runtime. Put the server behind HTTPS, set `PUBLIC_ORIGIN` to its exact external origin, and forward WebSocket upgrades. The Docker image contains the application assets, runtime source and installed dependencies. Production startup requires an HTTPS `PUBLIC_ORIGIN`. For local container testing, override `NODE_ENV=development` and use a loopback origin.

Authenticated request allowances belong to each player, so players sharing a proxy or network do not consume one another’s gameplay allowance. Anonymous creation/join limits still use the client address. Behind a reverse proxy, set `TRUSTED_PROXY_CIDRS` to the actual proxy peer addresses or narrow networks, for example `127.0.0.1/32,::1/128` for a same-host proxy. The proxy must overwrite or correctly append `X-Forwarded-For`. The server walks that chain from the trusted peer toward the first untrusted address; untrusted peers and malformed forwarding headers cannot select their own rate-limit identity. Leave this setting empty for a directly exposed server. Wildcards and globally trusting `/0` networks are rejected.

Player errors contain recovery guidance and safe codes. Operator-only provider diagnoses are written as bounded, redacted server log records; raw provider messages, credentials, search queries and stack traces are never included in those records.

## Agent tool

An MCP client can start the same research service with absolute paths:

```json
{
  "mcpServers": {
    "taste-heist": {
      "command": "node",
      "args": ["--env-file=/absolute/path/.env", "/absolute/path/server/agent.mjs"]
    }
  }
}
```

`research_taste_crew` accepts two to four profiles of confirmed entity UUIDs and returns genuine shared recommendation candidates. Calling agents must obtain human familiarity before describing a result as new. The tool exposes no room credentials or puzzle answers and uses the same Qloo credential as the game.

## Project map

- `public/` — interface, original artwork and licensed fonts
- `server/` — rooms, research, persistence, artwork and multiplayer
- `shared/` — public character and puzzle constants
- `tests/` — controlled provider, interface, persistence and contract checks
- `scripts/` — diagnostics, verification and build tools

Application code is licensed under [MIT](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for bundled font and WebSocket licenses.

Official integration references: [Qloo hackathon kit](https://github.com/qloo/qloo-hackathon-kit), [CLI starter](https://github.com/qloo/qloo-hackathon-kit/blob/main/starter/cli-workflow/README.md), [MCP starter](https://github.com/qloo/qloo-hackathon-kit/blob/main/starter/mcp-client/README.md), [API access](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/API_ACCESS.md) and [safe use](https://github.com/qloo/qloo-hackathon-kit/blob/main/docs/SAFE_USE.md).
