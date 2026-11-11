---
'@nomi-ai/desktop-go': patch
---

fix(updates): 自动更新装好并重新打开后，清掉缓存里已经用过的安装包（dmg、zip、exe、AppImage、deb）和没下完的半截文件；还没安装的更新版本会留着。不删正在使用的程序、下载文件夹里的文件和用户数据。 / After an update is installed and Nomi opens again, obsolete installer packages in the update cache (dmg, zip, exe, AppImage, deb) and unfinished downloads are removed. A newer package that has not been installed yet is kept. The running app, files in your Downloads folder, and your data are left alone.
