import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { RuntimeStatus } from '../shared/contracts';
export const VC_DOWNLOAD_URL = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
export async function inspectRuntime(signal?:AbortSignal):Promise<{state:'present'|'absent'|'unknown';evidence:string[]}>{
 if(process.platform!=='win32')return {state:'unknown',evidence:['当前平台不支持 Windows 注册表检查。']};
 let absent=0;const evidence:string[]=[];
 for(const key of ['HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64','HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64']){
  signal?.throwIfAborted();try{const output=await promisify(execFile)('reg.exe',['query',key,'/v','Installed'],{windowsHide:true,timeout:10000,signal});if(/Installed\s+REG_DWORD\s+0x1/i.test(output.stdout))return {state:'present',evidence:[key+': Installed=1']};if(/Installed\s+REG_DWORD\s+0x0/i.test(output.stdout)){absent++;evidence.push(key+': Installed=0');}else evidence.push(key+': 返回值无法识别。');}
  catch(error){signal?.throwIfAborted();const e=error as Error&{stderr?:string;code?:number};if(e.code===1&&/unable to find|找不到指定的注册表项|找不到指定的注册表键|找不到指定的注册表值/i.test(e.stderr||'')){absent++;evidence.push(key+': 项或值不存在。');}else evidence.push(key+': 查询失败或权限未知。');}
 }
 return {state:absent===2?'absent':'unknown',evidence};
}
export async function checkRuntime(): Promise<RuntimeStatus> {const result=await inspectRuntime();const installed=result.state==='present';return {installed,message:installed?'已检测到 Microsoft Visual C++ x64 运行库。':result.state==='absent'?'未安装 Microsoft Visual C++ x64 运行库，请运行官方安装器后重新检查。':'未确认 Microsoft Visual C++ x64 运行库，注册表查询结果未知。请核对环境后重新检查。',downloadUrl:VC_DOWNLOAD_URL};}
