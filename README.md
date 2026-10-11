# AntigravityHub

Antigravity 辅助工具：账号与配额、用量看板、客户端状态栏、界面与思维链汉化、自定义窗口尺寸。

[下载 Windows 版](https://github.com/Cainite07/AntigravityHub/releases/latest) · [版本说明](docs/RELEASE_NOTES_1.3.3.md) · [MIT 许可证](LICENSE)

**v1.3.3 · Windows x64 · 客户端增强适配 Antigravity 2.22.0**

## 界面预览

<table>
  <tr>
    <td width="50%" align="center"><a href="docs/images/overview-light.png"><img src="docs/images/overview-light.png" width="420" alt="纸色主页"></a><br><sub>纸色主页</sub></td>
    <td width="50%" align="center"><a href="docs/images/overview-dark.png"><img src="docs/images/overview-dark.png" width="420" alt="墨色主页"></a><br><sub>墨色主页</sub></td>
  </tr>
</table>

<p align="center">
  <a href="docs/images/client-status.png"><img src="docs/images/client-status.png" width="400" alt="客户端状态栏"></a><br>
  <sub>头像 · 5 小时额度 · 会话平均输出速率 · 今日 token</sub>
</p>

<details>
<summary>账号与用量</summary>

<table>
  <tr>
    <td width="50%" align="center"><a href="docs/images/accounts.png"><img src="docs/images/accounts.png" width="420" alt="账号管理"></a><br><sub>账号管理</sub></td>
    <td width="50%" align="center"><a href="docs/images/account-import.png"><img src="docs/images/account-import.png" width="420" alt="导入账号"></a><br><sub>导入账号</sub></td>
  </tr>
  <tr>
    <td width="50%" align="center"><a href="docs/images/usage-daily.png"><img src="docs/images/usage-daily.png" width="420" alt="每日消耗流水"></a><br><sub>每日消耗流水</sub></td>
    <td width="50%" align="center"><a href="docs/images/usage-weekly.png"><img src="docs/images/usage-weekly.png" width="420" alt="按周归档流水"></a><br><sub>按周归档流水</sub></td>
  </tr>
</table>

</details>

<details>
<summary>界面与思维链汉化</summary>

<table>
  <tr>
    <td width="50%" align="center"><a href="docs/images/client-localization.png"><img src="docs/images/client-localization.png" width="420" alt="界面汉化"></a><br><sub>界面汉化</sub></td>
    <td width="50%" align="center"><a href="docs/images/thinking-localization.png"><img src="docs/images/thinking-localization.png" width="420" alt="思维链汉化"></a><br><sub>思维链汉化</sub></td>
  </tr>
</table>

</details>

<details>
<summary>设置与托盘</summary>

<table>
  <tr>
    <td width="50%" align="center"><a href="docs/images/settings.png"><img src="docs/images/settings.png" width="420" alt="设置页面"></a><br><sub>设置页面</sub></td>
    <td width="50%" align="center"><a href="docs/images/tray.png"><img src="docs/images/tray.png" width="220" alt="托盘快捷切换"></a><br><sub>托盘快捷切换</sub></td>
  </tr>
</table>

</details>

## 功能

- **账号与配额**：导入、切换账号，查看订阅与剩余额度。
- **用量看板**：日／周／月明细、热力图、模型画像与参考费用。
- **客户端状态栏**：查看额度、会话平均输出速率和今日用量。
- **汉化与窗口**：界面汉化、思维链汉化分别控制，默认关闭；窗口尺寸可调整。
- **外观与托盘**：纸色／墨色主题、跟随系统、托盘快捷切换。

## 快速开始

1. 下载 Windows 压缩包，完整解压后打开 `AntigravityHub.exe`。
2. 首次启动默认进入托盘，从托盘打开主界面。
3. 在设置页按需开启汉化、调整窗口尺寸；需要重启时会显示提醒。

需要 Microsoft Edge WebView2 Runtime，发布包已包含其他运行组件。授权登录与令牌刷新需要 [本地 OAuth 配置](docs/USAGE.md#oauth-本地配置)。

[使用与配置](docs/USAGE.md) · [开发与维护](docs/DEVELOPMENT.md) · [第三方声明](THIRD-PARTY-NOTICES.md)

个人第三方辅助工具，与 Antigravity 官方无隶属关系。
