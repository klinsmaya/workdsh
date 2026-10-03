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
20-method business table. Opaque domain identifiers follow the original bounded
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
execution. Main freshly checks authority for every action. A prepared ticket
expires at the Main authority deadline, capped at 10 seconds, and disposes the
original Main lease. A committed IPC capability expires at the earlier of the
Main-owned Run deadline and ACK + 60 seconds; expiry cuts off the whole channel.
The 60-second cap is a new IPC restriction, not the owned-history read-grant TTL
and not a change to the server Run policy. Longer executions require a separately
reviewed renewal design before this component can serve them.

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
malformed replies, noncooperative timeout, restart and account switch. IdP, ACL and
model replies are fixtures. No Windows/macOS/Electron/safeStorage/confinement or
real external credentials are certified by those checks.

Remaining production work includes owning the actual private child channel and
bundle bootstrap in Desktop, Electron caller proof, native confinement, full
Renderer/Client wiring and Main-owned offline draft UI after Host exit. Main
production start remains refused. No D13/D14 business approval/save is enabled.
Rollback removes this optional composition/source patch and retains existing
Recovery, Sessions, namespace files, credentials and receipts.
