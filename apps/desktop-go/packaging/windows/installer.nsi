; Nomi Windows 安装器（Go + Wails 版）。语义对齐 electron-builder 的 oneClick NSIS（electron-builder.yml：nsis 默认值）：
; - 按用户安装（无 UAC），目录 %LOCALAPPDATA%\Programs\@nomi-aielectron（同 2.0.4），无向导页，装完自动启动；
; - 卸载项 HKCU\...\Uninstall\APP_GUID（不带花括号，同 2.0.4；GUID = uuidv5(appId, electron-builder 命名空间)，与 2.0.4 同一项 → 覆盖升级）；
; - 桌面 + 开始菜单快捷方式 Nomi.lnk；nomi:// 协议（2.0.4 安装器实际未注册，Go 版补上，见 D-B11-4）；卸载不删用户数据；
; - 发现旧安装（含 Electron 2.0.4）先静默跑旧卸载器（与 electron-builder 升级时一致，/KEEP_APP_DATA --updated）。
; 由 package.sh 调用：makensis -INPUTCHARSET UTF8 -DVERSION=… -DSTAGE=… -DOUTFILE=… installer.nsi
Unicode true
ManifestDPIAware true
; comctl32 v6：进度条走动画（marquee）需要
XPStyle on
RequestExecutionLevel user
SetCompressor /SOLID lzma

!define APP_ID "com.cookieboty.nomi"
!define APP_GUID "b397f92d-158f-5b6d-b066-7aee5a5f3bb7"
!define PRODUCT "Nomi"
!define EXE "Nomi.exe"
!define UNINST "Uninstall Nomi.exe"
!define PUBLISHER "Cookieboty"
!define UNKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP_GUID}"

Name "${PRODUCT}"
OutFile "${OUTFILE}"
; electron-builder 用 package.json name（@nomi-ai/electron → "@nomi-aielectron"）作目录名，CI 实装 2.0.4 核对过
InstallDir "$LOCALAPPDATA\Programs\@nomi-aielectron"
Icon "${STAGE}\icon.ico"
UninstallIcon "${STAGE}\icon.ico"
ShowInstDetails nevershow
ShowUninstDetails nevershow
AutoCloseWindow true
BrandingText "${PRODUCT} ${VERSION}"
VIProductVersion "${VERSION}.0"
VIAddVersionKey "ProductName" "${PRODUCT}"
VIAddVersionKey "CompanyName" "${PUBLISHER}"
VIAddVersionKey "FileDescription" "${PRODUCT} ${VERSION} Setup"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "Copyright © 2026 ${PUBLISHER}"

!include "LogicLib.nsh"
!include "FileFunc.nsh"

Page instfiles
UninstPage instfiles

; 界面语言跟随系统（第一个是缺省）：内置的「正在安装」「完成」等也随之切换
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"
LangString StClosing ${LANG_ENGLISH} "Closing the running ${PRODUCT}..."
LangString StClosing ${LANG_SIMPCHINESE} "正在关闭运行中的 ${PRODUCT}…"
LangString StRemoveOld ${LANG_ENGLISH} "Removing the previous version..."
LangString StRemoveOld ${LANG_SIMPCHINESE} "正在移除旧版本…"
LangString StWebView2 ${LANG_ENGLISH} "Installing the WebView2 runtime (downloads from Microsoft, this may take a few minutes)..."
LangString StWebView2 ${LANG_SIMPCHINESE} "正在安装 WebView2 运行时（需从微软下载，可能需要几分钟）…"
LangString StShortcuts ${LANG_ENGLISH} "Creating shortcuts..."
LangString StShortcuts ${LANG_SIMPCHINESE} "正在创建快捷方式…"
LangString StUninstalling ${LANG_ENGLISH} "Removing ${PRODUCT}..."
LangString StUninstalling ${LANG_SIMPCHINESE} "正在移除 ${PRODUCT}…"

; 旧卸载器、删目录、WebView2 下载都是一条阻塞指令，进度条按指令推进，期间不动看着像卡死：
; 这几段把进度条切成走动画（PBS_MARQUEE / PBM_SETMARQUEE），做完再切回按进度显示。静默安装没有窗口，跳过
!macro ProgressMarquee ON
  ${IfNot} ${Silent}
    FindWindow $R0 "#32770" "" $HWNDPARENT
    GetDlgItem $R0 $R0 1004
    System::Call "user32::GetWindowLong(p R0, i -16) i .R1"
    !if ${ON} == 1
      IntOp $R1 $R1 | 0x08
      System::Call "user32::SetWindowLong(p R0, i -16, i R1)"
      SendMessage $R0 0x40A 1 30
    !else
      SendMessage $R0 0x40A 0 0
      IntOp $R1 $R1 & 0xFFFFFFF7
      System::Call "user32::SetWindowLong(p R0, i -16, i R1)"
    !endif
  ${EndIf}
!macroend

!macro KillApp
  DetailPrint "$(StClosing)"
  ; 与 electron-builder 的 CHECK_APP_RUNNING 一样：只结束当前用户的 Nomi.exe。
  ; taskkill 结束了进程才返回 0（没有匹配的进程是 128）：只在真的结束了进程时等它释放文件
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /T /IM "${EXE}" /FI "USERNAME eq %USERNAME%"`
  Pop $R2
  ${If} $R2 == 0
    Sleep 500
  ${EndIf}
!macroend

; 每一步的耗时写进 %TEMP%\nomi-install.log（排查「安装慢」用；CI 验收会打印出来）
!macro StepLog MSG
  System::Call "kernel32::GetTickCount() i .R9"
  IntOp $R8 $R9 - $R7
  FileWrite $R6 "$R8 ms	${MSG}$\r$\n"
!macroend

Function .onInit
  SetShellVarContext current
  ; 旧安装（2.0.4 Electron 或更早的 Go 版）：沿用其目录，并先静默卸载（保留用户数据）
  ReadRegStr $0 HKCU "Software\${APP_GUID}" "InstallLocation"
  ${If} $0 != ""
    StrCpy $INSTDIR $0
  ${EndIf}
FunctionEnd

Section "Install"
  SetShellVarContext current
  System::Call "kernel32::GetTickCount() i .R7"
  FileOpen $R6 "$TEMP\nomi-install.log" w
  FileWrite $R6 "${PRODUCT} ${VERSION} setup$\r$\n"
  !insertmacro ProgressMarquee 1
  !insertmacro KillApp
  !insertmacro StepLog "close running app"
  DetailPrint "$(StRemoveOld)"
  ; 旧版本是 Electron（2.0.4 及更早）才跑它的卸载器：它清理的东西比本安装器多（自己的注册项、更新缓存）。
  ; 旧版本是 Go 版时它的卸载器做的事（结束进程、删快捷方式 / 注册项 / 安装目录）下面都会重做或覆盖，
  ; 不再把它拷到临时目录再启动一次（新拷出来的未签名 exe 还要被杀软完整扫一遍）
  ReadRegStr $1 HKCU "${UNKEY}" "UninstallString"
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$INSTDIR\${UNINST}"
  ${AndIf} ${FileExists} "$INSTDIR\resources\app.asar"
    CopyFiles /SILENT "$INSTDIR\${UNINST}" "$PLUGINSDIR\old-uninstaller.exe"
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA --updated _?=$INSTDIR' $2
    DetailPrint "old uninstaller exit=$2"
    !insertmacro StepLog "old Electron uninstaller (exit $2)"
  ${EndIf}
  ; 旧文件（Go 版，或卸载器被跳过时的 Electron 残留）：只清本应用目录
  RMDir /r "$INSTDIR"
  !insertmacro StepLog "remove old files"
  !insertmacro ProgressMarquee 0

  ; File 会逐个把「解压：…」写到进度条上方
  SetOutPath "$INSTDIR"
  File "${STAGE}\${EXE}"
  File /r "${STAGE}\resources"
  WriteUninstaller "$INSTDIR\${UNINST}"
  !insertmacro StepLog "extract files"

  ; WebView2 运行时（Win10 旧机器可能缺）：没有则跑随包的 Evergreen bootstrapper（静默，要从微软下载上百 MB）。
  ; 按微软的检测方式查三处，任一处有版本号就算装了，免得误判后每次安装都去下载：
  ; 64 位系统的 HKLM\...\WOW6432Node\...、32 位视图下的 HKLM\SOFTWARE\Microsoft\...（64 位系统上会重定向到同一处，
  ; 32 位系统上就是本体）、按用户安装的 HKCU
  !define WV2_KEY "Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"
  ReadRegStr $3 HKLM "SOFTWARE\WOW6432Node\${WV2_KEY}" "pv"
  ${If} $3 == ""
  ${OrIf} $3 == "0.0.0.0"
    ReadRegStr $3 HKLM "SOFTWARE\${WV2_KEY}" "pv"
  ${EndIf}
  ReadRegStr $4 HKCU "Software\${WV2_KEY}" "pv"
  ; 微软文档：pv 为空或 0.0.0.0 都算没装
  ${If} $3 == "0.0.0.0"
    StrCpy $3 ""
  ${EndIf}
  ${If} $4 == "0.0.0.0"
    StrCpy $4 ""
  ${EndIf}
  FileWrite $R6 "webview2: hklm=$3 hkcu=$4$\r$\n"
  ${If} $3 == ""
  ${AndIf} $4 == ""
    SetOutPath "$PLUGINSDIR"
    File "${STAGE}\MicrosoftEdgeWebview2Setup.exe"
    DetailPrint "$(StWebView2)"
    !insertmacro ProgressMarquee 1
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
    !insertmacro StepLog "install WebView2 runtime"
    !insertmacro ProgressMarquee 0
    SetOutPath "$INSTDIR"
  ${EndIf}

  DetailPrint "$(StShortcuts)"
  CreateShortCut "$DESKTOP\${PRODUCT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0
  CreateShortCut "$SMPROGRAMS\${PRODUCT}.lnk" "$INSTDIR\${EXE}" "" "$INSTDIR\${EXE}" 0

  ; nomi:// —— 与 electron-builder protocols 相同的 HKCU\Software\Classes 注册
  WriteRegStr HKCU "Software\Classes\nomi" "" "URL:Nomi"
  WriteRegStr HKCU "Software\Classes\nomi" "URL Protocol" ""
  WriteRegStr HKCU "Software\Classes\nomi\DefaultIcon" "" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "Software\Classes\nomi\shell\open\command" "" '"$INSTDIR\${EXE}" "%1"'

  WriteRegStr HKCU "Software\${APP_GUID}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "DisplayName" "${PRODUCT} ${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${UNKEY}" "DisplayIcon" "$INSTDIR\${EXE},0"
  WriteRegStr HKCU "${UNKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNKEY}" "UninstallString" '"$INSTDIR\${UNINST}" /currentuser'
  WriteRegStr HKCU "${UNKEY}" "QuietUninstallString" '"$INSTDIR\${UNINST}" /currentuser /S'
  WriteRegDWORD HKCU "${UNKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNKEY}" "NoRepair" 1
  ${GetSize} "$INSTDIR" "/S=0K" $5 $6 $7
  IntFmt $5 "0x%08X" $5
  WriteRegDWORD HKCU "${UNKEY}" "EstimatedSize" "$5"
  !insertmacro StepLog "shortcuts + registry"

  ; electron-builder oneClick：交互安装完成后启动应用；静默安装只有带 --force-run 才启动
  ${GetParameters} $8
  ClearErrors
  ${GetOptions} $8 "--force-run" $9
  ${IfNot} ${Silent}
  ${OrIfNot} ${Errors}
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
  !insertmacro StepLog "done"
  FileClose $R6
SectionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro ProgressMarquee 1
  !insertmacro KillApp
  DetailPrint "$(StUninstalling)"
  Delete "$DESKTOP\${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  DeleteRegKey HKCU "Software\Classes\nomi"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\${APP_GUID}"
  ; 用户数据（%APPDATA%\Nomi、%APPDATA%\@nomi-ai\electron）不删：electron-builder deleteAppDataOnUninstall 默认 false
  RMDir /r "$INSTDIR"
SectionEnd
