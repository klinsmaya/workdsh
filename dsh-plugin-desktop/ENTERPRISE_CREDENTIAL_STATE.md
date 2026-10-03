# Enterprise credential storage state

D04 and AT-11 require an explicit memory-only sign-in state when operating-system encryption is unavailable, including Linux `basic_text`. Main keeps credentials private and records the current refresh-token persistence result only after its account generation is checked. Sign-in and project changes clear the old persistence state; stale writes cannot update a newer account.

The native account menu displays one finite state: signed out, credentials in memory for this session, or an encrypted refresh credential saved. Successful account actions also explain that memory-only sign-in requires signing in again after restarting WorkDSH. The presentation contains no token, account identifier, namespace, filesystem path or backend details, and adds no Renderer or Agent credential IPC.

Main privately observes authentication changes and persistence results so that background refresh or revocation also updates the native menu. A rotated token clears the old saved state before publication. Native observer exceptions cannot alter authentication or business authority; the menu subscription ends at application quit.

Controlled Main tests cover refusal without a vault file, refresh rotation into memory-only state, and a late old-account write. They do not establish real IdP or Windows/macOS acceptance. The final carrier AT-11 must also consume the real Electron unavailable/basic_text evidence and inspect its owned disk. P1 G3 remains unpassed until the original acceptance requirements are met.

Rollback: revert this slice's Main state and native menu presentation together; preserve the existing encrypted vault and local drafts. No data migration, dependency change, permission expansion or Host activation is part of this change.
