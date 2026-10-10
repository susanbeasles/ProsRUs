# Job Stack

A recoverable recruiting workspace with a React dashboard, TypeScript domain/application capabilities, D1 records, private R2 originals and a Durable Object coordinator. The production default Worker returns 404. The canonical Control gateway invokes the private named service entrypoint and owns identity, selected grants and bounded sessions.

Current source supports read-first observations and recoverable domain operations. Provider intelligence, sending, scheduling and production audited admission require separate explicit activation. Source declarations are not evidence of a live deployment. See [status](docs/status.md), [product scope](docs/product-specification.md) and [deployment boundaries](docs/deployment.md).

## Development

Use the committed lockfile and supported Node version. `npm run typecheck`, `npm run lint`, `npm run check:recovery-schemas`, `npm run check:core-planner`, focused tests and `npm run build` verify the actual source. `npm run verify` also includes historical large-storage runtime suites; select affected checks when an unchanged expensive path does not need retesting. No clean installation or live test is implied by local results.

`src/domain` owns pure rules and contracts; `src/application` orchestrates them; `src/storage` and `migrations` own durable records/history; `src/providers` and `src/identity` are narrow external boundaries; `src/jobs` owns coordination; `dashboard` renders verified read data; `integration` is the shared gateway contract. [Engineering rules](docs/code-style-guide.md) and `AGENTS.md` govern changes.

Private audited profiles, source inventories, originals, observations, credentials and operational evidence are runtime inputs outside source. Public tests use an independent synthetic corpus. Packaging preserves the reciprocal Control overlay and verifies complete component composition. No public request chooses a profile or grants authority by parsing data.
