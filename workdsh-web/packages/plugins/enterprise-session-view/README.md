# Owned native Session read helper

This opt-in module wraps the installed original DSH SessionController through
its published Host definitions. It creates no Agent, Session history, renderer,
loader or carrier. It is not included in the enterprise Profile by default.

Main supplies the privately composed original controller, the current owned live
Agent/Session identities, an epoch, a revocation signal and a synchronous ingress
assertion. The assertion must cover HTTP, authenticated WS, direct Gateway calls,
direct shared Fetch/app-scheme dispatch and any forwarded event feed. Main derives
this short-lived read authority from its fresh actor/project check and owned
Draft-to-Session mapping; an old Run's execution lease is not required. Passing an assertion that does not
prove those boundaries is not an activation decision made by this module.

Only native list, page, follow, projections and control reads are allowed for the
current owned live Session. Identity and authority are checked before delegation,
after reads settle and before each yielded frame. Revocation and caller signals
are combined using the standard AbortSignal API. All other original Session
endpoints refuse with `afos/session-view-read-only`; fileReferences, skills,
uploads, attachments, path opening and search are not enabled by this helper.
The original protocol's wire/result codecs and stream cancellation are reused.
Disposing the installation aborts its own lifetime before unloading definitions.
The owner Context's disposal also revokes that lifetime. Cached references,
pending reads and existing streams cannot keep returning data after disposal.

The original native Client/Conversation still has mutation controls. The UI has
no published complete read-only switch in 0.1.7-rc.2. This helper refuses those
effects on the Host; it is not a claim that all such controls have been removed.
Cold Session reads are deliberately unavailable: original Controller follow can
promote a prepared ordinary Session into a live Agent after its opening frame.

Private Controller composition also registers `/api/file` and raw upload routes
on the shared Connection. A private Group does not remove those routes. Main
must deny them before calling `connection.createSharedFetchHandler('/api')`.
An HTTP-only `connection/request` listener does not protect WS or direct Fetch.
An aggregate native Remote event source may forward `api-session/*` events for
other Sessions. Main must select and filter the original event-source contribution
to current owned Sessions, or leave that event entry point absent. This module
does not register an event source or certify an existing one.
The current enterprise desktop Main activation must remain refused until its
complete admission and platform/identity checks pass.

`guardOwnedNativeSharedFetch(originalHandler, {baseUrl, signal, assertCurrent})`
is the public caller guard for Main's existing HTTP/app-scheme dispatch. Main
must pass the guarded handler to the carrier and use its `admit` before bridging
an HTTP request body. Only POST of the five literal native read paths at the
Main-owned application authority is admitted. Queries, fragments, encoded-path
variants, raw file/upload paths, mutations and all other methods are refused
before calling the original Fetch handler. The owner signal is forwarded, and
authority is checked again before returning a response. Fetch requests are
canonicalized with the standard Request constructor before admission, so
admission and forwarding use the same internal method, URL and caller signal.
An already cancelled caller is refused before delegation. This helper does not
register a second handler/transport, replace the official Connection registry,
or change the WS mux. Passing the original unguarded handler somewhere else
would reopen the measured raw-file gap.

The original isolated headless helper probes used the then-installed Cordis
4.0.3, below the official `~4.0.4` peer range. Those historical logs do not certify
peer compatibility. The subsequent owning WorkDSH workspace installs exact
Cordis 4.0.4 and tests this unchanged helper with the original native backend.
Neither probe constitutes Windows/macOS, native Provider binding, GUI, real IdP
or real model acceptance. See the Profile's NATIVE_READ_FORWARDING documents for
the actual integration scope and remaining carrier work.
Remove this module's contribution/fiber to roll back; no durable data migration,
profile change or package installation is part of this delivery.
