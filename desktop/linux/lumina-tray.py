#!/usr/bin/env python3
"""
Companion system tray helper for Lumina Photo (自己用的一个相册) on Linux desktops.
Communicates over newline-delimited JSON on stdin/stdout with scripts/start.mjs.
Exits with code 75 when running headless or when no supported GUI tray backend exists.
"""

from __future__ import annotations

import json
import os
import signal
import sys
import threading
from pathlib import Path

EXIT_UNAVAILABLE = 75


def has_display() -> bool:
    return bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))


def resolve_icon_path(cli_icon: str | None) -> str | None:
    candidates = []
    if cli_icon:
        candidates.append(Path(cli_icon))
    script_dir = Path(__file__).resolve().parent
    candidates.append(script_dir.parent / "assets" / "tray-icon.png")
    candidates.append(script_dir.parent / "assets" / "app-icon.png")
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def detect_backend():
    if not has_display():
        return None, {}

    try:
        import gi  # type: ignore

        gi.require_version("Gtk", "3.0")
        from gi.repository import Gdk, GLib, Gtk  # type: ignore

        try:
            gi.require_version("AyatanaAppIndicator3", "0.1")
            from gi.repository import AyatanaAppIndicator3 as Indicator  # type: ignore

            return "ayatana", {
                "Gtk": Gtk,
                "Gdk": Gdk,
                "GLib": GLib,
                "Indicator": Indicator,
            }
        except Exception:
            pass

        try:
            gi.require_version("AppIndicator3", "0.1")
            from gi.repository import AppIndicator3 as Indicator  # type: ignore

            return "appindicator", {
                "Gtk": Gtk,
                "Gdk": Gdk,
                "GLib": GLib,
                "Indicator": Indicator,
            }
        except Exception:
            pass

        if hasattr(Gtk, "StatusIcon"):
            return "gtk_status_icon", {"Gtk": Gtk, "Gdk": Gdk, "GLib": GLib}
    except Exception:
        pass

    for pkg in ("PyQt6", "PyQt5"):
        try:
            qtwidgets = __import__(f"{pkg}.QtWidgets", fromlist=["QApplication", "QSystemTrayIcon", "QMenu"])
            qtgui = __import__(f"{pkg}.QtGui", fromlist=["QIcon", "QAction"])
            qtcore = __import__(f"{pkg}.QtCore", fromlist=["QObject", "QTimer"])
            qaction = getattr(qtgui, "QAction", None) or getattr(qtwidgets, "QAction")
            sig_attr = "pyqtSignal"
            return pkg.lower(), {
                "QApplication": qtwidgets.QApplication,
                "QSystemTrayIcon": qtwidgets.QSystemTrayIcon,
                "QMenu": qtwidgets.QMenu,
                "QIcon": qtgui.QIcon,
                "QAction": qaction,
                "QtCore": qtcore,
                "sig_attr": sig_attr,
            }
        except Exception:
            pass

    return None, {}


class TrayState:
    def __init__(self) -> None:
        self.status = "starting"
        self.port = None
        self.open_url = None
        self.local_url = None
        self.lan_url = None
        self.mdns_url = None
        self.public_url = None
        self.tailscale_url = None
        self.lan_addresses = []
        self.data_dir = None
        self.log_file = None
        self.autostart = False
        self.error = None
        self.copied_feedback = None
        self.quitting = False

    def apply(self, msg: dict) -> str | None:
        msg_type = msg.get("type")
        if msg_type in ("shutdown", "alreadyRunning"):
            return msg_type
        if "status" in msg and msg["status"]:
            self.status = msg["status"]
        if msg.get("port") is not None:
            self.port = msg["port"]
        self.open_url = msg.get("openUrl") or msg.get("url") or self.open_url
        self.local_url = msg.get("localUrl")
        self.lan_url = msg.get("lanUrl")
        self.mdns_url = msg.get("mdnsUrl")
        self.public_url = msg.get("publicUrl")
        self.tailscale_url = msg.get("tailscaleUrl")
        if isinstance(msg.get("lanAddresses"), list):
            self.lan_addresses = msg["lanAddresses"]
        if msg.get("dataDir") is not None:
            self.data_dir = msg.get("dataDir")
        if msg.get("logFile") is not None:
            self.log_file = msg.get("logFile")
        if msg.get("autostart") is not None:
            self.autostart = bool(msg["autostart"])
        self.error = msg.get("error")
        return None

    def status_title(self) -> str:
        if self.quitting:
            return "◐ 自己用的一个相册 · 正在安全关闭..."
        if self.status == "running":
            if self.port:
                return f"● 自己用的一个相册 · 运行中 (端口 {self.port})"
            return "● 自己用的一个相册 · 运行中"
        if self.status == "building":
            return "◐ 正在检查并构建前端资源..."
        if self.status == "restarting":
            return "◐ 正在重启相册服务..."
        if self.status == "error":
            return "▲ 服务启动失败"
        return "◐ 正在启动相册服务..."

    def subtitle(self) -> str | None:
        if self.status == "error" and self.error:
            err = str(self.error).strip()
            return "  原因: " + (err[:65] + "..." if len(err) > 68 else err)
        if self.status == "running" and self.open_url:
            return f"  地址: {self.open_url}"
        return None


def send_action(payload: dict) -> None:
    try:
        sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    except Exception:
        pass


def start_stdin_reader(on_message, on_eof) -> None:
    def reader() -> None:
        try:
            while True:
                line = sys.stdin.readline()
                if line == "":
                    on_eof()
                    return
                text = line.strip()
                if not text:
                    continue
                try:
                    data = json.loads(text)
                    if isinstance(data, dict):
                        on_message(data)
                except Exception:
                    continue
        except Exception:
            on_eof()

    thread = threading.Thread(target=reader, daemon=True)
    thread.start()


def run_gtk_tray(backend_name: str, mods: dict, icon_path: str | None) -> int:
    Gtk = mods["Gtk"]
    Gdk = mods["Gdk"]
    GLib = mods["GLib"]
    Indicator = mods.get("Indicator")

    state = TrayState()
    updating = {"flag": False}
    menu = Gtk.Menu()
    status_icon = None
    indicator = None

    if Indicator is not None:
        icon_name = icon_path or "image-x-generic"
        indicator = Indicator.Indicator.new(
            "lumina-photo",
            icon_name,
            Indicator.IndicatorCategory.APPLICATION_STATUS,
        )
        if icon_path:
            indicator.set_icon_full(icon_path, "自己用的一个相册")
        indicator.set_status(Indicator.IndicatorStatus.ACTIVE)
        indicator.set_menu(menu)
    else:
        if icon_path:
            status_icon = Gtk.StatusIcon.new_from_file(icon_path)
        else:
            status_icon = Gtk.StatusIcon.new_from_icon_name("image-x-generic")
        status_icon.set_visible(True)

    def copy_url(url: str, feedback: str) -> None:
        copied = False
        try:
            clipboard = Gtk.Clipboard.get(Gdk.SELECTION_CLIPBOARD)
            clipboard.set_text(url, -1)
            clipboard.store()
            copied = True
        except Exception:
            copied = False
        if not copied:
            send_action({"action": "copyUrl", "url": url})
        state.copied_feedback = feedback
        rebuild_menu()

        def clear_feedback():
            if state.copied_feedback == feedback:
                state.copied_feedback = None
                rebuild_menu()
            return False

        GLib.timeout_add(2500, clear_feedback)

    def add_disabled(label: str) -> None:
        item = Gtk.MenuItem(label=label)
        item.set_sensitive(False)
        menu.append(item)

    def add_action(label: str, cb, enabled: bool = True) -> None:
        item = Gtk.MenuItem(label=label)
        item.set_sensitive(enabled)
        if enabled:
            item.connect("activate", lambda *_: cb())
        menu.append(item)

    def rebuild_menu() -> None:
        updating["flag"] = True
        try:
            for child in menu.get_children():
                menu.remove(child)

            add_disabled(state.status_title())
            sub = state.subtitle()
            if sub:
                add_disabled(sub)
            if state.copied_feedback:
                add_disabled(f"✓ {state.copied_feedback}")

            menu.append(Gtk.SeparatorMenuItem())

            add_action(
                "打开相册",
                lambda: send_action({"action": "open"}),
                enabled=(state.status == "running" and bool(state.open_url) and not state.quitting),
            )

            if state.local_url:
                local_url = state.local_url
                add_action(
                    f"复制本机地址 ({local_url})",
                    lambda u=local_url: copy_url(u, "已复制本机地址"),
                    enabled=not state.quitting,
                )

            remote_added = False
            if state.public_url:
                remote_added = True
                pub_url = state.public_url
                add_action(
                    f"复制公网地址 ({pub_url})",
                    lambda u=pub_url: copy_url(u, "已复制公网地址"),
                    enabled=not state.quitting,
                )

            if state.lan_url:
                remote_added = True
                lan_url = state.lan_url
                iface = (
                    state.lan_addresses[0].get("interfaceName")
                    if state.lan_addresses
                    else None
                )
                suffix = f" · {iface}" if iface else ""
                add_action(
                    f"复制局域网地址 ({lan_url}{suffix})",
                    lambda u=lan_url: copy_url(u, "已复制局域网地址"),
                    enabled=not state.quitting,
                )
            elif state.mdns_url:
                remote_added = True
                mdns_url = state.mdns_url
                add_action(
                    f"复制局域网域名 ({mdns_url})",
                    lambda u=mdns_url: copy_url(u, "已复制局域网域名"),
                    enabled=not state.quitting,
                )

            if state.tailscale_url:
                remote_added = True
                ts_url = state.tailscale_url
                add_action(
                    f"复制 Tailscale 地址 ({ts_url})",
                    lambda u=ts_url: copy_url(u, "已复制 Tailscale 地址"),
                    enabled=not state.quitting,
                )

            if state.status == "running" and not remote_added:
                add_disabled("  局域网未开放（当前仅限本机访问）")

            menu.append(Gtk.SeparatorMenuItem())

            autostart_item = Gtk.CheckMenuItem(label="开机自动启动")
            autostart_item.set_active(state.autostart)
            autostart_item.set_sensitive(not state.quitting)

            def on_toggle_autostart(*_):
                if updating["flag"]:
                    return
                send_action({"action": "toggleAutostart"})

            autostart_item.connect("toggled", on_toggle_autostart)
            menu.append(autostart_item)

            add_action(
                "打开数据目录",
                lambda: send_action({"action": "openDataDir"}),
                enabled=(not state.quitting and bool(state.data_dir)),
            )
            add_action(
                "查看运行日志",
                lambda: send_action({"action": "openLogs"}),
                enabled=not state.quitting,
            )

            menu.append(Gtk.SeparatorMenuItem())

            def on_restart():
                state.status = "restarting"
                rebuild_menu()
                send_action({"action": "restart"})

            add_action("重启服务", on_restart, enabled=not state.quitting)

            def on_quit():
                if state.quitting:
                    return
                state.quitting = True
                rebuild_menu()
                send_action({"action": "quit"})
                GLib.timeout_add(800, lambda: (Gtk.main_quit(), False)[1])

            add_action("退出相册", on_quit, enabled=not state.quitting)
            menu.show_all()

            if status_icon is not None:
                status_icon.set_tooltip_text(state.status_title())
        finally:
            updating["flag"] = False

    if status_icon is not None:
        def on_popup(_icon, button, activate_time):
            menu.popup(None, None, None, None, button, activate_time)

        status_icon.connect("activate", lambda *_: send_action({"action": "open"}) if state.status == "running" else None)
        status_icon.connect("popup-menu", on_popup)

    def handle_msg(msg: dict):
        ctrl = state.apply(msg)
        if ctrl in ("shutdown", "alreadyRunning"):
            Gtk.main_quit()
            return False
        rebuild_menu()
        return False

    rebuild_menu()
    start_stdin_reader(
        lambda data: GLib.idle_add(handle_msg, data),
        lambda: GLib.idle_add(lambda: (Gtk.main_quit(), False)[1]),
    )

    try:
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGINT, lambda *_: (Gtk.main_quit(), False)[1])
        GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signal.SIGTERM, lambda *_: (Gtk.main_quit(), False)[1])
    except Exception:
        pass

    Gtk.main()
    return 0


def run_qt_tray(_backend_name: str, mods: dict, icon_path: str | None) -> int:
    QApplication = mods["QApplication"]
    QSystemTrayIcon = mods["QSystemTrayIcon"]
    QMenu = mods["QMenu"]
    QIcon = mods["QIcon"]
    QAction = mods["QAction"]
    QtCore = mods["QtCore"]
    sig_factory = getattr(QtCore, mods["sig_attr"])

    app = QApplication(sys.argv[:1])
    app.setQuitOnLastWindowClosed(False)

    if not QSystemTrayIcon.isSystemTrayAvailable():
        return EXIT_UNAVAILABLE

    class Bridge(QtCore.QObject):
        msg_signal = sig_factory(dict)
        eof_signal = sig_factory()

    bridge = Bridge()
    state = TrayState()
    menu = QMenu()
    actions_ref = []

    icon = QIcon(icon_path) if icon_path else QIcon.fromTheme("image-x-generic")
    tray = QSystemTrayIcon(icon)
    tray.setContextMenu(menu)
    tray.show()

    def copy_url(url: str, feedback: str) -> None:
        try:
            cb = app.clipboard()
            if cb is not None:
                cb.setText(url)
            else:
                send_action({"action": "copyUrl", "url": url})
        except Exception:
            send_action({"action": "copyUrl", "url": url})
        state.copied_feedback = feedback
        rebuild_menu()

        def clear_cb():
            if state.copied_feedback == feedback:
                state.copied_feedback = None
                rebuild_menu()

        QtCore.QTimer.singleShot(2500, clear_cb)

    def add_disabled(text: str) -> None:
        act = QAction(text, menu)
        act.setEnabled(False)
        actions_ref.append(act)
        menu.addAction(act)

    def add_action(text: str, cb, enabled: bool = True, checked: bool | None = None) -> None:
        act = QAction(text, menu)
        act.setEnabled(enabled)
        if checked is not None:
            act.setCheckable(True)
            act.setChecked(checked)
        if enabled:
            act.triggered.connect(lambda _=False: cb())
        actions_ref.append(act)
        menu.addAction(act)

    def rebuild_menu() -> None:
        menu.clear()
        actions_ref.clear()

        add_disabled(state.status_title())
        tray.setToolTip(state.status_title())
        sub = state.subtitle()
        if sub:
            add_disabled(sub)
        if state.copied_feedback:
            add_disabled(f"✓ {state.copied_feedback}")

        menu.addSeparator()

        add_action(
            "打开相册",
            lambda: send_action({"action": "open"}),
            enabled=(state.status == "running" and bool(state.open_url) and not state.quitting),
        )

        if state.local_url:
            local_url = state.local_url
            add_action(
                f"复制本机地址 ({local_url})",
                lambda u=local_url: copy_url(u, "已复制本机地址"),
                enabled=not state.quitting,
            )

        remote_added = False
        if state.public_url:
            remote_added = True
            pub_url = state.public_url
            add_action(
                f"复制公网地址 ({pub_url})",
                lambda u=pub_url: copy_url(u, "已复制公网地址"),
                enabled=not state.quitting,
            )

        if state.lan_url:
            remote_added = True
            lan_url = state.lan_url
            iface = (
                state.lan_addresses[0].get("interfaceName")
                if state.lan_addresses
                else None
            )
            suffix = f" · {iface}" if iface else ""
            add_action(
                f"复制局域网地址 ({lan_url}{suffix})",
                lambda u=lan_url: copy_url(u, "已复制局域网地址"),
                enabled=not state.quitting,
            )
        elif state.mdns_url:
            remote_added = True
            mdns_url = state.mdns_url
            add_action(
                f"复制局域网域名 ({mdns_url})",
                lambda u=mdns_url: copy_url(u, "已复制局域网域名"),
                enabled=not state.quitting,
            )

        if state.tailscale_url:
            remote_added = True
            ts_url = state.tailscale_url
            add_action(
                f"复制 Tailscale 地址 ({ts_url})",
                lambda u=ts_url: copy_url(u, "已复制 Tailscale 地址"),
                enabled=not state.quitting,
            )

        if state.status == "running" and not remote_added:
            add_disabled("  局域网未开放（当前仅限本机访问）")

        menu.addSeparator()

        add_action(
            "开机自动启动",
            lambda: send_action({"action": "toggleAutostart"}),
            enabled=not state.quitting,
            checked=state.autostart,
        )
        add_action(
            "打开数据目录",
            lambda: send_action({"action": "openDataDir"}),
            enabled=(not state.quitting and bool(state.data_dir)),
        )
        add_action(
            "查看运行日志",
            lambda: send_action({"action": "openLogs"}),
            enabled=not state.quitting,
        )

        menu.addSeparator()

        def on_restart():
            state.status = "restarting"
            rebuild_menu()
            send_action({"action": "restart"})

        add_action("重启服务", on_restart, enabled=not state.quitting)

        def on_quit():
            if state.quitting:
                return
            state.quitting = True
            rebuild_menu()
            send_action({"action": "quit"})
            QtCore.QTimer.singleShot(800, app.quit)

        add_action("退出相册", on_quit, enabled=not state.quitting)

    def on_msg(msg: dict) -> None:
        ctrl = state.apply(msg)
        if ctrl in ("shutdown", "alreadyRunning"):
            app.quit()
            return
        rebuild_menu()

    bridge.msg_signal.connect(on_msg)
    bridge.eof_signal.connect(app.quit)

    rebuild_menu()
    start_stdin_reader(
        lambda data: bridge.msg_signal.emit(data),
        lambda: bridge.eof_signal.emit(),
    )

    signal.signal(signal.SIGINT, lambda *_: bridge.eof_signal.emit())
    signal.signal(signal.SIGTERM, lambda *_: bridge.eof_signal.emit())

    return app.exec()


def main() -> int:
    check_only = "--check" in sys.argv
    cli_icon = None
    if "--icon" in sys.argv:
        idx = sys.argv.index("--icon")
        if idx + 1 < len(sys.argv):
            cli_icon = sys.argv[idx + 1]

    backend_name, mods = detect_backend()
    if check_only:
        if backend_name is None:
            return EXIT_UNAVAILABLE
        print(backend_name)
        return 0

    if backend_name is None:
        return EXIT_UNAVAILABLE

    icon_path = resolve_icon_path(cli_icon)
    if backend_name in ("ayatana", "appindicator", "gtk_status_icon"):
        return run_gtk_tray(backend_name, mods, icon_path)
    return run_qt_tray(backend_name, mods, icon_path)


if __name__ == "__main__":
    sys.exit(main())
