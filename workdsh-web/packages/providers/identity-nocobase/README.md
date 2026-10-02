# NocoBase enterprise identity provider

Version `0.1.0-alpha.1` implements an explicit Cordis `workdshIdentity` service and
current-authority hooks for the existing WorkDSH Access and Session bridges. It is
an inactive integration component, with local fixture coverage. AT-13 through AT-16
remain **NOT_RUN** for the actual enterprise desktop product.

The trusted Host must provide `afosIdentityAuthority` implementing the exported
`NocoBaseIdentityAuthority` contract. The adapter must verify the current NocoBase
access grant, active user and membership, device binding, and record/field ACL on
every call. The provider never handles OAuth tokens, decodes JWTs, implements
login, stores enterprise members, or substitutes a local role when the server is
unavailable. There is no guessed HTTP endpoint or default authority adapter.

One Host binds one immutable issuer/subject/organization/device tuple. Its SHA-256
namespace is suitable for separately provisioned Profile/Home/cache/outbox roots;
this package does not create those directories or move existing personal data.
Identity switching requires stopping the old Host and its connections, then
creating a new Host with the new namespace. Calling `cutoff()` permanently rejects
this Host's actors and aborts in-flight authority reads; late responses cannot
restore authority. Controlled operations must use provider-minted actors, and
copies or forged actors fail validation.

Compose the existing AccessManager with `{ enterprise: true }` and the existing
ToolAccessBridge with `autoBindPersonalSessions: false`. Enterprise Access checks
current server permission even for an owner and refuses local grant management.
SessionAccessBridge persists its existing owner record before calling the official
Session controller, rejects creating an existing Session, and checks current
permission before resuming it. No second Session or execution engine is added.
The official synchronous monotonic tool guard rejects calls without an agent,
without a successful check, or with a stale actor after later asynchronous policy.
An official around-dispatch hook also fuses the call signal with Host cutoff and
the authorization deadline, requesting cooperative cancellation. Approved around
wrappers must retain that signal; a later wrapper that replaces it can bypass this
relay because DSH only re-fuses the original caller signal before the body. Trusted
ingress must fuse the authority signal into that original caller signal before
activation, or an independently verified official final-body guard is required.
That full boundary is unfinished; this package does not claim it is protected.

Freshness defaults to one second and cannot exceed five seconds or the grant
expiry. The window starts before the authority request, and delayed responses
cannot renew it. This bounded check does not stop arbitrary tool code already running or
erase downloaded plaintext immediately after server revocation. Every subsequent
controlled operation rechecks current server authority. Raw Remote, file and
WebSocket ingress still need full protection; carrier account switching, namespace
directory provisioning and outbox integration are unfinished. Do not activate an
enterprise Profile until those paths and the real NocoBase adapter are verified.
This package is absent from the personal bundle and defines no automatic Loader patch.

Build with the workspace's pinned `corepack pnpm --filter
workdsh-provider-identity-nocobase build`, then run the package test command after
building `workdsh-plugin-access` and `workdsh-plugin-audit`. Tests exercise real
published Cordis/DSH services and temporary JSON Storage Domain with a fixture
authority and Session controller; they do not constitute Windows/macOS or deployed
NocoBase acceptance. Remove this optional service/configuration to roll back; keep
namespace data and official Session owner records unchanged.
