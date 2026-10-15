param([ValidateSet('serve','recover')][string]$Mode='serve',[Parameter(Mandatory=$true)][string]$JobName)
$ErrorActionPreference='Stop'
[Console]::InputEncoding=New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding=New-Object System.Text.UTF8Encoding($false)
if ($JobName -notmatch '^Local\\KMMCompat-[a-f0-9-]{36}$') { throw 'Invalid SDK job name' }
# A kernel job owns only processes created suspended and assigned before resuming.
# Closing the last handle (including EOF after an SDK crash) kills that job tree.
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Diagnostics;
using System.ComponentModel;
using System.Runtime.InteropServices;
public static class KmmJob {
 [StructLayout(LayoutKind.Sequential)] struct Basic { public long a,b; public uint flags; public UIntPtr min,max; public uint count; public UIntPtr affinity; public uint priority,scheduling; }
 [StructLayout(LayoutKind.Sequential)] struct IO { public ulong a,b,c,d,e,f; }
 [StructLayout(LayoutKind.Sequential)] struct Extended { public Basic basic; public IO io; public UIntPtr a,b,c,d; }
 [StructLayout(LayoutKind.Sequential,CharSet=CharSet.Unicode)] struct Startup { public int cb; public string reserved,desktop,title; public uint x,y,cx,cy,xc,yc,fill,flags; public short show,cb2; public IntPtr reserved2,input,output,error; }
 [StructLayout(LayoutKind.Sequential)] struct Info { public IntPtr process,thread; public uint pid,tid; }
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr a,string name);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern IntPtr OpenJobObject(uint access,bool inherit,string name);
 [DllImport("kernel32",SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job,int cls,ref Extended info,uint size);
 [DllImport("kernel32",SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job,int cls,IntPtr info,uint size,IntPtr length);
 [DllImport("kernel32",SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job,IntPtr process);
 [DllImport("kernel32",SetLastError=true)] static extern bool IsProcessInJob(IntPtr process,IntPtr job,out bool result);
 [DllImport("kernel32",SetLastError=true)] static extern bool TerminateJobObject(IntPtr job,uint code);
 [DllImport("kernel32",SetLastError=true)] static extern bool TerminateProcess(IntPtr process,uint code);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateProcess(string app,StringBuilder command,IntPtr pa,IntPtr ta,bool inherit,uint flags,IntPtr env,string cwd,ref Startup si,out Info pi);
 [DllImport("kernel32",SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
 [DllImport("kernel32",SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
 [DllImport("kernel32",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder name,ref int length);
 [DllImport("kernel32")] static extern bool CloseHandle(IntPtr handle);
 static void Check(bool ok) { if(!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
 public static IntPtr Create(string name) {
  var h=CreateJobObject(IntPtr.Zero,name); int error=Marshal.GetLastWin32Error();
  if(h==IntPtr.Zero) throw new Win32Exception(error);
  if(error==183) { CloseHandle(h); throw new Exception("Job already exists; refusing adoption"); }
  var limits=new Extended(); limits.basic.flags=0x2000;
  try { Check(SetInformationJobObject(h,9,ref limits,(uint)Marshal.SizeOf(limits))); return h; } catch { CloseHandle(h); throw; }
 }
 static string Quote(string s) { var b=new StringBuilder("\""); int slashes=0; foreach(char c in s) { if(c=='\\') { slashes++; continue; } b.Append('\\',c=='"'?slashes*2+1:slashes); slashes=0; b.Append(c); } b.Append('\\',slashes*2); return b.Append('"').ToString(); }
 public static uint Start(IntPtr job,string exe,string[] args,string cwd) {
  var command=new StringBuilder(Quote(exe)); foreach(var a in args) command.Append(" "+Quote(a));
  var si=new Startup(); si.cb=Marshal.SizeOf(si); Info pi;
  Check(CreateProcess(exe,command,IntPtr.Zero,IntPtr.Zero,false,4,IntPtr.Zero,cwd,ref si,out pi));
  try { if(!AssignProcessToJobObject(job,pi.process)) { int e=Marshal.GetLastWin32Error(); TerminateProcess(pi.process,74); throw new Win32Exception(e); } if(ResumeThread(pi.thread)==0xffffffff) { TerminateJobObject(job,74); throw new Win32Exception(); } return pi.pid; }
  finally { CloseHandle(pi.thread); CloseHandle(pi.process); }
 }
 public static uint[] Pids(IntPtr job) {
  IntPtr b=Marshal.AllocHGlobal(8192);
  try { Check(QueryInformationJobObject(job,3,b,8192,IntPtr.Zero)); int count=Marshal.ReadInt32(b,4); if(count<0||count>512) throw new Exception("Job exceeds process budget"); var result=new uint[count]; for(int i=0;i<count;i++) result[i]=(uint)(IntPtr.Size==8?Marshal.ReadInt64(b,8+i*8):Marshal.ReadInt32(b,8+i*4)); return result; } finally { Marshal.FreeHGlobal(b); }
 }
 public static string Image(uint pid) { var h=OpenProcess(0x1000,false,pid); if(h==IntPtr.Zero) throw new Win32Exception(); try { var b=new StringBuilder(32768); int n=b.Capacity; Check(QueryFullProcessImageName(h,0,b,ref n)); return b.ToString(); } finally { CloseHandle(h); } }
 public static void Crash(IntPtr job,uint pid) { var h=OpenProcess(0x1001,false,pid); if(h==IntPtr.Zero) throw new Win32Exception(); try { bool owned; Check(IsProcessInJob(h,job,out owned)); if(!owned) throw new Exception("Process is not owned"); Check(TerminateProcess(h,73)); } finally { CloseHandle(h); } }
 public static void Stop(IntPtr job) { Check(TerminateJobObject(job,0)); }
 public static void Close(IntPtr job) { CloseHandle(job); }
 public static bool Recover(string name) { var h=OpenJobObject(0x000c,false,name); if(h==IntPtr.Zero) { int e=Marshal.GetLastWin32Error(); if(e==2) return true; throw new Win32Exception(e); } try { Stop(h); for(int i=0;i<100;i++) { if(Pids(h).Length==0) return true; System.Threading.Thread.Sleep(50); } return false; } finally { CloseHandle(h); } }
}
'@
function Reply($value) { [Console]::Out.WriteLine(($value | ConvertTo-Json -Compress -Depth 8)); [Console]::Out.Flush() }
if ($Mode -eq 'recover') { Reply @{ok=$true;complete=[KmmJob]::Recover($JobName)}; exit }
$job=[KmmJob]::Create($JobName)
try {
 Reply @{ok=$true;ready=$true}
 while ($null -ne ($line=[Console]::In.ReadLine())) {
  try {
   $request=$line | ConvertFrom-Json
   switch ($request.action) {
    'start' { $pidValue=[KmmJob]::Start($job,$request.executable,[string[]]$request.args,$request.cwd); Reply @{ok=$true;pid=$pidValue} }
    'status' { $items=@(); foreach($id in [KmmJob]::Pids($job)) { try { $items+=@{pid=$id;executable=[KmmJob]::Image($id)} } catch { if ([KmmJob]::Pids($job) -contains $id) { throw } } }; Reply @{ok=$true;processes=@($items)} }
    'existing' { $items=@(); foreach($p in [Diagnostics.Process]::GetProcessesByName([IO.Path]::GetFileNameWithoutExtension($request.executable))) { try { $items+=@{pid=$p.Id;executable=[KmmJob]::Image($p.Id)} } catch { if(-not $p.HasExited){throw} } finally { $p.Dispose() } }; Reply @{ok=$true;processes=@($items)} }
    'crash' { [KmmJob]::Crash($job,[uint32]$request.pid); Reply @{ok=$true} }
    'stop' { [KmmJob]::Stop($job); Reply @{ok=$true} }
    default { throw 'Unknown process operation' }
   }
  } catch { Reply @{ok=$false;error=$_.Exception.Message} }
 }
} finally { [KmmJob]::Stop($job); [KmmJob]::Close($job) }
