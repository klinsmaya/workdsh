# 原 Conversation 的有限冷会话保留

普通归属冷 Session 可通过原 rc.2 公开 `ISessions.retain`、Gateway journal 和原 23 模块 Conversation 打开。Main 每次提供精确账号/项目的 `ownedSessionRead` 新鲜授权。捕获的私有原 SessionController 经公开 `follow` 读取真实 SQLite/JSONL；适配只 `next()` 一次，在 `finally` 等待 `return()`，关闭后才转发未改动的真实 opening snapshot。锁定版本在首帧 yield 后、检查 abort 前就会促进 prepared Agent，所以取消不能代替 return。

仅接受普通安全 Session ID、原 assistant snapshot 选项及受限原 page window；未知字段、调用者 cursor、subagent、未归属 ID 和非法边界拒绝。异步工作前后核对 Controller/query 身份、无公开入口、冷 Agent/Session 不存在、Main epoch/signal/期限与物理 proof。原 source.dispose 异常拒绝首帧；pending first 传入实际 query signal，释放真实 observation 与 listeners。

原迭代器已关闭后，只静态持有该真实首帧，在短期限到来前周期性重新验证既有 Main 读授权，epoch 和 signal 必须相同。没有第二次原 source 读取、事件累积、HistoryLoop 或执行。单 Session 拒绝只结束该逻辑读；pending renewal 已取消时结束已清理的 source，carrier retry 仍由原 Gateway 管理。用户 release、账号/项目/Host/window cutoff 与物理到期结束持有；重连重新取授权和原首帧。

实际有限 Main issuer 提供固定、最多 60 秒的物理期限。准入和每次 caller assertion 仍验证短 Main 身份快照，不能把不相关物理连接缩成五秒。只有固定 Loader 图中真实有限 NativeWsFacade 与目录均已安装时，物理升级使用 identity-only 准入，原 upgrade 前后再验证；没有目录的旧入口仍保留 selected-Session transport permit。每次 unary/可见帧仍新鲜授权。Live follow 仅对当前 selected、已经存在的 Agent/Session 复用同一原公开迭代器。Main 短授权按相同 epoch/signal 续验，captured Controller/query 及公开/私有 Context 中的 Agent/Session 真实身份必须不变，每个可见帧再验证。拒绝、对象替换、取消或到期实际 abort 原 query 并等待 iterator.return，不新建 Agent 或 source。

离线夹具使用实际产品 Main、Core/Loader、公开 Gateway/Remote SDK、持久字节和原 Conversation；IdP/model 为结构化回复，Electron 使用 `--no-sandbox`。测试验证同一物理 peer 上原冷/活 SDK retain、健康目录与独立 active Run publication 跨固定物理截止，保留失败 baseline，覆盖取消/dispose异常/context变化/held权限/期限/逐Session拒绝/旧新peer/真实长重连。Provider34TS 生成自有68文件，Drafts20 与 Renderer306 明确复用；不改变共享依赖、锁、安装或第一方产物。

固定 Profile 仍无 settings provider；原启动 initializeDefault/session.create 及通用 prompt/upload/workspace/settings 写入继续拒绝。生产 capabilities 保持 false/unavailable；原60AT保持2PASS/12BLOCKED/46NOT_RUN，G3NOT_PASSED，D13–D15NOT_STARTED。组件证据不算目标桌面验收或激活许可，Root 组合和独审另有门槛。

回滚反向应用本增量并生成前一经审 Provider，保留账号本地 Session/JSONL、恢复草稿及服务端回执，不恢复或重放 Run/Agent/publication/model。精确作者报告记录失败、缺口、source/emit/input 哈希和独审窗口。
