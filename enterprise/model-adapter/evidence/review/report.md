# AFOS D10 model adapter independent read-only review

Reviewed on 2026-10-02 UTC. Repository: `/workspace/afos-model/enterprise/model-adapter`.

Final conclusion: the issues reproduced in the initial and first revised source snapshots have been addressed in the final reviewed source. Independent compilation and **25 focused offline baseline regression assertions passed**, followed by independent compilation and **3 targeted checks of the only subsequent source delta**, all passing. This conclusion covers the frozen source and injected fixture boundaries only. It does not establish formal AT-34/45/46/47 completion, a production gateway, durable billing transactions, commercial licensing, or Windows/macOS installation behavior.

## Scope and method

- Read repository `AGENTS.md`, D10 in `02_IMPLEMENTATION_TASKS.md`, and exact AT-34/45/46/47 in `03_ACCEPTANCE_MATRIX.md` under `/workspace/afos-handoff/specs`.
- Read `src/{adapter,contracts,gateway,stream,index}.ts` and the installed official `@deepseek-ai/dsh-llm` / `@deepseek-ai/dsh-llm-deepseek` `0.1.7-rc.2` implementation and declarations.
- Confirmed relevant official public source at the pinned tag: [DeepSeekAdapter](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.1.7-rc.2/packages/llm/llm-deepseek/src/adapter.ts), [Messages translation](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.1.7-rc.2/packages/llm/llm-deepseek/src/translate.ts), and [LLM public types](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/dsh-v0.1.7-rc.2/packages/llm/llm/src/types.ts).
- Copied source into `/tmp/afos-model-security-review` and two subsequent snapshot directories, compiled there with the installed TypeScript compiler, and exercised actual official DeepSeekAdapter calls through a replaced global fetch returning controlled Responses. No repository source file was edited by this reviewer; no commit was made.
- All credential/error strings in fixtures are explicit fake markers. No live vendor request or actual secret was used.

## Findings and final verification

| Finding | Initial location | Reproduction | Final reviewed behavior |
| --- | --- | --- | --- |
| Missing provider counters became an authoritative zero bill | `gateway.ts:127-133`, upstream translator initializes the two aggregate counters to zero | Valid Messages SSE with `message_start.message.usage = {}` and no later usage counts produced a `known/provider` settlement of 0 tokens | Gateway omits an unproven usage chunk and settles `usage.status = unknown`; uncertain reservations remain charged |
| Cleanup exceptions bypassed error sanitization | `gateway.ts:148-149` | Provider failure followed by ledger `settle` throwing `FAKE_LEDGER_SECRET_DO_NOT_FORWARD` escaped verbatim | Consumer receives a static `MODEL_PROVIDER_ERROR`; no fake secret in output |
| Cancellation blocked on finishing settlement, then emitted finish after cancellation | `gateway.ts:132-136` | Hold settlement promise, abort caller, wait 80 ms; original remained pending and yielded finish after releasing settlement | Consumer returns `ABORTED` within the 80 ms fixture bound; no finish chunk is emitted |
| Late successful reserve was orphaned after cancellation | `gateway.ts:95-97` | Abort while delayed reserve is pending, then let reserve commit | Late reserve retains owned promise and reconciles through one settlement; fixture counted `settled = 1` |
| Lease expiry did not stop idle vendor IO | `gateway.ts:71-86` | Expire lease while fetch is waiting without a chunk | Stable vendor signal is aborted by expiry timer |
| A spoofed LlmError name exposed transport errors | `adapter.ts:59` | Inject Error named `LlmError` with fake secret text | Static `MODEL_TRANSPORT_ERROR`; injected message/cause is discarded |
| Refreshed tool ACL was ignored when checking generated tools | `gateway.ts:125-126` | Initial lease permits tool, subsequent leases remove it, request omits its declaration, vendor emits that tool | Output rejected with `MODEL_TOOL_DENIED`; generated tool must be currently allowed and declared by the request |
| Already cancelled calls still started dependency promises and left rejections unhandled | `stream.ts:80-81`, adapter/gateway abortable call sites | Already aborted signal plus rejecting `authorize` / `assertCurrent` | Neither dependency starts; both consumer errors are `ABORTED`; zero unhandled rejections |
| Later lease revocation signals could not interrupt an existing fetch | First revised `gateway.ts:85-88` | First authorize returns live signal A; later authorizations return signal B; abort B while vendor waits | Every lease signal is registered against stable controller; vendor aborts and consumer returns `ABORTED` |
| Decoder accepted content after usage | `stream.ts:116-122` | SSE sequence usage → text-delta → finish | Rejected with `MALFORMED_MODEL_STREAM` at the standalone decoder |
| Canonical DTO accepted array enum values through String coercion | Initial `contracts.ts:87` and `stream.ts:35` | JSON `role: ["user"]` or `blockType: ["text"]` | Both rejected with `UNSUPPORTED_MODEL_CONTENT` |

Additional verified boundaries: default/omitted execution authorization is disabled before authorize/key callbacks; forged client usage, provider, endpoint, credentials, headers, actor, organization and run role are refused; the in-memory fixture admits only one of two concurrent 110-token reservations under a 150-token limit; unknown usage retains that reservation; terminal error failure and replay details are stripped; missing SSE finish is a truncation error.

## Remaining integration requirements and limits

1. The mounted trusted authorizer must derive principal, scope and allowed tools from current server identity/ACL/run state and actively abort returned lease signals on revocation. Rechecking at checkpoints alone cannot retroactively prevent a request dispatched concurrently with revocation. A fixture changing an `allowed` boolean inside mock fetch demonstrates that integration requirement; it is not evidence that a real authoritative revocation service was tested.
2. `InMemoryModelUsageLedger` is explicitly an offline fixture. Production atomic reserve/settle, crash recovery, ambiguous transaction acknowledgments and cross-process concurrency remain unverified until a durable server ledger is provided. Cancellation must not erase conservatively charged pending/unknown reservations.
3. The pinned official translator cannot distinguish omitted aggregate counters from genuine zero values. Current treatment requires positive input and output counters before reporting known usage; legitimate zero or fully cached calls may therefore remain conservatively unknown. No pricing source is configured, so cost remains unknown.
4. The public block/string and SSE byte bounds deliberately refuse oversized content. Images, native files, provider replay and unsupported content are refused rather than sent through an alternate route. These refusal checks do not establish that all real business sessions fit the configured limits.
5. Real gateway/OAuth/NocoBase ACL and license environments, live provider billing/results, malicious-material complete business tasks, and OS installation hosts were not supplied. AT-34 business-material grounding/no exfiltration, AT-45 actual audit authority, AT-46 full DSH/server receipt consistency, and AT-47 durable production budget accounting remain outside this review's executable scope. They must not be recorded as formal AT passed based on these fixtures.

## Evidence and reproducibility

Initial failing evidence and immutable source: `/tmp/afos-model-security-review/{src,dist,results.json,results-extra.json,results-abort.json}`.

First revised evidence: `/tmp/afos-model-security-review/revision-1/` (confirmed initial repairs and reproduced the remaining preaborted/replaced-lease issues).

Baseline source and 25-assertion artifacts: `/tmp/afos-model-security-review/revision-2/`.

Final frozen source and targeted delta artifacts: `/tmp/afos-model-security-review/final-freeze/`.

The final freeze comparison found exactly one source change after the 25-check baseline: `stream.ts` checks `signal.aborted` again inside the scheduled thunk microtask before starting `operation()`. Independent targeted checks verified cancellation between the first guard and that microtask starts zero operations; a live thunk still starts exactly once and resolves normally; an already started rejected promise under a preaborted signal still creates no unhandled rejection. `final-freeze/results-microtask-abort.json` records all 3 passing checks, SHA-256 `0cc67dbec2173735aa77c1dc65ea4781d04c434ce06591c48ee2eee6c9eec62a`.

The final README English/Chinese and REUSE text was also read. It explicitly states active server revocation, atomic durable ledger/crash reconciliation requirements, conservative zero-count treatment, token-budget versus unknown monetary cost, unsupported content, offline-only evidence, and formal D10 cases remaining `NOT_RUN`. These statements match the limitations recorded above.

Run from any directory:

```sh
/workspace/afos-model/enterprise/model-adapter/node_modules/.bin/tsc -p /tmp/afos-model-security-review/revision-2/tsconfig.json
node /tmp/afos-model-security-review/revision-2/reproduce.mjs
node /tmp/afos-model-security-review/revision-2/reproduce-extra.mjs
node /tmp/afos-model-security-review/revision-2/reproduce-abort.mjs
node /tmp/afos-model-security-review/revision-2/reproduce-livelease.mjs
node /tmp/afos-model-security-review/revision-2/verify-boundaries.mjs
node /tmp/afos-model-security-review/revision-2/verify-strict-arrays.mjs
/workspace/afos-model/enterprise/model-adapter/node_modules/.bin/tsc -p /tmp/afos-model-security-review/final-freeze/tsconfig.json
node /tmp/afos-model-security-review/final-freeze/verify-microtask-abort.mjs
```

`revision-2/regression-assertions.json` records 25 named assertions, all passing. SHA-256: `6dc1286efe1804ce2672f2a0d6a7e28f1b8bfe6cd7bb72d227043bebe7d758e4`.

Final reviewed source SHA-256:

```text
159657a1542338dae8b486b522ae7c34f9575668dfd145f2d9ecef4687e6700d  adapter.ts
b002ed489cae5c9cc92e82f841708d35400becff1077faf438ee7b434ae591d8  contracts.ts
ef4cf02bcec37758ea38b9b966df6bef6418159b96120c664332838c48ec42ad  gateway.ts
ec09cee2198d5fa20b3127b2d6497f46e62d0bf2cd706b5d0708dcdbd6229124  index.ts
f97ae358d942394ba8d16c6fb5e2ddeaccc0ee9f9b037ec4c6737fecf1972f36  stream.ts
```
