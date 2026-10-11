# 客户端增强：1.3.1 自动接入

## 设置来源与默认值

Hub 设置服务是唯一配置写入者，原子保存到用户目录的 `app_settings.json`。客户端增强只读取以下字段：

| 字段 | 默认值 | 含义 |
|---|---|---|
| EnableClientLocalization | false | 显式启用本地汉化 |
| EnableThinkingTranslation | false | 显式启用思考内容联网翻译 |
| EnableClientWindowSize | false | 显式启用窗口重设 |
| ClientWindowWidth | 1400 | 逻辑像素宽度 |
| ClientWindowHeight | 900 | 逻辑像素高度 |

不存在、损坏或超限的配置会回到关闭状态；字符串 `"true"` 不视为开启。窗口尺寸必须为范围内整数，原生设置服务也会复核。

汉化同时在 renderer bundle、preload、原生菜单和托盘文本上检查开关。preload 先通过受信任的 IPC 取得设置，关闭时不启动 DOM 观察器。界面汉化拒绝联网请求，只应用本地词典。思考内容翻译使用独立 IPC 通道，并在每个请求批次之前复核开关；关闭后不再发起新的请求，在途请求的响应不会回填。

窗口开关关闭时，恢复和显示不会强制取消最大化、退出全屏或重设窗口。开启时沿用 HansWin 的多显示器与小数 DPI 处理；每次恢复读取新宽高，没有轮询定时器。手动拖动尺寸仍允许，但下一次恢复 / 显示会回到配置尺寸。

## 安装与回退

补丁始终从独立核验的原版底包生成，不在已修改 ASAR 上叠加。组合候选逐文件核对 payload、完整性、可执行标志及外置依赖。安装前再次核对当前 ASAR，备份完整原版 / 旧补丁和外置资源，最后原子替换 ASAR。

安装、回退都要求客户端自行退出，不发终止命令。路径绑定到实际安装目录，过期 / 跨版本任务被拒绝。

需回退时先在私有维护目录找到已安装任务的 `job.json`，然后：

```powershell
$env:ANTIGRAVITY_MAINTENANCE_STATE = "$env:USERPROFILE\.antigravity_hub\client_maintenance"
python client/maintenance/tools/maintain.py --rollback "C:\path\to\client_maintenance\jobs\JOB_ID"
```

回退只接受匹配当前已安装哈希的已提交任务。不要删除备份或手工改写哈希。

## 发布边界

源码保留校验 profile 和适配器；原版客户端、ASAR、备份、运行状态、用户数据均不提交。新增 1.3.1 profile 已由隔离候选构建核对，真实客户端安装与多显示器实机操作需单独记录，不能拿旧验收记录替代当前验收。

完整发布包由 Build-Release.ps1 构建，含 Node.js 与 Python 隔离运行组件和维护器依赖。Hub 启动及打开设置时自动核验、准备；设置中没有安装按钮。首次启动默认关闭到托盘、启动最小化到托盘；已经保存的用户选择保留。

