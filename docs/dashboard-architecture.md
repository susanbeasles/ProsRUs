# Owner dashboard architecture

The owner UI ("Job Stack") is a React 19 + Vite single-page app served by the Product Worker under `/owner/job-stack/`. Control proxies every data request to Product. This document describes the modules, the data flow and the invariants the code and tests maintain.

## Modules

| Path | Responsibility |
| --- | --- |
| `dashboard/main.tsx` | Entry point; renders `App` in `StrictMode`. |
| `dashboard/app/` | Composition root (`App.tsx`), router (`router.ts`), navigation binding (`navigation.ts`), shell with skip link, navigation and route announcer (`Shell.tsx`), authority gate (`AuthorityGate.tsx`), error boundary, lazy route table (`routes.tsx`), mutation toasts, router context and `RouteLink`. |
| `dashboard/lib/` | Framework-free data layer: transport (`api.ts`), query cache (`queryCache.ts`), mutation client (`mutations.ts`), request keys and intents (`requestKeys.ts`), read definitions (`queries.ts`), per-grant workspace (`workspace.ts`), schema-driven form model (`schemaForm.ts`), optimistic helpers, opportunity rules mirror, recovery-status schema. `hooks.ts` is the only React binding (`useQuery`, `useIntent`, `useMutationRecords`, `useVisiblePolling`, ...). |
| `dashboard/components/` | Reusable UI: dialog, skeletons, empty/error/not-enabled states, disabled actions, pagination, record list and body, schema form, write actions and pending changes, toasts, backup status. |
| `dashboard/features/<context>/` | One lazily loaded page per bounded context: overview, opportunities, conversations, interviews, profile-evidence, packets, activity, settings, history. Each feature's mutation specs live in `specs.ts`. |

## Routing

The router reads the existing URL parameters `grant`, `record`, `history`, `version`, `view`, `cursor` plus `page`. Without `page` a URL opens the opportunity pipeline with the same selection as before the router existed, so old deep links keep their meaning and the landing view keeps its read budget (session + one pipeline page, or session + one record detail). `view` is a page-scoped sub-view normalised per page. Routes compare semantically: parameter order and unknown parameters never cause a navigation. The previous-page trail is stored in `history.state`.

## Reads

```
view -> useQuery(read) -> Workspace.read(read) -> QueryCache.ensure/fetch
     -> createReadClient(grant, signal) -> request(): nonce GET (grant + exact target) -> operation GET -> responseJson(maxOutputBytes)
     -> validateCoreOutput / identity checks -> commit only if (signal live, generation current, still the entry's fetch)
```

`request()` accepts only catalog read operations. `job_stack_recovery_status` is the one named exception while it is missing from the shared catalog; it uses the same owner GET flow with a local byte bound (see `docs/adr/0001-dashboard-data-layer.md`). List pages show record summaries only; details load when a record is opened, so no list issues per-row reads.

## Writes

```
form (schema from domainBodySchemas) -> coerce/validate (declared fields only) -> useIntent -> MutationClient.start
  -> optimistic patch (list/detail) -> per-entity queue -> body built when the mutation runs (newest revision)
  -> mutate(): validateCoreInput, <= 64 KiB, fresh nonce (grant, method=POST, query-free target) -> POST ?grant=
  -> success: server entityId/revision reconcile, invalidate affected reads
  -> failure: identity-checked rollback, invalidate (refetch), error toast, retry with the same request key when the outcome is unknown
```

Error mapping: 401, and 403 other than `write-elevation-required` / `invalid-owner-request`, is authority loss. `write-elevation-required` keeps reads, rolls back and links to `/owner/apps/job-stack`. `invalid-owner-request` is retried once with a fresh nonce. `request-key-conflict` and revision conflicts roll back and refetch. `operation-unavailable` disables the action with an explanation. Packet creation, submission recording, meeting import, profile export and all external effects are disabled with reasons and never simulated.

## Invariants and the tests that prove them

| Invariant | Tests |
| --- | --- |
| Every in-flight read aborts on a distinct navigation, grant change or authority loss; late responses never render, even if the transport ignores abort. | `dashboard-query-cache`, `read-first-navigation`, `pipeline-ui` (view, grant, selection and expiry cases), `dashboard-opportunities` (late tracked page) |
| Repeating the current selection (including reordered or irrelevant URL parameters) keeps data and in-flight reads. | `read-first-navigation`, `dashboard-router` |
| Responses are byte-bounded before parsing; malformed bytes give fixed errors. | `read-first-client`, `dashboard-mutations`, `dashboard-recovery-status` |
| `request()` performs only catalog reads; `mutate()` performs only catalog local-write domain operations with a request key, schema-valid input and the 64 KiB limit. | `read-first-client`, `dashboard-mutations` |
| One request key per intent, reused on retry with a fresh nonce; same-entity writes serialize; optimistic changes roll back on any failure and the server revision wins on success. | `dashboard-mutations`, `dashboard-opportunities` |
| Authority loss clears every read, cancels pending writes and says so; elevation is not authority loss. | `dashboard-mutations`, `dashboard-opportunities`, `pipeline-ui` |
| Only domain-allowed transitions are offered; confirmation where the domain requires it. | `dashboard-transitions` (conformance with `src/domain/rules.ts`), `dashboard-opportunities` |
| Forms send exactly the declared properties and mirror schema validation. | `dashboard-forms`, `dashboard-features` (settings) |
| "Protected" appears only for recovery state `protected`; pending is never protected; schema mismatch is an error, 501 is "Backup status unavailable"; polling at most every 60 s while visible. | `dashboard-recovery-status`, `dashboard-features` |
| CSP `style-src 'self'`: no inline script/style or style attributes; all assets flat under `assets/` with servable names; one chunk per feature. | `dashboard-build` |

## Accessibility and presentation

Navigation uses real links with `aria-current`; focus moves to the new page or record heading after a navigation and a polite live region announces it. Dialogs trap Tab, close on Escape and return focus. Toasts and status lines use live regions; errors use `role="alert"`. Disabled actions are focusable `aria-disabled` buttons described by their reason. Colors are CSS custom properties with a dark-mode override; `prefers-reduced-motion` removes transitions and the skeleton shimmer; the layout works down to 360px.

## Verification boundary

All of the above is verified headlessly (Vitest with happy-dom and server rendering, plus a programmatic Vite build). No real-browser, assistive-technology or deployed-environment acceptance is claimed.
