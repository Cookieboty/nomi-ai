#!/usr/bin/env python3
"""最小 org.kde.StatusNotifierWatcher（pip install dbus-next），只给 Linux bench 用。

xvfb 会话里没有托盘宿主时，Go 版走「无托盘 → 启动即打开对话窗」兜底，idle 采样实际是 mascot+对话窗；
跑一个 watcher 让会话像真实桌面一样有托盘，idle 才是 idle（Electron 版同一会话，口径一致）。"""
import asyncio

from dbus_next import PropertyAccess
from dbus_next.aio import MessageBus
from dbus_next.service import ServiceInterface, dbus_property, method, signal

NAME = "org.kde.StatusNotifierWatcher"


class Watcher(ServiceInterface):
    def __init__(self):
        super().__init__(NAME)
        self.items = []

    @method()
    def RegisterStatusNotifierItem(self, service: "s"):  # noqa: F821
        self.items.append(service)
        self.StatusNotifierItemRegistered(service)
        self.emit_properties_changed({"RegisteredStatusNotifierItems": self.items})

    @method()
    def RegisterStatusNotifierHost(self, service: "s"):  # noqa: F821
        pass

    @dbus_property(access=PropertyAccess.READ)
    def RegisteredStatusNotifierItems(self) -> "as":  # noqa: F821
        return self.items

    @dbus_property(access=PropertyAccess.READ)
    def IsStatusNotifierHostRegistered(self) -> "b":  # noqa: F821
        return True

    @dbus_property(access=PropertyAccess.READ)
    def ProtocolVersion(self) -> "i":  # noqa: F821
        return 0

    @signal()
    def StatusNotifierItemRegistered(self, service) -> "s":  # noqa: F821
        return service

    @signal()
    def StatusNotifierHostRegistered(self):
        pass


async def main():
    bus = await MessageBus().connect()
    bus.export("/StatusNotifierWatcher", Watcher())
    await bus.request_name(NAME)
    print("snwatcher: owning", NAME, flush=True)
    await asyncio.Event().wait()


asyncio.run(main())
