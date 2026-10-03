# 自有原生 Session 只读辅助模块

这个可选模块通过已发布的 Host 定义包装原版 DSH SessionController，不创建 Agent、Session 历史、渲染器、Loader 或载体。企业 Profile 默认不装载它。

Main 必须提供私有装配的原 Controller、当前自有 live Agent/Session、epoch、撤销 signal，以及同步入口断言。该断言必须覆盖 HTTP、已认证 WS、直接 Gateway、SharedFetch/app-scheme 和转发的事件流。Main 通过新鲜主体/项目权限和自有 Draft-to-Session 映射产生短期只读权限，不依赖旧 Run 的执行租约；传入不完整的断言不能构成激活证明。

只允许当前自有 live Session 的 list、page、follow、projections、control。委派前、读完成后和每一帧前检查身份及权限；使用标准 AbortSignal 合并撤销和调用方生命周期。其它原 Session 方法返回 `afos/session-view-read-only`；不启用 fileReferences、skills、上传、附件、路径打开或搜索。继续使用原 wire/result codec 与取消协议。卸载或 owner Context 销毁先撤销自有生命周期，使缓存引用、pending read 和现有流不能继续返回数据。

原 Client/Conversation 仍有修改控件，0.1.7-rc.2 未发布完整只读开关。本模块在 Host 拒绝效果，不代表所有控件已移除。暂不开放 cold Session：原 Controller follow 在 opening frame 后可能把 prepared Session 提升为 live Agent。

私有 Controller 仍在共享 Connection 注册 `/api/file` 与原始上传；私有 Group 不会消除这些路由。Main 调用 SharedFetch 之前必须拒绝它们，仅 HTTP `connection/request` listener 无法保护 WS 或直接 Fetch。聚合 Remote 事件源可能转发其它 Session 事件，必须在原事件源贡献中按当前自有 Session 过滤，或保持该入口缺席。本模块不注册事件源，也不认证其它贡献。全部入口与平台/身份检查通过前，桌面 Main 企业激活仍应拒绝。

`guardOwnedNativeSharedFetch(originalHandler, {baseUrl, signal, assertCurrent})` 是 Main 原 HTTP/app-scheme 分发的调用方守卫。Main 应向载体提供受保护 handler，并在转发 HTTP body 前调用其 `admit`。仅接纳 Main 固定 authority 下五个原生读路径的 POST；query、fragment、编码变体、文件/上传、修改和其它方法在调用原 handler 前拒绝。先以标准 Request 构造器规范化，再核查同一内部 method、URL 和 caller signal；已取消 caller 拒绝，owner signal 继续转发，返回 response 前再核权。该辅助模块不注册第二 transport/handler，不替换 Connection registry，也不改变 WS mux。暴露原未保护 handler 会重新打开已测得的文件读取缺口。

早期隔离无界面 helper 探针使用当时安装的 Cordis4.0.3，低于官方 `~4.0.4` peer，历史日志不能证明兼容。后续 WorkDSH 所属锁图使用 exact4.0.4，实际原生后端测试复用未改的 helper。两类证据都不能替代 Windows/macOS、原 Provider 绑定、GUI、真实 IdP 或模型验收。实际集成范围及载体缺口见 Profile 的 NATIVE_READ_FORWARDING 双语说明。

回滚移除此模块贡献/fiber，保留持久数据。该模块不要求数据迁移、Profile 改动或软件发布。
