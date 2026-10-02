# AFOS NocoBase Agent Bridge

这是获准 WorkDSH 仓库内的独立插件源码交付，目标参考 NocoBase 2.4.0-alpha.9。上游保持只读；没有安装、部署、生产迁移或 OAuth 管理操作。P1/G3 尚未通过，P2 审批和正式保存未启动。

复用 NocoBase Plugin、用户、IdP、原生 ACL 和 repository。受管配置必须固定 issuer、`/afos` audience、同源 JWKS、clientIds、releaseId、policyRevision；服务端 `afosClientAccess` 需显式启用主体/客户端、配置逻辑 deviceId 和毫秒 notBefore。设备字段是服务端逻辑绑定，不是硬件证明；代码不自动授予权限。

POST `<issuer-path>/afos` 使用 `{ "contractVersion": "afos.bridge.v1", "action": "materials.listAllowed", "params": { "projectId": "..." } }`。GET 需 `X-AFOS-Contract: afos.bridge.v1`。仅准入八个固定动作；拒绝未知或嵌套额外字段、通用 CRUD/MCP、伪造主体/角色/端点/路径。游标签名绑定主体、组织和查询，有效十分钟，服务重启后失效；仓储层分页尚待实现。

每次操作验证 RS256 `at+jwt`、当前用户/客户端/Grant、显式接入策略、项目成员和原生记录/字段 ACL；验证发生在 OAuth 被转换为内部令牌之前。`patches/nocobase-idp-grant-binding.patch` 将真实 grantId 签入 `grant_id`，仅在参考源码上通过应用检查，尚未应用或部署。未补丁的旧令牌会被拒绝。真实 native/public client、PKCE、`none` 和 loopback `/oauth/callback` 联调仍为 NOT_RUN。

授权输入采用 projectId/releaseId/inputRefs/clientRequestId，输出符合交接包原始 JSON schema，包含主体/组织/设备、策略、动作上限和 ISO 时间，不暴露内部请求摘要。上传绑定 run/attempt、MIME、大小和 sha256；`artifacts.upload` 只是暂存对象的受限 UTF-8 传输。提交返回 receiptId/runId/attempt/artifactId/revisionId/sha256/committedAt。当前支持 1 MiB 文本、32 个输入引用、每次运行一个不可变草稿，状态明确为 `draft-needs-review`。

实际输入及上传字节必须匹配摘要；草稿和回执在 SERIALIZABLE 事务中创建；相同提交幂等、异内容冲突；未知响应先查 `runs.getReceipt`。私有状态和草稿不开放普通 API；资料、草稿和回执拒绝逐条/批量修改和删除。此限制不对抗可信 raw SQL 或数据库管理员。客户端执行事实、用量和成本未实现，服务器回执不表示本机进程已完成。

本目录独立使用 pnpm 10.34.5。执行 `corepack pnpm install --frozen-lockfile --ignore-scripts`、`corepack pnpm test`、`corepack pnpm typecheck:core`、`corepack pnpm build`。测试使用内存 RSA、注入仓储/ACL 和原始独立 schema；不能替代真实 NocoBase 或桌面验收。发布依赖与参考源码的版本号相同，但 gitHead 不同；依赖 peer 警告及兼容性限制已记入证据。

真实 IdP/ACL/仓储钩子、跨进程事务、清理保留策略、业务 UI、桌面 Broker/身份/Profile 接线、固定模型代理、目标平台安装和恢复仍需完成。回滚不删除已归档业务数据。
