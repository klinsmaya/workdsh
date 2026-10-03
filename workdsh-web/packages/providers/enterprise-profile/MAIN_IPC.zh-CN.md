# Main 私有业务 IPC 组件

本可选组件提供 D03/D07/D08/D09 的工程增量，不激活桌面发行、不提升目标桌面验收。
Electron 默认能力继续为 `ingressValidated:false`、`sandbox:'unavailable'` 并拒绝启动。

`attachMainBusinessIpc(endpoint, business, startSignal, bootstrap)` 接受已有且由可信
owner 管理的 Node 子进程通道，并要求真实捕获的 `business.hostSignal`。
`connectMainBusinessIpc` 在子进程提供有限业务代理；`bootEnterpriseIpcCore` 调用既有
公开 Core 装配，由原 app-boot `boot.prepare` 注入代理。没有导入私有 desktop-host、
伪造 `runProfile.prepare`，也没有新增公开监听、Worker 池、Docker 要求、Remote、MCP、
Agent 循环、模型协议或审批引擎。

凭据、当前权限、原 publication lease、Recovery 草稿和持久事件投影都由 Main 唯一拥有。
bootstrap 仅包含 Main 拥有的受保护 Profile 路径、固定模型策略及权限快照。
wire 精确约束版本、kind、代际、调用序号、方法和参数，业务方法使用固定有限白名单。
领域 opaque 标识遵循原有界契约；代际、ticket 和 stream 标识继续严格验证。
未知方法、多余字段、非法数据、旧代际、坏的匹配回复及断线全部拒绝。
Node IPC 自身的反序列化不等于操作系统内存沙箱。

限制包括每 DTO 8 MiB、8 项 pending、Main 独立的 10 秒启动和调用期限、64 KiB 模型拉取块、
单模型流及 4 MiB 流总量。这些是本可选组件新增的保守边界，不是原执行或供应商契约。
模型解码继续由原 adapter 承担。数据遍历在整份序列化前累计并拒绝超限。
供应商及源异常文本被固定错误码替换。

原 `AgentSetupCommit.commit():void` 只同步消费子进程的本地有限 ticket，不宣称跨进程原子提交。
Runtime 收到 Main publication ACK 后才执行自己的 followup、创建草稿或接纳精确原 Agent。
捕获的 lease、Host 生命周期、原 Agent handle、pre-step、工具前置单调 guard 和原 LOOP LLM
检查共同限制执行；Main 每次授权动作重新检查当前权限。prepared ticket 按 Main 权限期限过期，
最长 10 秒，并释放 Main 原 lease。committed IPC publication 按当前 Main 权限期限、同一
Main-owned Run 期限和 60 秒三者的最早值过期。子进程仅通过固定私有 `publication.renew`
操作在到期前续同一已提交 ticket；Main 重新检查当前权限和精确 Session/Run/project，
不再次 commit，也不创建新 Agent。每次续期仍受上述三重期限约束，不延长服务器 Run。
过期、拒绝、Host 截断或续期失败关闭通道。通过准入的精确 ticket release 仅撤销：Main
在任何新鲜权限 await 前同步删除该 lease、清除到期 timer 并 dispose。renew 和 release
不等待串行业务写入。每次 renew 的 10 秒调用期限捕获精确 ticket 和 entry；若该 entry
已被撤销，期限只取消并移除该 pending 请求。仍活跃的不配合 renew 继续关闭全通道。
子进程在 release 或通道关闭时清除本地续期 timer；丢失或失败 ACK 不启动续期，迟到
回复或错误不能恢复已 dispose 的 publication，也不能关闭同一 Session/Run 的新 publication。
timer 只维护原权限 lease，执行仍由原 Agent 循环负责，不续 history read grant 或 caller 凭证。

same-realm 同步接口保持兼容。子进程同步读取只访问最新已 ACK、单调 revision 的 Main 不可变
快照；同步写入拒绝。显式 `asyncAccess` 等待刷新、编辑、取消请求和 Session 事件写入 ACK。
Runtime 在释放 Main 原 lease 前 drain 原 Session 投影 ACK；Main 忽略 terminal 投影后的迟到
取消请求。live Host RPC 的 `stopped:true` 被拒绝；原 aborted turn/end 持久记录为
`interrupted`，不声称已独立确认进程停止。

即使回复丢失或子进程退出，Main 仍拥有并释放原 lease。caller 取消、start abort、捕获 Host
截断、失败启动及账号切换使通道失效，迟到回复不能恢复快照或 ticket。真实两个 Node 进程测试
覆盖原 Loader/Agent/Session/工具/模型、Main/Broker/Recovery、丢失及失败 ACK 的创建监听器
提前 wake、模型取消、坏回复、不配合调用超时、重启与切账号。真实 66 秒原 Core 执行验证跨过
旧 60 秒期限；短期 fork 测试覆盖撤销权限、Run 变化、release 及 Host 截断。
release 回归将 renew 持有到跨过原 1,500 ms 到期点，并在新 ticket 活跃时跨过未改动的
10 秒调用期限。
IdP、ACL 和模型回复仍为 fixture，
这些检查没有认证 Windows/macOS、Electron、safeStorage、系统 confinement 或真实外部凭据。

生产剩余项包括 Desktop 真实私有子通道和 bundle bootstrap owner、Electron caller proof、
原生 confinement、完整 Renderer/Client 装配，以及 Host 退出后由 Main 拥有的离线草稿 UI。
真实 Main 默认仍拒绝启动，没有启用 D13/D14 的审批或业务保存。
回滚撤去可选组合及源码补丁，保留现有 Recovery、Session、namespace、凭据和回执。
