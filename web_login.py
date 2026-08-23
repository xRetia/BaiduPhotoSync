"""Ephemeral Qt WebEngine dialogs for Baidu QR login and web logout.

Both dialogs use an off-the-record profile.  They never persist Chromium
cookies: the caller receives an in-memory JSON snapshot only after the user
explicitly confirms a completed QR scan.
"""
from __future__ import annotations

import json
import logging
import time

from PySide6.QtCore import QTimer, QUrl, Qt, Signal
from PySide6.QtGui import QColor, QPainter, QPen
from PySide6.QtNetwork import QNetworkCookie
from PySide6.QtWidgets import QDialog, QFrame, QHBoxLayout, QLabel, QProgressBar, QPushButton, QVBoxLayout, QWidget

try:
    from PySide6.QtWebEngineCore import QWebEngineProfile
    from PySide6.QtWebEngineWidgets import QWebEngineView

    WEBENGINE_AVAILABLE = True
except ImportError:
    QWebEngineProfile = None  # type: ignore[assignment,misc]
    QWebEngineView = None  # type: ignore[assignment,misc]
    WEBENGINE_AVAILABLE = False


LOGGER = logging.getLogger(__name__)

LOGIN_URL = QUrl("https://photo.baidu.com/photo/web/login")
HOME_URL = QUrl("https://photo.baidu.com/")
REQUIRED_LOGIN_COOKIES = {"BAIDUID", "BDUSS"}
# Cookies that Baidu only issues after the phone confirmation completes a real
# photo session (never during the mere "scanned, awaiting confirm" state).
# Gating the candidate on one of these avoids verifying against the provisional
# BDUSS that the QR page sets the moment a code is scanned.
CONFIRMED_LOGIN_COOKIES = {"STOKEN", "PTOKEN", "PANWEB", "PANWEB.sig"}
AUTHENTICATION_COOKIE = "BDUSS"


def _cookie_text(cookie: QNetworkCookie) -> tuple[str, str]:
    return bytes(cookie.name()).decode("utf-8", "replace"), bytes(cookie.value()).decode("utf-8", "replace")


def _is_baidu_domain(cookie: QNetworkCookie) -> bool:
    domain = cookie.domain().lstrip(".").casefold()
    return domain == "baidu.com" or domain.endswith(".baidu.com")


class _RingSpinner(QWidget):
    """A small indeterminate ring spinner drawn with a rotating arc."""

    def __init__(self, parent=None, size: int = 54, color: QColor | None = None):
        super().__init__(parent)
        self._angle = 0
        self._size = size
        self._color = color or QColor("#2577d9")
        self.setFixedSize(size, size)
        self._timer = QTimer(self)
        self._timer.timeout.connect(self._tick)

    def start(self) -> None:
        if not self._timer.isActive():
            self._timer.start(40)

    def stop(self) -> None:
        self._timer.stop()

    def _tick(self) -> None:
        self._angle = (self._angle + 30) % 360
        self.update()

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        pen = QPen(self._color, max(3, self._size // 10))
        pen.setCapStyle(Qt.RoundCap)
        painter.setPen(pen)
        margin = pen.width() + 2
        rect = self.rect().adjusted(margin, margin, -margin, -margin)
        # 300-degree arc keeps a visible gap that rotates, reading as a spinner.
        painter.drawArc(rect, self._angle * 16, 300 * 16)


class _BaiduCookieDialog(QDialog):
    """Common in-memory cookie collection for a temporary Baidu web session."""

    def __init__(self, parent=None):
        super().__init__(parent)
        self._cookies: dict[tuple[str, str, str], QNetworkCookie] = {}
        self._profile = None
        self._view = None

    def _cookie_added(self, cookie: QNetworkCookie) -> None:
        if not _is_baidu_domain(cookie):
            return
        name, _ = _cookie_text(cookie)
        self._cookies[(name, cookie.domain(), cookie.path())] = cookie
        self._after_cookie_change()

    def _cookie_removed(self, cookie: QNetworkCookie) -> None:
        name, _ = _cookie_text(cookie)
        self._cookies.pop((name, cookie.domain(), cookie.path()), None)
        self._after_cookie_change()

    def _after_cookie_change(self) -> None:
        """Subclass hook; intentionally does not accept a dialog by itself."""

    def _has_cookie_names(self, names: set[str]) -> bool:
        available = {key[0] for key in self._cookies}
        return names.issubset(available)

    def _has_any_cookie(self, names: set[str]) -> bool:
        available = {key[0] for key in self._cookies}
        return bool(available & names)

    def cookie_text(self) -> str:
        records = []
        for cookie in self._cookies.values():
            name, value = _cookie_text(cookie)
            records.append({"name": name, "value": value, "domain": cookie.domain() or ".baidu.com"})
        return json.dumps(records, ensure_ascii=False)


class WebLoginDialog(_BaiduCookieDialog):
    """Show Baidu's QR page and keep it visible until remote validation succeeds."""

    # The main window receives a stable in-memory cookie snapshot and validates
    # it in a worker.  This dialog never calls accept() merely because a cookie
    # appeared: QR pages may create provisional/tracking cookies before phone
    # confirmation has granted an actual photo-account session.
    candidate_session = Signal(str)

    def __init__(self, parent=None):
        super().__init__(parent)
        self.setWindowTitle("扫码登录一刻相册")
        self.resize(850, 700)
        self.setMinimumSize(620, 520)
        self._verification_active = False
        self._bduss_seen_at = 0.0
        self._last_attempt_cookie_text = ""
        self._candidate_timer = QTimer(self)
        self._candidate_timer.setSingleShot(True)
        self._candidate_timer.timeout.connect(self._offer_candidate_session)
        self._loading_overlay = None
        layout = QVBoxLayout(self)

        if not WEBENGINE_AVAILABLE:
            layout.addWidget(QLabel("当前安装包缺少二维码登录组件。请使用完整 Windows 安装包。"))
            layout.addStretch(1)
            close_button = QPushButton("关闭")
            close_button.clicked.connect(self.reject)
            layout.addWidget(close_button)
            return

        self._profile = QWebEngineProfile(self)  # no storage name => off-the-record
        self._profile.cookieStore().cookieAdded.connect(self._cookie_added)
        self._profile.cookieStore().cookieRemoved.connect(self._cookie_removed)
        self._view = QWebEngineView(self._profile, self)
        self._view.loadFinished.connect(self._load_finished)
        layout.addWidget(self._view, 1)
        self._create_loading_overlay()

        self.status = QLabel("请使用百度 App 或一刻相册 App 扫描网页中的二维码。完成手机确认后，程序会自动验证登录。")
        self.status.setWordWrap(True)
        self.status.setObjectName("muted")
        layout.addWidget(self.status)

        actions = QHBoxLayout()
        self.reload_button = QPushButton("刷新二维码")
        self.reload_button.clicked.connect(self._reload)
        actions.addWidget(self.reload_button)
        actions.addStretch(1)
        self.cancel_button = QPushButton("取消")
        self.cancel_button.clicked.connect(self.reject)
        actions.addWidget(self.cancel_button)
        layout.addLayout(actions)
        self._view.setUrl(LOGIN_URL)

    def _create_loading_overlay(self) -> None:
        assert self._view is not None
        overlay = QFrame(self._view)
        overlay.setObjectName("loginLoadingOverlay")
        # Paint an opaque background ourselves so the web page is fully hidden.
        overlay.setAutoFillBackground(True)
        overlay.setAttribute(Qt.WA_StyledBackground, True)
        palette = overlay.palette()
        palette.setColor(overlay.backgroundRole(), QColor("#ffffff"))
        overlay.setPalette(palette)
        overlay.hide()
        content = QVBoxLayout(overlay)
        content.setContentsMargins(40, 40, 40, 40)
        content.addStretch(1)
        title = QLabel("正在登录，请稍候")
        title.setObjectName("loginLoadingTitle")
        title.setAlignment(Qt.AlignCenter)
        content.addWidget(title)
        hint = QLabel("正在验证一刻相册访问权限，请勿关闭窗口。")
        hint.setObjectName("loginLoadingHint")
        hint.setAlignment(Qt.AlignCenter)
        content.addWidget(hint)
        spinner = _RingSpinner(overlay)
        content.addWidget(spinner, alignment=Qt.AlignHCenter)
        content.addStretch(1)
        self._spinner = spinner
        self._loading_overlay = overlay

    def _set_loading(self, active: bool) -> None:
        if self._loading_overlay is None or self._view is None:
            return
        if active:
            self._loading_overlay.setGeometry(self._view.rect())
            self._loading_overlay.show()
            self._loading_overlay.raise_()
            self._spinner.start()
        else:
            self._spinner.stop()
            self._loading_overlay.hide()

    def resizeEvent(self, event) -> None:
        super().resizeEvent(event)
        if self._loading_overlay is not None and self._view is not None and self._loading_overlay.isVisible():
            self._loading_overlay.setGeometry(self._view.rect())

    def _load_finished(self, ok: bool) -> None:
        if not ok:
            self.status.setText("登录页面加载失败。请检查网络后点击“刷新二维码”。")
            return
        assert self._profile is not None
        self._profile.cookieStore().loadAllCookies()

    def _after_cookie_change(self) -> None:
        available = {key[0] for key in self._cookies}
        if self._verification_active or not self._has_cookie_names(REQUIRED_LOGIN_COOKIES):
            return
        if "BDUSS" in available and self._bduss_seen_at == 0.0:
            self._bduss_seen_at = time.monotonic()
        if self._has_any_cookie(CONFIRMED_LOGIN_COOKIES):
            # Phone confirmation completed: a real photo session exists.
            self._candidate_timer.start(1200)
            return
        # BDUSS is present but only the provisional scan-state session; wait for
        # the confirmation cookies before verifying. Safety net: a few accounts
        # may not issue these, so still try after a generous grace period.
        LOGGER.debug("BDUSS 已出现但缺少确认态 Cookie，等待手机确认完成")
        if self._bduss_seen_at and (time.monotonic() - self._bduss_seen_at) > 10:
            self._candidate_timer.start(1200)

    def _reload(self) -> None:
        self._cookies.clear()
        self._verification_active = False
        self._bduss_seen_at = 0.0
        self._last_attempt_cookie_text = ""
        self.reload_button.setEnabled(True)
        self._set_loading(False)
        if self._view is not None:
            self._view.setUrl(LOGIN_URL)
        self.status.setText("正在刷新二维码…")

    def _offer_candidate_session(self, force: bool = False) -> None:
        if self._verification_active:
            return
        if not self._has_cookie_names(REQUIRED_LOGIN_COOKIES):
            self.status.setText("尚未检测到完整登录会话。请完成扫码和手机确认后重试。")
            return
        # Emit from the live, signal-driven cookie jar. The cookieAdded signal
        # already captures the final BDUSS set by the phone-confirmation
        # redirect; if a provisional value slips through on the first attempt,
        # the app re-reads this same jar on every retry (see app.py), so the
        # settled session is used shortly after.
        self._emit_candidate(self.cookie_text(), force)

    def _emit_candidate(self, cookie_text: str, force: bool) -> None:
        if self._verification_active:
            return
        if not force and cookie_text == self._last_attempt_cookie_text:
            return
        self._verification_active = True
        self._last_attempt_cookie_text = cookie_text
        self.reload_button.setEnabled(False)
        self._set_loading(True)
        self.status.setText("已检测到扫码会话，正在自动登录与验证…")
        LOGGER.info("扫码候选已提交校验，候选 cookie 名称: %s", sorted({c["name"] for c in json.loads(cookie_text)}))
        self.candidate_session.emit(cookie_text)

    def verification_retrying(self, next_attempt: int, total_attempts: int, wait_seconds: float) -> None:
        self.status.setText(
            f"第 {next_attempt}/{total_attempts} 次自动验证将在 {wait_seconds:.1f} 秒后开始，请稍候…"
        )

    def verification_failed(self, message: str) -> None:
        self._verification_active = False
        self.reload_button.setEnabled(True)
        self._set_loading(False)
        self.status.setText(f"扫码会话验证失败：{message}。二维码仍在当前窗口，可刷新后重新扫码。")

    def verification_succeeded(self) -> None:
        self.status.setText("登录验证成功，正在进入一刻相册…")


class WebLogoutDialog(_BaiduCookieDialog):
    """Keep the user in Baidu's own page until its authentication cookie vanishes."""

    def __init__(self, cookie_text: str, parent=None):
        super().__init__(parent)
        self.setWindowTitle("退出百度账户")
        self.resize(850, 700)
        self.setMinimumSize(620, 520)
        self._initial_session_loaded = False
        self._logout_verified = False
        layout = QVBoxLayout(self)

        if not WEBENGINE_AVAILABLE:
            layout.addWidget(QLabel("当前安装包缺少网页登录组件，无法验证网页退出。"))
            layout.addStretch(1)
            close_button = QPushButton("关闭")
            close_button.clicked.connect(self.reject)
            layout.addWidget(close_button)
            return

        self._profile = QWebEngineProfile(self)
        self._profile.cookieStore().cookieAdded.connect(self._cookie_added)
        self._profile.cookieStore().cookieRemoved.connect(self._cookie_removed)
        self._view = QWebEngineView(self._profile, self)
        self._view.urlChanged.connect(lambda _url: self._check_logout_state())
        layout.addWidget(self._view, 1)
        self.status = QLabel("请在网页右上角账户菜单中点击“退出登录”")
        self.status.setWordWrap(True)
        self.status.setObjectName("logoutInstruction")
        layout.addWidget(self.status)
        hint = QLabel("完成官方退出后，本程序会自动验证网页登录会话是否已失效；请勿直接关闭此窗口。")
        hint.setWordWrap(True)
        hint.setObjectName("muted")
        layout.addWidget(hint)

        actions = QHBoxLayout()
        actions.addStretch(1)
        cancel_button = QPushButton("取消")
        cancel_button.clicked.connect(self.reject)
        actions.addWidget(cancel_button)
        layout.addLayout(actions)

        self._seed_cookies(cookie_text)
        QTimer.singleShot(600, self._open_home_after_cookie_seed)

    def _seed_cookies(self, cookie_text: str) -> None:
        if self._profile is None:
            return
        try:
            records = json.loads(cookie_text)
        except json.JSONDecodeError:
            records = []
        if not isinstance(records, list):
            return
        store = self._profile.cookieStore()
        for item in records:
            if not isinstance(item, dict) or not item.get("name") or not item.get("value"):
                continue
            domain = str(item.get("domain", ".baidu.com"))
            if "baidu.com" not in domain.casefold():
                continue
            cookie = QNetworkCookie(str(item["name"]).encode("utf-8"), str(item["value"]).encode("utf-8"))
            cookie.setDomain(domain if domain.startswith(".") else "." + domain)
            cookie.setPath("/")
            store.setCookie(cookie, HOME_URL)

    def _open_home_after_cookie_seed(self) -> None:
        self._initial_session_loaded = self._has_cookie_names({AUTHENTICATION_COOKIE})
        if not self._initial_session_loaded:
            self.status.setText("无法载入当前网页登录会话；已取消退出操作。")
            return
        if self._view is not None:
            self._view.setUrl(HOME_URL)

    def _after_cookie_change(self) -> None:
        QTimer.singleShot(300, self._check_logout_state)

    def _check_logout_state(self) -> None:
        if not self._initial_session_loaded or self._logout_verified:
            return
        if self._has_cookie_names({AUTHENTICATION_COOKIE}):
            return
        self._logout_verified = True
        self.status.setText("已检测到网页登录会话失效，正在验证退出状态…")
        QTimer.singleShot(300, self.accept)

    def logout_verified(self) -> bool:
        return self._logout_verified
