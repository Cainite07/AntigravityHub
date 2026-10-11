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

构建和正式发布时，将本地底包目录（不提交 Git）放到发布包的 `client/release-2.22.0/base/`，或让首次打开自行缓存。不能拿未知版本或修改过的包替代。

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
