' Runs "node watcher.js" with no console window. Task Scheduler starts
' node.exe (a console program) in the user's desktop, so without this
' wrapper a window flashes on every run. wscript.exe has no console.
' Usage: wscript.exe run-hidden.vbs "<node.exe>" "<watcher.js>"
Dim sh, cmd, i
Set sh = CreateObject("WScript.Shell")
cmd = ""
For i = 0 To WScript.Arguments.Count - 1
  cmd = cmd & """" & WScript.Arguments(i) & """ "
Next
WScript.Quit sh.Run(Trim(cmd), 0, True)
