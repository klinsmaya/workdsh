# 原 Electron 主窗的本地企业草稿界面

本轮是 D02/D05/D09 的局部实施，保留 WorkDSH 唯一的 Electron 窗口 owner。账号和凭据由 EnterpriseMainSession 管理，持久草稿由 EnterpriseRecoveryStore 管理。发行资产中的原版 frontend、ModuleSystem、Loader、layout 和 Slots，通过 enterprise-drafts 的替代 local-client 入口挂载同一草稿面板。没有新增 shell、Conversation、Remote、协议或 Agent 循环。

窗口保留 contextIsolation、sandbox:true 和 nodeIntegration:false。固定 preload 只向 afos-local://drafts/index.html 的主 frame 暴露 state()、edit({draftId,content}) 与不带数据的失效订阅。Main 的两个固定 handler 独立检查真实 WebContents、当前 mainFrame、精确文档以及当前账号和项目 lifetime；异步投影后再次检查。主 frame 导航或 reload 先撤销旧文档 lifetime，新文档独立读取；关闭窗口即中断未完成投影并移除其 handler。现有公开的无状态 draftView 生成同一 DTO。Renderer 不收到 token、私有 capability、原始记录、路径、URL 或泛型 IPC。登出和切项目立即使旧模型及未保存编辑失效；确认 Host 已停止后，同账号的本地副本继续可用。执行中断状态仍由 Main 停止流程决定。

本地 scheme 仅提供发行 manifest 中的规范 GET 资产，逐文件检查普通文件、精确大小和 SHA-256。API、文件代理、上传、WebSocket 与未知路径拒绝。connect、frame、object、form 继续禁用，弹窗、导航、跳转、webview 和下载拒绝。本页面不能读新资料、启动或取消任务、调用模型或归档。执行能力仍为 ingressValidated:false/sandbox:unavailable；缺发行资源不会生成配置或授权。

## 原前端 CSP 兼容决定

真实 Electron 首次消费出现空白页：未修改的官方 frontend index-Q6zc2uHV.js 在模块初始化时以 new Function 创建 Cordis 表达式求值器。原 script-src self 策略产生了实际 EvalError。复制官方私有实现或替换前端不属于本轮。

本地界面明确采用 script-src self unsafe-eval，并以 script-src-elem self 继续拒绝内联脚本；只加载经发行 hash 检查的脚本。官方内置 data 字体使用 font-src self data。connect-src 仍为 none。此兼容策略只允许原版求值器，项目名、草稿正文及 IPC 数据不能成为表达式：它们使用现有严格 DTO parser 和 React 纯文本。真实消费者必须覆盖看似表达式、Markdown、HTML 的恶意文本，以及外来文档/frame/window、未列资产、对外连接和额外 IPC 参数的拒绝。在线 Connection 与原生 admission 策略不变；这不是生产 OS 隔离证明。

## 发行与证据范围

Host 路径从 app.getAppPath()/resourcesPath 固定解析，不消费个人 runtime 环境变量覆盖。单独管理的 afos-host-runtime.json 如存在，只接受严格 afos.host-runtime.v1 的 release/policy 与固定模型标识和限额；它不进入公开 package files，也不自动生成。现有 Main/Broker/服务器模型策略仍作最终核验。可选进程只有原 EnterpriseCliHost owner：真实 exit/disconnect 仅在 ready 后通知一次，主动停止与启动失败不通知。

容器内 Linux Electron 43.3.0 组件测试需要明确的 --no-sandbox fixture；BrowserWindow sandbox:true 保持，OS 沙箱启动另记真实 BLOCKED。Windows/macOS、签名、打包/portable 真机消费、真实企业身份以及生产 native issuer/在线 UI 需要独立证据。fixture 不提升原 AT-03/04/05/06/31/40/41/42/43/44/48/49/50/51/52 或 P1G3，D13-D15 未开始。原 shell 可能仍显示原生会话操作，其原 Connection 在此本地界面没有对应路由。完整在线 UI、可信端口回报和私有 Main issuer 接线属于后续实际工程；本地资产 scheme 不能绕过原 loopback Origin 检查。

回滚保留所有用户变更、Recovery/outbox 和 vault 数据。先停可选 Host，仅在隔离分支回退本轮审查过的 carrier/local-client 源补丁，重建前版载体并重复其消费者测试。本轮不迁移数据、不对外写、不发布、不扩大权限。
