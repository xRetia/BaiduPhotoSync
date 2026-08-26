# Yike Album Sync Assistant

<p align="center">
  <img src="./.screenshot/mainWindow.png" alt="Yike Album Sync Assistant main window" width="640" />
</p>

<p align="center">
  A cross-platform desktop application for synchronizing local photos and videos with Yike Album, built with Electron.
</p>

> **Unofficial project.** This application is not affiliated with, endorsed by, or supported by Baidu Netdisk or Yike Album.

| Album Browser | Sync Center |
| --- | --- |
| ![Album browser](./.screenshot/mainWindow.png) | ![Sync center](./.screenshot/syncCenter.png) |

| Settings: General | Settings: Advanced |
| --- | --- |
| ![General settings](./.screenshot/settingOne.png) | ![Advanced settings](./.screenshot/settingTwo.png) |

## Overview

Yike Album Sync Assistant compares local folders with Yike Album snapshots and creates an explicit synchronization plan before it changes files. It supports local-to-cloud, cloud-to-local, and bidirectional workflows while keeping the current state and each queued action visible in the desktop interface.

The application is implemented as an Electron desktop client. It works with the public interfaces available to a user-authorized personal account and requires a valid account session configured in the application settings.

## Features

| Capability | Description |
| --- | --- |
| Synchronization modes | Choose local-to-cloud, cloud-to-local, or bidirectional synchronization. |
| Parallel comparison | Uses a `worker_threads` pool to calculate media checksums concurrently during comparison. Worker count follows CPU capacity by default and can be adjusted. |
| Content-aware deduplication | Avoids repeated transfers by comparing names, sizes, and MD5 content signatures. Cloud-compressed video variants are treated as already synchronized when appropriate. |
| Conflict handling | In bidirectional mode, files with the same name but different content are resolved by creation date so the newer version replaces the older one. |
| Ignore list | Add or remove albums from the ignore list from the album context menu without rescanning the full local and cloud trees. |
| Delete safeguards | Cloud-to-local deletion can remove local-only albums and media when explicitly enabled. Bidirectional mode does not infer deletion intent automatically. |
| Large-video handling | Oversized videos can be compressed to fit service limits while preserving the original local file. |
| Transfer controls | Pause, resume, or safely stop a synchronization plan. Frequent-operation errors are handled by pausing and reporting the issue. |
| Isolated upload workers | Upload tasks use independent child processes so individual client failures are isolated and can be retried. |

## Run from Source

Install a supported Node.js runtime, install dependencies, and start the application from the project root.

```bash
npm install
npm run dev
```

Use the following command for the normal Electron launch path.

```bash
npm start
```

| Platform | Minimum supported environment |
| --- | --- |
| Windows | Windows 10 or Windows 11 |
| macOS | macOS 12 or later |
| Linux | A current mainstream Linux distribution on x64 or arm64 hardware |

## Build and Release

The project uses `electron-builder` for platform packages. The following command builds local distributable artifacts without publishing them.

```bash
npm run dist
```

The release command builds packages and publishes assets to the configured GitHub Release when a suitable `GH_TOKEN` is available.

```bash
npm run release
```

GitHub Actions runs the release workflow for version tags matching `v*`. It builds packages for macOS, Windows, and Linux and uploads the generated artifacts to the tagged GitHub Release.

## Account Session

Configure a valid personal account session in the application's settings before creating a synchronization plan. The session is used only to access the public interfaces available to the authorized account. Do not paste account credentials into issues, pull requests, screenshots, or third-party services.

## Synchronization Workflow

The application follows a deliberate plan-and-execute model.

1. **Create a plan.** The application scans the selected local root and cloud album snapshot, compares albums in parallel, and produces explicit upload, download, album-creation, deletion, conflict, and skip actions.
2. **Execute the plan.** Album creation is performed first. Upload and download work is then scheduled with bounded concurrency, followed by finalization work.
3. **Review progress.** Every action reports a visible state such as pending, running, completed, skipped, or failed. The plan can be paused or safely stopped at any point.

## Responsible Use

This project is intended for learning, research, and personal account management. Do not use it for commercial services, unauthorized account access, bypassing membership or DRM controls, bulk scraping, or any activity that violates platform rules or applicable law.

Synchronization can create, replace, and delete local or cloud files. Verify the selected mode and deletion settings before execution, and maintain independent backups of important data.

## Acknowledgements

This project is informed by the interface research and open-source work in [HengyueLi/baiduphoto](https://github.com/HengyueLi/baiduphoto). Thanks also to everyone who reports issues and contributes feedback that improves the stability and correctness of the synchronization engine.

## Support

If this project is useful to you, consider starring the repository and using GitHub Issues for reproducible bug reports, feature discussions, and implementation feedback.
