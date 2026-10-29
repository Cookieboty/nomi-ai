// 打印所有在屏窗口：pid<TAB>宽<TAB>高<TAB>x<TAB>y（逻辑点）。bench.py 在 mac 上轮询用（swiftc 预编译）
import AppKit
import CoreGraphics
let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as! [[String: Any]]
for w in list {
  let pid = w[kCGWindowOwnerPID as String] as? Int32 ?? 0
  let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
  print("\(pid)\t\(Int(b["Width"] ?? 0))\t\(Int(b["Height"] ?? 0))\t\(Int(b["X"] ?? 0))\t\(Int(b["Y"] ?? 0))")
}
