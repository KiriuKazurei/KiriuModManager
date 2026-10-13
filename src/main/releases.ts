import { createPublicKey, createHash, verify } from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import { GameId } from '../shared/contracts';
export const SPECTRUM_KEY = 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEYac352uRGKZh6LOwK0fVDW/TpyECEfnRtUp+bP2PJPP63SWOkJ3a/d9pAnPfYezRVJ1hWjZtpRTT8HEAN/b4mWpJvqO43SAEV/1Q6vz9Rk/VvRV3jZ6B/tmqVnIeHKEb';
export const ZZMI_KEY = 'MHYwEAYHKoZIzj0CAQYFK4EEACIDYgAEb11GjbKQS6SmRe8TcIc5VMu5Ob3moo5v2YeD+s53xEe4bVPGcToUNLu3Jgqo0OwWZ4RsNy1nR0HId6pR09HedyEMifxebsyPT3T5PH82QozEXHQlTDySklWUfGItoOdf';
export interface PackageSource { id: string; repo: string; prefix: string; publicKey: string; signatureHeading: string }
export const OFFICIAL_SOURCES: Record<string, PackageSource> = {
  Launcher: { id: 'Launcher', repo: 'SpectrumQT/XXMI-Launcher', prefix: 'XXMI-Launcher-Portable-v', publicKey: SPECTRUM_KEY, signatureHeading: 'Signature Extra' },
  ZZMI: { id: 'ZZMI', repo: 'leotorrez/ZZMI-Package', prefix: 'ZZMI-PACKAGE-v', publicKey: ZZMI_KEY, signatureHeading: 'Signature' },
  EFMI: { id: 'EFMI', repo: 'SpectrumQT/EFMI-Package', prefix: 'EFMI-PACKAGE-v', publicKey: SPECTRUM_KEY, signatureHeading: 'Signature' },
  XXMI: { id: 'XXMI', repo: 'SpectrumQT/XXMI-Libs-Package', prefix: 'XXMI-PACKAGE-v', publicKey: SPECTRUM_KEY, signatureHeading: 'Signature' },
};
export type FetchClient = (url: string, options?: RequestInit) => Promise<Response>;
interface GithubAsset { name: string; browser_download_url: string; size: number; digest?: string }
export interface ReleaseAsset { source: PackageSource; version: string; name: string; url: string; size: number; signature: string; digest?: string; manifestUrl?: string }
export function officialUrl(value: string, repo?: string): void {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(url.hostname)) throw new Error('官方发行地址无效，已停止下载。');
  if (repo && (url.hostname !== 'github.com' || !url.pathname.startsWith(`/${repo}/releases/download/`))) throw new Error('发行资产不属于预期官方仓库。');
}
async function response(client: FetchClient, url: string, timeout = 60000): Promise<Response> {
  officialUrl(url);
  try {
    const result = await client(url, { headers: { 'User-Agent': 'KiriuModsManager', 'Accept': 'application/vnd.github+json' }, signal: AbortSignal.timeout(timeout) });
    if (!result.ok) throw new Error(result.status === 403 || result.status === 429 ? 'GitHub 请求限流，请稍后重试。' : `官方服务器返回 HTTP ${result.status}。`);
    return result;
  } catch (error) { throw new Error(`无法下载官方发行物：${(error as Error).message} 请检查网络后重试。`); }
}
export async function resolveRelease(client: FetchClient, source: PackageSource): Promise<ReleaseAsset> {
  const result = await response(client, `https://api.github.com/repos/${source.repo}/releases/latest`);
  const release = await result.json() as { tag_name: string; body: string; assets: GithubAsset[]; prerelease?: boolean; draft?: boolean };
  const version = /^v?(\d+\.\d+\.\d+)$/.exec(release.tag_name)?.[1];
  if (!version || release.prerelease || release.draft || !Array.isArray(release.assets)) throw new Error('官方稳定发行信息格式不受支持。');
  const name = `${source.prefix}${version}.zip`;
  const asset = release.assets.find(item => item.name === name);
  const pattern = new RegExp(`^## ${source.signatureHeading}\\r?\\n- ([A-Za-z0-9+/=]+)\\r?$`, 'm');
  const signature = pattern.exec(release.body ?? '')?.[1];
  if (!asset || !signature || !Number.isFinite(asset.size) || asset.size <= 0 || asset.size > 512 * 1024 ** 2) throw new Error('官方发行物或签名缺失，已停止部署。');
  officialUrl(asset.browser_download_url, source.repo);
  const manifest = release.assets.find(item => item.name === 'Manifest.json');
  if (manifest) officialUrl(manifest.browser_download_url, source.repo);
  return { source, version, name, url: asset.browser_download_url, size: asset.size, signature, digest: asset.digest, manifestUrl: manifest?.browser_download_url };
}
export function verifySignature(data: Buffer, signature: string, publicKey: string): boolean {
  try { return verify('sha256', data, createPublicKey({ key: Buffer.from(publicKey, 'base64'), format: 'der', type: 'spki' }), Buffer.from(signature, 'base64')); } catch { return false; }
}
export async function downloadAsset(client: FetchClient, asset: ReleaseAsset, target: string, progress: (bytes: number, total: number) => void): Promise<void> {
  const result = await response(client, asset.url, 10 * 60 * 1000);
  if (!result.body) throw new Error('官方下载返回空文件。');
  const stream = createWriteStream(target, { flags: 'wx' });
  const completion = finished(stream); completion.catch(() => {});
  let bytes = 0;
  try {
    for await (const chunk of result.body as unknown as AsyncIterable<Uint8Array>) {
      bytes += chunk.byteLength;
      if (bytes > asset.size || bytes > 512 * 1024 ** 2) throw new Error('下载文件大小超出官方发行声明。');
      if (!stream.write(chunk)) await once(stream, 'drain');
      progress(bytes, asset.size);
    }
    stream.end(); await completion;
    if (bytes !== asset.size) throw new Error('下载文件不完整，请重新部署到空目录。');
    const data = await fs.readFile(target);
    if (asset.digest && asset.digest.startsWith('sha256:') && createHash('sha256').update(data).digest('hex') !== asset.digest.slice(7)) throw new Error('官方发行物 SHA256 校验失败。');
    if (!verifySignature(data, asset.signature, asset.source.publicKey)) throw new Error(`${asset.source.id} 官方签名校验失败，文件未部署。`);
  } catch (error) { stream.destroy(); throw error; }
}
export async function downloadManifest(client: FetchClient, asset: ReleaseAsset): Promise<Buffer | null> {
  if (!asset.manifestUrl) return null;
  const result = await response(client, asset.manifestUrl);
  const data = Buffer.from(await result.arrayBuffer());
  if (data.length > 1024 * 1024) throw new Error('Manifest 大小异常。');
  return data;
}
export function sourcesForGame(game: GameId): PackageSource[] { return [OFFICIAL_SOURCES.Launcher, OFFICIAL_SOURCES[game === 'zzz' ? 'ZZMI' : 'EFMI'], OFFICIAL_SOURCES.XXMI]; }
