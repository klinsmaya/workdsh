# AFOS-0007: finite Main IPC in the original CLI Profile

Task `/root/afos_crossprocess_inventory`; component D07/D05 continuation authorized
by Parent, based on local reviewed commit ed79a0fad2b8cce09a14b145b196b37959650ecd.
Formal desktop AT/G3 remain unpassed; D13/D14 remain unopened.

The carrier keeps one official rc.2 CLI child. A normal fixed Cordis provider
in that child's original Loader tree adapts its existing private Node IPC fd.
It reuses connectMainBusinessIpc; it never calls bootEnterpriseIpcCore, boot,
runProfile.prepare, or a private desktop-host package. No Loader, Remote,
transport, Agent loop, model adapter or approval engine is copied.

Main remains the sole business/credential owner. The Parent adapter captures the
real business.hostSignal plus startSignal and owns the child before readiness.
The child receives the existing bounded immutable snapshot/bootstrap DTOs only.
Read/write/publication/model operations retain existing finite IPC and fresh Main
guards. The existing optional committed IPC lease cap remains 60 seconds.

A fixed private Group isolates Main/Identity/ready services from the CLI root.
The bootstrap provider awaits handshake, creates SnapshotIdentityAuthority,
checks fresh Main identity, provides the scoped capabilities and returns ACTIVE.
A separate injected Identity phase then awaits the public NocoBaseIdentityService
plugin with Main's immutable binding. Only then does it publish afosCliProfileReady.
The actual API probe proved that waiting for a child dependent on its still
LOADING provider returned PENDING, so the stages must remain separate. Consumers
must inject this gate as well as their actual service dependencies: YAML row order
or early service publication is not evidence that async Identity init completed.
All disconnect/abort/failure listeners belong to original Context effects.

The CLI automatically reads Profile and home patches. Tests and this optional
assembly use a fresh Main-owned 0700 home, empty bundles and one fixed reviewed
provider Group, with no additional home patches or user expressions. They do not
boot the personal/default Web base, generic tools, Gateway, MCP or auto-review.
No Loader.create persistence is introduced. Source verification alone does not
establish target OS confinement or remove file mutation/TOCTOU risks.

The Core phase reuses the same fixed row factory as the original headless
assembly. Main writes those known original Loader entries into the managed
Profile before spawn. Each entry explicitly injects Identity readiness. The
final Core consumer requires all actual Core services before publishing readiness.
It performs no boot, dynamic Loader entry write or arbitrary plugin lookup.
Actual slice07 proved nested ctx.plugin of StorageDomain failed the official
injection guard; that failure is preserved. Static original Loader entries retain
the existing per-entry injection owner instead of bypassing or widening the guard.
In the private Group the original StorageDomain backend callback also needs the
storage-domain row's explicit `storage` dependency; Loader merges row dependencies
into the nested backend fiber. Actual slice12/13 then built and ran both CLI tests
successfully. Group/storage rows are unchanged and no root storage is exposed.
Original AgentLoop's createScope has the same nested-fiber boundary. Actual
slice21 classified the official sessionProjections injection guard; the fixed
agent-loop row now explicitly carries its unchanged six original static inject
dependencies. Slice23/24 ran original Agent/read/render/model and Main Recovery
successfully, including failed/lost ACK and disconnect/restart tests. Temporary
test-only structural diagnostics are removed from the final fixture.

The final provider registers the original public `appReady.onReady` callback as a
Context effect and returns ACTIVE. It cannot await appReady inside initialization:
the CLI commits that signal only after the original boot/Loader audit succeeds.
The optional Main process owner waits for a fixed bounded stdout readiness marker
from this callback plus the private IPC handshake. It does not infer launcher
readiness from early service presence or create a second startup state machine.
The new optional `EnterpriseCliHost` is a Main-only assembly component, not wired
into the current default Electron lifecycle. It resolves the existing public CLI
and provider exports from one trusted local runtime Profile, creates an exclusive
temporary managed home under Main's Recovery cache, and writes the fixed patch
before spawning. No extra patch, module selector, environment secret, injected
callback or Renderer-supplied profile is accepted. Its capabilities remain
false/unavailable: component tests explicitly use the existing Main/IdP fixture's
separate proven-fixture capability switch. A source/helper path is not a signed
runtime/OS policy attestation. Those production prerequisites remain OPEN.
The 10-second component startup cap now starts when Main claims its child slot,
including preparation and the final fresh authority check. Abort-aware awaits
prevent any late result from spawning a child; any abandoned filesystem result
can only remove its own exclusive ephemeral home. Cleanup has bounded refusal
windows and retains the owner slot on unconfirmed failure. A timeout never means
the process stopped. The existing stopRuntimeTree remains the cooperative cleanup
helper: Windows taskkill and Linux descendant-exit confinement still require real
OS evidence, so default capabilities remain unavailable. Main's original Broker
already has an abortable 15-second server deadline; the shorter component startup
cap is an explicit assembly restriction, not a change to Run/model TTL.
The owner strips all case variants of prior HOME/USERPROFILE/HOMEDRIVE/HOMEPATH,
then installs the fresh managed HOME/USERPROFILE and exact DSH directories. It
creates private agents/tmp directories and replaces all prior TEMP/TMP/TMPDIR
case variants with that private tmp path, which shares ephemeral-home cleanup. It
keeps the existing approved environment allowlist and excludes NODE_OPTIONS,
proxy/private credential variables and caller-supplied preload options. Model
policy copies only the finite IPC's bounded provider/model/maxTokens and optional
maxRequestBytes fields; no unknown config or Loader expression reaches the patch.

The first slice proves a real original CLI process, private scoped handshake,
awaited Identity readiness and one Main-owned read, then rejection and cleanup.
Later business execution uses original Core in that same scope, with the existing
publication ACK gate before tools/LLM. Tests are headless fixture evidence, not
Windows/macOS/Electron acceptance. Default enterprise start/capabilities remain
false/unavailable and refused.

CallerProof for HTTP/WS, full GUI/Conversation, app-scheme offline draft UI,
portable release closure, real native OS policy/signing and real IdP/model remain
separate OPEN items. Existing finite IPC cannot serialize a caller proof function
or opaque AbortSignal, and current account authority is not Browser caller proof.

Public evidence: frozen /tmp/afos-desktop-ipc-wiring-inventory/REPORT.md and source
manifest; public runProfile options omit prepare; async ctx.plugin is PromiseLike;
the official CLI test uses fourth stdio ipc and a normal Host observer. Existing
Web docs/PLUGIN-DELIVERY.md and HARNESS-OFFICIAL-DEVELOPMENT.md are absent in this
environment and are not claimed read. Complete handed-off specifications, AGENTS,
CLAUDE, public exports/types and actual source/probes are the available basis.
Parent's explicit D07 continuation supersedes the partial D01 ledger sequencing;
this decision does not mark any stage or acceptance complete.

Rollback withdraws the optional provider/Profile composition and reverses the
incremental local source patch. Existing Main Recovery/credentials/Sessions and
user files are retained. No publishing, production migration or external write.
