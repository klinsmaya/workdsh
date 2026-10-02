# Official reuse record

- Tasks: D01/D04/D05/D07/D08/D09/D10; business delta is fixed enterprise ownership,
  pins, draft UI and admission. Formal desktop acceptance remains unpassed.
- Pinned public packages: DSH 0.1.7-rc.2; Cordis consumer 4.0.3; pnpm10.34.5.
  Official peers ~4.0.4 remain a compatibility gap; no private source is imported.
- Loader: public app-boot `boot` with exact absolute published entries, no home
  patches, JSON-only fixed rows, protected namespace, required-service checks,
  unique lifecycle-owned generated config. No second Loader or plugin framework.
- Session/Agent: official `agents.create` setup/commit/handle, exact AgentRegistry,
  `agentPresets.mount`, public `Agent.followup/cancel/whenIdle`, Session events and
  JSONL persistence. Main publishes the owned Run binding before an Agent becomes
  usable; cleanup covers failed setup. No execution or Session state machine.
- Skill: bundled Markdown registered with official Skills; public `scopeOf` and
  scoped lookup, `renderSkillContent`, SystemPrompt sections. No parser fork or
  duplicate prompt source. Pack resources are included.
- Model: public LlmAdapter/registerAdapter/llm-stream waterfall; original LOOP
  identity validated before official message/tool projection, exact active Agent
  and current Main Session/Run checked again before/chunkwise dispatch. Existing
  AFOS adapter/SSE stays the sole fixed business wire; no route discovery.
- Tools: official native mode/guard/pre-execute/body/result pipeline. Exactly two
  definitions; same-name shadows and expanded inventory deny. Original lifecycle
  and call signals retain ownership, including around-wrapper replacements.
- Identity/Access/Audit: contracts and injection into existing providers/services,
  no horizontal implementation imports. Main snapshots do not mint admin roles.
- Connection: sole public `/api` interceptor, browser auth and loopback server;
  no new HTTP/MCP/Remote transport. Actual authenticated HTTP and physical raw WS
  probes deny unmounted generic endpoints. No retrofit of a default profile.
- UI: implemented independent enterprise-drafts Client uses official paired Slots,
  ModuleLoader artifact, native session open and shared controls. Full native
  Conversation/Client assembly is still a separate uncompleted engineering item.
- Evidence: 20 admission cases and seven actual official Loader/AgentLoop cases;
  identity/server/model replies remain fixtures, not target desktop AT passes.
- Lifecycle: official effects/events/adapter ownership; Main synchronous revoke,
  coalesced asynchronous Host exit, predecessor Host callbacks invalidated. New
  account or Host waits for exit. Private facade never serializes credentials.
- Rollback: withdraw optional composition/revert local code and locks, retaining
  Profile, Session, owner, namespace drafts, credentials and receipts. No upstream
  or production changes are authorized or performed.
