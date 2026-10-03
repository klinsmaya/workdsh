# Renderer 崩溃后的显式企业新窗口

原生企业账号所有者保留既有 Main 会话、项目选择和本地 Recovery 存储。真实 `render-process-gone` 事件同步撤销旧文档和 caller 所有者，并停止企业执行。窗口显示原有本地页面，等待下一次显式原生 Start 操作。普通文档 reload 保持原有生命周期，不会自动启动 Host。

原生 Start 使用同一个本地窗口工厂预建 BrowserWindow，保留原有 sandbox/context-isolation 配置，并使用新的非持久 partition。旧物理窗口保持存活，直到旧本地 IPC 注册、账号观察器和在线请求 hooks 完成释放。随后新工厂安装自己的 handlers，并加载既有本地 renderer。只有这个 owned 窗口就绪后，既有 CLI/Core 才能启动并执行原有私有 index/cookie 交换。旧物理窗口在替换窗口就绪后关闭，替换过程中不会产生中间 `window-all-closed` 事件。

原生 Close 同步撤销文档和 caller，阻止立即销毁，并在既有 Host 清理完成后销毁最后一个窗口。重复 Close 共享该清理过程；期间拒绝 Start。清理失败时保留物理本地 shell 并拒绝在线 Start。原生 carrier 既有 `before-quit` 清理保持不变。原生 Close 已拥有 stop 后，`closed` 不再排入另一次 stop，避免与 quit/suspend 的账号 cutoff 竞争。

Close 已拥有本窗口的清理期间，Renderer 崩溃和文档加载取消回调共享已有 stop。主动关闭产生的取消不会再次报告清理失败；待完成 Start 仍返回其加载异常并执行自己的有界回退。其他所有者以及关闭之外的失败仍保持原来的 cutoff 行为。

旧 `closed`、Renderer 崩溃和本地加载失败回调使用所有者身份 guard。重复调用旧 owned close 回调不能清除新的 Main 窗口引用、移除新窗口 IPC handlers 或停止新 Host。严格在线 `mainFrame`、top-frame、URL 检查及有限 caller issuer 保持不变。并发 Start，以及显式 stop、账号、项目和 suspend cutoff，都不能放行旧的待完成 Start。

替换窗口构造、IPC 安装或本地加载失败时，会停止 Host 并拒绝在线入口。失败的预建窗口会被销毁。旧物理本地 shell 保留，供下一次显式原生操作重试；如果旧所有者已经释放，其旧 IPC 能力会持续撤销，直到新的替换成功。不会自动重放 Run、prompt、Agent promotion、旧 lease 或模型任务。

替换窗口准备期间的原生 Close 也会取消本次 Start。无论页面就绪还是 Host 清理先完成，回退只在关闭标记属于被丢弃替换窗口时清除该标记。延迟完成的 Close 回调不能销毁后来所有者，也不能清除后来所有者待完成的 Close。旧物理 shell 保留，供下一次显式重试。

作者验证包括十六个有界生命周期 probes、既有 Desktop 测试与真实 Main/CLI 回归，以及使用原 CLI、23 模块 loader 和 SDK 的 Linux Electron 43.3.0/Xvfb 真实组件 fixture。真实 fixture 检查 Renderer 崩溃和显式替换，独立 window、Session、partition、frame、cookie 与私有 readiness，先释放后安装的顺序，旧 owned 回调隔离，普通 reload、Host 崩溃、项目和账号切换、本地草稿保留、suspend 及当前窗口关闭。另两个真实原生 Close case 暂缓替换窗口就绪和真实 Main stop 完成，覆盖两种完成顺序，随后显式重试并检查后来所有者。一次显式 fixture Run 准备基线草稿；各次重启保留它，不产生新 Run 或模型请求。真实测试使用原生 Close，并只观察退出，不保持退出；owned Close 路径必须先完成清理。最终 Close 还在暂缓清理期间接收真实 Renderer 崩溃，并确认只有一次 owned stop。随后调用真实 Main suspend，确认 Close 不重复排入 stop 且无清理失败。它不声称验证了完整生产 app-quit 链路。它只重复调用 owned 工厂回调，不执行 Electron 内部 runtime listeners。此前在 Host 活跃时强制销毁最后一个窗口，会间歇性阻塞 Electron 清理；这些失败运行明确保留为证据，不计为验收通过。

首次失败运行和 fixture 修正均保留在 owner 证据中。Linux fixture 在受控 runner 中使用 `--no-sandbox`，不证明 OS sandbox 验收、Windows 验收、真实身份提供方凭据或生产能力。作者结果不代替冻结源码后的独立复审。原正式验收矩阵维持总计 60：2 PASS、12 BLOCKED、46 NOT_RUN；G3 维持 NOT_PASSED。
