# Enterprise drafts UI · 0.1.0-alpha.1

This Client feature contributes an enterprise draft page to the official `main`
and `sidebar.panellist` Slots. It consumes the fixed Main business facade; it owns
no Agent, Session, model route, transport, credentials or persistent execution state.
The Host entry exists only for official Client module discovery (like the existing
client-only activity feature). It registers no Host capability or fake response.

## Official reuse record (before implementation)

- Authorized tasks: D08/D09 UI slice. Source requirements: handoff
  `00_DOT_START_HERE.md`, `01_FULL_IMPLEMENTATION_PLAN.md`,
  `02_IMPLEMENTATION_TASKS.md`, `03_ACCEPTANCE_MATRIX.md`.
- Public packages: pinned DSH `0.1.7-rc.2`; Cordis `4.0.3` follows the current
  WorkDSH override. Official Connection `ClientConnectionRpc.call`, owner-gated
  Slots `inject/register`, Layout, and `UiWorkspace.openSession` are reused.
- Shared WorkDSH controls and Modal come from `workdsh-ui`. Component props derive
  from official `PropsRuntime<'main'>` and `InjectFace`; Context stays outside React.
- The frozen `workdsh-contracts/enterprise-drafts` DTO has no URL, token, path,
  actor, preset or provider selector. Only seven fixed `/api` endpoints are used.
- Existing API/Loader/lifecycle probes are frozen in the independently delivered
  `afos-profile-assembly-inventory` evidence. This package adds user selections,
  request/cache lifecycle and presentation of server-owned business projections.
- Referenced ignored developer/UI documents were absent from the checkout.
  Existing shared UI, official types and available handoff requirements are the
  implementation baseline; target desktop visual validation remains NOT_RUN.

## Behavior and limits

Select real material/revision/hash pins, inspect text snapshots, describe a goal,
and create a draft through Main. Opening a draft uses the original Session view.
Text preview is escaped React text; downloaded/active content, HTML and markdown
execution are unsupported. This UI declares plain-text preview/edit only and
does not claim Office import/export or file-format acceptance.
The first draft limit is the public `ENTERPRISE_DRAFT_MAX_BYTES` (64 KiB UTF-8).
Material text snapshots have a separate 1 MiB limit. Main enforces the same draft
limit; the larger broker/archive transport cap does not expand this UI allowance.

Execution and archive status come from Main. A successful cancellation request
does not mean execution stopped. Only `receipt-recorded` with a matching receipt
is displayed as archived. Archive requires an explicit confirmation for the
currently saved hash; no automatic archive occurs on refresh or reconnect.
Server offline authority disables material access, starting and archiving;
scoped local drafts remain editable. No browser persistence or outbox is added.
Unstructured transport failures clear the volatile view and authority until a
fresh Main projection arrives. Unsaved editor content is not guaranteed to survive
that invalidation; offline editing relies on an actual Main offline projection.

`npm run build`, `npm run typecheck`, `npm test` are package-local commands after
its exact dependencies and frozen workspace contracts are available. The Client
artifact uses the official ModuleLoader envelope. It must be included by the
trusted enterprise Profile; it does not change the personal/default Profile.

Acceptance IDs: AT-33/35/36/38/39/40/43/44. Package tests give supporting headless
evidence only. Real model, IdP/NocoBase, GUI, Windows/macOS and P1G3 remain NOT_RUN
or BLOCKED; this module does not authorize D13/D14 or production/external writes.

Rollback: withdraw `workdsh-plugin-enterprise-drafts` from the trusted Profile and remove
the module; official lifecycle disposal unregisters its Slots and aborts pending
UI calls. Existing Session logs and business data stay owned by their original
services. No production schema or data migration is introduced.
