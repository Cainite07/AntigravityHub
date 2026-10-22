# 开发与维护

## 环境与构建

- Windows x64。
- .NET 10 SDK（构建）；自包含发布包内置 .NET 运行时。
- Microsoft Edge WebView2 Runtime。
- 完整发布包自带隔离运行组件，不依赖用户安装的 Node.js 或 Python。

```powershell
dotnet build src/AntigravityHub -c Release
./Build-Release.ps1
```

`Build-Release.ps1` 生成完整、自包含的 Windows x64 发布目录：依赖预装在包内，固定版本 Node.js 与 Python 官方运行包经 SHA-256 校验后打包，并保留许可证。首次构建需要联网下载这些构建依赖；用户运行发布包不需要这些开发工具或再次下载它们。单独使用 `dotnet publish` 只构建 Hub，不构成完整发布包。

只运行 Hub 账号与用量功能不需要安装客户端补丁。

发布包将托管依赖压缩合并到主程序，原生依赖仍保留在程序旁，不在运行时解压到临时目录。保留主程序集和运行配置两个兼容文件，使已有 1.4.0 更新器仍能验证新包。Node 依赖只省略类型声明、源码映射和开发命令入口；运行脚本与许可证保留。演示图和开发文档留在仓库及源码包，Windows 包内保留使用说明、增强说明和版本说明。

前端 CSS 已提交。修改工具类后重新生成：

```powershell
cd src/AntigravityHub/ui-build
npm ci
npm run build
```

## 客户端补丁与原版底包

客户端增强从经过 SHA-256 核验的原版 2.22.0 `app.asar` 组合构建，保留无关文件和外置依赖。仓库不分发 Antigravity 原版程序、ASAR、用户记录或历史安装备份。

首次打开时，Hub 自动从当前未经修改的 2.22.0 客户端缓存原版底包。若客户端已经打过旧补丁，需要自己提供同版本原版包：

```powershell
cd client/maintenance/tools
npm ci --ignore-scripts
node seed-base.cjs "C:\path\to\original\app.asar"
```

相邻的 `app.asar.unpacked` 必须来自同一原版包。原版 ASAR 的已审核 SHA-256：

```text
259c83ffa266088dda6ede520a601bbf06cc5c34985cdf56c5d68549c98dbb0e
```

本机试用可用 `Build-Release.ps1 -IncludeLocalBase` 带入缓存底包。公开发布包不包含原版底包，首次打开时自动缓存。不能拿未知版本或修改过的包替代。

客户端运行期间只准备候选并等待自行退出；不会强制结束客户端任务。备份与维护状态写入 `%USERPROFILE%\.antigravity_hub\client_maintenance`。若宿主不允许独立后台维护进程，在退出客户端后重新打开 Hub 即可完成。

客户端升级后可能不再兼容，维护器会拒绝未知版本。不要绕过版本与文件校验。回退方法见 [客户端增强说明](CLIENT_ENHANCEMENTS.md)。

## 验证

```powershell
./Test-AntigravityHub.ps1
# 可指定未加入 PATH 的 .NET 10 SDK
./Test-AntigravityHub.ps1 -DotnetPath "C:\path\to\dotnet.exe"
```

隔离测试覆盖账号持久化、恢复、OAuth 回调、配额未知值、统计聚合、原生控件布局、前端状态，以及新增设置、窗口范围和汉化关闭路径。`tests/client-settings.cjs` 的组合补丁检查需要本地原版底包及维护器依赖。

带 `--live-*` 和 `--migration-replay` 的历史测试入口不属于默认测试，请阅读源码后单独决定是否运行。

## 项目结构

```text
src/AntigravityHub/           WPF / WebView2 应用及前端
tests/                       隔离验证与前端回归
client/maintenance/tools/    版本校验、补丁构建、窗口策略、安装与回退
client/release-2.22.0/source/ HansWin 汉化词典与引擎
docs/                        客户端增强说明、版本说明与演示预览
```

## 发布可自动更新的版本

修改项目版本并提交源码后，使用：

```powershell
./Package-Release.ps1 -OutputDirectory "C:\path\to\new-empty-release"
```

脚本生成完整 Windows x64 包、`Adaptation.zip`、`update-catalog.json`、当前提交的源码包和 `SHA256SUMS.txt`，并在本地留下汉化检查报告 `localization-audit.json`。上传前五项到同一个 Release；检查报告供维护使用，不必上传。`update-manifest.json` 列出全部发布文件的 SHA-256，同时记录主程序版本与源码指纹。日志、本机原版底包与用户数据不会进入更新清单。

仅修改客户端适配层时，递增项目版本，并复用上一版完整发布目录：

```powershell
./Package-Release.ps1 -OutputDirectory "C:\path\to\new-release" -CorePackageDirectory "C:\path\to\previous-release\AntigravityHub"
```

脚本校验主程序源码指纹与旧包核心文件，复用原有二进制，重新收集完整适配层；C#、Hub 前端、构建逻辑或依赖变化会拒绝此模式。完整包与小包对应同一个目标清单。小包包含所有当前适配文件与完整清单，运行环境、依赖、主程序由本机校验后复制到暂存区，随后使用同一个覆盖、健康确认和回退流程。不需要下载中间补丁。公开版本号与主程序版本可以不同，主程序版本仅供兼容判断。

GitHub 正式 Release 标签为 `v主.次.修订`，Windows 资产名必须为 `AntigravityHub-主.次.修订-Windows-x64.zip`，ZIP 内根目录固定为 `AntigravityHub/`。上传完整包后再发布 Release，GitHub 的资产 `digest` 必须提供 SHA-256。预发布版本和草稿不触发内置更新。

同一进程只执行一个检查或更新请求。更新助手从校验过的暂存包运行，等旧进程退出后持有单实例锁进行覆盖，保留全部被替换文件的回退副本；新版通过前端与本地数据初始化确认后才提交并删除备份。系统临时目录中的每个任务都限定在 `AntigravityHub-updates/随机ID`，清理拒绝链接和越界路径。

隔离更新测试使用独立单实例锁和临时程序副本，包含真实子进程的退出、替换、重启、失败回退与中断恢复；不会退出用户正在运行的 Hub，也不操作真实账号或客户端。

## 汉化漏项检查

`dev/review-renderer.cjs` 审核官方界面时会同时生成 `ui-audit-inventory.json`。发布前自动检查词典、已审核跨度、运行时补丁和客户端配置是否一致；已知译文没有应用或清单不一致会阻止打包。新英文、动态片段、产品名称等按候选类别列出，不把报告数量当作已确认遗漏数量。

新客户端尚未完成审核时，可只生成候选报告，不写入汉化规则：

```powershell
node dev/review-renderer.cjs "C:\path\to\official-renderer.js" "C:\path\to\@babel\parser" 2.26.0 --audit-only --previous "C:\path\to\previous-ui-report.json" --output "C:\path\to\ui-review.json"
node dev/check-localization.cjs --output "C:\path\to\release-ui-review.json"
```

上一版单个 UI 报告用于比较文字与用途，忽略压缩变量名和位置偏移；消失的旧标记列为待核对。固定标签、提示、模板片段和时间/操作前缀分别检查。插件与产品名的保留名单位于 `dev/localization-policy.json`，有歧义的内容继续人工审核。检查只读取本地官方界面与项目规则，不收集聊天、账号或凭据，也不在用户电脑上后台扫描。
