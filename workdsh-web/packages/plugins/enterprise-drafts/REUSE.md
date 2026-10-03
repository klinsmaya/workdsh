# AFOS-0006: original Client navigation readiness

## Main-owned local draft Client continuation (before implementation)

The authorized Source20 continuation adds an alternative public `./local-client`
face over the fixed preload `window.afosLocalDrafts.state/edit/subscribe` capability.
It reuses `DraftPanelModel`, `EnterpriseDraftPanel`, the existing strict DTO/hash
parsers, and the original main/sidebar Slot and Layout owners. The Client imports
no Connection, Session or Remote runtime. Main remains the account/project scope
and Recovery owner. The renderer forces every projection to offline/local-only,
and capability changes clear the view and editor scope before repulling. The
local panel renders no material/start/cancel/archive/native-navigation actions.
The public ModuleLoader artifact has id `workdsh-plugin-enterprise-drafts-local`;
`dsh.localClient` is owning-carrier metadata for selecting this alternative face,
not another Loader. Choose one drafts face for the shared Slot key. Validation
is local types, unit negative cases, original SlotRegistry and React SSR; actual
Electron/Chromium integration belongs to the carrier owner. No AT/P2 promotion.

Authorized continuation: user D08/D09 and Root's isolated P1 Client readiness
slice, based on source15 ed79a0fad2b8cce09a14b145b196b37959650ecd. P1/G3 remains
not passed; this decision adds no Main grant, remote method, execution owner or
transport. Formal mutation refusal remains the existing Host responsibility.

Before implementation, published DSH 0.1.7-rc.2/Cordis 4.0.4 public exports were
read and a real Chromium original UI graph was probed. The direct early-open
timeout and first positive were both retained; a successful sequenced probe was
not used to hide the race. The public artifacts and actual commands are frozen
in the separately delivered read-only full-client inventory.

| Owner / public entry | Reuse and constraint |
| --- | --- |
| `dsh-client-connection/client` | Read/subscribe original generation, consume reset; never register a second generation source or start loop. |
| `dsh-api-remotes/client` | Only original generated `session.list({}, signal)` is invoked. The Host supplies current ownership, not a Client assertion. |
| `dsh-api-session-controller/client` | Public refresh/list, `retain`, `SessionReference.ready/binding/release`, Session snapshot and `binding(id)`; consumer-labelled reference only. |
| `dsh-client-ui-workspace/client` | Original `openSession` synchronously retains the view before temporary reference release. |
| `dsh-client-ui-slots` / renderer | Keep the existing formal main/sidebar Slots and original SessionProvider/Conversation; no copied renderer. |
| `workdsh-ui` | Existing Button/status presentation for pending/cancel/error. |

Decision: operation-local cancellation waits original ready; new Main business
selection and fresh generated read must match the captured project/draft/Session.
The direct read is not the original Controller's catalog: await its public
refresh and subscribe to its actual Host-member ids/byId before retain. A settled
ready is not proof of open success: inspect original openState/error/removal and
binding identity. Recheck original generation/selection after every await.

The initial reset may temporarily remove the Main UI projection while a request
still awaits its first generation; only a fresh matching projection can resume
it. Changed nonfirst selection refuses. After binding a generation, reset/loss/
replacement cancels; cancel, supersession, offline/error, view/module disposal or
bounded deadline also cancel. No readiness cache is authoritative. The original
owner's shared baseline/open is not cancelled by another consumer's signal.

Component tests and real Chromium cover this path with published original
ModuleSystem/Loader/frontend and physical HTTP/WS synthetic fixtures. MainIPC
and NativeWS joint desktop activation, actual Renderer proof, target OS, signing
and real model/IdP/NocoBase remain unverified. Full native read-only affordances,
including the Sidebar New Session action lacking a separate public disable Slot,
remain open. Original cached history may survive generation loss.

Rollback: withdraw this Client contribution or reverse its local source patch;
official feature disposal cancels operations, releases consumer references and
unregisters Slots. No durable data, original Session log or schema changes occur.
