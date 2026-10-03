# 企业草稿界面 · 0.1.0-alpha.1

## Main 限定范围的本地 Client face

公开 `./local-client` 生成 `dist/local-client.browser.js`，ModuleLoader factory id
为 `workdsh-plugin-enterprise-drafts-local`。服务只注入 `slots/layout`；载体经原
模块图选取 `dsh.localClient.inject/external`。它与普通 face 共用原 main/sidebar
Slot key，必须只激活一个，不注册新 Loader、Connection、Session 或 Remote。
原main Slot owner存在且注册完成后，local face调用公开 `layout.selectPanel(panelKey)`
初始展示本地草稿，普通在线face不增加此默认选择行为。

唯一 preload 能力为 `window.afosLocalDrafts.state()`、
`edit({draftId,content})`、`subscribe(listener):unsubscribe`。响应直接为既有
state/draft DTO，不套 transport envelope、不增 secret/路径/URL/actor 字段。
Main 每次验证私有账号和项目范围；Client 复用严格字段、64KiB UTF-8、SHA与回执
校验，解析后强制 `authority:'offline'` 和仅 Renderer 使用的 `scopedLocalOnly:true`。
这不代表新鲜企业授权，不提供泛化 IPC、浏览器持久缓存或联网回退。

原 model/panel 保留来源、摘要、最近同步、纯文本预览和编辑。`localOnly:true`
真正不渲染资料、新建任务、取消、归档及确认框、打开原生会话的动作；adapter也拒绝
这些方法。cap 变化先 invalidate 再刷新，异步 SHA 后重验旧请求；editor cache key
在范围失效时更新，避免同项目/草稿 id 下保留旧账号未保存正文。普通刷新不重置该key。
官方生命周期释放 Main subscription 与两个 Slot。实际 Electron/preload/完整原生
界面联调归载体 owner；单元/SSR/SlotRegistry 证据不提高正式 AT/P1G3/P2 状态。

通过官方 main 与 sidebar.panellist 同 key Slots 提供企业草稿页，消费固定的
Main 业务 facade。此模块不拥有 Agent、Session、模型路由、传输、凭据或持久执行
状态。Host 入口仅用于官方 Client 发现，实际实现位于 Client；不注册假 Host 能力。

实现前按附件 D08/D09 与已发布 DSH 0.1.7-rc.2 的 Connection RPC、owner-gated
Slots、Layout、UiWorkspace.openSession 公开类型建立复用记录。复用 workdsh-ui
controls/Modal；Props 由官方接口推导，Context 不进入 React。七个固定 DTO 无 URL、
Token、路径、actor、preset 或 provider 选择器。正式界面规范文档在检出中缺失，
采用既有共享组件与公开类型，实际桌面视觉验收仍未执行。

## 原生导航就绪续作与复用决策

当前消费 Cordis 精确 4.0.4；首轮 4.0.3 探针仅为历史证据。复用原 Connection
generation observable、generated remote.session.list、带消费来源标签的
SessionReference.ready/binding/release 与原 Session snapshot。旧 catalog READY
可在读失败后继续存在，sessions.refresh() 也可能以软失败结束，均不能独立
作为当前会话读取许可。导航先等待原 generation，再重新取得 Main 业务选择；
新鲜原 generated list 必须明确包含同一选定草稿 Session；此结果不会填充原
Controller catalog，须另等原公开 refresh/catalog 的实际成员后保留原临时引用，
等待原 open attempt，核对 openState=open、无错误/删除、仍有效的 binding 和
未变化的 generation/选择。原 Workspace 同步保留视图后释放临时引用。
enterpriseDraftNavigation 只扩展官方 Client 引用来源记账，不新增 grant 或执行者。

原首次 ready 同样触发 reset。尚未绑定 generation 的请求只可在等待同一
project/draft/Session 的新鲜 Main 投影后继续；已绑定后任何 loss/replacement/reset
均取消。离线/错误、选择变化、后来的请求、页面/模块卸载、明确取消及 30 秒
操作期限也取消。等待状态只表示 UI 操作；不增加 generation source、Controller
或 transport。明确声明公开 Cordis 依赖 remote 与 remote.session。

新增生命周期测试和真实无界面 Chromium 探针使用原 frontend、ModuleSystem、
Loader、Slots、SessionProvider、Conversation，连接原真实 HTTP/WS 与合成
Main/caller/model fixture。实际点击后才释放延迟 ready；取消/reset/撤权不留
视图引用。保留早期失败日志。这不代表已验证打包 Electron、真实 Renderer
proof、MainIPC+NativeWS 联合载体或目标操作系统。原 composer/menu Slots 的
策略须另行贡献；此模块不声称完整原生只读界面。rc.2 Sidebar 的 New Session
没有独立公开禁用槽，仍必须依赖 Host 拒绝 mutation。generation 消失后原会话
历史缓存可能继续显示，不能称实时读取。

选取真实 material/revision/hash、预览快照、输入目标，再通过 Main 开始草稿。
打开草稿复用原生 Session view。内容只以 React 转义纯文本展示；此切片不实现
Office 导入/导出、下载、HTML 或 Markdown 执行，也不代表格式验收。
草稿限额来自公开 ENTERPRISE_DRAFT_MAX_BYTES（64 KiB UTF-8）；资料快照另限
1 MiB。更宽的 Broker/归档限额不扩大此界面允许的正文大小。

执行与归档状态来自 Main。取消请求成功不等于已停止；只有正文摘要匹配的真实
receipt-recorded 回执才显示已归档。归档须明确确认当前已保存 SHA256；刷新或
重连不自动归档。Main 提供 offline 投影时禁用资料、新任务与归档，仅保留本地
草稿编辑。没有浏览器持久层或 outbox。不明确的传输失败清空易失视图与权限，
等待重新拉取 Main 投影；未保存编辑内容不保证保留，离线编辑依赖实际 Main 投影。

依赖与冻结 workspace 契约就绪后可运行包内 build、typecheck、test。Client 产物
使用官方 ModuleLoader envelope，须由可信企业 Profile 发现；不改个人默认 Profile。

AT-33/35/36/38/39/40/43/44 有无界面及上述真实 Chromium 组件支持证据；真实模型、IdP/NocoBase、打包 GUI、
Windows/macOS 与 P1G3 仍为 NOT_RUN 或 BLOCKED，不进入 D13/D14 或生产写入。
回滚为从可信 Profile 撤下 workdsh-plugin-enterprise-drafts 并移除模块；官方
生命周期撤销 Slots/连接订阅并中止请求，保留原服务拥有的日志与业务数据。
