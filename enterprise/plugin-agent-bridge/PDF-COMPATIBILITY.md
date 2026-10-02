# OfficeParser consumption compatibility

D12 scoped dependency repair, task `/root/afos_delivery_security_inventory`.

## Change and affected consumers

Keep NocoBase `2.4.0-alpha.9` and LangChain Community `1.1.29` fixed. The
published NocoBase AI document worker routes PPTX through the public
LangChain PPTXLoader / OfficeParser API. OfficeParser `8.1.0` replaces
`AST.toText()` with async `AST.to('text').value`. The consumer-owned pnpm
patch changes one line in each published PPTXLoader ESM/CJS entry and uses
public `onWarning`. The two exact scoped overrides select OfficeParser
`8.1.0` for AI and LangChain's optional peer. Official pnpm
`patchedDependencies` records the patch and its lock fingerprint.

No upstream checkout, NocoBase worker/private implementation, core upgrade
or new loader/Agent engine is changed. DOCX still uses Mammoth, XLSX still
uses SheetJS, and PDFLoader still uses `pdf-parse 1.1.4` with its separate
bundled PDF.js `1.10.100`. The last route is an **open independent risk**;
this OfficeParser repair does not update or declare it safe.

## Actual local validation

A clean install of this exact candidate using pnpm `10.34.5`,
`--ignore-scripts --frozen-lockfile --offline`, succeeds. Six actual Node
and Linux Chromium tests pass. They exercise the unchanged AI worker on
rich DOCX/XLSX/PPTX/PDF fixtures, both public PPTXLoader exports, malformed
and blank input, Document content/metadata, the public OfficeParser Node
API, and the shipped browser bundle with the actual PDF.js worker.
The browser tests parse all four formats in two separate cold contexts.
Rich fixtures contain tables, images, Chinese text, spreadsheet formatting
and cached formulas, slides/notes and a two-page PDF. The generated blank
PPTX has an automatic page-number note; the existing worker's result `1`
is preserved. Tests do not claim reproduction of a security exploit.

The active graph contains OfficeParser `8.1.0` and PDF.js `6.2.108`, with no
OfficeParser `6.1.1` / PDF.js `5.6.205` lock entries. All five official browser
artifacts lack the old embedded version. Registry audit returns zero
advisories for this candidate's 666 dependency graph. That result measures
the registry graph, not separate opaque engines, a deployed application
or overall product security. GHSA-hq66-cqwq-w95j's OfficeParser dependency
path has been removed in this graph.

The initial exact SheetJS `0.20.3` vendor tarball entry lacked integrity.
The official URL/version and bytes are unchanged; only its verified SHA512
integrity was added to the isolated lock. The verified public cache capsule
and integrity-only delta are separate deliverables.

## Serial integration and activation

Apply the minimal source patch to the authorized consuming workspace;
retain its current unrelated changes and regenerate **its** Bridge lock.
Do not overwrite it with this candidate's older whole lock. Keep the two
exact overrides, public patch file and patchedDependencies mapping together.
Then run frozen install, `pnpm test:documents` and official registry audit
on the integrated graph. Browser tests need the existing Web workspace's
pinned `@playwright/test` (or `AFOS_DOCUMENT_BROWSER_TOOLS` pointing to its
package.json) and `AFOS_TEST_CHROMIUM` selecting local Chromium.

These are pnpm workspace settings for the local Bridge SDK consumption.
A separately installed NocoBase app does not inherit them by installing a
Bridge plugin tarball. The real application consuming workspace must apply
and verify the same exact public compatibility patch and overrides before
activation; that installation is UNKNOWN here. No plugin release or
application activation is performed.

Windows/macOS, Node22, the full packaged Shell, deployed NocoBase/database,
IdP/model/commercial plugins and malicious-document security testing remain
NOT_RUN/UNKNOWN. Native Forge has a separate advisory without a published
fix. D12/AT-52 and P1G3 remain BLOCKED; AT-50/51 are not upgraded.

Rollback this isolated source delta and regenerate the consuming lock from
its saved baseline. The original OfficeParser dependency is vulnerable, so
rollback must retain the activation block. Preserve independent runtime
issues and user changes. No production migration or external business write
is involved.
