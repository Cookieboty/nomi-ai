// 用法：swift mac-window.swift id <pid> <宽x高>   → 打印 CGWindowID
//       swift mac-window.swift alpha <png>          → 打印四角 + 中心像素的 alpha（0–255）
import AppKit
import CoreGraphics

let a = CommandLine.arguments
if a[1] == "id" {
  let pid = Int32(a[2])!
  let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
  // 没有屏幕录制权限时 kCGWindowName 为空，所以按窗口尺寸（逻辑点）匹配："WxH"
  let want = a[3].split(separator: "x").map { Double($0)! }
  for w in list where (w[kCGWindowOwnerPID as String] as? Int32) == pid {
    let b = w[kCGWindowBounds as String] as? [String: Double] ?? [:]
    FileHandle.standardError.write("win \(w[kCGWindowNumber as String]!) \(b) name=\(w[kCGWindowName as String] ?? "-")\n".data(using: .utf8)!)
    if b["Width"] == want[0] && b["Height"] == want[1] { print(w[kCGWindowNumber as String]!); exit(0) }
  }
  exit(1)
} else {
  let rep = NSBitmapImageRep(data: try! Data(contentsOf: URL(fileURLWithPath: a[2])))!
  let w = rep.pixelsWide, h = rep.pixelsHigh
  for (x, y) in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3), (w / 2, h / 2)] {
    let c = rep.colorAt(x: x, y: y)!
    print("\(x),\(y) alpha=\(Int(c.alphaComponent * 255)) rgb=\(Int(c.redComponent*255)),\(Int(c.greenComponent*255)),\(Int(c.blueComponent*255))")
  }
}
