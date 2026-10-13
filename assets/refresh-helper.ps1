param([Parameter(Mandatory=$true)][string]$ExePathsBase64,[ValidateRange(112,123)][int]$VirtualKey=121)
$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
try {
  $allowedPaths = @(ConvertFrom-Json ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($ExePathsBase64))))
  if ($allowedPaths.Count -ne 1 -or -not [IO.Path]::IsPathRooted($allowedPaths[0])) { throw '目标游戏路径无效。' }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class KmmInput {
 public delegate bool EnumProc(IntPtr window, IntPtr param);
 [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr param);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
 [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr window);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
 [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window,int command);
 [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] input,int size);
 [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT {public ushort vk;public ushort scan;public uint flags;public uint time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT {public int dx;public int dy;public uint data;public uint flags;public uint time;public UIntPtr extra;}
 [StructLayout(LayoutKind.Explicit)] public struct UNION {[FieldOffset(0)]public KEYBDINPUT keyboard;[FieldOffset(0)]public MOUSEINPUT mouse;}
 [StructLayout(LayoutKind.Sequential)] public struct INPUT {public uint type;public UNION value;}
 public static uint Press(ushort key,bool release){INPUT entry=new INPUT();entry.type=1;entry.value.keyboard.vk=key;entry.value.keyboard.flags=release?2u:0u;return SendInput(1,new INPUT[]{entry},Marshal.SizeOf(typeof(INPUT)));}
 public static uint Pid(IntPtr window){uint pid;GetWindowThreadProcessId(window,out pid);return pid;}
 public static IntPtr[] Windows(uint[] processes){var windows=new List<IntPtr>();EnumWindows((window,param)=>{if(IsWindowVisible(window)&&GetWindowTextLength(window)>0&&Array.IndexOf(processes,Pid(window))>=0)windows.Add(window);return true;},IntPtr.Zero);return windows.ToArray();}
}
'@
  $matchingProcesses = @(Get-Process | Where-Object { try { $_.Path -and [string]::Equals([IO.Path]::GetFullPath($_.Path),[IO.Path]::GetFullPath($allowedPaths[0]),[StringComparison]::OrdinalIgnoreCase) } catch { $false } })
  if ($matchingProcesses.Count -eq 0) { throw '未找到所选游戏 EXE 的运行进程；未发送按键。' }
  $targetWindows = @([KmmInput]::Windows([uint32[]]@($matchingProcesses | ForEach-Object { $_.Id })))
  if ($targetWindows.Count -ne 1) { throw '未找到唯一的有效游戏窗口；请关闭重复窗口后手动重试。未发送按键。' }
  $targetWindow=$targetWindows[0];$targetPid=[KmmInput]::Pid($targetWindow)
  [void][KmmInput]::ShowWindow($targetWindow,9)
  [void][KmmInput]::SetForegroundWindow($targetWindow)
  for($attempt=0;$attempt -lt 15 -and [KmmInput]::GetForegroundWindow() -ne $targetWindow;$attempt++){Start-Sleep -Milliseconds 40}
  if([KmmInput]::GetForegroundWindow() -ne $targetWindow -or [KmmInput]::Pid([KmmInput]::GetForegroundWindow()) -ne $targetPid){throw 'Windows 未允许切换到所选游戏前台。请手动切到游戏再重试；未发送按键。'}
  foreach($modifier in @(16,17,18,91,92,$VirtualKey)){if(([KmmInput]::GetAsyncKeyState($modifier) -band 0x8000) -ne 0){throw '请释放 Shift/Ctrl/Alt/Win 与刷新键后重试；未发送按键。'}}
  $pressed=0;$released=0
  try {if([KmmInput]::GetForegroundWindow() -ne $targetWindow){throw '前台目标已变化；未发送按键。'};$pressed=[KmmInput]::Press([uint16]$VirtualKey,$false);if($pressed -ne 1){throw 'SendInput 按下失败，可能是游戏管理员权限较高或输入被阻止。'};Start-Sleep -Milliseconds 150}
  finally {$released=[KmmInput]::Press([uint16]$VirtualKey,$true)}
  if($released -ne 1){throw 'SendInput 释放失败，请手动按下并释放刷新键。'}
  @{ok=$true;pid=$targetPid;key=$VirtualKey;pressed=$pressed;released=$released}|ConvertTo-Json -Compress
} catch { @{ok=$false;error=$_.Exception.Message}|ConvertTo-Json -Compress;exit 1 }
