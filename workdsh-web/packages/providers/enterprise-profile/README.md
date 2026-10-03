# Fixed enterprise Profile integration · 0.1.0-alpha.1

This optional AFOS component implements the fixed enterprise core through the
published DSH 0.1.7-rc.2 Loader, Session, AgentLoop, preset, Skill, LLM, Tools,
Storage and Connection services. It adds enterprise business ownership and
admission; those official services still own execution and transport.

`bootEnterpriseCore()` generates a private JSON-only Loader composition in the
Main-protected account/project namespace, mounts the exact reviewed inventory,
checks required services, and refuses generic Gateway, file, shell, MCP, PTC,
settings and SessionController services. It does not load user patches or a
default bundle. Generated configuration is unique per start and removed by its
lifecycle owner. Browser authentication uses official Connection on loopback.
The implemented drafts Client module is included for official discovery; the
complete native Client/Conversation composition and desktop activation remain
unverified. `assertEnterpriseDesktopActivation()` continues to refuse activation.

Main privately injects current project authority, pinned material access and
Run capabilities. `SnapshotIdentityAuthority` verifies the full
issuer/subject/organization/device/project binding, server authorization revision
and expiry (at most five seconds ahead). Existing WorkDSH Identity owns actor
proof and Access owns durable Session ownership. Display member/organization
labels grant no extra rights. A malformed, changed or failed authority response
cuts off that authority adapter.

`EnterpriseDraftRuntime` creates each Session through official `agents.create`,
mounts the fixed preset and bundled Markdown Skill, and binds its current actor
and Main Run before publication. Failed publication releases its admission.
The two tools are `afos_read_snapshot` and `afos_render_draft`: Main rechecks the
current server Run, exact pins and hashes; render persists only a local draft.
Official Session turn events supply the execution projection. Agent-loop request
provenance is checked in the original public `llm/stream` waterfall before
official projection; the adapter also verifies the exact live Agent and Main
Session/Run binding. OAuth tokens and provider secrets never reach the Client.

`EnterpriseProfileIngress` owns the existing Connection `/api` interceptor.
Seven fixed `afos/drafts/*` UI operations cover state, material listing, snapshot,
start, edit, cancel and explicit human archive. Legacy fixed read/render endpoints
remain bounded; generic method names and extra fields are refused. The UI archive
request must include the confirmed current SHA256; Main compares it before
Recovery captures the intent, queries the receipt, rechecks after awaits and
performs any authorized commit. Archive is never an Agent tool. This local fixture
implementation does not authorize an external production write or P2 approval.

Tool admission requires the original live official Agent, current actor, Session
owner, Access decision and original loop signal. Definition identity prevents
same-name scope shadows; inventory expansion cuts off dispatch. Legitimate
preset restriction/disposal notifications preserve the unchanged fixed inventory.
Registered hooks, cancellation listeners, adapters and handles have official
lifecycle owners. Main revokes capabilities synchronously and coalesces Host stop;
internal callers do not await disposal of their own task. Account changes and
new Host activation still await the old Host's exit. Each Host start invalidates
callbacks captured by its predecessor.

Draft content is bounded to the public 64 KiB UTF-8 limit. JSON admission allows
its worst-case escaping; material snapshots have a separate 1 MiB limit. The
initial recovery store is bounded to eight drafts per namespace. On transport
failure Main preserves verified local drafts, shows the last successful contact,
and synchronously aborts enterprise execution. Human local editing remains
available. Reconnection does not reactivate old callbacks: only explicit trusted
Main Host restart revalidates authority and replaces the Host lifetime. Completed
invalid JSON/UTF-8 and known denials cut off the account instead of entering an
offline view. Explicit account restoration actually reopens the same on-disk
namespace; account switching never replays another subject's drafts. No browser
outbox or second execution state source is added. Complete native UI integration
remains separate.

From `workdsh-web`, build the contracts and this package, then run its `test` and
`typecheck` scripts. From the independent `enterprise/plugin-agent-bridge`
workspace, `corepack pnpm test:profile` builds the Profile's workspace prerequisites
and runs eighteen real official-runtime integration cases using fixture identity,
ACL persistence and model replies. These cover actual tool turns, durable draft
and hash confirmation, authenticated HTTP and physical WS refusal, cancellation,
current Run policy, revocation at model dispatch, failed admission, repeated boot,
escaped-content size, offline editing/reopening, sticky Main admission before
Runtime refresh, malformed responses/body IO, and late original render/stream
cutoff, known refresh-token denial and concurrent denial/offline abort, Main-owned
history admission after execution completes, and failed Host start revocation.
Fixture/Linux evidence is not target desktop acceptance.
DSH remains pinned. Consumer Cordis4.0.4 now satisfies the published ~4.0.4
peers and is verified with original Core and existing consumers. This Linux
source evidence does not replace packaged Windows/macOS compatibility.

Main now privately supplies `ownedSessionRead` with a fresh current-project grant,
stable Host epoch and cutoff signal, and the server expiry. The mapped draft and
account binding own this read; a completed or expired execution Run does not.
Failed Host startup revokes captured grants before waiting for disposal. This
capability alone does not mount native Conversation or authorize desktop activation.

The optional private Main IPC publication renews only a delivered, committed
ticket against fresh authority and the exact original Session/Run, bounded by
the authority deadline, absolute server Run expiry and 60 seconds. Exact-ticket
release synchronously revokes the Main lease before authority reads or queued
business writes. A released renewal's unchanged 10-second deadline cannot close
a newer ticket. Real fork regressions cover release across expiry and that call
deadline; the original Core flow runs for 66 seconds with one Run and one Agent.
IdP, ACL and model replies remain controlled fixtures. See [MAIN_IPC.md](MAIN_IPC.md)
for the protocol, remaining production scope and rollback.

Supporting tasks: D01/D04/D05/D07/D08/D09/D10. Formal AT-03/07/08/10/11/13–18/20/
22–23/31/33–47 are not promoted by these headless checks. Native sandbox,
Windows/macOS, real IdP/NocoBase/SQL/vendor, complete Client assembly, signatures,
licenses and the complete security gate remain open. P1G3 has not passed.

Rollback by withdrawing the optional enterprise composition and reverting the
local source/lock changes, then repeating frozen installs and consumer tests.
Preserve personal Profiles, Sessions, owner records, namespace drafts, credentials
and server receipts. No upstream, production, merge, release or deployment action
is implied.

The optional original CLI online carrier now has a private ready handoff and an owned Electron Session/window connection. Production capabilities remain refused. The fresh owned read catalog and cold page/projections component are described in [READONLY_CATALOG.md](./READONLY_CATALOG.md); settings, retained cold follow and full Composer remain gaps, and combined Root/Main integration still requires verification. See [ONLINE_CARRIER.md](./ONLINE_CARRIER.md).
