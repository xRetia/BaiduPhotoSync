# vendor/pybaiduphoto 说明

本目录是第三方库 **pybaiduphoto**（百度网盘相册 / 一刻相册 API 的 Python 封装）的
**vendored（内置）副本**，并包含本项目的本地修改。

之所以 vendoring 而不是直接 `pip install`，是因为本项目对其逻辑做了定制修改，
需要随仓库一起提交，以保证构建（PyInstaller）时可独立复现。

## 来源

- 上游库：pybaiduphoto（百度网盘相册 API 客户端）
- 位置：`vendor/pybaiduphoto/`

## 本项目所做的修改

### 1. 新增 `cooperation/muyangren907_shoot_time.py`

这是相对上游新增的协作/扩展模块，提供了向百度相册上传媒体文件时所需的
**拍摄时间（shoot_time）与媒体信息（media info）的加密构造逻辑**，主要包括：

- `G` / `Q` / `Vchange` / `q`：一组 RC4 风格的密钥调度与加解密原语，
  用于将媒体元数据加密为百度相册接口要求的密文。
- `Rencode`：对加密结果做 Base64 编码。
- `JencodeString`：使用固定密钥 `7FED2719FC7E4D5602FB1D9D11AFA01B`
  对媒体信息字符串进行加密编码。
- `timestamp_to_strtime` / `timestamp_to_strtime2`：将 13 位毫秒时间戳
  转换为百度相册接口所需的本地时间 / UTC 时间字符串。
- `getCreateTime` / `getMediaType` / `get_video_duration` /
  `getMediaInfo` / `getMediaInfo_interface`：从本地媒体文件读取创建时间、
  文件类型、视频宽高与时长，并组装成加密后的 `media_info` 字符串，
  供上传接口携带拍摄时间等元数据。

> 说明：本模块的 `cooperation/` 目录及 `muyangren907_shoot_time.py` 为
> 本项目新增，不在上游原始发布中。若后续需同步上游更新，请手动 rebase
> 并保留该模块。

## 注意事项

- 该库包含 `__pycache__` 等编译缓存，已在 `.gitignore` 中忽略。
- 升级上游时，请对比 `API.py`、`Album.py` 等核心文件，避免覆盖本项目的定制逻辑。
