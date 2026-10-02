# NocoBase 企业身份提供方

版本 `0.1.0-alpha.1` 提供显式 Cordis `workdshIdentity` 服务，以及接入既有
WorkDSH Access 和 Session 桥的当前权限接点。它是未激活的集成组件，已有本地
fixture 测试。实际企业桌面的 AT-13 至 AT-16 仍为 **NOT_RUN**。

可信 Host 必须提供实现导出 `NocoBaseIdentityAuthority` 合同的
`afosIdentityAuthority`。适配器每次检查当前 NocoBase access grant、有效用户
和成员关系、设备绑定、记录及字段 ACL。提供方不处理 OAuth Token、不解码
JWT、不实现登录、不持久化企业成员，服务端不可用时不回退本地角色。没有猜测
HTTP 端点或默认权威适配器。

每个 Host 绑定不可变的 issuer/subject/organization/device 四元组。SHA-256
命名空间可用于另行准备的 Profile/Home/cache/outbox 根目录；此包不创建这些
目录，也不迁移既有个人数据。切换身份必须先停止旧 Host 和连接，再用新命名
空间创建 Host。`cutoff()` 永久拒绝此 Host 的 actor 并取消正在读取的当前权限；
迟到的响应不能恢复权限。受控操作必须使用提供方建立的 actor，复制或伪造
actor 会被拒绝。

既有 AccessManager 显式配置 `{ enterprise: true }`，既有 ToolAccessBridge
配置 `autoBindPersonalSessions: false`。企业 Access 对 owner 也检查当前服务端
权限，并拒绝本地管理 grant。SessionAccessBridge 在调用官方 Session controller
前持久化既有 owner 记录，拒绝创建已有 Session，并在恢复前重查权限。不新增
Session 或执行引擎。官方同步单向工具 guard 会拒绝缺少 agent、未完成成功检查、
或经过后续异步策略后 actor 已过期的调用。官方 around-dispatch 接点还将调用信号
与 Host cutoff 和授权截止信号融合，请求协作取消。获准 around wrapper 必须保留
该信号；后续 wrapper 若直接替换它，仍可能绕过此 relay，因为 DSH 只在主体入口
重新融合最初 caller 信号。激活前可信 ingress 必须先把权威信号融合到最初 caller
信号，或使用已独立验证的官方主体末端 guard。这条完整边界尚未实现，不能声称
本包已保护该入口。

新鲜度默认一秒，不得超过五秒或 grant 到期时间。窗口从权威请求开始前计时，迟到的响应不能续期。这项有限检查不能立即停止
已运行的任意工具代码，也不能在服务端撤权后擦除已下载明文。后续每次受控操作
重新检查服务端当前权限。原始 Remote、文件和 WebSocket 入口仍需完整保护；
载体账号切换、命名空间目录准备和 outbox 集成尚未完成。完整入口和真实 NocoBase
适配器验证前不能激活企业 Profile。本包未加入个人 bundle，没有自动 Loader patch。

使用 workspace 固定版本的 `corepack pnpm --filter
workdsh-provider-identity-nocobase build` 构建，构建 `workdsh-plugin-access` 和
`workdsh-plugin-audit` 后运行本包测试命令。测试使用真实已发布 Cordis/DSH 服务
和临时 JSON Storage Domain，权威接口及 Session controller 使用 fixture，不能
代替 Windows/macOS 或部署 NocoBase 验收。回滚时移除此可选服务和配置；命名空间
数据及官方 Session owner 记录保留原位。
