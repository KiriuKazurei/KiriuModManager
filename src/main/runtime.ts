import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeStatus } from '../shared/contracts';
export const VC_DOWNLOAD_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
export async function checkRuntime(): Promise<RuntimeStatus> {
  let installed = false;
  if (process.platform === 'win32') {
    for (const key of ['HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64']) {
      try {
        const output = await promisify(execFile)('reg.exe', ['query', key, '/v', 'Installed'], { windowsHide: true, timeout: 10000 });
        if (/Installed\s+REG_DWORD\s+0x1/i.test(output.stdout)) { installed = true; break; }
      } catch { /* Missing registry key or permission: report as unconfirmed rather than ready. */ }
    }
  }
  return { installed, message: installed ? '已检测到 Microsoft Visual C++ x64 运行库。' : '未确认 Microsoft Visual C++ x64 运行库。请下载并运行 Microsoft 官方安装器，完成后重新检查。', downloadUrl: VC_DOWNLOAD_URL };
}
