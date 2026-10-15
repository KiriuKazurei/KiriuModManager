# 开发端兼容测试 SDK 0.2.0

管理器版本保持 **0.0.5**。新增独立 `process` 范围：通过固定 XXMI 启动计划测试进程重启和异常退出恢复；显式 `--allow-processes` 才启动进程。用户端在设置常规分页查看/导入进程兼容记录，两项受限 IPC 不提供进程操作能力。按最新范围不做游戏窗口、输入、画面/Mod 加载效果、刷新或固定场景。旧 `full` 的完整游戏断言保留原语义，不用进程结果冒充完整游戏兼容。

## 进程范围（当前主流程）

```powershell
npm.cmd run compat:verify
npm.cmd run compat -- run --game endfield --suite process --allow-processes
npm.cmd run compat -- watch --game endfield --suite process --allow-processes --once
npm.cmd run compat -- recover --process-journal <process-UUID.json绝对路径>
npm.cmd run smoke:compatibility
npm.cmd run smoke:compatibility:process
```

`process` 先通过精确源码门禁和本地接入，再运行：正常启动对照→停止专属进程树→重新启动；正常启动对照→主动终止本轮游戏进程→清理剩余专属进程→重新启动。稳定观察为同一完整 EXE 路径的本轮进程连续存活两秒，启动预算每次 120 秒；不代表进入场景。停止使用专属 Windows Job Object 的终止操作，不发送按键或查找窗口；测试中游戏的配置保存不由 SDK 保证，请使用开发测试环境。已有目标或无法确认身份的同名进程会阻止启动，SDK 不接管它们。

每个助手先建立随机命名、关闭即杀死成员的 Job，随后 CreateProcess 挂起→归入 Job→恢复线程；Launcher 后代自然继承。助手因 SDK 中断收到 EOF 时关闭 Job，硬中断后的记录可显式恢复。恢复只打开日志里的专属 Job，不使用进程名/PID 批量终止。程序脱离进程树、权限不足、更新进行中、未观察到游戏或恢复失败均不能报告通过。

正常对照通过后的目标启动超时，需要同一上下文再次进行独立对照/目标尝试；连续两次才算进程范围失败。重试通过或任一环境/助手异常为证据不足。已确认失败生成本地 `incidents/process-*/task.json`，不提交、push 或发布。process watch 使用独立去重记录；通过保持安静。

本轮 `process-report.json` 保存开发上下文、逐次结果和进程记录；`compatibility.json` 是可导入产品的脱敏摘要，只含版本、内容指纹、范围、结论及完整性摘要，不含绝对路径、账号或原始配置。导入设置→常规设置→进程兼容测试；它是用户本地提供的记录，摘要不是可信签名。游戏已知文件、XXMI/Core、管理器编译代码改变即过期，原人工 Mod 验证字段保持独立。资源文件未全部覆盖，不能宣称任意游戏热更新都已识别。

`smoke:compatibility` 只验证受控记录与真实管理器窗口；`smoke:compatibility:process` 另编译自有游戏/Launcher 替身，实际运行两游戏 CLI 重启/恢复，再导入真实生成的进程报告。两者都不运行真实游戏或 XXMI。

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
| `recover` | `--sandbox` 恢复专有文件；`--process-journal` 恢复专属 Job；显式恢复可清理 PID 已确认消失的 execution 锁，活进程或所有权不明则拒绝 |
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
| `runProcessCompatibility` | 独立进程范围执行器；显式授权、local 门禁、正常重启/故障恢复、上下文复核与脱敏记录 |
| `recoverProcessJournal` | 开发端专属 Job 记录恢复；CLI 在显式恢复锁下调用，不是 renderer API |
| `evaluateReferenceFrames` | 对已取得的 RGBA 帧做同窗口/尺寸/场景、非重叠锚点、黑帧、ROI 变化/恢复、独立加载信号组合断言；本函数不捕获窗口，也不提供已校准阈值 |
| `RecoveryJournal.create/open/write/restore` | 专有 sandbox 所有权、写前日志、原字节保存、摘要保护和可重入恢复 |
| `watch / createFixTask / approveBaseline` | 对应上述命令，写入范围固定为 SDK 工作区 |

旧分层用例声明 `id/layer/required/timeoutMs/run(context, signal, {directory})`，证据写到本轮 directory，再返回 `status/message/attribution/controlPassed/evidence`。注册代码须响应 AbortSignal 并在 finally 收尾。新的 process 执行器独立于旧完整/视觉断言；固定适配器见 core/process-runner.ts 与 adapters/process-job.ps1，不通过配置或报告注册/执行任意命令。

## 证据、缓存与恢复

- 输出固定在 `.run-data/compat-sdk/`，已被 Git 忽略。机器配置、报告含本机路径，仅用于本地；不保存 Launcher Secrets/原始配置，不上传日志截图。
- 游戏发行版本暂为 `null`：已确认终末地 config.ini 为不透明二进制，verify_files.json 为 move/patch 文件清单，不能从中猜发行版本。EXE 的 ProductVersion/FileVersion 单独列为辅助字段。
- 游戏摘要覆盖 EXE 和根目录有限清单/配置，**不保证识别资源独立热更新**。组件摘要覆盖已知包 Manifest、Launcher、主 INI、可选 DLL/user INI 和 Core；不代表完整扫描整个游戏或第三方 Mod 库。
- `runKey` 纳入渠道、内容摘要、组件、源码提交/脏内容、SDK、fixture/scene 和机器配置。mtime/路径身份只用于现场稳定性；同内容搬迁不当作游戏升级。库/测试场景变化需要实际内容摘要，不能只用稳定 Mod ID。
- 自动运行只用本地轮询和持久去重，不依赖网络/后台任务。watch-state 按 machineProfile 分文件；上次兼容记录保留，但不能对新的构建继续有效。
- 每个 run 的 sandbox 新建且不可收养已有目录，写前日志只允许 work 内的文件。残留文件或进程日志阻止下一轮测试；恢复失败保留日志中的原字节。显式 recover 可以释放 PID 已消失的 execution 锁，普通 run 不抢锁；watch 锁保持保守人工核对，不能移除活进程或所有权不明的锁。
- 本工具没有 Git 写入、push、Release、计划任务或服务安装。只有 process 显式授权路径会执行已验证的固定 Launcher 计划；旧 local/full 和普通 watch 不启动游戏。基准批准不因测试失败调用。

## 尚需接通的真实验证

当前 S2 范围按用户要求缩为进程重启/恢复，S4 本地记录提示已接入；窗口、输入、加载效果、刷新和基准场景不是当前待开发任务。真实游戏/XXMI 的 process 验收仍未执行：已知终末地路径缺少标准 Launcher，绝区零未提供安装样本。远程签名结论共享未接入，不作为本轮交付条件。受控替身通过不能代替真实游戏验收。
