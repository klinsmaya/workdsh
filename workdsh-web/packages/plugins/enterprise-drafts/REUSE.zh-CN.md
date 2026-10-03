# AFOS-0006：原 Client 导航就绪

## Source20 授权本地草稿 Client（实现前复用记录）

新增替代公开 `./local-client`，factory id 为 `workdsh-plugin-enterprise-drafts-local`，
只消费 Main 固定 `afosLocalDrafts.state/edit/subscribe`。复用原 DraftPanelModel、
EnterpriseDraftPanel、严格 DTO/SHA parser、官方 main/sidebar Slots 与 Layout；
不用 Connection/Remote/Session运行时，不建立第二授权或执行事实。Main/Recovery
仍拥有账号/项目范围与本地记录，Client 强制 offline/scopedLocalOnly，cap事件先
清视图/编辑范围再刷新。localOnly UI不渲染企业动作。dsh.localClient 是载体选择替代
face的metadata，仍用原模块图，同Slot只选一个face。单元反例、原SlotRegistry、SSR
为工程证据，实际Chromium/Electron归载体接线方，正式AT/P2不提升。

授权来自用户 D08/D09 与 Root 独立 P1 Client 就绪切片，基线 source15
ed79a0fad2b8cce09a14b145b196b37959650ecd。P1/G3 尚未通过；不新增 Main grant、
remote 方法、执行所有者或 transport，仍由既有 Host 拒绝 mutation。

实现前读取已发布 DSH 0.1.7-rc.2/Cordis 4.0.4 的公开 exports，并实际运行
Chromium 原 UI 图。过早打开的真实 timeout 与首个正链均保留，顺序等待成功
没有掩盖原竞态；公开产物与真实命令在独立只读 full-client inventory 冻结。

| 所有者 / 公开入口 | 复用及限制 |
| --- | --- |
| dsh-client-connection/client | 读/订阅原 generation 与 reset；不注册第二 generation source 或启动循环。 |
| dsh-api-remotes/client | 只调用原 generated session.list({}, signal)，当前归属由 Host 核实。 |
| dsh-api-session-controller/client | 原 refresh/list、retain、SessionReference.ready/binding/release、snapshot、binding(id)；只增加消费来源标签。 |
| dsh-client-ui-workspace/client | 原 openSession 同步保留视图，随后才释放临时引用。 |
| dsh-client-ui-slots / renderer | 保持正式 main/sidebar Slots，使用原 SessionProvider/Conversation，不复制 renderer。 |
| workdsh-ui | 等待、取消与错误使用既有 Button/status 表达。 |

决策：操作局部取消等待原 ready；新鲜 Main 业务选择与 generated 读取必须
匹配捕获的 project/draft/Session。直接读取不填充原 Controller catalog；
须等原公开 refresh 并订阅其 Host 成员 ids/byId 后才 retain。ready 结束不等于
成功 open，须检查原 openState/error/removal 与 binding 身份。每次 await 后
重新核对原 generation/选择。

首次 reset 可在等待第一 generation 时暂时清空 Main UI 投影，只允许新鲜同一
投影继续；非首选草稿改变则拒绝。绑定后任何 reset/loss/replacement 都取消；
明确取消、后来请求、离线/错误、页面/模块卸载或有界期限也取消。没有权威
就绪缓存，不因单消费取消而中止原 owner 的共享 baseline/open。

组件测试与真实 Chromium 使用原 ModuleSystem/Loader/frontend 和真实 HTTP/WS
合成 fixture。MainIPC+NativeWS 联合桌面启动、真实 Renderer proof、目标 OS、
签名及真实 model/IdP/NocoBase 未验证。完整原生只读展示仍缺 Sidebar New Session
独立公开禁用槽等部分；generation 消失后原历史缓存可能继续存在。

回滚：撤下此 Client 贡献或反转本地源码补丁；官方卸载取消操作、释放消费引用、
撤销 Slots，不改变持久数据、原 Session 日志或数据库结构。
