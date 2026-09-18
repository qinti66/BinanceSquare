# Prototype Instructions

Run the local server yourself and open the preview in the browser available to this environment. Do not give the user server-start instructions when you can run it.

Before making substantial visual changes, use the Product Design plugin's `get-context` skill when the visual source is unclear or no longer matches the current goal. When the user gives durable prototype-specific design feedback, preferences, or decisions, record them in `AGENTS.md`.

When implementing from a selected generated mock, treat that image as the source of truth for layout, component anatomy, density, spacing, color, typography, visible content, and hierarchy.

Build app UI in `src/`. Keep `.openai/hosting.json`, `worker/index.js`, `scripts/prepare-sites-build.mjs`, and `tests/sites-worker.test.mjs` intact so the same local prototype can be handed to Sites. Before a Sites handoff, run `npm run build` and `npm run test:sites`; the build must leave `dist/client/index.html`, `dist/server/index.js`, and `dist/.openai/hosting.json`.

Selected design: first displayed ImageGen option, dark charcoal and warm yellow compose workspace. Preserve this direction. Source is docs/design-reference.png. User requested local API account management, multi-account publishing, persistent drafts and publication history.


Deployment preference: Linux server, one-command start/stop/restart, IP + configurable port access. Use the authenticated single-port production Node server, preserve .data and .env across updates, and test HTTP (non-secure-context) browser behavior.

Server configuration preference: Keep user-editable server settings in the root .env (HOST, PORT, ADMIN_USER, ADMIN_PASSWORD, DATA_DIR, PUBLIC_ORIGIN), with .env.example tracked as the template. Default to port 8081 because the user's port 8080 is occupied. When .env is absent, migrate the legacy .env.production if present and retain it; otherwise copy .env.example. .env takes precedence when both exist. Keep credentials out of Git; start.sh generates and saves a random password when ADMIN_PASSWORD is blank.

Production service settings must use .env as the sole source; omitted keys use application defaults rather than inherited HOST/PORT/admin/data/origin environment variables.

Workspace content preference: Remove demo accounts, sample editor content, simulated publishing UI/history, and fabricated market candles. New installations start empty. On upgrades preserve real accounts, media, user-authored drafts and real publication history; only discard exact original seed drafts and explicitly simulated records. Never convert a pending simulated publication into a live submission.

Account diagnostics preference: Provide an explicit per-account test button before publishing, using a non-publishing server-side probe. Distinguish network connectivity from key or posting permission validation, report useful DNS/TLS/timeout/HTTP errors without exposing credentials, and never create a post or upload media as a connection test.
