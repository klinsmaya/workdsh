# Published DSH public API probes

These scripts reproduce the read-only probes first run from `/workspace/workdsh/workdsh-web`. The recorded rerun uses the isolated `/workspace/afos-profile/workdsh-web` workspace. They import the installed published package entry points and public types; they do not modify upstream source or exercise a second Agent loop.

All three recorded commands exited `0`; standard error was empty. Probe-local `PASS` means that the assertion about an API was confirmed. **None of these results is a formal AFOS AT PASS.** Real enterprise authentication, revocation delivery, target Windows/macOS behavior, model credentials, and native containment remain outside the probes.

Run the following commands from `workdsh-web`:

```sh
node packages/providers/enterprise-profile/evidence/public-api-signal-interceptor-probe.mjs
node packages/providers/enterprise-profile/evidence/public-api-gateway-probe.mjs
node packages/providers/enterprise-profile/evidence/public-api-websocket-probe.mjs
```

Each command has a corresponding `.execution.json`, `.stdout.log`, and `.stderr.log`. `public-api-probes.execution.json` contains the combined record, including exact commands, timestamps, exit codes, and SHA-256 digests.

| Probe | Confirmed behavior | Limit |
| --- | --- | --- |
| Signal/interceptor | `HostConnectionService.rpc.intercept('/api', ...)` has one owner. A later `tools/execute` signal replacement defeats cancellation added only by an earlier wrapper. Authority cancellation fused into the captured caller signal prevents body dispatch. | The test calls official Tools directly; it does not establish full Agent lifecycle integration. |
| Gateway | Public `invoke`, `stream`, and `wireStream.open` all bypass an HTTP `connection/request` listener. Lookup/context policies each have a unique owner. | The Remote service and its policy are fixtures. |
| WebSocket | The real localhost Gateway `/api/remote.mux` upgrade opens without invoking an HTTP `connection/request` listener. | Browser authentication deliberately permits the fixture. No real enterprise authentication is asserted. |

The installed public declarations also expose only exact `WebServer.registerUpgrade()` registrations. There is no public global upgrade interception tap, and the raw server is private. Generic Gateway exposure therefore needs authorization in each exported effect owner or a restricted composition that does not load those exports.

Official Agent cancellation can reach the original Tools caller signal: the loop passes its phase abort signal to `ToolExecutionInput`, and public `Agent.cancel()` aborts that activity. An idle cancel does not prohibit a later wake, so stale input, `agent/pre-step`, and final effect admission still need denial. Current identity `actorSignal()` includes a short freshness timeout; it must not be mistaken for a permanent account cutoff signal.

No implementation, test, package manifest, or lockfile was edited by this evidence task. Removing only the `public-api-*` evidence files rolls back this task's additions.
