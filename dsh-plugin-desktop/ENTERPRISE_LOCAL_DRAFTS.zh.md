# Main 持有的企业本地草稿

本变更推进 AFOS 桌面方案的 D02/D05/D09。EnterpriseMainSession 继续持有账号和凭据，EnterpriseRecoveryStore 继续作为本地草稿与 outbox 唯一持久化真源；固定原版 DSH Host、Session、Agent loop、Loader 与 Conversation 不变。

localDraftCapabilities() 捕获当前已选账号/项目及其直接生命周期信号，仅交给可信 Electron Main owner。对象只有 accountSignal、localState、drafts、editDraft 四项；同账号 Host 停止或重启后仍可查看本地副本，退出、切账号/项目、选择失败和休眠立即撤销旧能力。它不能授权 Run、读新资料、调模型、发布 Session、取消执行或归档。状态始终声明离线权限，缓存选择仅允许本地副本，不代表当前企业授权。

公开 workdsh-provider-enterprise-profile/local-drafts 入口仅复用原有无状态 draftView 投影。载体必须先投影 Main 私有记录，再发送 IPC；Renderer 不接收 Run 绑定/输入快照内部记录、凭据、任意路径/命令/URL。Main 要求当前项目内确切草稿 ID；拒绝编辑执行中、已归档或归档结果未确认的草稿，并执行 afos.drafts.v1 的 64 KiB UTF-8 上限。

可信 stopEnterprise() 先撤销企业执行和旧 Host 代次，再等待实际进程 owner 确认停止。仅停止成功后，现有日志中未完成本地记录显示中断，并释放该执行的本地准入；不会根据客户端报告宣称已取消、已完成或已归档。停止失败时保留未知的活动状态并拒绝编辑，服务器回执、输入版本、账号归属、工作副本和 outbox 意图保留。应用休眠仍切断账号能力，恢复前必须明确重新鉴权。

main-local-drafts.integration.mjs 使用真实 Main/Broker/Recovery 与受控 IdP/服务端回复。原 AT-13/15/16/31/40/41/43/44/52 仅获得工程支持，不提升完整跨进程 GUI、Electron 准入、Windows/macOS/原生隔离或真实企业验收。生产 ingressValidated:false/sandbox:unavailable 门禁保持关闭。

回滚：保留用户变更和业务数据，在另一干净本地审查分支停止可选 Host、revert 此实际源码提交、重复相同消费者验证。不得删除 Recovery/outbox/vault、迁移生产数据库；本变更未授权发布、推送、合并或部署。
