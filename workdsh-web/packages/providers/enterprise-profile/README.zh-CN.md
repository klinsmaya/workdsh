# 固定企业 Profile 接线

版本 `0.1.0-alpha.1` 是未激活的 AFOS D01/D05/D07/D08 集成组件。复用已发布
DSH `0.1.7-rc.2` 的 Connection RPC registry 与 Tools pipeline，不新增 Agent
循环、Session 引擎、模型路由或 MCP 传输。个人 WorkDSH bundle 保留独立。

`SnapshotIdentityAuthority` 从 Main 私有回调读取固定
`identity.current(projectId)`。每次校验 `afos.identity.v1`、完整
issuer/subject/organization/device 绑定、项目、当前 read 权限、服务端修订和 UTC
有效期（最多未来五秒），再映射既有 canonical 身份合同。member 仅作显示，组织名称显示组织 ID。
只允许 actor 自身 personal Session 的 read/use；业务资源及 edit/manage 均拒绝。
既有身份提供方仍拥有 actor 证据，既有 Access 服务拥有持久 Session owner。
服务端失败、畸形或变化响应永久关闭本适配器；回调不接收调用者选择的 Token、URL
或角色。

`fixedEnterpriseComposition()` 是已审查的清单片段，**不是可运行的完整 Desktop
Profile 或生成的 Loader patch**。断言只接受完全相同的普通数据，拒绝附加插件、
工具、用户 patch、PTC、gateway 和公网监听地址。清单没有 Shell、stdio MCP、
浏览器、原始文件系统、配置、插件安装或通用 controller 能力；本机执行为
unavailable。Host launcher 必须只装配获准集合，在监听前注入可信命名空间存储配置
和 bridge 服务。完整官方 Agent/Client/preset 装配及制品验证未完成，因此
`assertEnterpriseDesktopActivation()` 始终拒绝激活。

`EnterpriseProfileIngress` 独占既有 Connection `/api` RPC interceptor，只提供
`afos/createSession`、`afos/readSnapshot`、`afos/renderDraft`。参数必须是准确字段及
有限 ID、正文、来源引用；通用 Session restore/create、文件、terminal、config、
settings、plugin 和 MCP RPC 返回固定拒绝。创建委托使用既有 Session Access bridge
的可信适配器，再校验返回 owner。读取和草稿准备必须使用当前 provider-minted
actor、持久 owner 和 Access 决定。注入的 Main bridge 必须另行校验当前 run 与固定
材料摘要，不能成为泛用网络/文件代理。文本快照再校验 SHA，成果保持 local-draft。
本包不提供审批、归档、业务保存或对外写 RPC/tool。

官方 Tools 只注册 `afos_read_snapshot`、`afos_render_draft`。全局单向 guard 拒绝其余
能力、缺失 Agent、失败授权及同名 scope 遮蔽。调用必须使用官方 AgentRegistry 中的
准确 live 对象，最初信号须由公开 agent/pre-step 登记或由可信 dispatcher 建立；
Agent 生命周期卸载即令证据失效。自身固定工具登记完成后，任何 tools/change 同步
关闭本 Host 片段，包含异步包装器迟到安装的同名 scope 遮蔽。实际工具主体在所有异步执行包装器后
重新检查当前权限，将融合后的 cutoff 信号交给实际业务效果 owner，并拒绝迟到结果。
可信 `executeTool()` 在官方 dispatch 前先将权威信号融入原始
`ToolExecutionInput.signal`，后续信号替换不能移除它。官方循环的每次工具调用在
pre-tool 检查后，将本次授权窗口信号接到公开 `Agent.cancel()`，终止原始 turn 信号。
Tools result 与服务卸载移除本次调用监听。另有独立稳定 Host cutoff 监听，在两次工具间
及模型工作时调用 Agent.cancel，不带 actor 新鲜度计时器，并在 Agent/服务卸载时释放。
测试使用真实 Tools、AgentRegistry 和 fixture 权威/可取消 Agent 句柄；真实 Agent-loop
集成与服务端账号撤权传递仍待验证。既有 actor 新鲜度默认一秒，这是保守的工具调用
时限，不是整次任务的生命周期策略。

官方 Gateway 已占唯一 RPC interceptor，其 WebSocket 和直接调用绕过 HTTP
`connection/request`；公开 WebServer 没有全局升级 tap。本包拒绝已装载 Gateway，
固定清单排除它和通用 controller。本包**不改造已经装载的默认 Profile**，不宣称
现有全部原始 HTTP/WS/Remote 路由已封闭，也不把隐藏按钮作为边界。完整原始入口、
可信 launcher/命名空间、真实 NocoBase 身份和目标桌面验证仍是激活与正式
AT-03/13–18/20/22–23/33/35–39 的前置。

在 `workdsh-web` 使用固定 Corepack pnpm `10.34.5`，先构建 `workdsh-contracts`，再运行
本包 build、typecheck、test。二十项离线测试覆盖固定清单、当前身份映射、原始 RPC
拒绝、scope 遮蔽、信号替换、撤权后主体入口、迟到响应、卸载、迟到注册及 Agent 生命周期证据。三项已发布 API 探针
记录实际 Gateway/WS 准入缺口。原始命令输出、退出码、源摘要和独立审查在
`evidence/`；fixture 或 Linux 结果均不计为正式桌面 AT PASS。

回滚只移除企业组合中这个可选包/配置与私有权威适配器，保留个人 Home、既有 Session
owner、命名空间 outbox、凭据和用户草稿。未执行远程 push、部署、生产迁移或对外
业务写入。
