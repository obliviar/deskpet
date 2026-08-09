Set WshShell = CreateObject("WScript.Shell")
Set FileSystem = CreateObject("Scripting.FileSystemObject")

ProjectDir = FileSystem.GetParentFolderName(WScript.ScriptFullName)
WshShell.CurrentDirectory = ProjectDir

' API configuration is loaded from the ignored local config.json or the
' in-app API settings screen. Never hard-code secrets in this script.
WshShell.Run "cmd /c ""set PATH=%PATH%;C:\Program Files\nodejs;C:\Users\%USERNAME%\AppData\Roaming\npm && pnpm dev:electron""", 0
