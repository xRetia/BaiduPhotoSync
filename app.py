from __future__ import annotations

import json
import logging
import multiprocessing
import os
import shutil
import sys
import time
import traceback
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, QSettings, QSize, QThread, QTimer, Qt, Signal, Slot
from PySide6.QtGui import QColor, QFont, QIcon
from PySide6.QtWidgets import (
    QApplication,
    QCheckBox,
    QComboBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QHeaderView,
    QInputDialog,
    QLabel,
    QLineEdit,
    QListWidget,
    QListWidgetItem,
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QProgressBar,
    QProgressDialog,
    QSizePolicy,
    QSpinBox,
    QStackedWidget,
    QSplitter,
    QStatusBar,
    QStyle,
    QTabWidget,
    QTableWidget,
    QTableWidgetItem,
    QTextBrowser,
    QTreeWidget,
    QTreeWidgetItem,
    QVBoxLayout,
    QWidget,
)

from remote_client import RemoteAlbum, RemoteClientError, RemoteMedia, UnsupportedRemoteFeature, YikeRemoteClient
from session_store import SessionStore, SessionStoreError
from web_login import WEBENGINE_AVAILABLE, SessionKeepAlive, WebLoginDialog, WebLogoutDialog
from sync_engine import FileCompareMode, PlanAction, SortField, SyncAction, SyncControl, SyncDirection, SyncEngine
from video_compression import VideoCompressionError, VideoCompressionOptions, locate_ffmpeg, prepared_video_upload
from ffmpeg_downloader import FFmpegDownloadError, ensure_windows_ffmpeg


class PlanTable(QTableWidget):
    """同步计划表格。

    列宽按各列功能以固定比例分配并填满表格宽度；文字超出列宽时显示省略号，
    完整内容通过单元格 tooltip 在鼠标悬停时显示。
    """

    COLUMN_FRACTIONS = (0.06, 0.09, 0.15, 0.21, 0.13, 0.16, 0.20)

    def __init__(self, rows: int, columns: int, parent: QWidget | None = None) -> None:
        super().__init__(rows, columns, parent)
        header = self.horizontalHeader()
        header.setSectionResizeMode(QHeaderView.Interactive)
        header.setMinimumSectionSize(50)
        header.setSectionsClickable(True)
        header.setStretchLastSection(False)
        self.setWordWrap(False)
        self.setTextElideMode(Qt.ElideRight)
        self.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        self.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)

    def apply_proportional_widths(self) -> None:
        width = self.viewport().width()
        if width <= 0:
            return
        for index, fraction in enumerate(self.COLUMN_FRACTIONS):
            if index < self.columnCount():
                self.setColumnWidth(index, max(50, int(width * fraction)))

    def resizeEvent(self, event) -> None:  # type: ignore[override]
        super().resizeEvent(event)
        self.apply_proportional_widths()


APP_NAME = "一刻同步"
LOGGER = logging.getLogger(__name__)
QR_LOGIN_MAX_ATTEMPTS = 8
APP_ROOT = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parent))
APP_ICON_PATH = APP_ROOT / "assets" / "yike_sync.ico"
PHOTO_MEDIA_ICON_PATH = APP_ROOT / "assets" / "photo_media.svg"
VIDEO_MEDIA_ICON_PATH = APP_ROOT / "assets" / "video_media.svg"
ERROR_LOG_PATH = Path.cwd() / "error.log"


class Worker(QObject):
    finished = Signal(object)
    failed = Signal(str)
    progress = Signal(int, str)

    def __init__(self, task: Callable[[Callable[[int, str], None]], object]):
        super().__init__()
        self.task = task

    @Slot()
    def run(self) -> None:
        try:
            self.finished.emit(self.task(self.progress.emit))
        except Exception:  # noqa: BLE001 - complete detail belongs in diagnostics, not the GUI
            LOGGER.exception("后台操作失败")
            self.failed.emit("操作未完成，请查看 error.log。")


class SyncWorker(QObject):
    finished = Signal(object)
    failed = Signal(str)
    progress = Signal(int, str)
    action_status = Signal(int, str)
    user_alert = Signal(str)

    def __init__(self, task: Callable[[Callable[[int, str], None], Callable[[int, str], None], Callable[[str], None]], object]):
        super().__init__()
        self.task = task

    @Slot()
    def run(self) -> None:
        try:
            self.finished.emit(self.task(self.progress.emit, self.action_status.emit, self.user_alert.emit))
        except Exception:  # noqa: BLE001 - complete detail belongs in diagnostics, not the GUI
            LOGGER.exception("同步后台任务失败")
            self.failed.emit("同步未完成，请查看 error.log。")


class SyncResultDialog(QDialog):
    """同步任务结束后弹窗：汇总统计 + 失败/跳过清单（可选中复制）。"""

    def __init__(self, summary_lines: list[str], detail_lines: list[str], parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("同步结果")
        self.setMinimumWidth(600)
        layout = QVBoxLayout(self)
        summary_label = QLabel("\n".join(summary_lines))
        summary_label.setTextInteractionFlags(Qt.TextSelectableByMouse)
        summary_label.setWordWrap(True)
        summary_label.setStyleSheet("font-size: 14px; font-weight: bold; padding: 4px;")
        layout.addWidget(summary_label)
        if detail_lines:
            detail_label = QLabel(f"失败 / 已跳过的项（共 {len(detail_lines)} 项，可全选复制）：")
            layout.addWidget(detail_label)
            self.detail_view = QPlainTextEdit()
            self.detail_view.setReadOnly(True)
            self.detail_view.setPlainText("\n".join(detail_lines))
            self.detail_view.setMinimumHeight(240)
            layout.addWidget(self.detail_view)
            # 默认全选，方便用户直接 Ctrl+C 复制。
            QTimer.singleShot(50, self._select_all_detail)
        else:
            layout.addWidget(QLabel("没有失败或跳过的项。"))
        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        _localize_dialog_buttons(buttons)
        # Close 按钮的角色是 RejectRole，会触发 rejected 信号，因此两个信号都关闭对话框。
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.accept)
        layout.addWidget(buttons)

    def _select_all_detail(self) -> None:
        self.detail_view.selectAll()
        self.detail_view.setFocus()


def _format_duration(seconds: float) -> str:
    seconds = max(0.0, float(seconds))
    if seconds < 60:
        return f"{seconds:.1f} 秒"
    minutes, sec = divmod(int(round(seconds)), 60)
    if minutes < 60:
        return f"{minutes} 分 {sec:02d} 秒"
    hours, minutes = divmod(minutes, 60)
    return f"{hours} 小时 {minutes:02d} 分 {sec:02d} 秒"


def _settings_icon(name: str) -> QIcon:
    """Load the user-provided PNG navigation icon from bundled resources."""
    return QIcon(str(Path(__file__).resolve().parent / "assets" / "icons" / f"{name}.png"))


def _localize_dialog_buttons(buttons: QDialogButtonBox, ok_text: str = "确定") -> None:
    """Keep every standard dialog action consistently Chinese on all Windows locales."""
    labels = {
        QDialogButtonBox.Ok: ok_text,
        QDialogButtonBox.Cancel: "取消",
        QDialogButtonBox.Close: "关闭",
        QDialogButtonBox.Yes: "是",
        QDialogButtonBox.No: "否",
    }
    for standard, text in labels.items():
        button = buttons.button(standard)
        if button is not None:
            button.setText(text)


class CookieDialog(QDialog):
    def __init__(self, saved_cookie: str = "", parent: QWidget | None = None):
        super().__init__(parent)
        self.setWindowTitle("连接一刻相册")
        self.resize(760, 580)
        screen = QApplication.primaryScreen()
        if screen is not None:
            available = screen.availableGeometry()
            self.resize(
                min(self.width(), max(520, available.width() - 24)),
                min(self.height(), max(420, available.height() - 24)),
            )
        self.setMinimumSize(520, 420)
        layout = QVBoxLayout(self)
        title = QLabel("导入已登录浏览器的 Cookie")
        title.setObjectName("dialogTitle")
        layout.addWidget(title)
        guide = QTextBrowser()
        guide.setOpenExternalLinks(True)
        guide.setHtml(
            """
            <p>粘贴已登录浏览器导出的 <code>photo.baidu.com</code> 与 <code>.baidu.com</code> Cookie 表格行或 JSON。Cookie 是登录凭据，请只在自己的受信任设备上使用，且不要发送给任何人。</p>
            <p>连接成功后，保活功能会在应用运行期间使用隐藏 WebView 携带成功登录的 Cookie，每分钟访问 <code>https://photo.baidu.com/photo/web/home</code>，并在 DEBUG 日志中记录启动、访问、刷新及停止状态。</p>
            <p>Cookie 内容不会写入日志。保存成功的会话会受到当前 Windows 用户的 DPAPI 保护。</p>
            """
        )
        layout.addWidget(guide, 1)
        self.editor = QPlainTextEdit()
        self.editor.setPlaceholderText("在此粘贴 Cookie 导出文本或 JSON 列表…")
        self.editor.setMinimumHeight(150)
        self.editor.setPlainText(saved_cookie)
        layout.addWidget(self.editor)
        self.remember_cookie = QCheckBox("保存到当前 Windows 用户，下次自动登录")
        self.remember_cookie.setChecked(bool(saved_cookie))
        self.remember_cookie.setToolTip("已保存的 Cookie 使用 Windows DPAPI 加密，且不会写入日志。")
        layout.addWidget(self.remember_cookie)
        buttons = QDialogButtonBox(QDialogButtonBox.Cancel | QDialogButtonBox.Ok)
        _localize_dialog_buttons(buttons, "连接")
        buttons.accepted.connect(self.accept)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)

    def cookie_text(self) -> str:
        return self.editor.toPlainText()

    def should_remember_cookie(self) -> bool:
        return self.remember_cookie.isChecked()


class MainWindow(QMainWindow):
    def __init__(self):
        super().__init__()
        self.setWindowTitle(APP_NAME)
        self.resize(1400, 880)
        # Fit the window to a small screen instead of opening larger than the
        # display and being clipped by the desktop.
        screen = QApplication.primaryScreen()
        if screen is not None:
            available = screen.availableGeometry()
            width = min(self.width(), max(880, available.width() - 8))
            height = min(self.height(), max(520, available.height() - 8))
            self.resize(width, height)
        self.setMinimumSize(880, 520)
        self.settings = QSettings("Baidu", "BaiduPhotoSync")
        self.session_store = SessionStore(self.settings)
        self.ignored_album_names = self._load_ignored_albums()
        self.client: YikeRemoteClient | None = None
        self.session_keepalive = SessionKeepAlive(self)
        self.session_keepalive.cookie_refreshed.connect(self._apply_keepalive_cookie)
        self.session_keepalive.refresh_failed.connect(self._keepalive_refresh_failed)
        self._login_dialog: WebLoginDialog | None = None
        self._qr_candidate_cookie = ""
        self._qr_login_attempts = 0
        self._pending_cookie_text = ""
        self._save_session_after_connect = False
        self._ffmpeg_download_dialog: QProgressDialog | None = None
        self._ffmpeg_downloading = False
        self.albums: list[RemoteAlbum] = []
        self.current_album: RemoteAlbum | None = None
        self.current_media: list[RemoteMedia] = []
        self.sync_actions: list[SyncAction] = []
        self._sync_actions_by_sequence: dict[int, SyncAction] = {}
        self._sync_finished_sequences: set[int] = set()
        self._sync_executable_total = 0
        self._sync_queue_refresh_pending = False
        self._sync_row_focus_pending = False
        self._pending_focus_sequence: int | None = None
        self._sync_control: SyncControl | None = None
        self._sync_thread: QThread | None = None
        self._sync_rows_by_sequence: dict[int, int] = {}
        self._current_sync_sequence: int | None = None
        self._sync_run_sequences: set[int] = set()
        self._sync_started_at: float | None = None
        self._sync_mode = "idle"
        self._running_threads: list[QThread] = []
        self._build_ui()
        self._apply_style()
        self._set_debug_logging(self.debug_checkbox.isChecked())
        self._set_connected(False)
        QTimer.singleShot(0, self._check_ffmpeg_at_startup)
        QTimer.singleShot(0, self._restore_or_prompt_login)

    # ----- UI layout -------------------------------------------------
    def _build_ui(self) -> None:
        central = QWidget()
        self.setCentralWidget(central)
        root_layout = QVBoxLayout(central)
        root_layout.setContentsMargins(16, 14, 16, 14)
        root_layout.setSpacing(12)

        hero = QFrame()
        hero.setObjectName("hero")
        hero_layout = QHBoxLayout(hero)
        heading = QVBoxLayout()
        heading.setSpacing(2)
        title = QLabel("一刻相册同步助手")
        title.setObjectName("heroTitle")
        subtitle = QLabel("快速同步电脑中的照片和一刻相册里面的照片")
        subtitle.setObjectName("heroSubtitle")
        heading.addWidget(title)
        heading.addWidget(subtitle)
        hero_layout.addLayout(heading)
        hero_layout.addStretch()
        hero_actions = QHBoxLayout()
        hero_actions.setObjectName("heroActions")
        hero_actions.setSpacing(5)
        self.hero_connect = self._button("登录", self.connect_account, icon=QStyle.SP_DialogOpenButton)
        self.hero_refresh = self._button("刷新", self.refresh_albums, icon=QStyle.SP_BrowserReload)
        self.hero_limits = self._button("说明", self.show_api_limits, icon=QStyle.SP_MessageBoxInformation)
        for button in (self.hero_connect, self.hero_refresh, self.hero_limits):
            hero_actions.addWidget(button)
        hero_layout.addLayout(hero_actions)
        root_layout.addWidget(hero)

        self.tabs = QTabWidget()
        self.tabs.addTab(self._build_browser_tab(), "相册浏览")
        self.tabs.addTab(self._build_sync_tab(), "同步中心")
        self.tabs.addTab(self._build_help_tab(), "登录与帮助")
        root_layout.addWidget(self.tabs, 1)

        self.progress = QProgressBar()
        self.progress.setTextVisible(True)
        self.progress.setValue(0)
        self.progress.setFormat("就绪")
        self.status = QStatusBar()
        self.status.addPermanentWidget(self.progress, 1)
        self.setStatusBar(self.status)

    def _button(self, text: str, slot: Callable[[], None], primary: bool = False, icon=None) -> QPushButton:
        button = QPushButton(text)
        button.clicked.connect(slot)
        if icon is not None:
            button.setIcon(self.style().standardIcon(icon))
        if primary:
            button.setProperty("primary", True)
        return button

    def _build_advanced_dialog(self) -> None:
        dialog = QDialog(self)
        dialog.setWindowTitle("高级同步设置")
        dialog.resize(840, 550)
        dialog.setMinimumSize(740, 480)
        outer = QVBoxLayout(dialog)
        content = QHBoxLayout()
        content.setSpacing(14)

        navigation = QListWidget(dialog)
        navigation.setObjectName("advancedNavigation")
        navigation.setFixedWidth(165)
        navigation.setIconSize(QSize(22, 22))
        navigation.setSpacing(4)
        for text, icon_name in (("同步", "sync"), ("传输", "transfer"), ("视频", "video"), ("高级", "advanced")):
            navigation.addItem(QListWidgetItem(_settings_icon(icon_name), text))
        navigation.setCurrentRow(0)
        pages = QStackedWidget(dialog)
        content.addWidget(navigation)
        content.addWidget(pages, 1)
        outer.addLayout(content, 1)

        sync_page = QWidget(dialog)
        sync_grid = QGridLayout(sync_page)
        sync_grid.setHorizontalSpacing(12)
        sync_grid.setVerticalSpacing(14)
        sync_grid.addWidget(QLabel("同步方向"), 0, 0)
        self.direction_combo = QComboBox(sync_page)
        for item in SyncDirection:
            self.direction_combo.addItem(item.value, item.value)
        sync_grid.addWidget(self.direction_combo, 0, 1)
        sync_grid.addWidget(QLabel("相册处理顺序"), 1, 0)
        self.sort_combo = QComboBox(sync_page)
        for item in SortField:
            self.sort_combo.addItem(item.value, item.value)
        sync_grid.addWidget(self.sort_combo, 1, 1)
        sync_grid.addWidget(QLabel("排序"), 2, 0)
        self.order_combo = QComboBox(sync_page)
        self.order_combo.addItem("正序", False)
        self.order_combo.addItem("逆序", True)
        sync_grid.addWidget(self.order_combo, 2, 1)
        sync_grid.addWidget(QLabel("文件对比模式"), 3, 0)
        self.compare_mode_combo = QComboBox(sync_page)
        for item in FileCompareMode:
            self.compare_mode_combo.addItem(item.value, item.value)
        self.compare_mode_combo.setToolTip("智能（推荐）会识别同名压缩视频和异名同内容副本；仅按文件名适合纯镜像；内容优先会标记同名但内容不同的非视频冲突。")
        sync_grid.addWidget(self.compare_mode_combo, 3, 1)
        self.delete_checkbox = QCheckBox("启用同步删除（危险，默认关闭）")
        sync_grid.addWidget(self.delete_checkbox, 4, 0, 1, 2)
        sync_grid.setRowStretch(5, 1)
        pages.addWidget(sync_page)

        transfer_page = QWidget(dialog)
        transfer_grid = QGridLayout(transfer_page)
        transfer_grid.setHorizontalSpacing(12)
        transfer_grid.setVerticalSpacing(14)
        self.size_limit_checkbox = QCheckBox("跳过超过普通用户大小限制的文件（照片/视频均 30MB）")
        self.size_limit_checkbox.setChecked(self.settings.value("skip_oversize", True, type=bool))
        self.size_limit_checkbox.setToolTip("启用视频压缩时，超过限制的视频会优先生成临时压缩副本上传；其他超限文件仍会跳过。")
        transfer_grid.addWidget(self.size_limit_checkbox, 0, 0, 1, 2)
        transfer_grid.addWidget(QLabel("文件上传并发"), 1, 0)
        self.worker_spin = QSpinBox(transfer_page)
        self.worker_spin.setRange(1, 10)
        self.worker_spin.setValue(int(self.settings.value("file_client_workers", 2)))
        self.worker_spin.setToolTip("主控制器同时下发的单文件客户端数（1–10）。大于等于 16MB 的传输会自动独占上行链路，避免多路大视频写超时。")
        transfer_grid.addWidget(self.worker_spin, 1, 1)
        transfer_grid.addWidget(QLabel("读取相册列表线程数"), 2, 0)
        self.list_threads_spin = QSpinBox(transfer_page)
        self.list_threads_spin.setRange(1, 16)
        self.list_threads_spin.setValue(int(self.settings.value("list_threads", 4)))
        self.list_threads_spin.setToolTip("生成计划时并行读取云端相册列表的线程数（1–16）。默认 4；如遇限流可调小。")
        transfer_grid.addWidget(self.list_threads_spin, 2, 1)
        transfer_grid.setRowStretch(3, 1)
        pages.addWidget(transfer_page)

        video_page = QWidget(dialog)
        video_layout = QVBoxLayout(video_page)
        self.compress_video_checkbox = QCheckBox("压缩视频到30M以内")
        self.compress_video_checkbox.setChecked(self.settings.value("compress_oversize_videos", False, type=bool))
        self.compress_video_checkbox.setToolTip("启用时，程序在本地保留高清原件，仅上传临时压缩副本。")
        video_layout.addWidget(self.compress_video_checkbox)
        video_note = QLabel("免费用户单个视频不能超过30M，如果视频上传失败可开启，但会影响视频画质。")
        video_note.setWordWrap(True)
        video_note.setObjectName("muted")
        video_layout.addWidget(video_note)
        video_layout.addStretch(1)
        pages.addWidget(video_page)

        advanced_page = QWidget(dialog)
        advanced_layout = QVBoxLayout(advanced_page)
        self.debug_checkbox = QCheckBox("写入 DEBUG 日志")
        self.debug_checkbox.setChecked(self.settings.value("debug_logging", True, type=bool))
        self.debug_checkbox.toggled.connect(self._set_debug_logging)
        advanced_layout.addWidget(self.debug_checkbox)
        ignored_hint = QLabel("提示：在同步中心左侧相册列表上点击右键，可将相册加入或移出忽略列表。")
        ignored_hint.setWordWrap(True)
        ignored_hint.setObjectName("muted")
        advanced_layout.addWidget(ignored_hint)
        reset_button = QPushButton("重置应用（清除本机全部数据）")
        reset_button.setObjectName("dangerButton")
        reset_button.setToolTip("删除注册表设置与登录会话、AppData 缓存与 FFmpeg、程序目录 error.log，然后退出。")
        reset_button.clicked.connect(self._reset_application)
        advanced_layout.addWidget(reset_button)
        advanced_layout.addStretch(1)
        pages.addWidget(advanced_page)

        navigation.currentRowChanged.connect(pages.setCurrentIndex)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        _localize_dialog_buttons(buttons)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        outer.addWidget(buttons)
        dialog.accepted.connect(self._save_advanced_settings)

        self.advanced_dialog = dialog
        self._load_advanced_settings()
        self.compress_video_checkbox.toggled.connect(self._on_compress_video_toggled)

    def open_advanced_settings(self) -> None:
        self.advanced_dialog.exec()

    def _load_advanced_settings(self) -> None:
        self.direction_combo.setCurrentIndex(
            self.direction_combo.findData(str(self.settings.value("direction", SyncDirection.LOCAL_TO_REMOTE.value)))
        )
        self.sort_combo.setCurrentIndex(
            self.sort_combo.findData(str(self.settings.value("sort_field", SortField.NAME.value)))
        )
        self.order_combo.setCurrentIndex(self.order_combo.findData(self.settings.value("reverse", False, type=bool)))
        self.delete_checkbox.setChecked(self.settings.value("deletion", False, type=bool))
        self.compress_video_checkbox.setChecked(self.settings.value("compress_oversize_videos", False, type=bool))
        self.compare_mode_combo.setCurrentIndex(
            self.compare_mode_combo.findData(str(self.settings.value("file_compare_mode", FileCompareMode.SMART.value)))
        )
        self.worker_spin.setValue(int(self.settings.value("file_client_workers", 2)))
        self.list_threads_spin.setValue(int(self.settings.value("list_threads", 4)))

    def _save_advanced_settings(self) -> None:
        self.settings.setValue("direction", self.direction_combo.currentData())
        self.settings.setValue("sort_field", self.sort_combo.currentData())
        self.settings.setValue("reverse", bool(self.order_combo.currentData()))
        self.settings.setValue("deletion", self.delete_checkbox.isChecked())
        self.settings.setValue("file_client_workers", self.worker_spin.value())
        self.settings.setValue("list_threads", self.list_threads_spin.value())
        self.settings.setValue("debug_logging", self.debug_checkbox.isChecked())
        self.settings.setValue("skip_oversize", self.size_limit_checkbox.isChecked())
        self.settings.setValue("compress_oversize_videos", self.compress_video_checkbox.isChecked())
        self.settings.setValue("file_compare_mode", self.compare_mode_combo.currentData())

    def _reset_application(self) -> None:
        answer = QMessageBox.warning(
            self,
            "重置应用",
            "此操作将删除本程序在本机留下的全部本地数据，且无法撤销：\n"
            "• Windows 注册表中的设置与登录会话\n"
            "• AppData 下的全部缓存与 FFmpeg（BaiduPhotoSync）\n"
            "• 程序目录下的 error.log\n\n"
            "完成后需要重新扫码登录，正在进行的同步会被中断。确定继续吗？",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.No,
        )
        if answer != QMessageBox.Yes:
            return
        self.session_keepalive.stop()
        # 1) 注册表：清空并删除应用键
        self.settings.clear()
        self.settings.sync()
        try:
            import winreg

            key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, r"Software\Baidu", 0, winreg.KEY_ALL_ACCESS)
            winreg.DeleteKey(key, "BaiduPhotoSync")
            winreg.CloseKey(key)
        except OSError:
            pass
        # 2) AppData：新的 BaiduPhotoSync 与历史遗留的 YikeSync
        try:
            from ffmpeg_downloader import download_directory

            appdata = download_directory().parent.parent
            for name in ("BaiduPhotoSync", "YikeSync"):
                target = appdata / name
                if target.exists():
                    shutil.rmtree(target, ignore_errors=True)
        except Exception as exc:  # noqa: BLE001
            LOGGER.warning("重置时清理 AppData 失败：%s", exc)
        # 3) 程序目录下的 error.log
        try:
            if ERROR_LOG_PATH.exists():
                ERROR_LOG_PATH.unlink()
        except OSError as exc:
            LOGGER.warning("重置时清理 error.log 失败：%s", exc)
        QMessageBox.information(self, "重置完成", "本机数据已清除，应用即将退出，请重新启动程序。")
        QApplication.instance().quit()

    def _on_compress_video_toggled(self, checked: bool) -> None:
        if not checked:
            return
        if self._ffmpeg_downloading:
            # 已有一次下载在进行，忽略重复触发，避免并发下载互相覆盖文件。
            return
        try:
            locate_ffmpeg()
            self.status.showMessage("已检测到 FFmpeg，视频压缩已启用。", 5000)
            return
        except VideoCompressionError:
            pass
        dialog = QProgressDialog("正在准备视频压缩组件…", "", 0, 100, self)
        dialog.setWindowTitle("下载视频压缩组件")
        dialog.setWindowModality(Qt.ApplicationModal)
        dialog.setAutoClose(False)
        dialog.setAutoReset(False)
        dialog.setCancelButton(None)
        # 不允许通过标题栏关闭按钮中断下载，否则会留下进行中的后台任务。
        dialog.setWindowFlags(dialog.windowFlags() & ~Qt.WindowCloseButtonHint)
        dialog.setMinimumDuration(0)
        dialog.resize(460, 130)
        dialog.rejected.connect(self._on_ffmpeg_dialog_rejected)
        dialog.show()
        self._ffmpeg_download_dialog = dialog
        self._ffmpeg_downloading = True
        self._run_job(
            "正在下载 FFmpeg",
            lambda progress: ensure_windows_ffmpeg(progress),
            self._ffmpeg_download_succeeded,
            self._ffmpeg_download_failed,
        )

    def _on_ffmpeg_dialog_rejected(self) -> None:
        # 用户关闭了下载窗口（如按 Esc）：后台下载仍在进行，仅丢弃对话框句柄，
        # 待下载线程结束后再恢复界面状态，避免重复触发第二次下载。
        self._ffmpeg_download_dialog = None

    def _ffmpeg_download_succeeded(self, result: object) -> None:
        dialog = self._ffmpeg_download_dialog
        self._ffmpeg_download_dialog = None
        self._ffmpeg_downloading = False
        if dialog is not None:
            dialog.setValue(100)
            dialog.close()
        downloaded = bool(getattr(result, "downloaded", False))
        message = "视频压缩组件已下载并校验完成。" if downloaded else "已检测到可用的视频压缩组件。"
        self.status.showMessage(message, 8000)
        QMessageBox.information(self, "视频压缩已就绪", message)

    def _ffmpeg_download_failed(self, _error: str) -> None:
        dialog = self._ffmpeg_download_dialog
        self._ffmpeg_download_dialog = None
        self._ffmpeg_downloading = False
        if dialog is not None:
            dialog.close()
        self.compress_video_checkbox.blockSignals(True)
        self.compress_video_checkbox.setChecked(False)
        self.compress_video_checkbox.blockSignals(False)
        QMessageBox.warning(
            self,
            "下载视频压缩组件失败",
            "未能下载或校验 FFmpeg，视频压缩已关闭。请检查网络后重新勾选该选项。",
        )

    def _load_ignored_albums(self) -> set[str]:
        raw = self.settings.value("ignored_album_names", "[]")
        try:
            values = json.loads(str(raw))
        except (TypeError, ValueError, json.JSONDecodeError):
            return set()
        return {str(value) for value in values if str(value).strip()}

    def _save_ignored_albums(self) -> None:
        self.settings.setValue("ignored_album_names", json.dumps(sorted(self.ignored_album_names), ensure_ascii=False))

    def _ignored_name_entry(self, album_name: str) -> str | None:
        target = SyncEngine._name_key(album_name)
        return next((name for name in self.ignored_album_names if SyncEngine._name_key(name) == target), None)

    def _build_browser_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 6, 0, 0)
        splitter = QSplitter(Qt.Horizontal)

        # Album pane
        left = QFrame()
        left.setObjectName("pane")
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(14, 14, 14, 14)
        top = QHBoxLayout()
        heading = QLabel("云端相册")
        heading.setObjectName("paneTitle")
        top.addWidget(heading)
        top.addStretch()
        self.album_refresh = self._button("刷新", self.refresh_albums, icon=QStyle.SP_BrowserReload)
        top.addWidget(self.album_refresh)
        left_layout.addLayout(top)
        tools = QHBoxLayout()
        self.album_create = self._button("新建", self.create_album, True, QStyle.SP_FileDialogNewFolder)
        self.album_rename = self._button("重命名", self.rename_album, icon=QStyle.SP_FileDialogDetailedView)
        self.album_delete = self._button("删除", self.delete_album, icon=QStyle.SP_TrashIcon)
        tools.addWidget(self.album_create)
        tools.addWidget(self.album_rename)
        tools.addWidget(self.album_delete)
        left_layout.addLayout(tools)
        self.album_tree = QTreeWidget()
        self.album_tree.setHeaderLabels(["相册"])
        self.album_tree.setRootIsDecorated(False)
        self.album_tree.header().setSectionResizeMode(0, QHeaderView.Stretch)
        self.album_tree.itemSelectionChanged.connect(self.album_selected)
        left_layout.addWidget(self.album_tree, 1)

        # Media pane
        right = QFrame()
        right.setObjectName("pane")
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(14, 14, 14, 14)
        media_top = QHBoxLayout()
        self.media_title = QLabel("选择一个相册以浏览媒体")
        self.media_title.setObjectName("paneTitle")
        media_top.addWidget(self.media_title)
        media_top.addStretch()
        self.media_upload = self._button("上传", self.upload_media, True, QStyle.SP_ArrowUp)
        self.media_download = self._button("下载", self.download_media, icon=QStyle.SP_ArrowDown)
        self.media_delete = self._button("删除", self.delete_media, icon=QStyle.SP_TrashIcon)
        self.media_rename = self._button("重命名（受限）", self.rename_media, icon=QStyle.SP_FileDialogDetailedView)
        for button in (self.media_upload, self.media_download, self.media_delete, self.media_rename):
            media_top.addWidget(button)
        right_layout.addLayout(media_top)
        self.media_table = QTableWidget(0, 5)
        self.media_table.setHorizontalHeaderLabels(["名称", "类型", "大小", "修改时间", "状态"])
        self.media_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.media_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.media_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.media_table.verticalHeader().setVisible(False)
        self.media_table.horizontalHeader().setSectionResizeMode(0, QHeaderView.Stretch)
        for column in (1, 2, 3, 4):
            self.media_table.horizontalHeader().setSectionResizeMode(column, QHeaderView.ResizeToContents)
        right_layout.addWidget(self.media_table, 1)
        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([380, 950])
        layout.addWidget(splitter)
        return page

    def _build_sync_tab(self) -> QWidget:
        page = QWidget()
        layout = QVBoxLayout(page)
        layout.setContentsMargins(0, 6, 0, 0)
        options = QGroupBox("同步设置")
        options_layout = QVBoxLayout(options)
        options_layout.setContentsMargins(14, 14, 14, 12)
        options_layout.setSpacing(8)

        basic_grid = QGridLayout()
        basic_grid.setHorizontalSpacing(12)
        basic_grid.addWidget(QLabel("本地根目录"), 0, 0)
        self.local_root = QLineEdit()
        self.local_root.setPlaceholderText("每个直接子文件夹对应一个云端相册")
        self.local_root.setText(self.settings.value("local_root", ""))
        basic_grid.addWidget(self.local_root, 0, 1)
        browse = self._button("选择文件夹", self.choose_root, icon=QStyle.SP_DirOpenIcon)
        basic_grid.addWidget(browse, 0, 2)
        self.advanced_button = self._button("高级设置", self.open_advanced_settings, icon=QStyle.SP_ToolBarHorizontalExtensionButton)
        self.advanced_button.setToolTip("打开同步方向、排序、并发、读取线程数与删除策略等高级选项。")
        basic_grid.addWidget(self.advanced_button, 0, 3)
        basic_grid.setColumnStretch(1, 1)
        options_layout.addLayout(basic_grid)

        self._build_advanced_dialog()
        layout.addWidget(options)

        controls = QHBoxLayout()
        controls.setContentsMargins(12, 0, 12, 0)
        controls.setSpacing(8)
        self.plan_button = self._button("比较并生成计划", self.build_sync_plan, True, QStyle.SP_BrowserReload)
        self.execute_button = self._button("执行已确认计划", self.execute_sync_plan, icon=QStyle.SP_DialogApplyButton)
        self.pause_button = self._button("暂停", self.pause_sync, icon=QStyle.SP_MediaPause)
        self.resume_button = self._button("继续", self.resume_sync, icon=QStyle.SP_MediaPlay)
        self.stop_button = self._button("停止", self.stop_sync, icon=QStyle.SP_BrowserStop)
        self.clear_ignored_button = self._button("清空忽略列表", self.clear_ignored_albums, icon=QStyle.SP_DialogResetButton)
        controls.addWidget(self.plan_button)
        controls.addWidget(self.execute_button)
        controls.addWidget(self.pause_button)
        controls.addWidget(self.resume_button)
        controls.addWidget(self.stop_button)
        controls.addWidget(self.clear_ignored_button)
        controls.addStretch()
        self.plan_summary = QLabel("尚未比较")
        self.plan_summary.setObjectName("muted")
        self.sync_live_label = QLabel("同步未运行")
        self.sync_live_label.setObjectName("muted")
        controls.addWidget(self.plan_summary)
        controls.addWidget(self.sync_live_label)
        self._set_sync_controls("idle")
        layout.addLayout(controls)

        splitter = QSplitter(Qt.Horizontal)
        left = QFrame()
        left.setObjectName("pane")
        left_layout = QVBoxLayout(left)
        left_layout.setContentsMargins(12, 12, 12, 12)
        left_title = QLabel("相册队列")
        left_title.setObjectName("paneTitle")
        left_layout.addWidget(left_title)
        left_note = QLabel("右键某个相册可加入或取消忽略。")
        left_note.setObjectName("muted")
        left_note.setWordWrap(True)
        left_layout.addWidget(left_note)
        self.sync_album_tree = QTreeWidget()
        self.sync_album_tree.setHeaderLabels(["相册", "计划"])
        self.sync_album_tree.setRootIsDecorated(False)
        self.sync_album_tree.setContextMenuPolicy(Qt.CustomContextMenu)
        self.sync_album_tree.customContextMenuRequested.connect(self._show_sync_album_menu)
        self.sync_album_tree.header().setSectionResizeMode(0, QHeaderView.Stretch)
        self.sync_album_tree.header().setSectionResizeMode(1, QHeaderView.ResizeToContents)
        left_layout.addWidget(self.sync_album_tree, 1)

        right = QFrame()
        right.setObjectName("pane")
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(12, 12, 12, 12)
        plan_title = QLabel("同步计划")
        plan_title.setObjectName("paneTitle")
        right_layout.addWidget(plan_title)
        self.plan_table = PlanTable(0, 7)
        self.plan_table.setHorizontalHeaderLabels(["顺序", "操作", "相册", "媒体", "来源/目标", "说明", "状态"])
        self.plan_table.setEditTriggers(QTableWidget.NoEditTriggers)
        self.plan_table.setSelectionBehavior(QTableWidget.SelectRows)
        self.plan_table.setSelectionMode(QTableWidget.ExtendedSelection)
        self.plan_table.verticalHeader().setVisible(False)
        # Columns keep a fixed proportional width and fill the pane; overflowing
        # text is elided and shown in full via the cell tooltip.
        self.plan_table.apply_proportional_widths()
        right_layout.addWidget(self.plan_table, 1)

        splitter.addWidget(left)
        splitter.addWidget(right)
        splitter.setSizes([330, 1000])
        layout.addWidget(splitter, 1)
        return page

    def _build_help_tab(self) -> QWidget:
        browser = QTextBrowser()
        browser.setOpenExternalLinks(True)
        browser.setHtml(
            """
            <div style='max-width:920px; margin:12px auto; line-height:1.75;'>
              <p style='color:#718096; margin-top:0;'>本地相册与一刻相册的桌面同步工具</p>

              <div style='background:#fff4f4; border:2px solid #e5484d; border-radius:10px; padding:16px 20px; margin:18px 0;'>
                <div style='color:#b4232a; font-size:18pt; font-weight:800; text-align:center;'>本软件免费使用，禁止收费倒卖本软件，软件仅供学习请于24小时内删除</div>
              </div>

              <h2 style='color:#1d63bf;'>登录与账户安全</h2>
              <p>首次打开或本机登录会话失效时，程序会展示百度官方二维码。请使用百度 App 或一刻相册 App 扫码并在手机确认。扫码后程序会自动在窗口内验证一刻相册权限；如遇网络抖动，会自动再尝试一次。验证成功才会进入主界面，失败时二维码保留在当前窗口，可刷新后重试。</p>
              <p>已验证的登录信息使用 Windows DPAPI 加密保存，仅供当前 Windows 用户使用。退出登录会打开临时网页，请在右上角账户菜单完成百度官方退出；程序确认网页会话失效后才会清除本机登录信息。</p>

              <h2 style='color:#1d63bf;'>同步与文件对比</h2>
              <p>选择本地根目录后，直接子文件夹会映射为云端相册。请先点击“比较并生成计划”，核对右侧计划后再执行。默认“智能”文件对比会识别异名同内容副本，并将云端同名压缩视频视为已同步，从而保留本地高清原件而不重复上传。</p>
              <p>大于 16MB 的文件会自动独占上行链路，避免多路大视频同时写入造成网络超时。涉及删除的计划会在执行前再次提示确认。</p>

              <h2 style='color:#1d63bf;'>视频压缩</h2>
              <p>免费用户单个视频不能超过 30M。若视频上传失败，可在“高级设置 → 视频”勾选“压缩视频到30M以内”。程序会保留本地高清原件，仅上传同名临时压缩副本；压缩可能影响画质。首次启用时，如未检测到 FFmpeg，程序会从已配置的公开发布源下载并校验后再使用。</p>

              <h2 style='color:#1d63bf;'>关于</h2>
              <table cellpadding='7' cellspacing='0' style='border-collapse:collapse; width:100%; border:1px solid #dbe4ef;'>
                <tr style='background:#f4f7fb;'><td><b>软件名称</b></td><td>一刻同步</td></tr>
                <tr><td><b>运行环境</b></td><td>Windows 桌面程序</td></tr>
                <tr style='background:#f4f7fb;'><td><b>登录方式</b></td><td>百度官方二维码网页登录</td></tr>
                <tr><td><b>同步说明</b></td><td>使用非官方接口实现；接口或会话格式变化时可能需要更新。</td></tr>
                <tr style='background:#f4f7fb;'><td><b>反馈前建议</b></td><td>在“高级设置 → 高级”启用 DEBUG 日志，并保留错误发生时间和操作步骤。</td></tr>
              </table>
              <p style='margin-top:18px; color:#718096;'>官网：<a href='https://photo.baidu.com/'>https://photo.baidu.com/</a></p>
            </div>
            """
        )
        return browser

    def _apply_style(self) -> None:
        self.setStyleSheet(
            """
            QWidget { font-family: "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "Noto Sans CJK SC"; font-size: 10pt; }
            QMainWindow { background: #f4f7fb; color: #14213d; }
            QToolBar { background: #ffffff; border: none; border-bottom: 1px solid #e4e9f1; spacing: 4px; padding: 2px 10px; min-height: 30px; max-height: 34px; }
            QToolButton { border-radius: 6px; padding: 3px 6px; margin: 0; }
            QToolBar::separator { width: 1px; margin: 3px 5px; background: #d9e1eb; }
            QToolButton:hover { background: #edf3ff; }
            #hero { background: qlineargradient(x1:0,y1:0,x2:1,y2:1, stop:0 #143a70, stop:1 #2577d9); border-radius: 14px; padding: 8px; }
            #heroTitle { color: white; font-size: 24px; font-weight: 700; }
            #heroSubtitle { color: #d9e9ff; }
            #badgeOffline, #badgeOnline { border-radius: 12px; padding: 6px 11px; font-weight: 600; }
            #badgeOffline { background: #eef2f7; color: #576574; }
            #badgeOnline { background: #dcfce7; color: #166534; }
            #pane { background: white; border: 1px solid #e3e9f2; border-radius: 12px; }
            #paneTitle, #dialogTitle { font-size: 16px; font-weight: 700; color: #14213d; }
            QGroupBox { background: white; border: 1px solid #e3e9f2; border-radius: 10px; margin-top: 10px; padding: 14px; font-weight: 700; }
            QGroupBox::title { subcontrol-origin: margin; left: 12px; padding: 0 4px; }
            QTabWidget::pane { border: none; }
            QTabBar::tab { background: transparent; padding: 10px 16px; margin-right: 4px; color: #5b677a; }
            QTabBar::tab:selected { color: #1d63bf; border-bottom: 3px solid #2577d9; font-weight: 700; }
            #advancedNavigation { background: #f7f9fc; border: 1px solid #e3e9f2; border-radius: 10px; padding: 6px; outline: none; }
            #advancedNavigation::item { padding: 9px 8px; border-radius: 7px; margin: 2px 0; }
            #advancedNavigation::item:selected { background: #e2efff; color: #175fb5; font-weight: 700; }
            #advancedNavigation::item:hover { background: #edf4ff; }
            #dangerButton { background: #fff1f2; border: 1px solid #fb7185; color: #b4232a; font-weight: 700; padding: 8px 12px; }
            #dangerButton:hover { background: #fecdd3; }
            #dangerButton:pressed { background: #fda4af; }
            #loginLoadingOverlay { background: #ffffff; border: none; }
            #loginLoadingTitle { color: #14213d; font-size: 19px; font-weight: 700; }
            #loginLoadingHint { color: #5b677a; font-size: 11pt; }
            #logoutInstruction { color: #b4232a; background: #fff1f2; border: 2px solid #fb7185; border-radius: 8px; padding: 11px 14px; font-size: 14pt; font-weight: 800; }
            QPushButton { background: #ffffff; border: 1px solid #dbe4ef; border-radius: 7px; padding: 7px 12px; color: #22324a; }
            QPushButton[connected="true"] { background: #dcfce7; border-color: #86efac; color: #166534; font-weight: 600; }
            QPushButton:hover { background: #f2f7ff; border-color: #9ec3f6; }
            QPushButton[primary="true"] { background: #2577d9; border-color: #2577d9; color: white; font-weight: 600; }
            QPushButton[primary="true"]:hover { background: #175fb5; }
            QPushButton:disabled { color: #98a4b5; background: #f5f7fa; border-color: #e6ebf1; }
            QLineEdit, QPlainTextEdit, QComboBox { background: white; border: 1px solid #dbe4ef; border-radius: 7px; padding: 7px; selection-background-color: #bfd9ff; }
            QTreeWidget, QTableWidget, QTextBrowser { background: white; border: 1px solid #e3e9f2; border-radius: 8px; gridline-color: #edf1f6; }
            QHeaderView::section { background: #f7f9fc; color: #5b677a; border: none; border-bottom: 1px solid #e3e9f2; padding: 8px; font-weight: 600; }
            QProgressBar { background: #eef2f7; border: none; border-radius: 7px; text-align: center; min-height: 18px; color: #24364d; }
            QProgressBar::chunk { background: #2577d9; border-radius: 7px; }
            #muted { color: #718096; }
            """
        )

    # ----- background jobs -----------------------------------------
    def _run_job(
        self,
        label: str,
        task: Callable[[Callable[[int, str], None]], object],
        on_success: Callable[[object], None] | None = None,
        on_failure: Callable[[str], None] | None = None,
    ) -> None:
        self.progress.setValue(0)
        self.progress.setFormat(label)
        thread = QThread(self)
        worker = Worker(task)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.progress.connect(self._update_progress)
        worker.finished.connect(lambda result: self._job_success(thread, worker, result, on_success))
        worker.failed.connect(lambda error: self._job_failed(thread, worker, error, on_failure))
        thread.finished.connect(lambda: self._thread_finished(thread))
        thread.start()
        self._running_threads.append(thread)

    def _job_success(self, thread: QThread, worker: Worker, result: object, callback: Callable[[object], None] | None) -> None:
        if callback:
            callback(result)
        self.progress.setValue(100)
        # Individual callbacks may replace this with a more specific status,
        # e.g. “plan generated; not executed”.  Never imply a sync ran here.
        if self.progress.format() in {"", "完成"}:
            self.progress.setFormat("操作完成")
        worker.deleteLater()
        thread.quit()

    def _job_failed(
        self,
        thread: QThread,
        worker: Worker,
        error: str,
        callback: Callable[[str], None] | None = None,
    ) -> None:
        self.progress.setValue(0)
        self.progress.setFormat("操作失败")
        if callback:
            callback(error)
        else:
            QMessageBox.critical(self, "操作失败", "操作未完成。详细错误已写入 error.log。")
        worker.deleteLater()
        thread.quit()

    def _thread_finished(self, thread: QThread) -> None:
        if thread in self._running_threads:
            self._running_threads.remove(thread)
        thread.deleteLater()

    def _update_progress(self, value: int, text: str) -> None:
        safe_value = max(0, min(100, value))
        self.progress.setValue(safe_value)
        self.progress.setFormat(text)
        if self._ffmpeg_download_dialog is not None:
            self._ffmpeg_download_dialog.setValue(safe_value)
            self._ffmpeg_download_dialog.setLabelText(text)

    def _set_debug_logging(self, enabled: bool) -> None:
        self.settings.setValue("debug_logging", enabled)
        root_logger = logging.getLogger()
        root_logger.setLevel(logging.DEBUG if enabled else logging.INFO)
        # In windowed builds the console is normally hidden, so the file handler
        # must also receive DEBUG records when the user explicitly enables it.
        for handler in root_logger.handlers:
            if isinstance(handler, logging.FileHandler) and Path(handler.baseFilename) == ERROR_LOG_PATH:
                handler.setLevel(logging.DEBUG if enabled else logging.ERROR)
        LOGGER.debug("调试日志已%s", "启用" if enabled else "关闭")

    # ----- remote connection and browser ---------------------------
    def _set_connected(self, connected: bool) -> None:
        # The login button itself carries the connection state, so there is no
        # separate "connected" badge duplicating the information.
        self.hero_connect.setText("已登录" if connected else "登录")
        self.hero_connect.setProperty("connected", connected)
        self.hero_connect.style().unpolish(self.hero_connect)
        self.hero_connect.style().polish(self.hero_connect)
        for button in (
            self.hero_refresh, self.album_refresh, self.album_create, self.album_rename, self.album_delete,
            self.media_upload, self.media_download, self.media_delete, self.media_rename,
            self.plan_button, self.execute_button, self.clear_ignored_button,
        ):
            button.setEnabled(connected)
        if not connected or self._sync_mode == "idle":
            self._set_sync_controls("idle")

    def _set_sync_controls(self, mode: str) -> None:
        self._sync_mode = mode
        connected = self.client is not None
        idle = mode == "idle"
        paused = mode == "paused"
        active = mode in {"running", "paused", "stopping"}
        self.plan_button.setEnabled(connected and idle)
        self.execute_button.setEnabled(connected and idle and bool(self.sync_actions))
        self.clear_ignored_button.setEnabled(connected and idle)
        self.pause_button.setEnabled(connected and mode == "running")
        self.resume_button.setEnabled(connected and paused)
        self.stop_button.setEnabled(connected and active and mode != "stopping")
        # 同步进行中禁止刷新相册列表，避免与执行线程争用远端读取。
        self.album_refresh.setEnabled(connected and not active)
        self.hero_refresh.setEnabled(connected and not active)
        if mode == "running":
            self.sync_live_label.setText("同步进行中")
        elif mode == "paused":
            self.sync_live_label.setText("同步已暂停")
        elif mode == "stopping":
            self.sync_live_label.setText("正在安全停止")
        elif not connected:
            self.sync_live_label.setText("同步未运行")
        else:
            self.sync_live_label.setText("同步待命")

    def _check_ffmpeg_at_startup(self) -> None:
        """At launch, if video compression is enabled but FFmpeg is missing, ask
        the user to download it; declining turns compression off instead of
        silently starting a download or leaving it unchecked-but-configured."""
        if not self.compress_video_checkbox.isChecked():
            return
        try:
            locate_ffmpeg()
            return
        except VideoCompressionError:
            pass
        answer = QMessageBox.question(
            self,
            "缺少视频压缩组件",
            "已勾选“压缩视频到30M以内”，但未检测到 FFmpeg。是否现在下载并校验该组件？",
            QMessageBox.Yes | QMessageBox.No,
            QMessageBox.Yes,
        )
        if answer == QMessageBox.Yes:
            self._on_compress_video_toggled(True)
            return
        self.compress_video_checkbox.blockSignals(True)
        self.compress_video_checkbox.setChecked(False)
        self.compress_video_checkbox.blockSignals(False)
        self.settings.setValue("compress_oversize_videos", False)
        self.status.showMessage("未下载视频压缩组件，已关闭视频压缩。", 6000)

    def _restore_or_prompt_login(self) -> None:
        """Validate the saved session first; show Baidu QR only when needed."""
        saved_cookie = self.session_store.load().strip()
        if saved_cookie:
            self.status.showMessage("正在校验本机保存的登录会话…")
            self._begin_login(saved_cookie, save_after_verify=True)
            return
        self.status.showMessage("未发现有效登录信息，请扫描二维码登录。")
        self._open_qr_login()

    def connect_account(self) -> None:
        if self.client is not None:
            self._show_account_menu()
            return
        self._open_qr_login()

    def _open_qr_login(self) -> None:
        # A fresh QR flow owns the browser session; do not keep an older hidden
        # profile alive while the user is signing in again.
        self.session_keepalive.stop()
        if not WEBENGINE_AVAILABLE:
            QMessageBox.critical(
                self,
                "缺少二维码登录组件",
                "当前程序包没有 Qt WebEngine，无法展示百度二维码。请使用包含 PySide6-Addons 的完整 Windows 安装包。",
            )
            return
        if self._login_dialog is not None:
            self._login_dialog.raise_()
            self._login_dialog.activateWindow()
            return
        dialog = WebLoginDialog(self)
        dialog.setModal(True)
        dialog.candidate_session.connect(lambda cookie: self._verify_qr_candidate(dialog, cookie))
        dialog.paste_cookie_requested.connect(lambda: self._open_paste_cookie_login(dialog))
        dialog.finished.connect(lambda _result: self._login_dialog_finished(dialog))
        self._login_dialog = dialog
        dialog.show()

    def _open_paste_cookie_login(self, qr_dialog: WebLoginDialog) -> None:
        """Switch from QR sign-in to the deliberately separate pasted-Cookie flow."""
        dialog = CookieDialog(parent=qr_dialog)
        if dialog.exec() != QDialog.Accepted:
            return
        cookie_text = dialog.cookie_text().strip()
        if not cookie_text:
            QMessageBox.warning(self, "Cookie 为空", "请粘贴完整的 Cookie 后再连接。")
            return
        # Close the QR dialog first so a failed pasted session can reopen a fresh
        # QR dialog rather than raising a hidden one.
        qr_dialog.reject()
        self._begin_login(cookie_text, save_after_verify=dialog.should_remember_cookie())

    def _login_dialog_finished(self, dialog: WebLoginDialog) -> None:
        if self._login_dialog is dialog:
            self._login_dialog = None
            self._qr_candidate_cookie = ""
            self._qr_login_attempts = 0
            self._pending_cookie_text = ""
            self._save_session_after_connect = False

    def _verify_qr_candidate(self, dialog: WebLoginDialog, cookie_text: str) -> None:
        self._qr_candidate_cookie = cookie_text
        self._qr_login_attempts = 0
        self._start_qr_login_validation(dialog)

    def _start_qr_login_validation(self, dialog: WebLoginDialog) -> None:
        # Always read the current cookie jar from the live webview rather than
        # reusing the first snapshot: the QR confirmation may still be settling
        # a final BDUSS, and re-verifying with a stale cookie would loop forever.
        cookie_text = dialog.cookie_text() if dialog is not None else self._qr_candidate_cookie
        self._qr_candidate_cookie = cookie_text
        self._begin_login(
            cookie_text,
            save_after_verify=True,
            on_success=lambda client: self._qr_login_succeeded(dialog, client),
            on_failure=lambda _error: self._qr_login_failed(dialog),
        )

    def _begin_login(
        self,
        cookie_text: str,
        save_after_verify: bool,
        on_success: Callable[[object], None] | None = None,
        on_failure: Callable[[str], None] | None = None,
    ) -> None:
        self._pending_cookie_text = cookie_text
        self._save_session_after_connect = save_after_verify
        self._run_job(
            "正在验证一刻相册登录会话",
            lambda progress: self._connect_client(cookie_text, progress),
            on_success or self._connected,
            on_failure or self._login_failed,
        )

    @staticmethod
    def _connect_client(cookie_text: str, progress: Callable[[int, str], None]) -> YikeRemoteClient:
        progress(15, "正在解析扫码会话")
        client = YikeRemoteClient(cookie_text)
        progress(55, "正在验证一刻相册访问权限")
        client.verify_login()
        progress(100, "登录验证成功")
        return client

    def _login_failed(self, _error: str) -> None:
        self.session_keepalive.stop()
        self.session_store.clear()
        self._pending_cookie_text = ""
        self._save_session_after_connect = False
        self.status.showMessage("登录会话无效或已过期，请重新扫码登录。", 8000)
        QTimer.singleShot(0, self._open_qr_login)

    def _qr_login_failed(self, dialog: WebLoginDialog) -> None:
        if self._login_dialog is dialog and self._qr_login_attempts < QR_LOGIN_MAX_ATTEMPTS - 1:
            self._qr_login_attempts += 1
            next_attempt = self._qr_login_attempts + 1
            delay_ms = min(5000, 900 + (self._qr_login_attempts - 1) * 650)
            delay_seconds = delay_ms / 1000
            dialog.verification_retrying(next_attempt, QR_LOGIN_MAX_ATTEMPTS, delay_seconds)
            self.status.showMessage(
                f"第 {self._qr_login_attempts}/{QR_LOGIN_MAX_ATTEMPTS} 次扫码验证未完成，将自动进行第 {next_attempt} 次验证。",
                int(delay_ms + 5000),
            )
            QTimer.singleShot(delay_ms, lambda: self._start_qr_login_validation(dialog))
            return
        self._pending_cookie_text = ""
        self._save_session_after_connect = False
        if self._login_dialog is dialog:
            dialog.verification_failed(f"已自动尝试 {QR_LOGIN_MAX_ATTEMPTS} 次，仍未通过一刻相册权限校验")
        self.status.showMessage(f"扫码会话已自动尝试 {QR_LOGIN_MAX_ATTEMPTS} 次，二维码窗口仍保持打开。", 8000)

    def _qr_login_succeeded(self, dialog: WebLoginDialog, client: object) -> None:
        if self._login_dialog is not dialog:
            return
        self._qr_login_attempts = 0
        self._qr_candidate_cookie = ""
        dialog.verification_succeeded()
        self._connected(client)
        QTimer.singleShot(180, dialog.accept)

    def _connected(self, client: object) -> None:
        self.client = client  # type: ignore[assignment]
        validated_cookie_text = self._pending_cookie_text
        saved = False
        if self._pending_cookie_text and self._save_session_after_connect:
            try:
                self.session_store.save(self._pending_cookie_text)
                saved = True
            except SessionStoreError as exc:
                LOGGER.warning("登录会话未持久化：%s", exc)
                self.status.showMessage("账户已连接，但 Windows DPAPI 保存失败；会话仅在本次运行有效。", 8000)
        if saved:
            self.status.showMessage("账户已连接；扫码会话已使用 Windows DPAPI 加密保存。", 5000)
        elif not self._pending_cookie_text:
            self.status.showMessage("账户已连接；会话仅在内存中使用。", 5000)
        self._pending_cookie_text = ""
        self._save_session_after_connect = False
        self._set_connected(True)
        # Keep the authenticated website session alive only while this desktop
        # application is running. The private profile is destroyed on logout,
        # reset, and normal application shutdown.
        self.session_keepalive.start(validated_cookie_text)
        self.refresh_albums()

    def _apply_keepalive_cookie(self, cookie_text: str) -> None:
        """Persist a rotated browser session without treating refresh errors as logout."""
        if self.client is None:
            return
        try:
            refreshed_client = YikeRemoteClient(cookie_text)
            self.session_store.save(cookie_text)
        except (RemoteClientError, SessionStoreError) as exc:
            LOGGER.warning("会话保活未保存刷新后的 Cookie：%s", exc)
            return
        # Do not replace an API client while any worker might still reference it.
        if self._sync_mode == "idle" and not any(thread.isRunning() for thread in self._running_threads):
            self.client = refreshed_client
        LOGGER.debug("隐藏 WebView 已刷新并保存当前登录会话。")

    def _keepalive_refresh_failed(self, reason: str) -> None:
        # A failed background webpage refresh can be caused by a short network
        # interruption. Keep the encrypted session instead of clearing it.
        LOGGER.warning("隐藏 WebView 会话保活未完成：%s", reason)

    def _show_account_menu(self) -> None:
        menu = QMenu(self)
        logout_web = menu.addAction("退出登录")
        selected = menu.exec(self.hero_connect.mapToGlobal(self.hero_connect.rect().bottomLeft()))
        if selected == logout_web:
            self._logout_via_web()

    def _can_logout(self) -> bool:
        if self._sync_mode != "idle":
            QMessageBox.warning(self, "同步正在运行", "请先暂停或停止同步并等待当前网络请求结束，再退出登录。")
            return False
        return True

    def _clear_connected_account(self) -> None:
        self.session_keepalive.stop()
        self.session_store.clear()
        self.client = None
        self._pending_cookie_text = ""
        self._save_session_after_connect = False
        self.albums = []
        self.current_album = None
        self.current_media = []
        self.sync_actions = []
        self._sync_actions_by_sequence.clear()
        self.album_tree.clear()
        self.media_table.setRowCount(0)
        self.plan_table.setRowCount(0)
        self._set_connected(False)

    def _logout_via_web(self) -> None:
        if not self._can_logout() or self.client is None:
            return
        current_cookie_text = self.client.export_cookie_json()
        # Prevent the private keepalive view from renewing the same session while
        # the user is actively completing the official logout flow.
        self.session_keepalive.stop()
        dialog = WebLogoutDialog(current_cookie_text, self)
        if dialog.exec() != QDialog.Accepted:
            self.session_keepalive.start(current_cookie_text)
            self.status.showMessage("未检测到网页退出完成，本机登录会话仍保留。", 6000)
            return
        if not dialog.logout_verified():
            self.session_keepalive.start(current_cookie_text)
            self.status.showMessage("网页退出状态无法确认，本机登录会话仍保留。", 6000)
            return
        self._clear_connected_account()
        self.status.showMessage("已验证百度网页登录会话失效，并已清除本机登录信息。", 8000)

    def refresh_albums(self) -> None:
        if not self.client:
            return
        self._run_job("正在读取相册列表", lambda progress: self._list_albums(progress), self._albums_loaded)

    def _list_albums(self, progress: Callable[[int, str], None]) -> list[RemoteAlbum]:
        assert self.client
        progress(20, "正在读取云端相册")
        result = self.client.list_albums(force_refresh=True)
        progress(100, f"已读取 {len(result)} 个相册")
        return result

    def _albums_loaded(self, albums: object) -> None:
        self.albums = albums  # type: ignore[assignment]
        previous_id = self.current_album.album_id if self.current_album else None
        self.album_tree.clear()
        for album in self.albums:
            item = QTreeWidgetItem([album.title])
            item.setIcon(0, self.style().standardIcon(QStyle.SP_DirClosedIcon))
            item.setData(0, Qt.UserRole, album.album_id)
            self.album_tree.addTopLevelItem(item)
            if album.album_id == previous_id:
                self.album_tree.setCurrentItem(item)
        self.status.showMessage(f"已加载 {len(self.albums)} 个云端相册。", 3500)

    def album_selected(self) -> None:
        items = self.album_tree.selectedItems()
        if not items:
            return
        album_id = items[0].data(0, Qt.UserRole)
        self.current_album = next((album for album in self.albums if album.album_id == album_id), None)
        if self.current_album:
            self.media_title.setText(self.current_album.title)
            self._run_job("正在读取相册媒体", lambda progress: self._list_media(progress), self._media_loaded)

    def _list_media(self, progress: Callable[[int, str], None]) -> list[RemoteMedia]:
        assert self.client and self.current_album
        progress(20, f"正在读取 {self.current_album.title}")
        result = self.client.list_media(self.current_album.album_id)
        progress(100, f"已读取 {len(result)} 个媒体")
        return result

    @staticmethod
    def _format_size(value: int) -> str:
        size = float(value)
        for unit in ("B", "KB", "MB", "GB", "TB"):
            if size < 1024 or unit == "TB":
                return f"{size:.1f} {unit}" if unit != "B" else f"{int(size)} B"
            size /= 1024
        return str(value)

    @staticmethod
    def _format_time(value: int | None) -> str:
        if not value:
            return "—"
        from datetime import datetime
        return datetime.fromtimestamp(value).strftime("%Y-%m-%d %H:%M")

    def _media_icon(self, name: str):
        suffix = Path(name).suffix.lower()
        if suffix in {".mp4", ".mov", ".avi", ".mkv", ".wmv", ".flv", ".webm", ".3gp"}:
            return QIcon(str(VIDEO_MEDIA_ICON_PATH)), "视频"
        if suffix in {".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic", ".bmp", ".tif", ".tiff"}:
            return QIcon(str(PHOTO_MEDIA_ICON_PATH)), "照片"
        return self.style().standardIcon(QStyle.SP_FileIcon), Path(name).suffix.lower().lstrip(".") or "文件"

    def _media_loaded(self, media: object) -> None:
        self.current_media = media  # type: ignore[assignment]
        self.media_table.setRowCount(0)
        for row, item in enumerate(self.current_media):
            self.media_table.insertRow(row)
            icon, media_type = self._media_icon(item.name)
            name = QTableWidgetItem(item.name)
            name.setIcon(icon)
            name.setData(Qt.UserRole, item.fsid)
            type_item = QTableWidgetItem(media_type)
            type_item.setIcon(icon)
            cells = [name, type_item, QTableWidgetItem(self._format_size(item.size)), QTableWidgetItem(self._format_time(item.modified_at)), QTableWidgetItem("云端媒体")]
            for column, cell in enumerate(cells):
                self.media_table.setItem(row, column, cell)

    # ----- album actions -------------------------------------------
    def create_album(self) -> None:
        if not self.client:
            return
        title, accepted = QInputDialog.getText(self, "新建相册", "相册名称：")
        if not accepted or not title.strip():
            return
        self._run_job("正在创建相册", lambda progress: self._create_album(title, progress), lambda _: self.refresh_albums())

    def _create_album(self, title: str, progress: Callable[[int, str], None]) -> RemoteAlbum:
        assert self.client
        progress(25, "正在创建相册")
        album = self.client.create_album(title)
        progress(100, "相册创建成功")
        return album

    def rename_album(self) -> None:
        if not self.client or not self.current_album:
            QMessageBox.information(self, "请选择相册", "请先在左侧选中要重命名的相册。")
            return
        title, accepted = QInputDialog.getText(self, "重命名相册", "新名称：", text=self.current_album.title)
        if not accepted or not title.strip() or title.strip() == self.current_album.title:
            return
        album_id = self.current_album.album_id
        self._run_job("正在重命名相册", lambda progress: self._rename_album(album_id, title, progress), lambda _: self.refresh_albums())

    def _rename_album(self, album_id: str, title: str, progress: Callable[[int, str], None]) -> None:
        assert self.client
        progress(25, "正在提交新名称")
        self.client.rename_album(album_id, title)
        progress(100, "相册重命名成功")

    def delete_album(self) -> None:
        if not self.client or not self.current_album:
            QMessageBox.information(self, "请选择相册", "请先在左侧选中要删除的相册。")
            return
        response = QMessageBox.warning(
            self,
            "确认删除相册",
            f"确定删除相册“{self.current_album.title}”吗？\n\n默认只删除相册关系，保留其中已上传的云端媒体。",
            QMessageBox.Cancel | QMessageBox.Yes,
            QMessageBox.Cancel,
        )
        if response != QMessageBox.Yes:
            return
        album_id = self.current_album.album_id
        self._run_job("正在删除相册", lambda progress: self._delete_album(album_id, progress), lambda _: self._after_album_deleted())

    def _delete_album(self, album_id: str, progress: Callable[[int, str], None]) -> None:
        assert self.client
        progress(25, "正在删除相册")
        self.client.delete_album(album_id, delete_items=False)
        progress(100, "相册删除成功")

    def _after_album_deleted(self) -> None:
        self.current_album = None
        self.current_media = []
        self.media_table.setRowCount(0)
        self.media_title.setText("选择一个相册以浏览媒体")
        self.refresh_albums()

    # ----- media actions -------------------------------------------
    def _selected_media(self) -> list[RemoteMedia]:
        selected = {self.media_table.item(row.row(), 0).data(Qt.UserRole) for row in self.media_table.selectionModel().selectedRows()}
        return [item for item in self.current_media if item.fsid in selected]

    def upload_media(self) -> None:
        if not self.client or not self.current_album:
            QMessageBox.information(self, "请选择相册", "请先选择上传目标相册。")
            return
        paths, _ = QFileDialog.getOpenFileNames(self, "选择要上传的照片或视频")
        if not paths:
            return
        album_id = self.current_album.album_id
        files = [Path(path) for path in paths]
        self._run_job("准备上传媒体", lambda progress: self._upload_media(album_id, files, progress), lambda _: self.album_selected())

    def _upload_media(self, album_id: str, files: list[Path], progress: Callable[[int, str], None]) -> None:
        assert self.client
        compression_options = VideoCompressionOptions(
            enabled=bool(self.settings.value("compress_oversize_videos", False, type=bool))
        )
        total = max(1, len(files))
        for index, source in enumerate(files, start=1):
            def local_progress(value: int, message: str) -> None:
                fraction = max(0, min(100, value)) / 100
                progress(int(((index - 1) + fraction) / total * 100), message)

            with prepared_video_upload(source, compression_options, local_progress) as prepared:
                upload_path = prepared.path if prepared is not None else source
                self.client.upload_files(album_id, [upload_path], local_progress)

    def download_media(self) -> None:
        if not self.client or not self.current_album:
            return
        selected = self._selected_media()
        if not selected:
            QMessageBox.information(self, "请选择媒体", "请在右侧选择至少一个要下载的媒体。")
            return
        directory = QFileDialog.getExistingDirectory(self, "选择下载目录")
        if not directory:
            return
        album_id = self.current_album.album_id
        self._run_job("正在下载媒体", lambda progress: self._download_media(album_id, selected, Path(directory), progress))

    def _download_media(self, album_id: str, selected: list[RemoteMedia], directory: Path, progress: Callable[[int, str], None]) -> None:
        assert self.client
        for index, item in enumerate(selected, start=1):
            progress(int((index - 1) / max(1, len(selected)) * 100), f"正在下载 {item.name}")
            self.client.download_media(album_id, item.fsid, directory)
        progress(100, "下载完成")

    def delete_media(self) -> None:
        if not self.client or not self.current_album:
            return
        selected = self._selected_media()
        if not selected:
            QMessageBox.information(self, "请选择媒体", "请在右侧选择至少一个要删除的媒体。")
            return
        response = QMessageBox.warning(
            self,
            "确认删除媒体",
            f"确定删除所选 {len(selected)} 个远端媒体吗？此操作会影响云端文件。",
            QMessageBox.Cancel | QMessageBox.Yes,
            QMessageBox.Cancel,
        )
        if response != QMessageBox.Yes:
            return
        album_id = self.current_album.album_id
        self._run_job("正在删除媒体", lambda progress: self._delete_media(album_id, selected, progress), lambda _: self.album_selected())

    def _delete_media(self, album_id: str, selected: list[RemoteMedia], progress: Callable[[int, str], None]) -> None:
        assert self.client
        for index, item in enumerate(selected, start=1):
            progress(int((index - 1) / max(1, len(selected)) * 100), f"正在删除 {item.name}")
            self.client.delete_media(album_id, item.fsid)
        progress(100, "媒体删除完成")

    def rename_media(self) -> None:
        try:
            raise UnsupportedRemoteFeature(
                "当前接口库没有已验证的远端媒体重命名功能。为了保护你的媒体，本程序不会使用重新上传和删除来模拟重命名。"
            )
        except UnsupportedRemoteFeature as exc:
            QMessageBox.information(self, "远端媒体重命名受限", str(exc))

    # ----- sync actions --------------------------------------------
    def choose_root(self) -> None:
        directory = QFileDialog.getExistingDirectory(self, "选择本地同步根目录", self.local_root.text() or str(Path.home()))
        if directory:
            self.local_root.setText(directory)
            self.settings.setValue("local_root", directory)

    def _sync_options(self) -> tuple[Path, SyncDirection, SortField, bool, bool, int, FileCompareMode, VideoCompressionOptions]:
        root = Path(self.local_root.text().strip())
        # QComboBox returns a plain string for str-based Enum values on some
        # PySide6/Windows builds, so restore the Enum explicitly here.
        direction = SyncDirection(str(self.direction_combo.currentData()))
        sort_field = SortField(str(self.sort_combo.currentData()))
        compare_mode = FileCompareMode(str(self.compare_mode_combo.currentData()))
        reverse = bool(self.order_combo.currentData())
        compression_options = VideoCompressionOptions(enabled=self.compress_video_checkbox.isChecked())
        return (
            root,
            direction,
            sort_field,
            reverse,
            self.delete_checkbox.isChecked(),
            self.worker_spin.value(),
            compare_mode,
            compression_options,
        )

    def build_sync_plan(self) -> None:
        if not self.client:
            return
        if self._sync_mode != "idle":
            # 比较或执行正在进行，忽略重复点击，避免并发生成计划导致数据竞争。
            return
        root, direction, sort_field, reverse, deletion, workers, compare_mode, compression_options = self._sync_options()
        if not root.is_dir():
            QMessageBox.warning(self, "本地目录无效", "请选择一个有效的同步根目录。")
            return
        self.settings.setValue("local_root", str(root))
        self.settings.setValue("file_client_workers", workers)
        list_threads = self.list_threads_spin.value()
        self.settings.setValue("list_threads", list_threads)
        skip_oversize = bool(self.settings.value("skip_oversize", True, type=bool))
        LOGGER.debug("生成同步计划：方向=%s，排序=%s，逆序=%s，文件客户端并发=%s，读取线程=%s，比较模式=%s，超限视频压缩=%s，忽略=%s，跳过超限=%s", direction.value, sort_field.value, reverse, workers, list_threads, compare_mode.value, compression_options.enabled, sorted(self.ignored_album_names), skip_oversize)
        self._set_sync_controls("planning")
        self.progress.setValue(0)
        self.progress.setFormat("正在比较本地与云端")
        self._run_job(
            "正在比较本地与云端",
            lambda progress: SyncEngine(
                self.client,
                max_workers=workers,
                list_threads=list_threads,
                compare_mode=compare_mode,
                compression_options=compression_options,
            ).build_plan(
                root, direction, sort_field, reverse, deletion, progress, self.ignored_album_names, skip_oversize
            ),
            self._sync_plan_ready,
            self._sync_plan_failed,
        )

    def _sync_plan_failed(self, _error: str) -> None:
        # _job_failed 已弹出错误框；这里仅把界面控件恢复为可操作状态。
        self._set_sync_controls("idle")

    def _sync_plan_ready(self, actions: object) -> None:
        self.sync_actions = actions  # type: ignore[assignment]
        self._sync_actions_by_sequence = {action.sequence: action for action in self.sync_actions}
        self._populate_plan()
        self._populate_sync_album_queue()
        count = len(self.sync_actions)
        conflicts = sum(action.action == PlanAction.CONFLICT for action in self.sync_actions)
        executable = sum(action.can_execute for action in self.sync_actions)
        ignored = sum(action.action == PlanAction.SKIP and "忽略" in action.detail for action in self.sync_actions)
        self.plan_summary.setText(f"共 {count} 项；可执行 {executable} 项；冲突 {conflicts} 项；已忽略 {ignored} 项")
        self.progress.setValue(100)
        self.progress.setFormat(f"同步计划已生成：{executable} 项待执行（尚未开始上传）")
        # A previous cancelled/failed job must not leave the execute button
        # disabled after a fresh, reviewable plan has been generated.
        self._set_sync_controls("idle")

    def _plan_icon(self, action: PlanAction):
        mapping = {
            PlanAction.CREATE_REMOTE_ALBUM: QStyle.SP_FileDialogNewFolder,
            PlanAction.CREATE_LOCAL_FOLDER: QStyle.SP_FileDialogNewFolder,
            PlanAction.UPLOAD: QStyle.SP_ArrowUp,
            PlanAction.DOWNLOAD: QStyle.SP_ArrowDown,
            PlanAction.DELETE_REMOTE: QStyle.SP_TrashIcon,
            PlanAction.DELETE_LOCAL: QStyle.SP_TrashIcon,
            PlanAction.CONFLICT: QStyle.SP_MessageBoxWarning,
            PlanAction.SKIP: QStyle.SP_DialogApplyButton,
        }
        return self.style().standardIcon(mapping[action])

    def _populate_sync_album_queue(self) -> None:
        self.sync_album_tree.clear()
        by_album: dict[str, list[SyncAction]] = {}
        for action in self.sync_actions:
            if action.album_name:
                by_album.setdefault(action.album_name, []).append(action)
        for album_name in sorted(by_album, key=str.casefold):
            actions = by_album[album_name]
            executable = sum(action.can_execute for action in actions)
            ignored = any(action.action == PlanAction.SKIP and "忽略" in action.detail for action in actions)
            if ignored:
                state = "已忽略"
            elif executable:
                state = f"{executable} 项"
            else:
                state = "无需操作"
            item = QTreeWidgetItem([album_name, state])
            item.setData(0, Qt.UserRole, album_name)
            item.setIcon(0, self.style().standardIcon(QStyle.SP_DirClosedIcon))
            if ignored:
                item.setForeground(0, QColor("#718096"))
                item.setForeground(1, QColor("#718096"))
            self.sync_album_tree.addTopLevelItem(item)

    def _show_sync_album_menu(self, position) -> None:
        item = self.sync_album_tree.itemAt(position)
        if item is None:
            return
        album_name = str(item.data(0, Qt.UserRole) or "")
        if not album_name:
            return
        menu = QMenu(self)
        if self._ignored_name_entry(album_name) is not None:
            action = menu.addAction("从忽略列表移除")
            action.setIcon(self.style().standardIcon(QStyle.SP_DialogResetButton))
        else:
            action = menu.addAction("加入忽略列表")
            action.setIcon(self.style().standardIcon(QStyle.SP_DialogCancelButton))
        action.triggered.connect(lambda: self._toggle_ignore_album(album_name))
        menu.exec(self.sync_album_tree.viewport().mapToGlobal(position))

    def _toggle_ignore_album(self, album_name: str) -> None:
        existing = self._ignored_name_entry(album_name)
        if existing is not None:
            self.ignored_album_names.remove(existing)
            self.status.showMessage(f"已取消忽略相册：{album_name}", 3500)
        else:
            self.ignored_album_names.add(album_name)
            self.status.showMessage(f"已加入忽略列表：{album_name}", 3500)
        self._save_ignored_albums()
        self.build_sync_plan()

    def clear_ignored_albums(self) -> None:
        if not self.ignored_album_names:
            self.status.showMessage("忽略列表为空。", 2500)
            return
        self.ignored_album_names.clear()
        self._save_ignored_albums()
        self.status.showMessage("已清空忽略列表。", 3500)
        if self.sync_actions:
            self.build_sync_plan()

    @staticmethod
    def _truncate_status(status: str) -> str:
        # The status column now elides overflow visually and keeps the full text
        # in the cell tooltip, so no separate truncation is needed here.
        return status

    @staticmethod
    def _truncate_text(text: str, limit: int) -> str:
        # Long detail/name cells are clipped in the table but kept intact in the
        # cell tooltip, so the column can size to a predictable width.
        return text if len(text) <= limit else text[:limit] + "…"

    def _populate_plan(self) -> None:
        self.plan_table.setRowCount(0)
        self._sync_rows_by_sequence = {}
        # Keep ordinary no-op folders in the left queue only, but show files
        # rejected by the real-media validator on the right for transparent
        # review. They never become executable upload tasks.
        visible_actions = [
            action
            for action in self.sync_actions
            if action.action != PlanAction.SKIP or "非有效照片/视频" in action.detail
        ]
        for row, action in enumerate(visible_actions):
            self.plan_table.insertRow(row)
            self._sync_rows_by_sequence[action.sequence] = row
            target = action.local_path.name if action.local_path else ("云端" if action.remote_album_id else "—")
            operation = QTableWidgetItem(action.action.value)
            operation.setIcon(self._plan_icon(action.action))
            cells = [
                QTableWidgetItem(str(action.sequence)),
                operation,
                QTableWidgetItem(action.album_name or "—"),
                QTableWidgetItem(action.media_name or "—"),
                QTableWidgetItem(target),
                QTableWidgetItem(action.detail),
                QTableWidgetItem(self._truncate_status(action.status)),
            ]
            cells[5].setToolTip(action.detail)
            cells[6].setToolTip(action.status)
            if action.action == PlanAction.CONFLICT:
                for cell in cells:
                    cell.setForeground(QColor("#b42318"))
            elif action.action in {PlanAction.DELETE_LOCAL, PlanAction.DELETE_REMOTE}:
                for cell in cells:
                    cell.setForeground(QColor("#9a6700"))
            elif action.action == PlanAction.SKIP:
                for cell in cells:
                    cell.setForeground(QColor("#718096"))
            for column, cell in enumerate(cells):
                self.plan_table.setItem(row, column, cell)
            self._apply_action_row_style(row, action.status)
        self.plan_table.apply_proportional_widths()
        if self._current_sync_sequence is not None:
            self._focus_sync_row(self._current_sync_sequence)

    def _apply_action_row_style(self, row: int, status: str) -> None:
        colors = {
            "正在执行": QColor("#dbeafe"),
            "正在上传并确认入册": QColor("#dbeafe"),
            "等待上传并确认入册": QColor("#eef6ff"),
            "已暂停，等待继续": QColor("#fef3c7"),
            "已完成": QColor("#dcfce7"),
            "已跳过": QColor("#f1f5f9"),
            "已停止": QColor("#e5e7eb"),
        }
        color = next((value for prefix, value in colors.items() if status.startswith(prefix)), None)
        if status.startswith(("失败", "错误")):
            color = QColor("#fee2e2")
        if color is None:
            return
        for column in range(self.plan_table.columnCount()):
            cell = self.plan_table.item(row, column)
            if cell:
                cell.setBackground(color)

    def _focus_sync_row(self, sequence: int) -> None:
        row = self._sync_rows_by_sequence.get(sequence)
        if row is None:
            return
        self.plan_table.selectRow(row)
        status_cell = self.plan_table.item(row, 6)
        if status_cell:
            self.plan_table.scrollToItem(status_cell)

    def _schedule_sync_row_focus(self, sequence: int) -> None:
        self._pending_focus_sequence = sequence
        if self._sync_row_focus_pending:
            return
        self._sync_row_focus_pending = True
        QTimer.singleShot(80, self._flush_sync_row_focus)

    def _flush_sync_row_focus(self) -> None:
        self._sync_row_focus_pending = False
        if self._pending_focus_sequence is not None:
            self._focus_sync_row(self._pending_focus_sequence)

    def _schedule_sync_album_queue_refresh(self) -> None:
        if self._sync_queue_refresh_pending:
            return
        self._sync_queue_refresh_pending = True
        QTimer.singleShot(180, self._flush_sync_album_queue_refresh)

    def _flush_sync_album_queue_refresh(self) -> None:
        self._sync_queue_refresh_pending = False
        self._populate_sync_album_queue()

    def _sync_action_status_changed(self, sequence: int, status: str) -> None:
        action = self._sync_actions_by_sequence.get(sequence)
        if action is None:
            # Normal plans build this index once. Keep a one-time fallback for
            # imported plans and tests that assign sync_actions directly.
            action = next((item for item in self.sync_actions if item.sequence == sequence), None)
            if action is None:
                return
            self._sync_actions_by_sequence[sequence] = action
        action.status = status
        self._current_sync_sequence = sequence
        row = self._sync_rows_by_sequence.get(sequence)
        if row is None:
            self._populate_plan()
        else:
            status_cell = self.plan_table.item(row, 6)
            if status_cell:
                status_cell.setText(self._truncate_status(status))
                status_cell.setToolTip(status)
            self._apply_action_row_style(row, status)
            self._schedule_sync_row_focus(sequence)
        self._schedule_sync_album_queue_refresh()
        if status in {"已完成", "已停止"} or status.startswith(("失败", "错误", "已跳过")):
            self._sync_finished_sequences.add(sequence)
        else:
            self._sync_finished_sequences.discard(sequence)
        self.plan_summary.setText(f"同步中：已处理 {len(self._sync_finished_sequences)}/{self._sync_executable_total} 项")
        self.sync_live_label.setText(f"当前：{action.album_name} / {action.media_name or action.action.value}")

    def execute_sync_plan(self) -> None:
        if self._sync_mode != "idle":
            return
        if not self.client or not self.sync_actions:
            QMessageBox.information(self, "尚无计划", "请先生成同步计划。")
            return
        executable = [
            action
            for action in self.sync_actions
            if action.can_execute
            and (
                action.status in {"待执行", "已停止"}
                or action.status.startswith("失败")
                or action.status.startswith("错误")
                or action.status.startswith("待重试")
            )
        ]
        if not executable:
            QMessageBox.information(self, "无需执行", "当前计划没有可安全执行的项目。")
            return
        deletes = [action for action in executable if action.action in {PlanAction.DELETE_LOCAL, PlanAction.DELETE_REMOTE}]
        message = f"确定执行 {len(executable)} 项同步操作吗？\n忽略与冲突项目不会执行。"
        if deletes:
            message += f"\n\n其中包含 {len(deletes)} 项删除操作，请确认已检查计划。"
        response = QMessageBox.warning(self, "确认执行同步", message, QMessageBox.Cancel | QMessageBox.Yes, QMessageBox.Cancel)
        if response != QMessageBox.Yes:
            return
        root, _, _, _, _, workers, compare_mode, compression_options = self._sync_options()
        self._current_sync_sequence = None
        self._sync_finished_sequences = {
            action.sequence
            for action in self.sync_actions
            if action.can_execute and (action.status in {"已完成", "已停止"} or action.status.startswith(("失败", "错误", "已跳过")))
        }
        self._sync_executable_total = sum(action.can_execute for action in self.sync_actions)
        self._sync_run_sequences = {action.sequence for action in executable}
        self._sync_started_at = time.monotonic()
        self._sync_control = SyncControl()
        self._set_sync_controls("running")
        self.progress.setValue(0)
        self.progress.setFormat("正在执行同步计划")
        list_threads = self.list_threads_spin.value()
        self.settings.setValue("list_threads", list_threads)
        LOGGER.debug("执行同步计划：操作数=%s，主控制器文件客户端并发=%s，读取线程=%s，比较模式=%s，超限视频压缩=%s", len(executable), workers, list_threads, compare_mode.value, compression_options.enabled)

        thread = QThread(self)
        worker = SyncWorker(
            lambda progress, action_status, alert: SyncEngine(
                self.client,
                max_workers=workers,
                list_threads=list_threads,
                compare_mode=compare_mode,
                compression_options=compression_options,
            ).execute_plan(
                root,
                self.sync_actions,
                progress,
                self._sync_control,
                action_status,
                alert,
            )
        )
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.progress.connect(self._update_progress)
        worker.action_status.connect(self._sync_action_status_changed)
        worker.user_alert.connect(self._sync_user_alert)
        worker.finished.connect(lambda result: self._sync_job_success(thread, worker, result))
        worker.failed.connect(lambda error: self._sync_job_failed(thread, worker, error))
        thread.finished.connect(lambda: self._thread_finished(thread))
        thread.start()
        self._sync_thread = thread
        self._running_threads.append(thread)

    def pause_sync(self) -> None:
        if not self._sync_control or self._sync_mode != "running":
            return
        self._sync_control.pause()
        self._set_sync_controls("paused")
        if self._current_sync_sequence is not None:
            self._sync_action_status_changed(self._current_sync_sequence, "已暂停，等待当前请求完成")
        self.status.showMessage("已请求暂停：当前网络请求完成后不会启动下一项。", 5000)

    def resume_sync(self) -> None:
        if not self._sync_control or self._sync_mode != "paused":
            return
        self._sync_control.resume()
        self._set_sync_controls("running")
        self.status.showMessage("同步已继续。", 3000)

    def _sync_user_alert(self, message: str) -> None:
        # Fired by the engine (e.g. repeated rate-limit hits) from the worker
        # thread; the signal is queued to the UI thread, so this runs on the UI.
        if self._sync_mode != "running":
            return
        self._set_sync_controls("paused")
        QMessageBox.warning(self, "同步已暂停", message)

    def stop_sync(self) -> None:
        if not self._sync_control or self._sync_mode not in {"running", "paused"}:
            return
        self._sync_control.stop()
        self._set_sync_controls("stopping")
        self.status.showMessage("已请求安全停止：当前网络请求完成后，剩余任务将标记为已停止。", 6000)

    def _sync_job_success(self, thread: QThread, worker: SyncWorker, result: object) -> None:
        self._sync_execution_finished(result)
        self.progress.setValue(100)
        actions = result  # type: ignore[assignment]
        retry_pending = sum(
            action.can_execute and (action.status.startswith(("失败", "错误")) or action.status.startswith("待重试"))
            for action in actions
        )
        if self._sync_control and self._sync_control.stopped:
            self.progress.setFormat("同步已安全停止")
        elif retry_pending:
            self.progress.setFormat(f"同步执行结束：{retry_pending} 项待重试（失败相册的后续文件未启动）")
        else:
            self.progress.setFormat("同步执行完成")
        self._show_sync_result(actions)
        self._sync_control = None
        self._sync_thread = None
        self._set_sync_controls("idle")
        worker.deleteLater()
        thread.quit()

    def _show_sync_result(self, actions: list[SyncAction]) -> None:
        if self._sync_run_sequences:
            run_actions = [action for action in actions if action.sequence in self._sync_run_sequences]
        else:
            run_actions = list(actions)
        total = len(run_actions)
        success = sum(1 for action in run_actions if action.status == "已完成")
        failed = [action for action in run_actions if action.status.startswith(("失败", "错误"))]
        skipped = [action for action in run_actions if action.status.startswith("已跳过")]
        pending = total - success - len(failed) - len(skipped)
        summary_lines = []
        if self._sync_control and self._sync_control.stopped:
            summary_lines.append("同步已停止（剩余项未执行）。")
        summary_lines.append(
            "总项数：{total}    成功：{success}    失败：{failed}    已跳过：{skipped}".format(
                total=total,
                success=success,
                failed=len(failed),
                skipped=len(skipped),
            )
        )
        if pending:
            summary_lines.append(f"未执行：{pending}")
        if self._sync_started_at is not None:
            elapsed = time.monotonic() - self._sync_started_at
            summary_lines.append(f"总用时：{_format_duration(elapsed)}")
            if success:
                summary_lines.append(f"平均每项（按成功 {success} 项）：{_format_duration(elapsed / success)}")
        detail_lines = []
        for action in failed:
            detail_lines.append(
                "[失败] {} / {} — {}".format(
                    action.album_name, action.media_name or action.action.value, action.status.split("：", 1)[-1]
                )
            )
        for action in skipped:
            detail_lines.append(
                "[已跳过] {} / {} — {}".format(
                    action.album_name, action.media_name or action.action.value, action.status.split("：", 1)[-1]
                )
            )
        SyncResultDialog(summary_lines, detail_lines, self).exec()

    def _sync_job_failed(self, thread: QThread, worker: SyncWorker, error: str) -> None:
        self.progress.setFormat("同步执行失败")
        self.sync_live_label.setText("同步失败：请查看 error.log")
        self._sync_control = None
        self._sync_thread = None
        self._set_sync_controls("idle")
        QMessageBox.critical(self, "同步执行失败", "同步未完成。详细错误已写入 error.log。")
        worker.deleteLater()
        thread.quit()

    def _sync_execution_finished(self, actions: object) -> None:
        self.sync_actions = actions  # type: ignore[assignment]
        self._sync_actions_by_sequence = {action.sequence: action for action in self.sync_actions}
        self._populate_plan()
        self._populate_sync_album_queue()
        failures = sum(action.status.startswith(("失败", "错误")) for action in self.sync_actions)
        retry_pending = sum(action.status.startswith("待重试") for action in self.sync_actions)
        skipped = sum(action.status.startswith("已跳过") for action in self.sync_actions)
        stopped = sum(action.status == "已停止" for action in self.sync_actions)
        parts = []
        if failures:
            parts.append(f"{failures} 项失败")
        if retry_pending:
            parts.append(f"{retry_pending} 项待重试（失败相册的后续文件未启动）")
        if skipped:
            parts.append(f"{skipped} 项已跳过")
        if parts:
            self.plan_summary.setText("同步执行结束：" + "；".join(parts))
        elif stopped:
            self.plan_summary.setText(f"同步已安全停止，剩余 {stopped} 项未执行")
        else:
            self.plan_summary.setText("同步执行完成")
        self.refresh_albums()

    def show_api_limits(self) -> None:
        QMessageBox.information(
            self,
            "当前接口限制",
            "相册浏览、创建、删除、重命名，以及媒体浏览、上传、下载、删除已纳入程序。\n\n"
            "当前项目没有已验证的远端媒体重命名接口，因此该操作不会执行。为避免重复传输，双向同步中两端已有同名媒体会跳过，不会自动覆盖。",
        )

    def closeEvent(self, event) -> None:  # type: ignore[override]
        if self._sync_control:
            self._sync_control.stop()
        # Retain the single background worker until it exits. This prevents Qt
        # from destroying a live QThread when the user closes the window during
        # an API request. Closing may wait briefly for the current request.
        for thread in list(self._running_threads):
            if thread.isRunning():
                thread.quit()
                thread.wait(10000)
            if thread.isRunning():
                event.ignore()
                self.status.showMessage("正在等待当前网络请求安全结束，请稍后再次关闭窗口。", 8000)
                return
        self.session_keepalive.stop()
        self.client = None  # Drop the in-memory Cookie reference.
        self._pending_cookie_text = ""
        super().closeEvent(event)


def main() -> int:
    multiprocessing.freeze_support()
    log_format = "%(asctime)s %(levelname)s [%(threadName)s] %(name)s: %(message)s"
    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(logging.DEBUG)
    error_file_handler = logging.FileHandler(ERROR_LOG_PATH, encoding="utf-8")
    error_file_handler.setLevel(logging.ERROR)
    logging.basicConfig(
        level=logging.DEBUG,
        format=log_format,
        handlers=[console_handler, error_file_handler],
    )
    LOGGER.info("错误日志文件：%s", ERROR_LOG_PATH)
    app = QApplication(sys.argv)
    ui_font = QFont("Segoe UI", 10)
    ui_font.setStyleStrategy(QFont.PreferAntialias)
    ui_font.setHintingPreference(QFont.PreferFullHinting)
    app.setFont(ui_font)
    app.setApplicationName("BaiduPhotoSync")
    app.setOrganizationName("Baidu")
    icon = QIcon(str(APP_ICON_PATH))
    if not icon.isNull():
        app.setWindowIcon(icon)
    window = MainWindow()
    if not icon.isNull():
        window.setWindowIcon(icon)
    window.show()
    return app.exec()


if __name__ == "__main__":
    raise SystemExit(main())
