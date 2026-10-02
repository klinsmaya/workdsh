# Official reuse record

- Task IDs: D01 prerequisite repair; D05/D07/D08 integration support.
- Formal AT IDs: AT-03, AT-13–18, AT-20, AT-22–23, AT-33, AT-35–39.
- Current implementation state: inactive source integration; formal AT NOT_RUN.
- Public packages: pinned DSH 0.1.7-rc.2; workspace Cordis 4.0.3 and pnpm10.34.5.
- Connection: root export `HostConnectionService`, public
  `HostConnectionHandle.rpc.intercept('/api', matches, handler)` and
  `createSharedFetchHandler('/api')`. It owns envelopes, peer and lifecycle.
- Tools: root export `ToolRuntime`/`ToolDefinition`, public `guard`, `get`,
  `register`, `execute`; existing pre-execute/execute/result events. It owns
  scheduling, immutable caller cancellation, output and execution facts.
- Scope: public `createScope` used only in the independent scoped-shadow test.
- Agent: public `Agent.cancel({kind:'hook',reason})`, verified published type and
  loop source ownership. This package adds only a call-window listener; tests use
  the actual `AgentRegistry`, but its live Agent and pre-step event are fixtures,
  not actual Agent-loop acceptance. Exact registry handles plus signal/lifecycle
  evidence deny manual unregistered callers; late tools changes cut off dispatch.
- Existing WorkDSH contracts: type-only EnterpriseBinding/current authority,
  identity and Access/RuntimeBinding interfaces. No horizontal feature imports.
- Business differences: fixed current project identity mapping, exact finite
  admission, pinned text and local draft domain operations. Trusted Main owns
  credentialed transport/current run; existing Access owns Session owner records.
- Probe limitations: Gateway HTTP interceptor does not cover WebSocket/direct
  dispatch; WebServer exposes no global upgrade admission tap. Fixed fragment
  excludes Gateway; no retrofit default Profile or fabricated activation.
- Compatibility: package family versions are pinned. Published packages may
  declare newer Cordis peer ranges than the repository's override. Real packaged
  runtime/public peer compatibility and enterprise assembly remain NOT_RUN; no
  silent peer upgrade or second installed DSH is part of this source change.
- Lifecycle: official registration effects and events own guards/tools/RPC;
  cancellation listeners are explicit effects released on result/disposal.
- Rollback: remove optional composition/source; preserve all user data and owner
  records. No upstream or production changes.
