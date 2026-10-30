@echo off
rem 开发态构建并启动 Go 版（Windows）。macOS / Linux 用 run-dev.sh。
rem   run-dev.cmd                  构建前端 + Go，然后启动
rem   set SKIP_FRONTEND=1 ^& run-dev.cmd   只改了 Go 代码时跳过前端构建
rem   set SKIP_BUILD=1 ^& run-dev.cmd      不跑 turbo build，直接复制 renderer / ai-chat 现有的 dist
rem   视图热更新用 pnpm dev:go
rem   run-dev.cmd ^<参数…^>         参数原样传给程序
rem 需要 cgo 用的 gcc（如 MSYS2 mingw-w64）在 PATH 里。
rem 不加 -H windowsgui，保留控制台以便看日志。
setlocal
chcp 65001 >nul
cd /d "%~dp0"

if not exist "%~dp0..\..\node_modules" (
  echo 找不到 node_modules，先在仓库根目录执行 pnpm install 1>&2
  exit /b 1
)

rem 视图 = packages/renderer + ai-chat 的构建产物（frontend\build.mjs）；SKIP_BUILD=1 直接复制现有 dist
if not "%SKIP_FRONTEND%"=="1" (
  if "%SKIP_BUILD%"=="1" (
    node frontend\build.mjs --skip-build || exit /b 1
  ) else (
    node frontend\build.mjs || exit /b 1
  )
)

echo == go build
set CGO_ENABLED=1
go build -o build\bin\nomi.exe . || exit /b 1

echo == run
build\bin\nomi.exe %*
