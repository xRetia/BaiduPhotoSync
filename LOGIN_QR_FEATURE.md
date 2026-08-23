# 二维码登录、会话校验与退出登录

**作者：Manus AI**  
**适用版本：** 一刻同步 Windows 桌面程序。

## 登录流程

程序启动后首先读取当前 Windows 用户保存的登录会话，并立刻调用一刻相册的只读相册列表接口验证其有效性。验证通过后直接进入已登录状态；不存在会话、会话无法解密，或远端验证失败时，程序会清除旧会话并自动打开 `https://photo.baidu.com/photo/web/login` 的内嵌网页。用户扫描百度官方网页呈现的二维码并在手机端确认后，程序会在**登录窗口仍保持可见**的情况下收集百度域候选 Cookie，并在后台再次通过一刻相册接口验证。验证成功后窗口才会自动关闭；验证失败时二维码保留在当前窗口，状态栏会说明失败并允许刷新或重试。只有验证通过的 Cookie 才会保存。

| 阶段 | 行为 | 凭据边界 |
|---|---|---|
| 启动 | 尝试读取并验证本机保存会话 | 不写日志、不展示 Cookie |
| 无效/不存在 | 显示百度官方二维码登录页 | 网页使用临时、无痕浏览配置 |
| 扫码候选 | 监听百度域 Cookie，要求至少有 `BAIDUID`、`BDUSS` | Cookie 仅在内存中转换为候选请求会话；不会关闭窗口 |
| 二次验证 | 在窗口内后台调用现有 `verify_login()` | 成功才自动关闭；失败保留二维码，避免“先关闭、后失败、又弹出” |
| 保存 | Windows DPAPI 为当前 Windows 用户加密保存 | 不再使用明文 `saved_cookie` QSettings 项 |

> Qt 的 `QWebEngineCookieStore` 可以访问特定浏览器配置文件的 HTTP Cookie，并提供 `cookieAdded`、`cookieRemoved`、`loadAllCookies` 和清理接口。[1]

## 隐私与安全设计

二维码登录窗口显式创建**无存储名的 `QWebEngineProfile`**。Qt 官方文档说明，这种 profile 是 off-the-record 模式：不在本机留下持久数据或缓存，Cookie 仅在内存中存在。[2] 窗口关闭后，这个临时网页容器与其中的 Cookie 一并销毁。

登录通过后，程序将 Cookie 文本交给 Windows DPAPI，以当前 Windows 用户身份加密；只有同一用户在同一台机器上可解密。若 DPAPI 不可用或保存失败，程序不会退回到明文保存，而是仅在当前运行期间使用会话。旧版本可能留下的明文 `saved_cookie` 仅作为一次性迁移输入：验证通过后立即转换为 DPAPI 数据并删除旧值。

| 数据位置 | 是否持久化 | 是否加密 | 退出时处理 |
|---|---:|---:|---|
| 内嵌二维码网页 Cookie | 否 | 内存中 | 关闭窗口即销毁 |
| 远端客户端请求 Cookie | 否 | 内存中 | 本地退出即丢弃 |
| QSettings 登录会话 | 是 | DPAPI | 本地退出即删除 |
| 日志/错误报告 | 否 | 不适用 | 从不写入 Cookie |

## 退出登录

用户点击顶部“已登录”按钮后只有一个 **退出登录** 入口。程序会打开带当前内存会话的临时无痕网页，用户在网页右上角账户菜单中自行完成百度官方退出。程序持续观察网页认证 Cookie；仅在检测到会话确已失效时，才自动关闭退出窗口、删除 DPAPI 会话并清空软件内存状态。

网页退出属于百度账户状态变更，因此程序不会模拟点击账户菜单、不会提供“我已退出”的绕过按钮，也不会在无法确认状态时删除本机会话。用户取消窗口或网页登录状态未失效时，本地登录信息保持不变。同步运行时退出入口会被阻止，必须先暂停或停止同步，避免中断正在进行的上传。

## Windows 构建要求

二维码登录依赖 `PySide6-Addons==6.6.3.1` 的 Qt WebEngine 组件。高级同步设置采用左侧“同步设置 / 传输设置 / 视频与对比”导航和右侧内容页；所有标准对话框按钮显式显示为“确定”“取消”或“关闭”。`requirements.txt` 和 `build_windows.bat` 已加入该依赖与 PyInstaller 收集规则。构建后的 `dist/一刻同步/` 目录必须完整保留，Qt WebEngine 的子进程和资源不可单独删除。

| 构建项 | 已完成配置 |
|---|---|
| Python 依赖 | `PySide6` + `PySide6-Addons` 6.6.3.1 |
| PyInstaller | 显式收集 `PySide6.QtWebEngineCore`、`PySide6.QtWebEngineWidgets` |
| 登录模块 | `web_login.py`、`session_store.py` 已加入隐藏导入 |
| FFmpeg | 保持内置 Windows `ffmpeg.exe` 与 `ffprobe.exe`，与登录功能独立 |

## 验证步骤

在 Windows 上构建后，首次启动应自动弹出二维码窗口。扫码并在手机确认后，登录窗口应显示“正在验证”，但不会立即关闭；只有远端权限验证成功才自动进入主界面。若验证失败，二维码仍保留在当前窗口，可刷新后重试。关闭并重新启动程序时，若会话仍有效则应不显示二维码并直接连接；若账号已在网页退出或 Cookie 到期，则应删除旧会话并重新显示二维码。

最后，点击“已登录”按钮并选择“退出登录”。在临时网页中完成官方退出后，程序应自动检测认证 Cookie 已失效，再清除本机登录信息；若取消或检测不到退出，不应清除会话。

## 参考

[1]: [Qt `QWebEngineCookieStore` 官方文档](https://doc.qt.io/qt-6/qwebenginecookiestore.html)
[2]: [PySide6 `QWebEngineProfile` 官方文档](https://doc.qt.io/qtforpython-6/PySide6/QtWebEngineCore/QWebEngineProfile.html)
[3]: [PySide6 `QWebEngineView` 官方文档](https://doc.qt.io/qtforpython-6/PySide6/QtWebEngineWidgets/QWebEngineView.html)
