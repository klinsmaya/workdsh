# 业务任务后的可选原版 Client 原生视图

`bootEnterpriseNativeWsCore` 是 D08/D09 的显式工程组合。必须提供 Main 私有 `nativeCaller.assertRequest` 能力，返回仍有效的 AbortSignal 和距当前最多 60 秒的明确期限；缺失能力直接拒绝启动。默认 Core、默认桌面启用、P1/G3 和 D13/D14 保持原状，均未由本模块验收通过。

官方 DSH 0.1.7-rc.2 Loader Group 保留私有 Controller/Reader 组合。第三个 Group 装配原版 Gateway、Typert registry 和五读取业务 facade。WebServer 能力仅将原 `/api/remote.mux` 升级注册委托给同一个父物理 WebServer，不创建 listener、端口、mux、codec 或执行器。Connection 能力委托原浏览器认证、operator 和 fetch API；对 `/api` 的 interceptor 贡献明确为零，父固定 Ingress 仍是唯一 RPC owner。这是限定能力，不是通用 Connection 实现。

每个物理原生升级先通过原 Connection 的 Host/Origin/签名 Cookie 验证，再通过独立 Main 私有 caller proof，最后取得新鲜的所属 Session 读取许可。proof 等待最多十秒。caller、Host、Session 撤销及最早的 proof/read 期限都会关闭真实 socket。暂停中的 upgrade 若没有缓冲字节，通过 Node 公开零字节读取观察 FIN；若有提前字节，清理可延迟至有界 proof 截止。包装不消费或重编码 carrier 字节。

Root HTTP proof 模块在 Main 新鲜核权之前保护三条规范原生读取路径，生命周期独立于可选 mux owner。WS 模式的 ReadBridge 要求该 owner 存在，卸载后拒绝。标准 AsyncLocalStorage 将单次 HTTP caller 许可沿现有 Ingress 传递，内层读取许可合并其信号与最早期限，在返回原版编码结果之前再次检查。受信任进程内 SharedFetch 能力保持私有，不经过物理 caller 认证。

ADR AFOS-0006：同一已认证 operator 上更严格的逐 socket 作用域。保留原已认证 PeerId，在原 Peer 的 Context 下通过官方受管子 Context 仅携带有界私有 caller 元数据。只读 PeerScope view 经原 Gateway 传递。WeakMap 以实际 request 和该 view 对象关联，绝不按共享 operator id 关联。view.dispose 只撤销自身子 fiber 和 socket 许可，不调用原 operator.dispose，不创建新主体或增加权限。facade 使用公开 `this.ctx.invocation.peer`，在 await 后及每个原生 stream frame 前验证该 caller 许可。直接使用原 operator 的调用没有许可而拒绝。不改绑 socket event listeners，不导入私有 transport 实现。

仅提供原版五项 Session 读取；另外十四项 Session 方法、通用 SRC 服务及 `$events/result` 均拒绝。原空 remote-event source 让原 Gateway 自己产生 `home: ''` 的 ready，不产生 Host 业务通知、Session 内容或 waterfall。每个方法仍取得 Main 新鲜账号/项目/Recovery 所有权，并通过原内层 Agent/Session/期限检查。执行与协议继续由官方 Agent、Session、持久化、Remote 和 Client 拥有。

本候选支持成功创建的 live 业务任务之后的原生视图。在尚无该 Session 时，真实原 WS 升级拒绝。原业务 connection 仍能在没有 Remote generation 时通过认证父 HTTP 调用 state/materials/start。该证据限定为组件链路，不证明完整 ModuleLoader/Workspace/Conversation GUI 首次装配。

本地测试运行真实官方发布浏览器 bundle factory、generated Session Remote、localhost 物理 HTTP、原 WebSocket 以及真实 Main/Broker/Recovery，身份与模型回复使用确定性 fixture。Node WebSocket fixture 加入合成的原 Cookie 与独立 Main caller proof header，不实现或认证实际 Electron trusted-frame proof 发行与跨进程传递。二十一项 `AFOS-WS-01` 至 `AFOS-WS-21` 检查覆盖认证、实际 SDK 读取、无 Session 拒绝、独立过期/撤销、Root/mux 卸载、双 socket proof 隔离、迟到 frame、十秒 proof 截止及子 fiber 先卸载的静默清理。默认 Core 18、原生后端 8、Profile 20 为独立通过的回归。这些是工程证据编号，不是正式桌面 AT 编号。

尚未完成实际 Main proof 发行及 Electron carrier 边界、完整原生 Conversation/SessionProvider、初始完整 UI、cold history、Windows/macOS 和沙箱/签名/真实身份提供方/模型验证。此前上游未启动 uplink 清理限制仍保留。没有生产数据库、外部写、权限扩大或 P2 操作。

回滚移除本显式可选 entry 与 exports 后重新构建 Profile。保留现有 namespace 数据、Session、草稿、回执与浏览器凭据；不需要 schema 迁移或删除数据。
