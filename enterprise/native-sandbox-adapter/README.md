# AFOS native sandbox adapter

Private version `0.1.0-alpha.1`, task **D06**, inactive foundation. [中文](README.zh-CN.md). The desktop carrier, existing Profiles and pinned upstream source are not modified by this module.

This module compiles a trusted Broker's per-run filesystem/environment policy and reuses the public DSH subprocess handle. It creates a separate SRT manager Worker for every invocation. All policy objects are immutable, no global `updateConfig` is used, and live runs cannot share writable/input roots or expose each other through runtime read grants. The default network policy is deny-all. Configurable tool environment, URLs, shell executable and arbitrary filesystem roots are rejected. Ambient environment entries are explicitly removed before the official DSH provider's environment merge.

The public SRT manager is used at exact npm version `0.0.78`. Its research source and published artifact are recorded separately in [reuse evidence](REUSE.md) and [compatibility evidence](evidence/compatibility.json). The module depends only on the published DSH `0.1.7-rc.2` subprocess interface. It installs no second process runner, Agent loop, tool protocol, MCP transport, approval engine or privileged service.

**The production capability result is deliberately `partial` or `unavailable`; `execute` refuses both.** Positive dependency checks are not enforcement evidence. This module does not yet certify file/link races, raw TCP/UDP/IPv6, local sockets, all managed descendants or every enabled desktop tool path. A future native backend must establish those conditions before returning `full`. Injected full backends are used only by offline tests and are not configuration supplied by a model, Renderer or material.

Process isolation cannot certify Host file operations, PTC, browser partitions, model HTTP or desktop IPC. A path inventory that includes those routes, or omits the inventory, is rejected. stdio MCP and local scripts are only eligible when their actual subprocess launch travels through this adapter and the native boundary has been proven. Existing SDKs that spawn outside this route remain uncovered. An enterprise Profile must not be activated based on this module alone.

`compileNativePolicy` accepts canonical existing input, workspace, temporary, fixed dependency and protected Host directories. Input/workspace/tmp must be distinct; symlink/junction ancestors, hardlinked files and nonregular run-tree entries are rejected. These checks do **not** claim to prevent a later concurrent path replacement or prove that supplied materials came from an authorized server. Trusted snapshot materialization and real OS enforcement remain required.

`NativeSandboxBoundary.execute` prepares a fixed descriptor and calls the supplied official DSH `spawn`. It consumes `done`, calls `terminate`, and awaits the same managed range's `waitForExit` before SRT reset. Cancellation and disposal share invocation completion; pending preparation cannot publish resources after disposal finishes. Failed preparation carries an owned cleanup lease. Unconfirmed range/reset cleanup retains the run roots and manager for recovery and refuses reuse. SRT's public `reset` completion alone does not prove every native helper exited; that evidence is still required and is one reason capability remains partial.

| Platform | Observed prerequisite result | Product enforcement |
| --- | --- | --- |
| Linux x64, this AFOS container | bubblewrap `0.12.0`; functional namespace probe exits `1` with read-only uid map; socat absent | **BLOCKED**; unconfined fallback denied |
| Windows | No target machine; no sandbox account, ACL, WFP or CA installation performed | **NOT_RUN**; initialization refused |
| macOS | No target machine | **NOT_RUN**; no full capability declaration |

Commands from this directory use the pinned `pnpm@10.34.5`:

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run probe
```

The first install generated the checked-in lockfile without lifecycle scripts. Build/typecheck and 18 local tests passed. `probe` exits `2` for partial/unavailable and prints only fixed capability diagnostics; that exit is evidence of refusal, not a passing security acceptance. Tests N01–N13 and N16–N18 use injected lifecycle fixtures; N14 uses the real public SRT probe and N15 runs two ordered real Worker operations. All are support evidence, not Windows/macOS or desktop acceptance.

Formal D06 **AT-12, AT-24–AT-30 and AT-32 remain NOT_RUN/BLOCKED**. Missing work includes the target OS native implementation and installation evidence, complete tool/provider integration, validated gateway/network policy, TOCTOU and descendant/helper adversarial probes, actual secret-exposure testing, and independent installed desktop acceptance.

Rollback: remove this isolated module or revert its local source change. It is not loaded by any runtime and creates no production tables, users, installed service or native grants. Tests remove only their own temporary fixtures. No upstream source patch, push, merge, release, deployment or privileged install is performed.
