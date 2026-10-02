# AFOS 本机沙箱适配器

私有版本 `0.1.0-alpha.1`，任务 **D06**，当前为未激活基础。[English](README.md)。本模块没有修改桌面载体、既有 Profile 或固定上游源码。

模块为可信 Broker 的每次运行编译固定目录与环境策略，复用官方 DSH subprocess 句柄；每次调用拥有独立 SRT 管理 Worker。策略不可变，不使用全局 `updateConfig`；运行不能共享输入/可写目录，也不能通过 runtime 读取授权暴露另一个运行。网络固定全部拒绝，不接受工具传入环境、URL、Shell 可执行路径或任意目录。调用官方 DSH 的环境合并前，显式清除所有父进程环境项。

正式依赖固定为 SRT npm `0.0.78` 与 DSH subprocess `0.1.7-rc.2` 公共接口。研究源码与发布包证据分开记录，见 [官方能力复用记录](REUSE.md) 和 [兼容证据](evidence/compatibility.json)。不新增进程执行器、Agent 循环、通用工具协议、MCP 传输、审批引擎或高权服务。

**生产能力探针只返回 `partial` 或 `unavailable`，两种状态都拒绝执行。** 依赖和 namespace 可运行不代表完整隔离。当前尚未证明路径/链接并发替换、原始 TCP/UDP/IPv6、本地 socket、全部进程树和实际桌面工具路径。以后只有具备真实完整证据的原生后端才能声明 `full`。离线测试注入的 full fixture 不是模型、Renderer 或材料可提供的配置。

进程边界不覆盖 Host 直接文件、PTC、浏览器分区、模型 HTTP 或桌面 IPC。包含这些路径或者没有提供路径清单的调用会被拒绝。stdio MCP/本地脚本只有真实启动经过本适配器且 OS 边界已验证时才有资格启用；绕过该路线自行 spawn 的 SDK 仍属于缺口。不得只凭本模块激活企业 Profile。

策略编译器要求输入、工作区、临时目录和固定依赖目录已经存在且路径规范；输入/工作区/tmp 分开，保护 Host 状态。拒绝 symlink/junction 祖先、hardlink 文件和非普通文件。该检查**不证明**后续 TOCTOU 替换无法发生，也不证明材料由授权服务器下发；仍需可信快照落地和真实 OS 约束。

执行生命周期调用官方 DSH `spawn`，等待 `done` 后执行 `terminate`，确认同一 managed range 的 `waitForExit`，再 reset SRT。取消、退出共同等待完整调用收口；准备期间的资源不会在 dispose 完成后突然发布。准备失败携带可恢复清理 lease；进程范围/reset 清理无法确认时保留目录占用和管理器，拒绝复用。SRT 公共 `reset` 返回**不能单独证明**原生辅助进程已退出，因此仍不声明完整能力。

| 平台 | 实测前置 | 产品强制隔离 |
| --- | --- | --- |
| 当前 AFOS Linux x64 容器 | bubblewrap `0.12.0`；namespace 探针退出 `1`，uid map 只读；没有 socat | **BLOCKED**；禁止无限制降级 |
| Windows | 无目标机器；未安装账号、ACL、WFP 或 CA | **NOT_RUN**；拒绝初始化 |
| macOS | 无目标机器 | **NOT_RUN**；不声明 full |

在本目录按固定 `pnpm@10.34.5` 执行：

```sh
corepack pnpm install --frozen-lockfile --ignore-scripts
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run probe
```

首次依赖准备未运行生命周期脚本，锁文件随源码交付。构建/类型检查及 18 个本地用例通过。`probe` 对 partial/unavailable 退出 `2`，表示实际拒绝，不能作为安全验收通过。N01–N13、N16–N18 是注入的策略/生命周期 fixture；N14 使用正式 SRT 依赖探针，N15 运行真实 Worker 的有序操作。Linux 和模拟支持证据不能替代目标桌面验收。

正式 **AT-12、AT-24–AT-30、AT-32 仍为 NOT_RUN/BLOCKED**。未完成：目标 OS 原生实现和安装证据、全工具/provider 接入、固定网关网络策略、TOCTOU 与进程/辅助进程对抗测试、真实凭据泄漏测试、独立安装级桌面验收。

回滚：移除独立模块或撤销其本地源码增量。当前没有任何运行时加载本模块，没有生产表、账号、安装服务或原生授权。测试只删除自行创建的临时 fixture。没有修改上游、推送、合并、发布、部署或高权安装。
