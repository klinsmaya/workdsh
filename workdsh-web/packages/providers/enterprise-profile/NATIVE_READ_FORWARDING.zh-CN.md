# 可选的归属原生 Session 只读转发

默认仍为 `bootEnterpriseCore`。新增具名导出 `bootEnterpriseNativeReadCore` 仅供 D08/D09 显式选择的无 GUI 装配，不代表桌面 carrier 已启用或验收。

原版公开 Loader Group 装配两个私有 scope，共用一个原版 Connection，私有 WebServer 不存在、不新增监听端口。Controller scope 持有原版 SessionController 及依赖；Reader scope 持有原版 Gateway、Typert 和归属只读 facade，隔离 Controller、文件、LLM 与 preset 服务。父 Connection 保留固定 Ingress 与七个草稿方法。

只转发 `session/list`、`session/page`、`session/projections`、`session/follow`、`session/control`。Runtime 仅选择最近成功启动且仍为原版 live Agent/Session 的本机会话，不接受调用方传入其他历史、actor、project 或路径。每次请求通过私有 Main `ownedSessionRead` 新鲜核对账号、项目与 Recovery 归属，取得稳定 Host epoch、撤销 signal 和有限期限。这不是已完成执行或旧 Run TTL 的读许可。标准 AsyncLocalStorage 仅承载每请求的临时只读 admission；直接调用私有 Gateway 没有该上下文便拒绝。每个异步返回及原版流帧都重新核对选中会话、取消与到期，定时器及 consumer 退出会关闭业务 lease。

三个 unary 读调用原版 Connection SharedFetch 和公开 envelope schema。follow/control 经 Ingress `openNative` 保留原版 `wireStream.open` 值；这是进程内 carrier hook，不新增 transport、mux 或 renderer。unary HTTP 拒绝流方法。尚未 next 的 consumer return 会立即关闭自有 lease，且调用原版 iterator.return 一次；此证据不等于验证原版尚未启动 generator 的 uplink finally 已清理。

私有原版 SharedFetch 仍含原来的受信文件/上传能力，不能交给浏览器或 carrier。父入口没有文件/上传 owner，已审 caller guard 仍需单独在 carrier 接线。不在此装配启用 raw Gateway、WebSocket mux 或 `$events`。

使用 Cordis 4.0.4 与官方 DSH 0.1.7-rc.2。真实 Core 测试位置为 `enterprise/plugin-agent-bridge/src/server/__tests__/native-session-flow.integration.mjs`，运行真实 Main/Broker/Recovery、原版 Loader/Agent/Session/Controller/Gateway 与协议，模型为确定性的 idle fixture。覆盖三读、并行流、仅缩短真实许可的到期、projection 延迟、无上下文拒绝、父 raw 入口拒绝、Main 撤销、未启动 return、JSON 消费期间选中会话变化。既有 Profile 20 项和默认 Core 18 项另作回归；这些测试不代替正式 AT 验收。

cold 历史、完整原生 Conversation/SessionProvider 装配、原版 Client `$events` generation、实际 Electron 跨进程 carrier 接线、Windows/macOS、完整沙箱/SRT、真实 IdP 与模型尚未验证。P1/G3 与桌面 activation 继续拒绝；此模块不启用 D13/D14。

回滚移除该 opt-in 源码增量和包引用，重建原 Profile。不迁移 schema，不删除 Session、草稿或可选派生索引，保留所有用户已有修改。
