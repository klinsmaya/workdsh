# 企业草稿界面 · 0.1.0-alpha.1

通过官方 main 与 sidebar.panellist 同 key Slots 提供企业草稿页，消费固定的
Main 业务 facade。此模块不拥有 Agent、Session、模型路由、传输、凭据或持久执行
状态。Host 入口仅用于官方 Client 发现，实际实现位于 Client；不注册假 Host 能力。

实现前按附件 D08/D09 与已发布 DSH 0.1.7-rc.2 的 Connection RPC、owner-gated
Slots、Layout、UiWorkspace.openSession 公开类型建立复用记录。复用 workdsh-ui
controls/Modal；Props 由官方接口推导，Context 不进入 React。七个固定 DTO 无 URL、
Token、路径、actor、preset 或 provider 选择器。正式界面规范文档在检出中缺失，
采用既有共享组件与公开类型，实际桌面视觉验收仍未执行。

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

AT-33/35/36/38/39/40/43/44 仅有无界面支持证据；真实模型、IdP/NocoBase、GUI、
Windows/macOS 与 P1G3 仍为 NOT_RUN 或 BLOCKED，不进入 D13/D14 或生产写入。
回滚为从可信 Profile 撤下 workdsh-plugin-enterprise-drafts 并移除模块；官方
生命周期撤销 Slots/连接订阅并中止请求，保留原服务拥有的日志与业务数据。
