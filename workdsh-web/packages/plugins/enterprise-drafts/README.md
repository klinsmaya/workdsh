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
- Public packages: pinned DSH `0.1.7-rc.2`; the first UI probe used Cordis `4.0.3`.
  The reviewed current consumer uses exact Cordis `4.0.4`. Official Connection `ClientConnectionRpc.call`, owner-gated
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

### Fixed local-only Client face

The explicit public `./local-client` entry and `dist/local-client.browser.js`
artifact use factory id `workdsh-plugin-enterprise-drafts-local`. Its public
service dependencies are only `slots` and `layout`; the owning carrier selects
the paired `dsh.localClient.inject/external` module metadata through the original
module graph. It must choose this face instead of the normal drafts Client face,
since both contribute the same main/sidebar Slot key.
After the original main Slot owner is available and the entry is registered, the
local face calls the public `layout.selectPanel(panelKey)` to show local drafts
initially. The normal online face does not acquire this default-selection behavior.

The trusted preload capability is exactly `window.afosLocalDrafts` with
`state(): Promise<EnterpriseDraftState>`,
`edit({draftId, content}): Promise<EnterpriseDraftView>` and
`subscribe(listener): unsubscribe`. Replies are the existing direct business
DTOs, without a transport envelope or extra fields. Main rechecks its private
account/project scope on every operation; the renderer never chooses an account,
project, URL, path, secret or generic IPC channel. Existing strict parsers verify
fields, UTF-8 limits, content hashes and receipt facts. The adapter then forces
`authority: 'offline'` and adds a renderer-only `scopedLocalOnly: true` marker.
This projection cannot authorize new enterprise actions.

The alternative reuses the original draft model and panel, retaining sources,
hashes, sync times and plain-text preview/edit. With `localOnly: true`, materials,
start, cancel, archive (including its confirmation dialog) and native Session
navigation controls are absent from the rendered tree. The adapter itself
rejects those operations. Capability events invalidate the model before refresh;
event, caller and module lifetimes are rechecked after asynchronous hash parsing.
An invalidation also changes an editor cache key, so an account/project cutoff
cannot preserve dirty content under a reused project/draft id. Ordinary refresh
does not change that key. Disposal removes the Main subscription and both Slots.
There is no Connection/Remote fallback, browser persistence or automatic upload.

The carrier owner supplies the actual preload capability and original frontend
assembly. This package's unit/SSR/SlotRegistry evidence does not certify actual
Electron IPC, complete original-shell controls or formal target desktop AT.

### Client readiness continuation / reuse decision

The original public Connection generation observable, generated
`remote.session.list`, source-labelled `SessionReference.ready/binding/release`
and Session snapshot are the navigation authorities. `sessions.refresh()` and
catalog READY may preserve an earlier cache after a failed read; they cannot
alone authorize opening an owned Session. The navigation first waits the original
generation, repulls the Main business selection, requires the actual fresh
generated list result to contain that same selected draft Session, and waits the
original Controller's own public refresh/catalog before allocating a binding.
A direct generated result cannot populate that original catalog. It then waits
the original reference's open attempt. It checks `openState === 'open'`, no error or
removal, live binding identity and unchanged original generation/selection before
the original Workspace synchronously retains the view. Its temporary reference
then releases. The consumer label `enterpriseDraftNavigation` extends only the
official Client reference accounting; it is not a new grant or execution owner.

First ready emits the original reset, so an operation still awaiting its first
generation may survive the temporary business invalidate only by waiting for a
fresh Main projection of exactly the original project/draft/Session. Once bound,
loss, replacement or reset cancels it. Offline/error, selection change,
supersession, panel/module disposal, explicit cancel and a 30-second operation
deadline also cancel. Waiting/cancel controls describe only this UI operation;
the feature does not supply another generation source, Controller or transport.
Both `remote` and `remote.session` are declared as public Cordis dependencies.

Supporting tests cover these lifecycle races and a real headless Chromium graph
using original frontend/ModuleSystem/Loader/Slots/SessionProvider/Conversation,
physical original HTTP + WS and synthetic Main/caller/model fixtures. Delayed
ready is released only after the real user opens the waiting UI; cancel, reset
and revocation leave no view retention. Probe and earlier failed evidence are
separately retained. This does not verify packaged Electron, production Renderer
caller proof, the joint MainIPC + NativeWS carrier or target OS acceptance.
Native composer/menu Slots can contribute a policy separately; this module does
not claim complete read-only native presentation. The original Sidebar New
Session action has no separate public disable Slot in rc.2; Host mutation refusal
remains required. Cached native history can remain visible after generation loss.

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
evidence only. Real model, IdP/NocoBase, packaged GUI, Windows/macOS and P1G3 remain NOT_RUN
or BLOCKED; this module does not authorize D13/D14 or production/external writes.

Rollback: withdraw `workdsh-plugin-enterprise-drafts` from the trusted Profile and remove
the module; official lifecycle disposal unregisters its Slots and aborts pending
UI calls. Existing Session logs and business data stay owned by their original
services. No production schema or data migration is introduced.
