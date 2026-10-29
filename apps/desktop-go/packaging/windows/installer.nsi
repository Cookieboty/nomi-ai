; Nomi Windows 安装器（Go + Wails 版）。语义对齐 electron-builder 的 oneClick NSIS（electron-builder.yml：nsis 默认值）：
; - 按用户安装（无 UAC），目录 %LOCALAPPDATA%\Programs\@nomi-aielectron（同 2.0.4），无向导页，装完自动启动；
; - 卸载项 HKCU\...\Uninstall\APP_GUID（不带花括号，同 2.0.4；GUID = uuidv5(appId, electron-builder 命名空间)，与 2.0.4 同一项 → 覆盖升级）；
; - 桌面 + 开始菜单快捷方式 Nomi.lnk；nomi:// 协议（2.0.4 安装器实际未注册，Go 版补上，见 D-B11-4）；卸载不删用户数据；
; - 发现旧安装（含 Electron 2.0.4）先静默跑旧卸载器（与 electron-builder 升级时一致，/KEEP_APP_DATA --updated）。
; 由 package.sh 调用：makensis -DVERSION=… -DSTAGE=… -DOUTFILE=… installer.nsi
Unicode true
ManifestDPIAware true
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

!macro KillApp
  ; 与 electron-builder 的 CHECK_APP_RUNNING 一样：只结束当前用户的 Nomi.exe
  nsExec::Exec `"$SYSDIR\cmd.exe" /c taskkill /F /T /IM "${EXE}" /FI "USERNAME eq %USERNAME%"`
  Sleep 500
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
  !insertmacro KillApp
  ReadRegStr $1 HKCU "${UNKEY}" "UninstallString"
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$INSTDIR\${UNINST}"
    CopyFiles /SILENT "$INSTDIR\${UNINST}" "$PLUGINSDIR\old-uninstaller.exe"
    ExecWait '"$PLUGINSDIR\old-uninstaller.exe" /S /KEEP_APP_DATA --updated _?=$INSTDIR' $2
    DetailPrint "old uninstaller exit=$2"
  ${EndIf}
  ; 旧 Electron 文件可能残留（卸载器被跳过时）：只清本应用目录
  RMDir /r "$INSTDIR"

  SetOutPath "$INSTDIR"
  File "${STAGE}\${EXE}"
  File /r "${STAGE}\resources"
  WriteUninstaller "$INSTDIR\${UNINST}"

  ; WebView2 运行时（Win10 旧机器可能缺）：没有则跑随包的 Evergreen bootstrapper（静默）
  ReadRegStr $3 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ReadRegStr $4 HKCU "Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}" "pv"
  ${If} $3 == ""
  ${AndIf} $4 == ""
    SetOutPath "$PLUGINSDIR"
    File "${STAGE}\MicrosoftEdgeWebview2Setup.exe"
    ExecWait '"$PLUGINSDIR\MicrosoftEdgeWebview2Setup.exe" /silent /install'
    SetOutPath "$INSTDIR"
  ${EndIf}

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

  ; electron-builder oneClick：交互安装完成后启动应用；静默安装只有带 --force-run 才启动
  ${GetParameters} $8
  ClearErrors
  ${GetOptions} $8 "--force-run" $9
  ${IfNot} ${Silent}
  ${OrIfNot} ${Errors}
    Exec '"$INSTDIR\${EXE}"'
  ${EndIf}
SectionEnd

Function un.onInit
  SetShellVarContext current
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  !insertmacro KillApp
  Delete "$DESKTOP\${PRODUCT}.lnk"
  Delete "$SMPROGRAMS\${PRODUCT}.lnk"
  DeleteRegKey HKCU "Software\Classes\nomi"
  DeleteRegKey HKCU "${UNKEY}"
  DeleteRegKey HKCU "Software\${APP_GUID}"
  ; 用户数据（%APPDATA%\Nomi、%APPDATA%\@nomi-ai\electron）不删：electron-builder deleteAppDataOnUninstall 默认 false
  RMDir /r "$INSTDIR"
SectionEnd
