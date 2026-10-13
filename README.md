# Kiriu Mod Manager

Electron + React + TypeScript 本地 Windows 工具，支持绝区零/终末地的独立 Mod 库、已有 XXMI 检测/备份同步和官方组件空目录部署。管理器文件操作不等于游戏内加载成功。

正式首版目标为 **0.0.1**，新增管理器更新器：设置页检查稳定版本、查看说明、确认下载、校验、退出后替换并重启。默认源为 [KiriuKazurei/KiriuModManager](https://github.com/KiriuKazurei/KiriuModManager)，支持其它 HTTPS 更新清单；源码模式不替换目录。详见[管理器更新与发布说明](docs/管理器更新与发布说明.md)。正式 GitHub Release 需要上传完整 ZIP 与 kmm-update.json，源码推送本身不会产生可用更新。

当前文档入口：[docs 导航](docs/README.md)、[项目技术说明](docs/项目技术说明.md)、[44 + 1 桌面接口文档](docs/桌面接口文档.md)、[XXMI 集成与部署](docs/XXMI集成与部署说明.md)。旧工程/分工/研究资料本地保留在 docs/disable，不属于发布源码必需文件。

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
