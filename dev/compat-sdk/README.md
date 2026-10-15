# 开发端兼容测试 SDK 0.1.0

管理器版本为 **0.0.5**。这是开发工具，未新增 `window.kmm` 接口或产品页面。当前可用范围为稳定构建检测、源码门禁、本机只读接入、分层报告、SDK 专有目录的恢复、前台轮询和本地缺陷任务。真实游戏窗口/输入/捕获及固定基准 Mod 自动化尚未接通，默认完整运行返回 `inconclusive`，不会报告游戏兼容。

## 命令与功能

在仓库根目录执行：

```powershell
npm.cmd run compat:typecheck
npm.cmd run compat:verify
npm.cmd run smoke:compat-sdk
npm.cmd run compat -- inspect --game endfield
npm.cmd run compat -- run --game endfield --suite local
npm.cmd run compat -- run --game endfield --suite full
npm.cmd run compat -- watch --once
npm.cmd run compat -- watch
npm.cmd run compat -- triage --run <本轮report.json绝对路径>
npm.cmd run compat -- baseline approve --run <本轮report.json绝对路径> --reviewed
npm.cmd run compat -- recover --sandbox <待恢复sandbox绝对路径>
```

`--config <绝对路径>` 可覆盖默认 `.run-data/compat-sdk/config.local.json`。参照 [config.example.json](config.example.json) 创建本机配置。配置只包含路径、渠道、机器配置名和间隔；不接受命令或动态加载模块。现有真实游戏和 XXMI 路径只读，`xxmiRoot` 支持外层根或有已知父配置的 `EFMI/ZZMI` 组件目录。它们不会被当作 SDK 专用写入目录。

| 命令 | 对应功能与边界 |
| --- | --- |
| `inspect` | 两次有间隔且一致的观察，最多四次；读取 EXE、有限安装清单、PE 辅助字段、组件包/核心版本、固定启动计划及公开配置。输出 inspection JSON，不启动游戏。退出 0 仅代表取得稳定观察；组件问题仍列在 issues 中 |
| `run --suite local` | L0 源码门禁、L1 接入和 SDK 工作区写入、L4 恢复；退出 0 只代表所选范围通过，`gameCompatibility` 仍为 inconclusive |
| `run --suite full` | 包含 L0–L4。未注册 L2/L3 自动生成必需的待补测项；没有 live 实现时不能得到完整兼容结论 |
| `watch` | 前台按 pollMs 低频复检，稳定后串行执行完整范围；不安装服务/任务、不启动真实游戏。相同语义 runKey 去重；不稳定不覆盖上次记录；完整通过无输出，失败/待补测输出一次；once 缺条件返回 2。条件无变化的待补测需手动 run 或改好配置/测试输入后复测 |
| `triage` | 校验报告结论、读取本轮证据并生成 incidents 下的 task.json/fix-task.md；同一构建/断言/归因只生成一次。条件不足不生成缺陷任务，不发送给外部 Agent |
| `baseline approve` | 要求显式 reviewed、真实生命周期/A-B-A/刷新重启通过、基准与场景摘要、三张指定窗口 PNG；复制为不可覆盖的基线。现有默认 suite 不具备这些证据，命令会拒绝批准 |
| `recover` | 只恢复 SDK 自建 sandbox 中日志登记的文件；摘要与预期不符时保留外部新值和原字节副本，返回 2；不按名称终止进程 |
| `compat:verify` | 固定运行产品/SDK 类型检查、全部测试、API 清单和构建；每次执行隔离的源码窗口路径修复/重启验证，不依赖本机旧门禁。任一源码/SDK/测试/脚本/工具链配置变化使门禁失效 |
| `smoke:compat-sdk` | 在源码门禁完成后，用独立 CLI 进程验证两游戏受控样本的 inspect/local/full/triage/baseline 拒绝/recover/watch 去重；完整游戏结论仍为待补测 |

运行退出码：**0** 所选必需范围全部通过；**1** 有稳定环境、有效对照、证据和针对性重复失败；**2** 不完整、取消、超时、来源不确定、恢复失败或已确认不了的波动。重试后偶然通过也不自动放行。进程/窗口存在不能作为通过证据。

## Node 接口

从 `dev/compat-sdk/index.ts` 导入，均为开发端 Node 接口。

| 接口 | 对应功能 |
| --- | --- |
| `loadConfig / parseConfig` | 严格验证配置、两游戏标识、具体绝对路径、间隔和允许字段 |
| `probeContext / stableContext` | 单次观察/有限稳定观察；语义 buildKey、完整 runKey 与路径/stat 观察指纹分别保存 |
| `createRunner().registerSuite` | 注册仓库内受审查的用例代码；重复 ID 拒绝；最小必需矩阵固定，不允许通过不注册用例来放行 |
| `createRunner().run` | `config, gameId, local/full`；全机执行锁、失败项一次重试、前后观察核对、finally 恢复与本轮 report.json |
| `evaluateRun` | 稳定性、完整必需范围、对照、重试、归因、恢复和三态判定 |
| `registerLocalSuites` | 注册当前 L0/L1 的固定实现；未接真实游戏层 |
| `evaluateReferenceFrames` | 对已取得的 RGBA 帧做同窗口/尺寸/场景、非重叠锚点、黑帧、ROI 变化/恢复、独立加载信号组合断言；本函数不捕获窗口，也不提供已校准阈值 |
| `RecoveryJournal.create/open/write/restore` | 专有 sandbox 所有权、写前日志、原字节保存、摘要保护和可重入恢复 |
| `watch / createFixTask / approveBaseline` | 对应上述命令，写入范围固定为 SDK 工作区 |

用例声明 `id/layer/required/timeoutMs/run(context, signal, {directory})`，证据写到本轮 directory，再返回 `status/message/attribution/controlPassed/evidence`。注册代码须响应 AbortSignal 并在 finally 收尾；当前超时为协作取消，不能将不响应取消或具有任意副作用的脚本作为 live 适配器。配置或报告不能注册/执行命令。后续 live 应先完成进程身份、专用 XXMI/Mod 根、窗口捕获及输入隔离，再接入这些用例。

## 证据、缓存与恢复

- 输出固定在 `.run-data/compat-sdk/`，已被 Git 忽略。机器配置、报告含本机路径，仅用于本地；不保存 Launcher Secrets/原始配置，不上传日志截图。
- 游戏发行版本暂为 `null`：已确认终末地 config.ini 为不透明二进制，verify_files.json 为 move/patch 文件清单，不能从中猜发行版本。EXE 的 ProductVersion/FileVersion 单独列为辅助字段。
- 游戏摘要覆盖 EXE 和根目录有限清单/配置，**不保证识别资源独立热更新**。组件摘要覆盖已知包 Manifest、Launcher、主 INI、可选 DLL/user INI 和 Core；不代表完整扫描整个游戏或第三方 Mod 库。
- `runKey` 纳入渠道、内容摘要、组件、源码提交/脏内容、SDK、fixture/scene 和机器配置。mtime/路径身份只用于现场稳定性；同内容搬迁不当作游戏升级。库/测试场景变化需要实际内容摘要，不能只用稳定 Mod ID。
- 自动运行只用本地轮询和持久去重，不依赖网络/后台任务。watch-state 按 machineProfile 分文件；上次兼容记录保留，但不能对新的构建继续有效。
- 每个 run 的 sandbox 新建且不可收养已有目录，写前日志只允许 work 内的文件。残留日志阻止下一轮测试；恢复失败保留日志中的 base64 原字节。突然退出遗留的 execution/watch 锁不会自动删除；先核对锁里的 PID/本机进程和恢复记录，再手动移除确认无主的具体锁文件。
- 本工具没有 Git 写入、push、Release、计划任务、服务安装或启动真实游戏的代码路径。基准批准是显式本地操作，不因测试失败调用。

## 尚需接通的真实验证

S2 未完成：SDK 专用 XXMI/Mod 根、可用 Launcher、自有基准 Mod、固定角色/场景、初次正常与失效样本、真实窗口捕获/输入/生命周期、刷新/重启、进程恢复。绝区零安装样本也尚未提供。S4 用户端兼容提示和远程结论共享仍在后续阶段。受控测试通过不能代替这些验收。
