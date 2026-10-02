# AFOS dependency remediation / AFOS 依赖修复

Recorded on 2026-10-02. These are **consumer overrides**, not upgrades of the
pinned DSH or NocoBase release. No upstream checkout was modified. The Web
workspace and the independent bridge retain separate lockfiles.

记录于 2026-10-02。这些变更是消费方定向 override，不代表 DSH 或 NocoBase
基线已经升级。上游 checkout 未修改；Web 与独立 Bridge 保留各自锁文件。

| Consumer / 消费方 | Resolved patch / 精确修复版本 |
| --- | --- |
| Web: nanoid 5.1.11 | 5.1.16 |
| Web: postcss-selector-parser 7.1.0 | 7.1.3 |
| Web: fflate 0.8.2 | 0.8.3 |
| Web: @ai-sdk/provider-utils 5.0.0 | 5.0.1 |
| Web: fast-uri 3.1.7 | 3.1.8 |
| Web: ip-address 10.7.0 | 10.7.1 |
| Web: brace-expansion 1.1.18 / 2.1.4 | 1.1.21 / 2.1.7 |
| Web: dompurify 3.4.15 | 3.4.16 |
| Web: @grpc/grpc-js 1.14.4 | 1.14.5 |
| Web ExcelJS 4.4.0 / Bridge Sequelize 6.37.8: uuid | 11.1.1 |

`uuid` crosses major versions. Version 11.1.1 retains CommonJS; the actual
ExcelJS and Sequelize consumers use the tested zero-argument `v1`/`v4` API.
Do not replace it with a floating latest. Version-specific overrides preserve
other already safe versions of each dependency.

`uuid` 跨大版本。11.1.1 保留 CommonJS；实际 ExcelJS/Sequelize 调用的是已测试的
无参数 `v1`/`v4`。不得改为浮动 latest。其他消费路径已经安全的版本不被这些
针对原漏洞版本的 override 替换。

Headless checks include the Office browser/Host build, document and workbook
content tests, and Bridge build/tests. Reproduce the audit from each owning
workspace with `corepack pnpm audit --json --registry=https://registry.npmjs.org`.
Audit results are time-dependent; retain the command, raw result, lock digest
and date alongside delivery evidence. Registry zero findings do not establish
desktop, sandbox, identity, business ACL, or license acceptance.

无界面验证包括 Office browser/Host 构建、文档和表格内容测试、Bridge 编译与测试。
分别在所属 workspace 执行上述审计命令，保留原始结果、锁摘要和日期。审计零发现
不等于桌面、沙箱、身份、业务权限或许可验收通过。

Remaining at this milestone / 本阶段仍未关闭：

- ExcelJS 4.4.0's official browser `dist/exceljs.min.js` embeds an older UUID
  implementation. The Node dependency override does not replace those bytes.
  The actual Office client consumes that precompiled bundle; isolated execution
  confirms that its `v3`/`v5` output-buffer range checks remain vulnerable.
  npm audit's zero findings describe its dependency graph, not this bundle.
  ExcelJS 浏览器预编译包仍内嵌旧 UUID；Node override 和零审计均未关闭该问题。
- Bridge's NocoBase → AI → OfficeParser graph contains PDF.js 5.6.205.
  [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j)
  requires 6.2.108. A transitive override cannot replace PDF.js embedded in
  OfficeParser's browser bundle. The tested 8.1.0 candidate removes the `toText()`
  API used by the pinned LangChain PPTXLoader and fails that consumer test;
  it needs a reviewed consumer migration and bundle verification.
  P1's own draft preview is plain text.
  Bridge 的间接 PDF.js 漏洞仍在；不得把简单文本探针或纯文本预览当作该依赖的修复。
- Native SRT's node-forge 1.4.0 has no published patched version for
  [GHSA-86w9-cpqp-85rv](https://github.com/advisories/GHSA-86w9-cpqp-85rv).
  An open, unmerged PR is not an official release. Native activation remains
  refused until enforcement and the security gate are independently verified.
  Native 的 node-forge 尚无已发布修复；停用路径属于限制措施，不算漏洞已修复。
- Node 22, Windows/macOS, real SQL/IdP/vendor and packaged runtime checks are
  not established by these Linux checks. Those acceptance rows remain open.
  Linux 验证不替代 Node 22、目标系统、真实 SQL/IdP/模型与安装包验收。

Rollback is a local source revert followed by a frozen-lockfile install and
the same consumer checks. Preserve all Profiles, Sessions, namespaces, drafts,
credentials, server receipts and business data. No database rollback or
release operation is implied.

回滚为本地代码 revert、按锁重装并重跑消费路径检查；保留全部业务与账号数据。
此说明不授权数据库回滚或发布操作。
