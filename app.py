from __future__ import annotations

import json
import logging
import multiprocessing
import sys
import time
import traceback
from pathlib import Path
from typing import Callable

from PySide6.QtCore import QObject, QSettings, QThread, QTimer, Qt, Signal, Slot
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
    QMainWindow,
    QMenu,
    QMessageBox,
    QPushButton,
    QPlainTextEdit,
    QProgressBar,
    QSizePolicy,
    QSpinBox,
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
from sync_engine import PlanAction, SortField, SyncAction, SyncControl, SyncDirection, SyncEngine


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
        buttons = QDialogButtonBox(QDialogButtonBox.Ok)
        buttons.accepted.connect(self.accept)
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
            <p>本程序通过已登录网页的会话 Cookie 连接一刻相册。Cookie 相当于登录凭据，请仅在自己的电脑上操作，<b>不要发送给任何人</b>。</p>
            <ol>
              <li>在 Edge 或 Chrome 登录 <a href='https://photo.baidu.com'>一刻相册</a>，确认能正常查看相册。</li>
              <li>按 <b>F12</b> 打开开发者工具，进入 <b>Application（应用）→ Storage（存储）→ Cookies</b>。</li>
              <li>分别选择 <code>https://photo.baidu.com</code> 与 <code>.baidu.com</code>，复制 Cookie 表格行，或用浏览器导出为 JSON。</li>
              <li>将文本粘贴到下方，选择仅本次使用或保存到本机后连接。</li>
            </ol>
            <p>程序兼容“开发者工具复制的制表符文本”和 JSON Cookie 列表。Cookie 不会写入日志。勾选保存后，Cookie 会写入当前 Windows 用户的 Qt 设置存储（并非加密保险箱），请仅在受信任的个人电脑上使用。</p>
            """
        )
        layout.addWidget(guide, 1)
        self.editor = QPlainTextEdit()
        self.editor.setPlaceholderText("在此粘贴 Cookie 导出文本或 JSON 列表…")
        self.editor.setMinimumHeight(150)
        self.editor.setPlainText(saved_cookie)
        layout.addWidget(self.editor)
        self.remember_cookie = QCheckBox("将 Cookie 保存到本机，下次打开时自动填入（明文保存）")
        self.remember_cookie.setChecked(bool(saved_cookie))
        self.remember_cookie.setToolTip("仅限受信任的个人电脑。保存的 Cookie 不会写入日志或源码压缩包。")
        layout.addWidget(self.remember_cookie)
        buttons = QDialogButtonBox(QDialogButtonBox.Cancel | QDialogButtonBox.Ok)
        buttons.button(QDialogButtonBox.Ok).setText("连接")
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
        self.settings = QSettings("Manus", "YikeSyncGUI")
        self.ignored_album_names = self._load_ignored_albums()
        self.client: YikeRemoteClient | None = None
        self._pending_cookie_text = ""
        self._clear_saved_cookie_after_connect = False
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
        dialog.setMinimumWidth(620)
        outer = QVBoxLayout(dialog)
        grid = QGridLayout()
        grid.setHorizontalSpacing(12)
        grid.setVerticalSpacing(10)

        grid.addWidget(QLabel("同步方向"), 0, 0)
        self.direction_combo = QComboBox(dialog)
        for item in SyncDirection:
            self.direction_combo.addItem(item.value, item.value)
        grid.addWidget(self.direction_combo, 0, 1)

        grid.addWidget(QLabel("相册处理顺序"), 0, 2)
        self.sort_combo = QComboBox(dialog)
        for item in SortField:
            self.sort_combo.addItem(item.value, item.value)
        grid.addWidget(self.sort_combo, 0, 3)

        grid.addWidget(QLabel("排序"), 0, 4)
        self.order_combo = QComboBox(dialog)
        self.order_combo.addItem("正序", False)
        self.order_combo.addItem("逆序", True)
        grid.addWidget(self.order_combo, 0, 5)

        self.delete_checkbox = QCheckBox("启用同步删除（危险，默认关闭）")
        grid.addWidget(self.delete_checkbox, 1, 0, 1, 3)
        self.debug_checkbox = QCheckBox("终端输出 DEBUG 日志")
        self.debug_checkbox.setChecked(self.settings.value("debug_logging", True, type=bool))
        self.debug_checkbox.toggled.connect(self._set_debug_logging)
        grid.addWidget(self.debug_checkbox, 1, 3, 1, 3)

        self.size_limit_checkbox = QCheckBox("跳过超过普通用户大小限制的文件（照片/视频均 30MB）")
        self.size_limit_checkbox.setChecked(self.settings.value("skip_oversize", True, type=bool))
        self.size_limit_checkbox.setToolTip(
            "普通（非超级会员）账号的单文件大小上限约为 30MB（照片与视频相同）。"
            "勾选后，超过上限的文件会在计划中直接标记为“已跳过”并写明原因，"
            "不必等到服务端拒绝才看到错误码。超级会员账号请取消勾选。"
        )
        grid.addWidget(self.size_limit_checkbox, 2, 0, 1, 6)

        grid.addWidget(QLabel("文件客户端并发"), 3, 0)
        self.worker_spin = QSpinBox(dialog)
        self.worker_spin.setRange(1, 10)
        self.worker_spin.setValue(int(self.settings.value("file_client_workers", 2)))
        self.worker_spin.setToolTip("主控制器同时下发的单文件客户端数（1–10）。每个客户端只上传一个指定文件并回报 FSID；主控制器每累计 50 个 FSID 即统一入册。传输中 TLS/连接中断会自动换新连接重发；上传最终失败会跳过该文件并继续，不阻塞后续文件。日常建议 2；受控验证可使用 10。")
        grid.addWidget(self.worker_spin, 3, 1)

        grid.addWidget(QLabel("读取相册列表线程数"), 3, 2)
        self.list_threads_spin = QSpinBox(dialog)
        self.list_threads_spin.setRange(1, 16)
        self.list_threads_spin.setValue(int(self.settings.value("list_threads", 4)))
        self.list_threads_spin.setToolTip("生成/执行计划时并行读取各云端相册媒体列表的线程数（1–16）。线程越多读取越快，但并发请求越多；若触发账号限流请调小。默认 4。")
        grid.addWidget(self.list_threads_spin, 3, 3)

        ignored_hint = QLabel("右键左侧相册可加入忽略列表")
        ignored_hint.setObjectName("muted")
        grid.addWidget(ignored_hint, 4, 0, 1, 6)

        guidance = QLabel("先比较并检查右侧计划，再执行。按扩展名选择照片/视频（jpg、png、mp4 等），其余扩展名或空文件显示为跳过。文件客户端只上传并回报 FSID；主控制器每累计 50 个成功上传的文件即统一加入相册，最后不足 50 的尾批也会加入。上传最终失败（网络/接口异常）的文件标记为已跳过，其余文件继续；网络恢复后重新生成计划即可补传。")
        guidance.setWordWrap(True)
        guidance.setObjectName("muted")
        grid.addWidget(guidance, 5, 0, 1, 6)

        outer.addLayout(grid)
        buttons = QDialogButtonBox(QDialogButtonBox.Ok | QDialogButtonBox.Cancel)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        outer.addWidget(buttons)
        dialog.accepted.connect(self._save_advanced_settings)

        self.advanced_dialog = dialog
        self._load_advanced_settings()

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
            <h2>登录令牌获取与安全使用</h2>
            <p>本程序使用一刻相册网页登录后的 Cookie 连接远端接口。Cookie 是登录凭据，请仅保留在自己的电脑上，切勿发给他人、提交到网盘或写入同步目录。</p>
            <h3>导入步骤</h3>
            <ol>
              <li>用 Edge 或 Chrome 登录 <a href='https://photo.baidu.com'>photo.baidu.com</a>。</li>
              <li>按 <b>F12</b> 打开开发者工具，进入 <b>Application（应用）→ Storage（存储）→ Cookies</b>。</li>
              <li>选择 <code>https://photo.baidu.com</code> 与 <code>.baidu.com</code>，复制 Cookie 表格的全部行，或导出为 JSON Cookie 列表。</li>
              <li>点击主工具栏的“登录”，粘贴文本后选择“仅本次连接”。</li>
            </ol>
            <p>程序只在内存内使用 Cookie；关闭应用即丢弃。Cookie 过期时，重新登录并再次导入即可。</p>
            <h2>同步说明</h2>
            <p>本地根目录的直接子文件夹会映射为云端相册，直接文件会映射为该相册的媒体。同步中心支持按文件夹名称、修改日期或创建日期正序/逆序生成计划。两端已有同名媒体时会按“已存在”跳过，不进入右侧可执行计划；执行前仍应检查删除项。</p>
            <h2>已知接口限制</h2>
            <ul>
              <li>远端媒体重命名接口未在当前 API 中验证，按钮会说明限制而不会进行危险替代操作。</li>
              <li>为避免重复上传或下载，双向同步将两端已有同名媒体视为已存在并跳过，不自动覆盖或删除任一侧。</li>
              <li>该程序使用非官方接口实现；接口或会话格式变化时可能需要更新。</li>
            </ul>
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
    ) -> None:
        self.progress.setValue(0)
        self.progress.setFormat(label)
        thread = QThread(self)
        worker = Worker(task)
        worker.moveToThread(thread)
        thread.started.connect(worker.run)
        worker.progress.connect(self._update_progress)
        worker.finished.connect(lambda result: self._job_success(thread, worker, result, on_success))
        worker.failed.connect(lambda error: self._job_failed(thread, worker, error))
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

    def _job_failed(self, thread: QThread, worker: Worker, error: str) -> None:
        self.progress.setValue(0)
        self.progress.setFormat("操作失败")
        QMessageBox.critical(self, "操作失败", "操作未完成。详细错误已写入 error.log。")
        worker.deleteLater()
        thread.quit()

    def _thread_finished(self, thread: QThread) -> None:
        if thread in self._running_threads:
            self._running_threads.remove(thread)
        thread.deleteLater()

    def _update_progress(self, value: int, text: str) -> None:
        self.progress.setValue(max(0, min(100, value)))
        self.progress.setFormat(text)

    def _set_debug_logging(self, enabled: bool) -> None:
        self.settings.setValue("debug_logging", enabled)
        logging.getLogger().setLevel(logging.DEBUG if enabled else logging.INFO)
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

    def connect_account(self) -> None:
        saved_cookie = str(self.settings.value("saved_cookie", ""))
        dialog = CookieDialog(saved_cookie, self)
        if dialog.exec() != QDialog.Accepted:
            return
        cookie_text = dialog.cookie_text().strip()
        if not cookie_text:
            QMessageBox.warning(self, "缺少 Cookie", "请粘贴 Cookie 后再连接。")
            return
        self._pending_cookie_text = cookie_text if dialog.should_remember_cookie() else ""
        self._clear_saved_cookie_after_connect = not dialog.should_remember_cookie()
        self._run_job(
            "正在验证登录会话",
            lambda progress: self._connect_client(cookie_text, progress),
            self._connected,
        )

    @staticmethod
    def _connect_client(cookie_text: str, progress: Callable[[int, str], None]) -> YikeRemoteClient:
        progress(15, "正在解析登录信息")
        client = YikeRemoteClient(cookie_text)
        progress(55, "正在验证远端会话")
        client.verify_login()
        progress(100, "登录验证成功")
        return client

    def _connected(self, client: object) -> None:
        self.client = client  # type: ignore[assignment]
        if self._pending_cookie_text:
            self.settings.setValue("saved_cookie", self._pending_cookie_text)
            self.status.showMessage("账户已连接；Cookie 已按你的选择保存到本机设置。", 5000)
        elif self._clear_saved_cookie_after_connect:
            self.settings.remove("saved_cookie")
            self.status.showMessage("账户已连接；Cookie 仅本次使用，已清除本机保存内容。", 5000)
        else:
            self.status.showMessage("账户已连接；Cookie 仅在内存中使用。", 5000)
        self._pending_cookie_text = ""
        self._clear_saved_cookie_after_connect = False
        self._set_connected(True)
        self.refresh_albums()

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
        self.client.upload_files(album_id, files, progress)

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

    def _sync_options(self) -> tuple[Path, SyncDirection, SortField, bool, bool, int]:
        root = Path(self.local_root.text().strip())
        # QComboBox returns a plain string for str-based Enum values on some
        # PySide6/Windows builds, so restore the Enum explicitly here.
        direction = SyncDirection(str(self.direction_combo.currentData()))
        sort_field = SortField(str(self.sort_combo.currentData()))
        reverse = bool(self.order_combo.currentData())
        return root, direction, sort_field, reverse, self.delete_checkbox.isChecked(), self.worker_spin.value()

    def build_sync_plan(self) -> None:
        if not self.client:
            return
        root, direction, sort_field, reverse, deletion, workers = self._sync_options()
        if not root.is_dir():
            QMessageBox.warning(self, "本地目录无效", "请选择一个有效的同步根目录。")
            return
        self.settings.setValue("local_root", str(root))
        self.settings.setValue("file_client_workers", workers)
        list_threads = self.list_threads_spin.value()
        self.settings.setValue("list_threads", list_threads)
        skip_oversize = bool(self.settings.value("skip_oversize", True, type=bool))
        LOGGER.debug("生成同步计划：方向=%s，排序=%s，逆序=%s，文件客户端并发=%s，读取线程=%s，忽略=%s，跳过超限=%s", direction.value, sort_field.value, reverse, workers, list_threads, sorted(self.ignored_album_names), skip_oversize)
        self._run_job(
            "正在比较本地与云端",
            lambda progress: SyncEngine(self.client, max_workers=workers, list_threads=list_threads).build_plan(
                root, direction, sort_field, reverse, deletion, progress, self.ignored_album_names, skip_oversize
            ),
            self._sync_plan_ready,
        )

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
        root, _, _, _, _, workers = self._sync_options()
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
        LOGGER.debug("执行同步计划：操作数=%s，主控制器文件客户端并发=%s，读取线程=%s", len(executable), workers, list_threads)

        thread = QThread(self)
        worker = SyncWorker(
            lambda progress, action_status, alert: SyncEngine(self.client, max_workers=workers, list_threads=list_threads).execute_plan(
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
    app.setApplicationName(APP_NAME)
    app.setOrganizationName("Manus")
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
