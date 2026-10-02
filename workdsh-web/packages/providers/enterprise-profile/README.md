# Fixed enterprise Profile integration

Version `0.1.0-alpha.1` is an inactive AFOS D01/D05/D07/D08 integration component.
It uses the published DSH `0.1.7-rc.2` Connection RPC registry and Tools pipeline;
it does not create an Agent loop, Session engine, model router or MCP transport.
The personal WorkDSH bundle remains separate.

`SnapshotIdentityAuthority` consumes a private Main callback for the fixed
`identity.current(projectId)` response. It verifies `afos.identity.v1`, the exact
issuer/subject/organization/device binding and project, current read permission,
server revision and UTC expiry no more than five seconds ahead on every call. It maps that evidence to the existing
canonical identity contract with a display-only member role and organization ID as
the display name. It grants only read/use of the actor's own personal Session;
business resources and edit/manage always return deny. The existing identity
provider still owns actor evidence and the existing Access service owns durable
Session owner records. A failed, malformed or changed server response permanently
cuts off this adapter. The callback receives no caller-selected token, URL or role.

`fixedEnterpriseComposition()` is a reviewed inventory fragment, **not a runnable
full Desktop Profile or generated Loader patch**. Its assertion accepts only exact
plain data; it rejects extra plugins, tools, user patches, PTC, gateway and public
bind addresses. It admits no shell, stdio MCP, browser, raw filesystem, config,
plugin installation or general controller capability. Native execution remains
unavailable. The Host launcher must assemble only this reviewed set and inject
trusted namespace storage configuration and bridge services before listening.
Complete official Agent/Client/preset assembly and pack validation remain pending.
`assertEnterpriseDesktopActivation()` therefore always refuses activation.

`EnterpriseProfileIngress` exclusively owns the existing Connection `/api` RPC
interceptor. It exposes only `afos/createSession`, `afos/readSnapshot` and
`afos/renderDraft`. Each payload has exact fields and bounded IDs/text/references;
generic Session restore/create, files, terminal, config, settings, plugin and MCP
RPCs return a stable denial. Creation delegates to a trusted adapter using the
existing Session Access bridge, then verifies its returned owner. Reads and draft
preparation require a current provider-minted actor, persisted owner and Access
decision. The injected Main bridge must independently verify the current run and
its exact pinned material hashes; it is not a generic network/filesystem proxy.
Text snapshots are hash-verified again and drafts remain `local-draft`.
There is no approval, archive, business save or external write RPC/tool here.

Only `afos_read_snapshot` and `afos_render_draft` are registered in official Tools.
A global monotonic guard rejects every other capability, missing Agents, failed
authorization and same-name scope shadows. Tool calls require the exact live
official AgentRegistry object, with an original signal registered by public
`agent/pre-step` or minted by the trusted dispatcher. Evidence is invalidated when
that Agent lifecycle is disposed. After this package registers its fixed tools,
any further `tools/change` synchronously cuts off the Host fragment, including a
late scope shadow installed by an execution wrapper. Each definition's body rechecks current
authority after asynchronous execution wrappers, then passes the combined cutoff
signal to the business effect owner and rejects late results. The trusted
`executeTool()` seam fuses authority into the original `ToolExecutionInput.signal`
before official dispatch, so later signal replacement cannot detach it. For an
official loop tool call, the pre-tool check subscribes its call-window authority
signal to public `Agent.cancel()`, which aborts the loop's original turn signal.
The call listener is removed on the Tools result and service disposal. A separate
stable Host cutoff listener calls `Agent.cancel()` between tools and during model
work; it has no actor freshness timer and is released on Agent/service disposal.
Tests exercise
the actual Tools machinery and AgentRegistry with fixture authority/cancellable Agent handles;
actual Agent-loop integration and remote account revocation delivery remain to be
verified. Existing actor freshness is one second by default, so the tool window is a
conservative call deadline, not a whole-run lifetime policy.

The public Gateway already occupies the sole RPC interceptor, and its WebSocket
and direct dispatch bypass HTTP `connection/request`. Public WebServer has no
global upgrade tap. This package rejects an already mounted Gateway and its fixed
inventory excludes that service and generic controllers. It **does not retrofit a
fully mounted default Profile** or claim all existing raw HTTP/WS/Remote routes are
closed. No UI buttons are used as the security boundary. Full raw-route closure,
trusted launcher/namespace wiring, real NocoBase identity and target desktop tests
remain prerequisites for activation and formal AT-03/13–18/20/22–23/33/35–39.

From `workdsh-web`, build `workdsh-contracts`, then run the package `build`,
`typecheck` and `test` scripts using pinned Corepack pnpm `10.34.5`. Twenty offline
tests cover fixed composition, current-authority mapping, raw RPC denial, scoped
tool shadows, cancellation replacement, revoked body entry, late response and
disposal, late registration and Agent lifecycle evidence. Three published-API probes document the real Gateway/WS admission gap.
Raw command outputs, exit codes, source hashes and independent review are under
`evidence/`; no fixture or Linux result is a formal desktop AT pass.

Rollback by removing this optional package/configuration and its private authority
adapter from the enterprise composition. Do not remove personal Home, existing
Session owner records, namespace outbox, credentials or user drafts. No remote
push, deployment, production migration or external business write was performed.
