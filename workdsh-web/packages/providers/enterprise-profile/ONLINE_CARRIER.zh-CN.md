# 原 CLI 在线载体

本可选组件连接既有 managed CLI 与企业窗口。生产 capability 仍为 `ingressValidated:false`、`sandbox:unavailable`，生产 Host 启动 gate 仍拒绝激活。Linux Electron 夹具使用结构化 IdP/模型回复及 `--no-sandbox`，只提供工程证据，不代表目标桌面验收。原验收仍为 2 PASS、12 BLOCKED、46 NOT_RUN；G3 未通过，D13–D15 未开始。

Main 在独占 managed Profile 中提供固定 online frontend index。原 Loader 将原 frontend-static fallback 安装到原 WebServer。原 `AppReady.onReady` 通过既有私有 Node IPC 回传端口零的实际绑定端口和原 `Connection.authenticatedUrl`。Main 生成的 generation/nonce、严格有限 DTO、单次 ready 回调及捕获的 Host cutoff 绑定交接。stdout 诊断标记不携带 URL，也不作为 online face 的 ready 权威。

既有窗口拥有唯一非持久 Electron Session。Main 对固定 loopback index 的交换通过公开 `net.request` redirect 事件和 Session `webRequest.onHeadersReceived` 核对原 303 与 clean 根跳转，严格核对原 cookie 名称、签名值结构、authority/expiry、固定属性和实际 cookie jar，再由原 Connection 在 clean index 验证 cookie。Main 仅加载干净的 `http://127.0.0.1:port/` 根页面。启动 URL、token、cookie 和 witness 不进入 Renderer IPC、preload 或日志。实际 Electron 的 manual `Session.fetch` 会以 `Redirect was cancelled` 拒绝，但已保存原 cookie；redirect 事件的 headers 会省略 Set-Cookie。这些差异保留为实测证据，不依赖 `Response.url` 或 `Response.type` 推断。

原 renderer builder 用 enterprise-drafts 的真实 `./client` 导出生成独立 online 图，保留原 23 个模块、ModuleSystem、Layout、Slots 和 Conversation。local 图继续使用 `./local-client`。没有第二 boot、Core、Gateway、WebServer 或模型账号。

Main 自有 Session 的 webRequest hook 仅为既有 13 条 POST 和 GET mux 握手签发 witness，使用实际 WebContents、Session 和顶层 mainFrame 引用。服务器先执行原 Connection 认证及 Origin 检查。iframe、foreign window、伪造 witness、非规范路由和跨 Origin 的 local 文档无法获得 permit。导航、同 URL reload、账号项目替换、child exit/crash、Host stop 和 window close 同步撤销旧文档 permit；旧 ready 不能替换当前 face。原 caller TTL 仍为 60 秒，原 SDK 重连通过新握手取得新 witness。

有限切片验证 cold SDK ready、state/material/snapshot/start、原 read-snapshot/render-draft 工具及 owned Session follow/Conversation 导航接点。没有 live owned Session 时 cold session list/control 仍不可用；owned control 可返回原过滤 baseline。workspace follow、settings describe 仍拒绝，generic prompt/create/upload/workspace/settings 写仍拒绝。缺少 workspace/catalog 事实仍可能阻塞原 UI；GUI 加载不代表完整 startup 或 Composer 可用。持久化 cold history 需要单独恢复 Main ownership map，并通过原 Sessions/query/JSONL 只读消费者读取，不调用 cold follow、不 promote Agent。空只读 baseline 可能触发原 initializeDefault/session.create 启动请求，这些写必须继续拒绝。

真实 Electron 的 renderer crash 后，既有 WebContents 的 mainFrame 在随后加载 clean 根页面后仍处于 detached 状态。Main 保留精确顶层 frame 检查，拒绝该次启动并恢复 local recovery face。最终夹具验证这一拒绝；此前 fresh SDK 恢复失败的 probe 原样保留。renderer crash 后重新恢复 online 需要另一个 owned-window 生命周期改动，复用原 Desktop 窗口工厂。本切片不宣称该恢复已经完成。

回滚时移除可选 online Host/window 接点与 `--online` build 调用，既有 local draft face 保留为恢复视图。本源码基于已审 caller Source23。Root 后续 publication renewal 补丁须按独立 hunk 合入 `main-ipc.ts`，保留本 private ready 合同及 publication ticket/10 秒 deadline 语义。整合后须重跑实际组合的长期 publication 测试。本切片不提交、不 push、不部署、不提升验收状态。
