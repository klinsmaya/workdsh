# Private Main business IPC component

This optional component covers D03/D07/D08/D09 engineering. It does not activate
the Desktop carrier or pass target desktop acceptance. Default Electron
capabilities remain `ingressValidated:false`, `sandbox:'unavailable'` and refuse.

`attachMainBusinessIpc(endpoint, business, startSignal, bootstrap)` accepts an
already owned Node child channel and a real captured `business.hostSignal`.
`connectMainBusinessIpc` exposes fixed business operations in that child.
`bootEnterpriseIpcCore` then calls the existing public Core assembly: original
app-boot `boot.prepare` injects the proxy. No private desktop-host package,
`runProfile.prepare`, new public listener, Worker pool, Docker requirement, Remote,
MCP, Agent loop, model protocol or approval engine is introduced.

Main retains credentials, current authority, original publication leases,
Recovery drafts and durable event projection. Bootstrap carries only the
Main-owned protected Profile path, fixed model policy and authority snapshot.
The wire has exact version/kind/generation/call/method/argument fields and a fixed
finite business method table. Opaque domain identifiers follow the original bounded
contract; generation/tickets/stream IDs remain strict. Unknown methods, unexpected
fields, invalid data, old generations, malformed matching replies and disconnect
fail closed. Node IPC deserialization itself is not an OS memory sandbox.

Bounds are 8 MiB per JSON DTO, 8 pending calls, a trusted 10-second Main startup
and per-call deadline, 64 KiB model byte pulls, one model stream and a 4 MiB model
stream total. These are additional conservative limits of this optional IPC
component, rather than the original execution/provider contracts. Model decoding
still belongs to the existing adapter. Oversized values are refused during data
traversal before whole-value serialization. Provider/source exception text is
replaced with fixed error codes.

The original `AgentSetupCommit.commit():void` consumes only a child local ticket.
It remains synchronous and does not claim atomic cross-process publication.
Runtime awaits delivered Main publication ACK before its own followup, draft
creation or exact Agent admission. Captured lease, Host lifetime, exact original
Agent handle, pre-step, pre-tool monotonic guard and original LOOP LLM checks gate
execution. Main freshly checks authority for every granting action. A prepared ticket
expires at the Main authority deadline, capped at 10 seconds, and disposes the
original Main lease. A committed IPC publication expires at the earliest of the
fresh Main authority deadline, the same Main-owned Run deadline and 60 seconds.
The child renews only that committed ticket through the fixed private
`publication.renew` operation before expiry. Main rechecks current authority and
the exact Session/Run/project, without committing or creating another Agent.
Every renewal remains bounded by all three deadlines; it never extends the
server Run. Expiry, refusal, Host cutoff or a failed renewal closes the channel.
An admitted exact-ticket release only revokes: Main synchronously deletes that
lease, clears its expiry timer and disposes it before any fresh-authority await.
Renewal and release do not wait behind serialized business writes. Each renewal's
10-second call deadline captures its exact ticket and entry; if that entry has
already been revoked, the deadline aborts and removes only that pending request.
An active noncooperative renewal still cuts off the channel. The child clears its
local renewal timer on release or channel cutoff. Lost or failed ACKs never start
renewal, and a late reply or error cannot revive a disposed publication or cut off
a newer publication for the same Session/Run.
This timer maintains the original permission lease; execution still belongs to
the original Agent loop. It does not renew owned-history read grants or callers.

Same-realm synchronous capability signatures remain compatible. In the child,
synchronous reads use only the most recently ACKed immutable Main snapshot with
monotonic revision; synchronous writes refuse. Named `asyncAccess` awaits refresh,
edit, cancellation request and Session event writes. Runtime drains actual
original Session projection ACKs before releasing the original Main lease. Main
ignores late cancellation requests after a terminal projection. `stopped:true`
from a live Host RPC is rejected: original aborted turn/end yields durable
`interrupted`, without claiming independently confirmed process stop.

Parent owns original lease disposers even when a reply is lost or the child exits.
Caller cancellation, start abort, captured Host cutoff, failed startup and account
switch invalidate the channel; late replies do not revive snapshots or tickets.
The real two-process tests include original Loader/Agent/Session/tools/model,
Main/Broker/Recovery, lost/failed ACK with creation-listener wake, model cancellation,
malformed replies, noncooperative timeout, restart and account switch. A real
66-second original Core run exercises renewal across the old 60-second cutoff;
short-lived fork cases exercise revoked authority, a changed Run, release and
Host cutoff. The release regressions hold renewal across the original 1,500 ms
expiry and across its unchanged 10-second call deadline while a new ticket is
live. IdP, ACL and
model replies are fixtures. No Windows/macOS/Electron/safeStorage/confinement or
real external credentials are certified by those checks.

Remaining production work includes owning the actual private child channel and
bundle bootstrap in Desktop, Electron caller proof, native confinement, full
Renderer/Client wiring and Main-owned offline draft UI after Host exit. Main
production start remains refused. No D13/D14 business approval/save is enabled.
Rollback removes this optional composition/source patch and retains existing
Recovery, Sessions, namespace files, credentials and receipts.
