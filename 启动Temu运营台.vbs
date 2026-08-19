Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")
projectDir = fso.GetParentFolderName(WScript.ScriptFullName)
shell.CurrentDirectory = projectDir
shell.Run "cmd.exe /d /s /c ""npm.cmd run dashboard""", 0, False
WScript.Sleep 1800
shell.Run "http://127.0.0.1:37821", 1, False
