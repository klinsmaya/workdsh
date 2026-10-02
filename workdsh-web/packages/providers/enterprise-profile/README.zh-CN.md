# 固定企业 Profile 接线 · 0.1.0-alpha.1

本 AFOS 可选组件通过已发布 DSH 0.1.7-rc.2 的 Loader、Session、AgentLoop、
preset、Skill、LLM、Tools、Storage 和 Connection 实现固定企业核心。
新增部分只负责企业业务归属和准入；执行与传输仍由官方服务拥有。

`bootEnterpriseCore()` 在 Main 保护的账号/项目 namespace 生成私有 JSON-only
Loader 组合，装配精确清单并检查必要服务，拒绝通用 Gateway、文件、Shell、
MCP、PTC、settings 和 SessionController。不会加载用户 patch 或默认 bundle。
每次启动生成唯一配置，由生命周期 owner 删除。浏览器认证复用官方 loopback
Connection。已实现的草稿 Client 模块加入官方发现；完整原生 Client/Conversation
装配与桌面激活仍未验证，`assertEnterpriseDesktopActivation()` 继续拒绝激活。

Main 私下提供当前项目权限、固定资料和 Run 能力。`SnapshotIdentityAuthority`
验证完整 issuer/subject/organization/device/project 绑定、服务端权限修订及
最多未来五秒的有效期。既有 WorkDSH Identity 拥有 actor 证据，Access 拥有持久
Session owner。显示用 member/组织标签不增加权限；畸形、变化或失败响应关闭
该权限适配器。

`EnterpriseDraftRuntime` 通过官方 `agents.create` 创建 Session，在发布前挂载
固定 preset、随包 Markdown Skill 并绑定当前 actor 与 Main Run。发布失败会释放
占用。两个固定工具是 `afos_read_snapshot` 和 `afos_render_draft`：Main 重查当前
服务端 Run、精确 pin 与摘要；render 只保存本地草稿。执行投影来自官方 Session
turn 事件。模型调用在公开 `llm/stream` 原始 envelope 上验证官方循环标记，
避免官方投影复制对象后丢失标记；Adapter 再查真实活跃 Agent 与 Main Session/Run。
OAuth Token 与模型密钥均不进入 Client。

`EnterpriseProfileIngress` 拥有既有 Connection `/api` interceptor。七个固定
`afos/drafts/*` UI 操作负责状态、资料列表、快照、开始、编辑、取消与明确人工
归档；旧固定 read/render 入口仍有界。通用方法名与额外字段被拒绝。归档必须
携带用户确认的当前 SHA256；Main 同步比较，再由 Recovery 捕获意图、先查询
回执、在 await 后重查意图并执行有权限的提交。归档不是 Agent 工具。本地夹具
实现不授权外部生产写入，也不代表 P2 审批已实现。

工具准入要求原版活跃 Agent、当前 actor、Session owner、Access 决策和原始
循环 signal。定义对象身份防止同名 scope shadow；能力清单扩张关闭 dispatch。
正常 preset restrict/dispose 发出的通知在清单未变时可以保留。Hooks、取消监听、
Adapter 与 handles 均由官方生命周期拥有。Main 同步撤销能力并合并 Host 停止，
内部调用不会等待自身任务被销毁；换账号与新 Host 仍须等待旧 Host 退出。
每次 Host 启动使前一 Host 捕获的回调失效。

草稿正文复用公开 64 KiB UTF-8 限额，JSON 准入覆盖最坏转义膨胀；资料快照另限
1 MiB。初版 recovery store 每个 namespace 最多八份草稿。传输断开后 Main 保留
已验证的本地草稿和最后联系时间，同步取消企业执行；人工本地编辑仍可用。
重连不恢复旧回调，必须由可信 Main 明确重启 Host、重新验证权限并更换生命周期。
完整响应的 JSON/UTF-8 异常和已知拒绝会撤销账号，不进入离线回退。
显式账号恢复会实际重读同一磁盘 namespace；切换账号不重放其他主体的草稿。
完整原生 UI 接线仍需完成；没有浏览器 outbox 或第二套执行状态真源。

在 `workdsh-web` 编译契约与本包后运行 `test`、`typecheck`。在独立
`enterprise/plugin-agent-bridge` 执行 `corepack pnpm test:profile`，先构建 Profile
workspace 前置，再运行十五项真实官方运行时集成检查。身份、ACL 持久层和模型回复
为夹具；覆盖真实工具 turn、持久草稿/哈希确认、已认证 HTTP 和物理 WS 拒绝、
取消、当前 Run policy、模型 dispatch 时撤权、失败占用释放、重复启动及转义内容
边界，以及离线编辑/磁盘重读、界面刷新前的 Main 准入锁、异常响应/body IO
迟到原版 render/stream 的取消、已知 refresh token 拒绝及并发拒绝/断网取消。夹具/Linux 证据不算目标桌面验收。DSH 保持锁定；消费方 Cordis4.0.4 已符合发布包 ~4.0.4 peer 并在原版 Core
及现有消费模块验证。Linux 源码证据不替代目标 Windows/macOS 安装包兼容验证。

支持任务 D01/D04/D05/D07/D08/D09/D10。正式 AT-03/07/08/10/11/13–18/20/22–23/
31/33–47 不因这些检查提升。原生沙箱、Windows/macOS、真实 IdP/NocoBase/SQL/模型、
完整 Client 装配、签名、许可和整体安全门槛仍未关闭；P1G3 未通过。

回滚为撤下可选企业组合、revert 本地源码/锁，再按锁安装并重跑消费路径检查。
保留个人 Profile、Session、owner、namespace 草稿、凭据及服务端回执。
此说明不涉及上游修改、生产操作、合并、发布或部署。
