# 企业 Profile 独立只读审查

结论：**允许作为未激活源码整合**。本次冻结范围没有遗留的源码整合阻塞；**不批准运行激活，不认定任何正式 AT 通过**。

审查覆盖 `src/`、测试、`package.json`、锁文件、公开身份契约与已安装 DSH 的公开接口。审查任务只新增 `evidence/profile-review*`，没有修改实现、测试、依赖或上游。最终 14 个冻结文件的 SHA 及复核结果分别见 `profile-review-final-frozen-files.json` 和 `profile-review-freeze-verification.json`，全部保持一致。

最终独立复跑：`node --test tests/profile.test.mjs` **20/20 通过，退出 0**；`tsc -p packages/providers/enterprise-profile/tsconfig.json --noEmit` **退出 0**。两条命令的 stdout/stderr、退出码和摘要均已保存。这里的身份、业务桥接与 Agent driver 为 fixture；使用真实发布的 Connection、Tools、Scope、AgentRegistry，不等于运行了真实官方 AgentLoop、IdP 或目标桌面。

审查中发现并经实施任务修复的三处问题：

- 异步工具包装器在最后 guard 之后安装同名 scope 工具，曾执行未审查主体。现在定义已冻结，工具表变化同步 cutoff，已证明的原始调用信号在替换主体前中止；新回归的主体计数为 0。
- 仅有 `id` 和 `cancel()` 的仿造 Agent 曾被接受。现在要求与公开 AgentRegistry 中的对象完全相等，并校验原始信号、Agent 对象和生命周期 generation；未登记手动信号以及同对象重新登记后的旧信号均被拒绝。
- `agent/pre-step` 后、尚未进入工具窗口时，显式 Host cutoff 曾没有取消循环信号。现在稳定 Host lifetime 与公开 `Agent.cancel()` 独立接线，由 `ctx.effect` 与 `agent/disposed` 清理；一秒 actor 新鲜度仍仅用于调用窗口。新回归验证未调用工具时也会中止原始信号。

另外，两个固定工具的 `safeTool()` 已对非本模块异常输出稳定错误码，新增回归确认业务桥接异常详情不会直接进入模型工具错误。

固定身份映射重新检查 issuer/sub/org/device、项目、当前读取权限、服务器修订及不超过五秒的 UTC 到期时间。显示角色仅为 member；会话 read/use 之外的业务、edit/manage 映射拒绝。工具主体在异步包装器之后再次调用当前授权，并验证返回内容、SHA、大小与固定字段；cutoff 后迟到响应被丢弃。未创建第二套 Agent、Session、模型路由或 MCP 实现。

仍阻止激活的事项：

- 固定 JSON 是组合片段，尚未强制实际 Loader/插件/物理路由清单。精确 Connection Fetch 路由优先于共享 RPC interceptor；独立 HTTP 与 WebSocket 升级也不受它覆盖。可信启动器必须完成受限组合、完整官方 Agent/Session/模型/Client/preset 接线和物理请求大小限制。
- 尚未验证真实官方 AgentLoop 与当前身份提供方、Access 的完整组合，以及取消后收敛、一秒调用时限和真实撤权传播。
- Main 的身份与业务 IPC 仍是注入接口。账户、组织、项目切换和 logout 必须明确触发 cutoff；业务效果 owner 必须独立核对当前 run、权限、项目、Session 归属及材料 pins。真实 IdP/grant 交换未验证。
- 实际 Client/GUI、打包启动、Windows/macOS、签名和原生隔离未验证；原生执行仍不可用。

历史探针与原始失败输出保留，不能当作当前通过项：`profile-review-fault-probes.*` 重现修复前的替换/仿造缺口；`profile-review-lifetime-route-probe.*` 重现已修的 lifetime 缺口并证明仍存在的精确 Fetch 组合边界；初次测试的 13/15 结果来自实施任务补充测试而旧 dist 尚未重建的时序。最终结论只依据此次冻结文件与 20/20 回归。

回滚只移除该可选、未激活模块和其配置；保留用户已有 Session、归属记录、命名空间、凭据、outbox 与草稿。此次审查没有运行部署、数据库迁移或对外业务写入。
