# Kiriu Mod Manager

0.0.4 第二批四项已接入：设置环境诊断与脱敏报告、备份空间／保护／恢复预览和手动清理、候选 INI 详情与辅助处理、多条件排序。版本号保持不变；151 项测试和实际源码窗口通过，性能差异单独登记。详见[第二批功能与验收](docs/0.0.4第二批功能与验收.md)。

Electron + React + TypeScript 本地 Windows 工具，支持绝区零/终末地的独立 Mod 库、已有 XXMI 检测/备份同步和官方组件空目录部署。管理器文件操作不等于游戏内加载成功。

当前源码版本为 **0.0.4**。第一批五项已接入：独立 INI 配置档、依赖与组件版本检查、手动 Mod 更新与定向换包、收藏、自定义标签。123 项测试通过；配置切换有完整副本与中断回退，两游戏真实站点更新链路已验证。详见[0.0.4 说明与验收](docs/0.0.4版本说明与验收.md)。

0.0.3 已实现：终末地与绝区零共用一个内置浏览器、导航历史、登录 Cookie，以及 GameBanana 托管下载、校验、资源绑定和下载页一键安装流程。各任务固定自己的游戏与设置目录，按所属游戏匹配角色，支持手动位置选择，安装后默认停用。支持加密保存会话 Cookie 并在重启后恢复登录。设置“关于”分页集中显示版本号、检查更新和获取更新。详见[0.0.3 说明与验收](docs/0.0.3版本说明与验收.md)与[浏览器登录保存](docs/内置浏览器与登录保存.md)。

主窗口标题栏与日夜主题同色并隐藏标题文字；请求刷新、网页入口和退出功能集中在设置页快捷操作，见[窗口与设置入口调整](docs/0.0.2窗口与设置入口调整.md)。

0.0.1 已接入管理器更新器：设置页检查稳定版本、查看说明、确认下载、校验、退出后替换并重启。默认源为 [KiriuKazurei/KiriuModManager](https://github.com/KiriuKazurei/KiriuModManager)，支持其它 HTTPS 更新清单；源码模式不替换目录。详见[管理器更新与发布说明](docs/管理器更新与发布说明.md)。正式 GitHub Release 需要上传完整 ZIP 与 kmm-update.json，源码推送本身不会产生可用更新。本轮未发布 Release 或生成新便携包。

三项重点迭代已接入：列表多选与批量管理、手动角色外观互斥组、Mod 来源及版本历史。主窗/浮窗/批量/预设统一执行互斥规则，冲突先选择再操作；来源状态为人工记录。详见[重点迭代功能说明](docs/重点迭代功能说明.md)。后续正式版本号按发布安排确定。

大库性能与操作中断恢复已完成开发增量：扫描索引、封面缓存、搜索索引与长列表虚拟化，以及文件提交记录和“备份与恢复”中的中断回退。同一千项隔离库扫描由约 1.59 秒降至 0.39 秒，16 项预设切换由约 30.86 秒降至 1.64 秒；97 项测试与源码窗口专项通过。测量、恢复流程和验收边界见[性能优化与操作中断恢复](docs/性能优化与操作中断恢复.md)。

本地操作记录已实现为数据目录中的 `logs/operations.jsonl`：记录操作时间、对象 ID、结果与副本关联，最多保留约 8 MiB，排除 Cookie、URL 和配置/INI 正文。102 项完整测试与窗口日志核对通过，详见[本地操作日志](docs/本地操作日志.md)。

当前文档入口：[docs 导航](docs/README.md)、[项目技术说明](docs/项目技术说明.md)、[80 + 1 桌面接口文档](docs/桌面接口文档.md)、[XXMI 集成与部署](docs/XXMI集成与部署说明.md)。旧工程/分工/研究资料本地保留在 docs/disable，不属于发布源码必需文件。

需要 Node.js 22.12+；本机使用 Node 24。当前源码命令：

```powershell
npm.cmd install
npm.cmd run typecheck
npm.cmd test
npm.cmd run api:inventory
npm.cmd run api:check
npm.cmd run build
$env:KMM_DATA_DIR = Join-Path $PWD '.run-data\manual'
npm.cmd start
```

`npm.cmd run dev` 启动 Vite 与真实 Electron；main/preload 改动需重启。start 使用已有 dist，先 build。KMM_DATA_DIR 必须为绝对路径，隔离配置/缓存/会话；不要设置 ELECTRON_RUN_AS_NODE。关闭行为由 closeToTray 和托盘可用状态决定，可明确退出。

本地功能包括扫描与稳定 ID、启停/实际改名/metadata/分类、文件夹和 ZIP/7z/RAR 批量导入、Mod 预览与角色封面、预设、INI/key 编辑、候选 hash、恢复副本与完整快照、托盘/浮窗、固定 XXMI 请求与 HTTP(S) 网页入口。实际规则、数据与范围见技术/接口文档。

源功能脚本采用独立 `.run-data` fixture；需要构建后运行：

```powershell
npm.cmd run smoke
npm.cmd run smoke:framework
npm.cmd run smoke:deployment
npm.cmd run smoke:mods -- --functional
npm.cmd run smoke:business -- --functional
npm.cmd run smoke:gallery -- --functional
npm.cmd run smoke:desktop -- --functional
node scripts/smoke-settings-patches.mjs
node scripts/smoke-mod-interfaces.mjs
node scripts/smoke-business-interfaces.mjs
```

functional 只跳过 CSS 固定宽/overflow 验收，保留真实 UI/bridge/文件功能断言。部署用隔离 HTTP/signature fixtures；XXMI/游戏和浏览器请求在相应脚本 stub，helper 只输入自己的已验证测试 App。没有运行真实游戏或本轮联网下载。

更新器之前的框架/模块审查记录见[完成进度与未完成事项](docs/完成进度与未完成事项.md)。当前两个局部配置 API 已接入设置页；部分导入反馈、角色图取消反馈及人工体验按各自最新验收记录处理，不能把后端通过当作全部页面体验通过。

上述 37 tests/9 组流程为更新器之前的审查记录。后续用户已授权优先实现更新器并生成隔离便携测试包验证替换与重启；既有 release 保留，隔离测试包不自动发布。当前设置页局部保存已接入，以当前接口清单和各次验收记录为准。真实 XXMI/游戏加载/刷新及人工体验仍独立验收；市场/账号/其它游戏和复杂中断可靠性专项不在本轮范围。

更新器实现后的测试为 47/47 通过。用户最新要求只确保更新器功能存在，已停止 Release 下载、便携包和安装专项验证；完整替换/重启/回退效果未验收，源码推送不等于正式发行。
