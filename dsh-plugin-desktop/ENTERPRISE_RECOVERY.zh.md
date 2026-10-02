# AFOS 本地草稿恢复

中文 | [English](ENTERPRISE_RECOVERY.md)

状态：已实现源码和 Linux 文件系统／模拟合同测试。本模块尚未激活桌面登录、Host、UI 或后台上传。运输能力须由可信 Main 持有并连接固定 Enterprise Broker 动作。Windows/macOS 安装、真实 IdP、Session 恢复及服务端存储恢复尚未验证。

`EnterpriseRecoveryStore.open(base, binding, transport)` 建立 `base/afos-accounts/<sha256(issuer, subject, organizationId, deviceId)>/{profile,home,cache,outbox}`。调用者须提供已认证的身份绑定，并保证只有一个 Main 持有该目录。个人文件保留原位。切换 Host／账号前调用 `close()` 中断旧请求并关闭句柄；新账号使用不同目录，不能接收旧运输能力。调用者仍须停止旧 Host、关闭连接，并阻止 Renderer／Agent 获得存储、输入快照或运输对象。

持久记录只有有界且版本化的数据：真实并校验摘要的输入快照、不可变 Run／release／policy／来源引用、官方 Session 引用、本地可编辑草稿、固定归档幂等键、粗粒度执行投影和已记录的服务器回执。合同不接受凭据、模型提示词、工具轨迹、任意路径、端点或脚本字段。最多八份草稿和八 MiB 编码后的正文／元数据；超限拒绝写入并保留现有记录，不自动删除用户文件。草稿及输入快照是企业本地明文，由文件访问规则保护；不能声称已下载内容能被服务器即时抹除。

`createDraft()` 要求服务器当前授权及服务器复核后未变化的 Run。`editDraft()` 允许离线编辑已有本地副本，直到存在归档意图或回执。显式调用 `archive()` 先查当前授权、查询回执，再查当前授权；服务器回执须匹配 Run／attempt／正文摘要。服务器确认尚未归档时，再验证当前 Run／ACL／release／policy／输入／设备／有效期。首次可能上传之前，模块原子发布并 fsync `needs-reconciliation`；未知响应、损坏回执、进程退出或重试均先查回执。Run 过期后仍可对账既有回执，不能新上传。主任务接线须提供 `assertCurrent`、`validateRun`、`getReceipt`、`archiveDraft`，磁盘 Run 自身不是授权句柄。

并发归档被拒绝，每个 Run／attempt 仅有一份草稿。待对账或已归档的内容不能在原幂等键下改变。安全重跑要求新授权的 Run／attempt、相同项目／release／来源版本及明确的前驱引用。加载存储不创建任务、不调用服务器、不恢复 Session；原排队／运行／取消请求记录变为 `interrupted`。不承诺恢复未提交的模型流，也不显示进程退出后任务仍继续。

可信官方 Session 订阅可通过 `projectSessionEvent()` 投影 DSH 0.1.7-rc.2 的公开 `turn/start`、`turn/end` 信封（`type`、`seq`、`time`、`data.turn`、`data.reason.kind`）。已在固定 DSH 公开 Session 源码核实信封和结束原因。序号去重同时绑定命名空间／Run／attempt／Session，旧尝试不能覆盖新投影。投影不保存消息或错误正文，不改变归档状态、不启动 Agent。`aborted` 仅表明中断；可信调用者确认实际 Host／进程停止后才能记录 `cancelled`，该状态对相应 Run／attempt 为终态。归档响应仅把归档字段合入最新投影，待完成的网络响应不能回退较新序号或取消状态。派发前取消会拒绝新上传；已发生的服务器提交仍能与已确认本地取消并列记录。磁盘回执是带 `lastSyncAt` 的缓存服务器响应，不是新授权、服务器见证的本机执行事实，也不能替代联网后的回执查询。

POSIX 使用私有目录／文件权限、当前 uid、祖先目录／普通文件／链接检查、`O_DIRECTORY`／`O_NOFOLLOW`、描述符与路径身份核验、随机独占临时文件、fsync、原子 rename 和目录 fsync。所有受管目录及其父目录在使用前同步，包括上次启动失败留下的目录。rename 后持久性失败会关闭存储，防止旧内存覆盖新磁盘版本；重新打开须验证磁盘记录。调用者须提供规范化的绝对现有根路径。链接／硬链接、权限过宽的受管路径、损坏数据及未知合同版本都会被拒绝，不 reset 或覆盖。Node 路径操作仍存在同用户目录／重解析点竞态；这不是原生恶意文件系统边界，也不是 Agent 沙箱。需要桌面单实例持有，进程内检查不是 OS 锁。

Windows 默认返回 `recovery/platform-acl-unverified`，必须提供独立验证的 `verifyWindowsAcl(paths)` 原生适配器，验证受管目录及文件。POSIX 权限、Linux 测试或注入回调不能替代 Windows ACL 或 macOS 安装验收。真实受保护 Profile／Home 接线、电源／休眠事件、实际 Host 退出、官方 Session checkpoint／旧版本兼容、加密凭据恢复、服务端数据库／对象存储恢复及目标平台签名仍须分别提供证据。

回滚：保留账号目录的未改动副本，在隔离 Profile 中用上一兼容读取器验证。不能替换个人 Home、修改官方 Session 日志、把 Token 文件复制到本存储，或把应用回滚等同数据库回滚。未知存储版本拒绝加载。服务端文件／元数据／回执、官方 Session、桌面草稿及 OS 保护凭据分属不同领域，须分别恢复。移除本模块源码不能撤销已完成归档。模拟备份测试只验证本地草稿 v1 读取器，AT-50／51 仍 NOT_RUN。

证据映射：D09 AT-40／41／42／43 和 D05 AT-13／14 中的账号绑定部分具有模拟合同／文件系统覆盖；本模块不证明 D09 AT-31。D11 AT-48／49 因目标机器与已验证 OS 适配器缺失保持阻塞。D12 AT-50／51／52 仍要求真实升级／恢复和产品整体独立审查。模拟测试通过不等于正式验收通过。

根任务现已把本存储与私有 Main OAuth/Broker、当前权限、加密凭据轮换/恢复及先查回执的归档操作组合起来。退出清理会等待尚未完成的凭据写入；同一 namespace 重新发布凭据前，旧的失败删除必须先完成。普通调用者取消和账号生命周期取消会结束待处理模型读取，不依赖流主体配合。Main 在 Host 启动前拒绝过期权限。仅当应用内部存在发行负责人提供的 `afos-desktop-config.json` 时，Electron 载体才包含原生账号、项目和退出菜单，不接受环境变量或 Renderer 配置。精确字段为 `contractVersion: afos.desktop-config.v1`、`releaseId`、`policyRevision` 与 `auth: {issuer, clientId, resource, scope}`；issuer 必须为 HTTPS，resource 必须等于 issuer 路径加 `/afos`，scope 为 `afos`，可附加 `offline_access`。不要在该文件放凭据。

可选载体入口不在启动时登录，也不从 Renderer/Agent 接收凭据。无脚本状态窗口提供原生受信任账号操作；缺少配置文件时，原有个人载体照常启动。企业入口不启动个人 Profile，其 Host 能力保持 `ingressValidated: false`、`sandbox: unavailable`，在真实 Profile 入口与原生隔离验证之前拒绝启动企业 Host。完整 Loader/Agent/Session/LLM/Client 装配、原始 HTTP/WS 收口、草稿界面及目标平台验证仍未完成。源码整合或原生菜单编译均不构成 G3 通过。
