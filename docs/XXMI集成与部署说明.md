# XXMI 集成与部署说明

管理器首次读取或原 Mod 路径为空时，默认创建管理器安装目录下的 `Mods/ZZZ` 和 `Mods/Endfield`，各游戏分别保存；源码模式使用项目根目录。已有自定义 Mod 目录保持原值，不自动搬动文件。默认目录属于管理器库，仍需通过“同步路径到 XXMI”或新部署配置 loader 后才能由游戏读取。

更新日期：2026-10-12。以当前 `xxmi.ts/sync.ts/deployment.ts/releases.ts/runtime.ts/desktop.ts` 为准。旧样本与方案全文保存于 [disable/XXMI集成与部署说明.md](disable/XXMI集成与部署说明.md)，不把旧 K: 盘路径当当前用户配置。当前完整 API 见[桌面接口文档](桌面接口文档.md)。

## 职责与三个路径

管理器负责本地库、文件启停/整理、预设、INI、候选与恢复、XXMI 配置/部署；XXMI 的 ZZMI/EFMI 负责真实游戏内加载。管理器文件成功或启动请求提交不代表游戏 Mod 已生效。

GamePaths 固定为 `xxmiRoot/gameDirectory/modsDirectory`。外层 XXMI 根应含 `Resources/Bin/XXMI Launcher.exe`；启动计划固定该 EXE、cwd 为 Resources/Bin，gui 参数 `--xxmi ZZMI/EFMI`，game 参数 `--nogui --xxmi ZZMI/EFMI`。没有“任选 Launcher EXE/选择程序”接口，也不允许 renderer 传任意可执行文件。

普通路径保存只校验空/绝对路径格式，不要求目录存在、不部署/同步、不启动游戏。sync/deploy 有更严格真实目录和已知游戏 EXE 校验：zzz 为 ZenlessZoneZero.exe/ZenlessZoneZeroBeta.exe，endfield 为 Endfield.exe；根目录存在任一已知 EXE 即匹配，根未匹配时必须唯一嵌套匹配。根目录同时存在多个已知名称不会进行唯一计数。拒绝链接、不合格目录、XXMI/Mods 磁盘根、将 XXMI 放入游戏目录及直接用游戏/XXMI 根作 Mod 目录。

## 已有安装识别与同步

`inspect(game,root)` 读外层 `XXMI Launcher Config.json` 的指定 Importers 记录，结合 importer 目录和 d3dx.ini；installed 仅确认固定 Launcher 文件、importer 目录和 d3dx.ini 存在，不检查完整 Core/DLL 或游戏效果。支持相对/绝对 importer/Include、多 include_recursive、读取范围与文件存在状态。Inspection 不返回 Secrets，基础安装未识别或路径/规则不匹配以状态与 warnings 提示。

界面“使用识别路径”是草稿，普通保存后管理器业务才使用新根。`syncPaths(settings)` 在主进程以操作游戏合并最新已保存配置：要求上述基础安装识别状态为 installed；修改该 importer 的 game_folder、importer_folder 和首个 Include，保留其它游戏、其它 JSON 字段（含原 Secrets）、INI 注释/额外递归目录。还保存 `d3dx_ini.core.Include.include_recursive` 覆盖，防止 Launcher 更新后丢该读取路径。

修改前在 XXMI 根 `.kmm-backups/paths-*` 保存原配置/INI；副本可能含原敏感字段，应按原配置保管。自定义 Mod 路径改变需要共享库 Manifest 版本 1.2.0+，不满足就拒绝，不暗改不兼容安装。写入失败尝试恢复原文并明确返回副本位置，成功重检实际 Include 后保存对应游戏管理器 Settings。

实际启停需 loader 的 `exclude_recursive=DISABLED*` 规则。库不在 Include 或规则未确认时提示，但文件管理仍与游戏生效分开；不会把扫描正常当注入成功。

## 新用户官方空目录部署

部署已实现；当前代码配置四官方来源，单款游戏使用 Launcher、对应 ZZMI/EFMI 和 XXMI 库三包：

| 组件 | 代码配置仓库 | ZIP/签名声明 |
| --- | --- | --- |
| Launcher | SpectrumQT/XXMI-Launcher | XXMI-Launcher-Portable-v，Signature Extra |
| ZZMI | leotorrez/ZZMI-Package | ZZMI-PACKAGE-v，Signature |
| EFMI | SpectrumQT/EFMI-Package | EFMI-PACKAGE-v，Signature |
| XXMI | SpectrumQT/XXMI-Libs-Package | XXMI-PACKAGE-v，Signature |

不在文档固定“最新版本”。运行时查询官方稳定 release，拒绝 draft/prerelease/不支持版本格式、缺资产/签名、越界发行 URL；下载校验声明大小、可用 SHA256 digest 和内置公钥 SHA256 签名。共享库 Manifest 要匹配 release version，并逐文件验证 3dmloader.dll/d3d11.dll/d3dcompiler_47.dll 签名。Manifest 可来自发行资产或包内；缺省包 Manifest 可由验证过的发行元数据形成，但共享库逐文件签名仍必需。

流程为 resolve→download→verify→extract→configure→complete/error，进度可 polling。先在独立 downloads staging 解 ZIP，限制越界/链接和资源范围；检查固定 Launcher、importer d3dx.ini/Core 主 INI，复制已验证 DLL。只复制到空 XXMI 根，不覆盖已有安装；已有安装走识别/同步。安装迁移只支持受限 Core/ShaderFixes 的合法 delete，拒绝其它命令，不执行 PreLaunch/任意安装命令。复制后按文件 hash 核验，再同步所选游戏路径并保存当前 Settings。

签名/网络/路径失败返回 error，不报安装成功；已开始写目标后失败会明确目标可能有部分文件，应检查并改选空目录重试，不声称自动完整回滚。其它游戏/desktop 配置保持。

## 运行库、请求与实际验收

`checkRuntime` 读取 Windows Microsoft Visual C++ x64 Installed 注册表；缺项或权限不确认时 installed:false。`openRuntimeDownload` 只打开 Microsoft 官方下载地址，不自动运行安装器。DeploymentResult 分开 filesDeployed:true 与 ready:runtime.installed；缺运行库时文件完成/配置保存，但 ready:false，不显示可用就绪。

桌面启动/刷新功能已实现固定计划与目标进程验证。当前测试只 stub XXMI/游戏启动和外部浏览器请求；真实 helper 只对自己的已核对测试 App 窗口输入。真实 XXMI 启动、游戏加载及游戏内刷新效果未验收。

部署门禁使用 `.run-data` 中本地签名 HTTP fixture 与明确标记的 runtime mock，证明两游戏部署/同步/保存/错误/缺运行库语义；不是本轮真实联网下载。source tests、smoke:deployment、framework/desktop 功能窗口已有阶段证据，最后统一检查由主进程记录。按用户要求本轮不生成新包/ZIP，也不运行 packaged 窗口。
