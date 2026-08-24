# Baidu Photo Sync

A desktop application for synchronizing local photo folders with Baidu Photo albums. The application provides a visual album browser, conservative sync planning, background transfer controls, optional video compression, and a built-in QR-code sign-in flow.

> This project is intended for accounts and media that you are authorized to access. Review every generated sync plan before executing it, especially when deletion is enabled.

## Highlights

| Area | Capability |
| --- | --- |
| Album browser | Browse cloud albums and media, then create, rename, delete, upload, download, or preview a selected photo from one desktop interface. |
| Sync planner | Map local folders to cloud albums, compare content, produce an explicit plan, and control execution with pause, resume, and stop actions. |
| Safe defaults | Keep destructive synchronization disabled by default and surface file conflicts before any transfer begins. |
| Video handling | Optionally create a temporary upload copy for oversize video files while keeping the local original unchanged. |
| Account session | Use an in-app Baidu QR-code or pasted-Cookie sign-in flow, keep the validated session scoped to the current Windows user, and retain a private hidden session page while the app is open. Optional enhanced protection reloads it every three minutes. |
| Windows release | Use the standard executable; it downloads and validates FFmpeg only when video compression is enabled. |

## Download and Use

Download the newest Windows x64 executable from [GitHub Releases](https://github.com/xRetia/BaiduPhotoSync/releases/latest). The standard build is distributed as a self-contained executable.

| Asset | Recommended for | FFmpeg behavior |
| --- | --- | --- |
| `BaiduPhotoSync-<version>-Windows-x64.exe` | All supported Windows users. | The executable downloads and validates FFmpeg only after video compression is enabled. |

Run the downloaded `.exe` file, select **Sign In**, and complete the QR-code confirmation in the official Baidu page. After the account is connected, select a local root directory in **Sync Center**, create a plan, inspect the listed actions, and run only the confirmed plan.

## Screenshots

### Album Browser

![Album Browser](screenshots/01-album-browser.png)

### Sync Center

![Sync Center](screenshots/02-sync-center.png)

### Sign-in and Help

![Sign-in and Help](screenshots/03-login-help.png)

### Advanced Settings

![Advanced Settings](screenshots/04-advanced-settings.png)

## Workflow

The application is designed around an inspect-first workflow. Connect an account, select a local folder, generate a comparison plan, and review all proposed actions before running them. The Sync Center separates the album queue from the planned operations so that progress and pending work remain visible.

| Step | Action | Result |
| --- | --- | --- |
| 1 | Connect the account through QR-code sign-in. | The application can retrieve the accessible album list. |
| 2 | Select a local root directory in Sync Center. | Each direct child folder can be matched with a cloud album. |
| 3 | Choose **Compare and Build Plan**. | The application creates a reviewable list of proposed operations. |
| 4 | Review the queue, conflict details, and any skipped files. | You decide whether the proposed work is acceptable. |
| 5 | Choose **Run Confirmed Plan**. | The application performs only the approved operations. |

## Video Compression and FFmpeg

Video compression is optional and disabled by default. When enabled, the application prepares a temporary compressed upload copy for an oversize video and retains the original local file. The Windows executable downloads the required FFmpeg tools only after the option is used. The downloadable FFmpeg archive is obtained from the official BtbN build release and checked against its published SHA-256 checksum before installation.[1]

## Privacy and Data Handling

The QR-code flow is displayed in the application rather than requiring a separate browser; a pasted-Cookie sign-in option is also available inside that flow. The preview command downloads one selected photo into the current Windows user's reusable application cache and displays it in an in-app window. Repeated downloads and previews can reuse verified cached media. Advanced Settings exposes the cache limit and a manual clearing command; once the limit is exceeded, least-recently-used media is evicted automatically. A validated local sign-in session is kept for the current Windows user, and the project does not intend to write cookies to application logs. While the application is open, a hidden private WebView keeps the Baidu Photo session page loaded and can save a rotated complete session back to the encrypted local store. The optional **Enhanced Account Keepalive** setting reloads `https://photo.baidu.com/photo/web/home` every three minutes; it is disabled by default because the page itself maintains its session through JavaScript. The hidden view stops on re-login, verified sign-out, application reset, and normal shutdown. Treat any local session as sensitive and use the application only on a trusted Windows account.

## Build from Source

The application restores a valid prior window size and position for the current Windows user, while moving the window back onto a visible display if monitor arrangements change. The repository includes a GitHub Actions workflow that creates the standard Windows x64 executable from the tagged source. For a local Windows build, install Python, install the dependencies in `requirements.txt` together with PyInstaller, and invoke the release build script. The default transfer settings use four upload clients, four download clients, and eight concurrent album-media reads; all three can be adjusted in Advanced Settings. The workflow uses the vendored `pybaiduphoto` implementation and packages the application assets, the embedded browser runtime, and the required Python modules.

| Build option | Command | Output |
| --- | --- | --- |
| Windows x64 | `powershell -ExecutionPolicy Bypass -File scripts\build-windows-release.ps1` | `BaiduPhotoSync-<version>-Windows-x64.exe` |

## Support and Responsible Use

This is an independent desktop client. It is not an official Baidu product. Please comply with the applicable Baidu service terms, protect your account credentials, and avoid running deletion-enabled synchronization without verifying the generated plan.

## References

[1] [BtbN FFmpeg-Builds release assets](https://github.com/BtbN/FFmpeg-Builds/releases/latest)
