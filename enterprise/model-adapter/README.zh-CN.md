# AFOS 固定模型适配器

这个私有模块实现 `afos.model.v1` 传输和单个受管模型的官方 DSH `LlmAdapter`。它是企业 Profile 和服务器网关的受限源码，没有激活生产端点。`FixedModelGateway` 默认拒绝执行，只有可信服务器配置明确设置 `enabled: true` 才允许工作；外层服务器还必须为当前运行单独授权 `models.stream`。

Host 使用公开的 `ctx.llm.registerAdapter()` 注册 `EnterpriseModelAdapter`。已有 DSH 模型循环、消息组装、取消和 Session 事件继续拥有这些职责。适配器只接收注入的可信 `ModelTransport` 和当前运行检查；它没有 fetch 端点、供应商凭据、路由发现、重试引擎、Agent 循环或 MCP 传输。调用者不能选择其他 provider/model。`serializeModelRequest()` 与 `validateModelRequest()` 提供封闭 JSON 合同，不接受 URL、Token、客户端用量、主体、组织或角色字段。

服务器的 `FixedModelGateway` 用一个冻结的 HTTPS Messages 端点和固定模型创建公开官方 `DeepSeekAdapter`，供应商 Key 留在服务器闭包内。官方适配器负责供应商线协议转换与流传输，发送所需产品标识头，并拒绝重定向。生产实现没有修改全局 fetch。网关关闭可选 API 扩展，不解析本机附件，也不发送原始 Session 身份。提交的模型消息仍会有意发送到获准模型服务；资料授权与来源校验由外层可信 Profile/Broker 负责。

当前服务器 ACL/运行校验每次必须返回 `ModelAuthorityLease`，包含经验证的范围键、允许工具名称、到期时间和有效撤销信号。所有授权信号，包括后续刷新的信号，都会终止供应商已持有的稳定信号。准入、私有认证和最终供应商请求准备之前，以及每个输出块之前都会检查。到期时间和最长五分钟也会中断空闲请求。工具定义、历史工具调用和供应商返回的工具名称都必须获准；返回工具还必须存在于本次请求声明中。权限变化时服务器必须主动撤销信号；仅轮询校验不能立即中断空闲供应商连接。

`encodeModelSse()` 与 `decodeModelSse()` 仅承载公开 DSH 数据块词汇。解析器将每帧限制为 64 KiB、全流限制为 16 MiB，校验 UTF-8、版本、字段、计数、终止顺序和断流；外层传输必须提供拥有取消/期限的信号。取消能结束不配合的读取等待，不挂起消费者。边界删除供应商错误正文、私有 cause、重放信封以及传输伪造的错误文本。只有服务器用量结算成功且再次检查有效信号后才输出成功终止块。

网关要求原子服务器 `ModelUsageLedger`。持久实现必须保存预留和幂等结算，绑定经验证的账号/项目/运行范围，并核对结果未知的写入。预留按配置的上下文窗口加输出上限保守计算，未知用量继续占用预留。配置窗口和真实供应商计数仍需联调验证；这是 Token 预算，不能声称货币成本上限。`InMemoryModelUsageLedger` 明确仅供离线测试，不能作为生产计费存储。忽略取消而迟到完成的预留会保留并核对，不发起模型调用；实际服务器不得静默清除未结算或崩溃留下的预留。

锁定的官方适配器把供应商缺失的计数初始化为零。本模块只有在输入和输出计数都为正数时才将其汇总计数记为 known；缺失或零计数保持 `unknown`，不输出虚构用量块，继续保留预留。这会保守地将真实零计数边界也标为未知。未提供经验证价格，因此 cost 永远为 `unknown`。客户端自报用量无法进入本合同或服务器账本。账本结果描述服务器观察的模型传输，不代表业务批准、成果回执，也不能证明断线后供应商已停止生成。

这里的 P1 只支持有限文本和非延迟工具。图片、文件引用、developer 工具历史扩展、自定义内容块和调用者推理级别覆盖会以 `UNSUPPORTED_MODEL_CONTENT` 拒绝，不转换为任意本机路径或备用端点。图片/文件验收保持 `NOT_RUN`。D10 正式 AT-34、AT-45、AT-46、AT-47 均保持 `NOT_RUN`，直至挂载的 Profile、真实 NocoBase 当前权限、持久账本、获准网关凭据与完整资料到草稿闭环完成测试。离线测试不能关闭正式用例。

在本目录运行 `COREPACK_HOME=/workspace/afos-handoff/corepack corepack pnpm install --frozen-lockfile`、`corepack pnpm run typecheck` 和 `corepack pnpm test`。本包锁定 DSH `0.1.7-rc.2` 与当前 WorkDSH Cordis `4.0.3`。发布的 DSH peer 要求 Cordis `~4.0.4`；已在当前 `4.0.3` 锁上测试公开 LLM 注册组合，但不声称跨运行时互通或已升级依赖。来源、命令证据、审查范围与回滚见 `REUSE.md` 和 `evidence/delivery.json`。

激活前回滚独立源码时，只通过经审查的本地补丁/revert 移除这个模块。网关挂载后，先禁用明确模型动作；恢复代码时保留未知预留和供应商用量记录。代码回滚不删除凭据、Session 文件、成果或 NocoBase 数据。本任务没有推送源码、部署服务器、调用外部模型、迁移生产数据库或扩大权限。
