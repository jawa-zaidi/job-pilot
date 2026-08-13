Option Explicit

' Creates JobPilot shortcuts on the Desktop and in the Start Menu, both
' pointing at JobPilot.bat in the folder above this script.
'
' Double-click this file to run it, or:  cscript //nologo create-shortcuts.vbs
' Pass /quiet to skip the confirmation dialog (JobPilot does this on first run).

Dim fso, sh, args, quietMode, here, root, target, made, i

Set fso = CreateObject("Scripting.FileSystemObject")
Set sh = CreateObject("WScript.Shell")

quietMode = False
Set args = WScript.Arguments
For i = 0 To args.Count - 1
  If LCase(args(i)) = "/quiet" Then quietMode = True
Next

here = fso.GetParentFolderName(WScript.ScriptFullName)
root = fso.GetParentFolderName(here)
target = fso.BuildPath(root, "JobPilot.bat")

If Not fso.FileExists(target) Then
  If Not quietMode Then
    MsgBox "Could not find JobPilot.bat." & vbCrLf & vbCrLf & _
           "Keep this script inside the JobPilot folder's 'install' folder.", _
           16, "JobPilot"
  End If
  WScript.Quit 1
End If

made = ""
If MakeShortcut(sh.SpecialFolders("Desktop"), target, root) Then made = made & vbCrLf & "   - Desktop"
If MakeShortcut(sh.SpecialFolders("Programs"), target, root) Then made = made & vbCrLf & "   - Start Menu"

If Not quietMode Then
  If made = "" Then
    MsgBox "Sorry, the shortcuts could not be created." & vbCrLf & vbCrLf & _
           "You can still start JobPilot by double-clicking JobPilot.bat.", _
           48, "JobPilot"
  Else
    MsgBox "JobPilot shortcuts created:" & made & vbCrLf & vbCrLf & _
           "Double-click JobPilot whenever you want to start it.", _
           64, "JobPilot"
  End If
End If

WScript.Quit 0

Function MakeShortcut(folder, targetPath, workDir)
  Dim lnk, lnkPath
  MakeShortcut = False
  If folder = "" Then Exit Function

  On Error Resume Next
  lnkPath = fso.BuildPath(folder, "JobPilot.lnk")
  Set lnk = sh.CreateShortcut(lnkPath)
  If Err.Number <> 0 Then
    Err.Clear
    On Error GoTo 0
    Exit Function
  End If
  lnk.TargetPath = targetPath
  lnk.WorkingDirectory = workDir
  lnk.WindowStyle = 1
  lnk.Description = "Start JobPilot"
  lnk.Save
  If Err.Number = 0 Then MakeShortcut = True
  Err.Clear
  On Error GoTo 0
End Function
