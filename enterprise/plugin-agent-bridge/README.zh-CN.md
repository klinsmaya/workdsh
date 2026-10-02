# AFOS NocoBase Agent Bridge

这是获准 WorkDSH 仓库内的独立插件源码交付，目标参考 NocoBase 2.4.0-alpha.9。上游保持只读；没有安装、部署、生产迁移或 OAuth 管理操作。P1/G3 尚未通过，P2 审批和正式保存未启动。

复用 NocoBase Plugin、用户、IdP、原生 ACL 和 repository。受管配置必须固定 issuer、`/afos` audience、同源 JWKS、clientIds、releaseId、policyRevision；服务端 `afosClientAccess` 需显式启用主体/客户端、配置逻辑 deviceId 和毫秒 notBefore。设备字段是服务端逻辑绑定，不是硬件证明；代码不自动授予权限。

POST `<issuer-path>/afos` 使用 `{ "contractVersion": "afos.bridge.v1", "action": "materials.listAllowed", "params": { "projectId": "..." } }`。GET 需 `X-AFOS-Contract: afos.bridge.v1`。仅准入十个固定动作；拒绝未知或嵌套额外字段、通用 CRUD/MCP、伪造主体/角色/端点/路径。游标签名绑定主体、组织和查询，有效十分钟，服务重启后失效；仓储查询在 ACL 过滤前限制为 51 个成员/资料行，每页重查当前权限；过滤后空页仍可前移游标。

每次操作验证 RS256 `at+jwt`、当前用户/客户端/Grant、显式接入策略、项目成员和原生记录/字段 ACL；验证发生在 OAuth 被转换为内部令牌之前。`patches/nocobase-idp-grant-binding.patch` 将真实 grantId 签入 `grant_id`，仅在参考源码上通过应用检查，尚未应用或部署。未补丁的旧令牌会被拒绝。真实 native/public client、PKCE、`none` 和 loopback `/oauth/callback` 联调仍为 NOT_RUN。

授权输入采用 projectId/releaseId/inputRefs/clientRequestId，输出符合交接包原始 JSON schema，包含主体/组织/设备、策略、动作上限和 ISO 时间，不暴露内部请求摘要。上传绑定 run/attempt、MIME、大小和 sha256；`artifacts.upload` 只是暂存对象的受限 UTF-8 传输。提交返回 receiptId/runId/attempt/artifactId/revisionId/sha256/committedAt。当前支持 1 MiB 文本、32 个输入引用、每次运行一个不可变草稿，状态明确为 `draft-needs-review`。

实际输入及上传字节必须匹配摘要；草稿和回执在 SERIALIZABLE 事务中创建；相同提交幂等、异内容冲突；未知响应先查 `runs.getReceipt({runId, projectId})`，回包附原服务器授权固定引用；过期仍可核对回执，不产生执行或写能力。私有状态和草稿不开放普通 API；资料、草稿和回执拒绝逐条/批量修改和删除。此限制不对抗可信 raw SQL 或数据库管理员。客户端执行事实、用量和成本未实现，服务器回执不表示本机进程已完成。

本目录独立使用 pnpm 10.34.5。执行 `corepack pnpm install --frozen-lockfile --ignore-scripts`、`corepack pnpm test`、`corepack pnpm typecheck:core`、`corepack pnpm build`。测试使用内存 RSA、注入仓储/ACL 和原始独立 schema；不能替代真实 NocoBase 或桌面验收。发布依赖与参考源码的版本号相同，但 gitHead 不同；依赖 peer 警告及兼容性限制已记入证据。

尚未发布的 alpha 合同新增 `identity.current({projectId})` 与 `runs.getAuthorization({runId})`。当前身份由服务器记录派生，快照至多五秒；恢复重查 release、策略、输入及设备。旧回执调用遗漏 projectId 明确拒绝，客户端和服务端须配套更新。

真实 IdP/ACL/仓储钩子、跨进程事务、清理保留策略、业务 UI、桌面 Broker/身份/Profile 接线、固定模型代理、目标平台安装和恢复仍需完成。回滚不删除已归档业务数据。

可选 `model` 配置仅在受信任服务端负责人明确设置 `enabled: true` 后开放。同一网关的固定 `afos.model.v1` 流复用原始所属 Run 和官方 DSH Adapter。供应商、模型、HTTPS 地址与密钥解析函数来自服务端配置，不能由请求指定。入口、每个块和每秒空闲轮询都会重查 Token/Grant/client/device/project/source/release/policy 与不经过缓存的原生 `users.roles` 关联。流期间不能扩大初始所选角色；未验证的部门 `attachRoles` 直接拒绝。连接断开监听早于异步准入，禁用插件会取消全部流。

私有 `afosModelBudgets` 与 `afosModelCalls` 仓库使用 SERIALIZABLE 事务和行锁预留、结算，只保存规范化核算字段，不保存提示词或供应商密钥。未知用量保留预留；供应商已知用量按实际计数记录，即使高于预留。必须以真实供应商验证固定 `contextWindow` 可作为预留上界。本源码不证明严格金额封顶、真实计费或未知部署方言的 SQL 隔离。新增隔离检查使用精确官方 NocoBase 包和真实 SQLite
repository/native transaction，覆盖独立连接及两个进程竞争、事务回滚、唯一键、
不可变 hooks、当前角色和成员撤权；身份/ACL 服务准入仍是 fixture。SQLite 的
SERIALIZABLE 实际为 BEGIN DEFERRED，竞争写入一方以 SQLITE_BUSY 拒绝；不证明
PostgreSQL/MySQL 行锁行为，没有打开生产数据库。

从获准仓库根运行 `node enterprise/plugin-agent-bridge/scripts/run-sql-integration.mjs`。
它只读复制源码到新临时 staging，独立 cache/store，仅在 staging manifest 加入
`sqlite3@5.1.7`，执行六阶段安装/构建/测试并留存日志、锁和输入摘要。13 项
AFOS-SQL 检查为 AT-18/20/22/33/38/39/47 提供子证据，不提升正式验收。
产品 manifest/lock 不变。回滚仅撤下四个可选测试文件，不删除业务数据。
