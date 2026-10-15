import type {Attempt} from './types';

export interface Frame {width: number; height: number; rgba: Uint8Array; scene: string; windowIdentity: string}
export interface Region {x: number; y: number; width: number; height: number}
export interface ReferenceRules {
  scene: string;
  anchor: Region;
  target: Region;
  maxAnchorDelta: number;
  maxRestoredDelta: number;
  minEnabledDelta: number;
  minBrightness: number;
}

// Pure assertions for a future verified window adapter. These do not capture a desktop or approve a baseline.
export function evaluateReferenceFrames(frames: {before: Frame; enabled: Frame; after: Frame}, rules: ReferenceRules, runtime: {controlReady: boolean; fixtureLoaded: boolean | null; evidence: string[]}): Attempt {
  const input = [frames.before, frames.enabled, frames.after];
  const base = frames.before;
  const uncertain = (message: string): Attempt => ({status: 'inconclusive', message, attribution: 'test', evidence: runtime.evidence});
  if (!runtime.controlReady) return uncertain('无 Mod 对照未就绪');
  if (!runtime.evidence.length || runtime.fixtureLoaded === null) return uncertain('缺少独立日志/加载信号或窗口证据');
  if (input.some(f => !Number.isInteger(f.width) || !Number.isInteger(f.height) || f.width < 1 || f.height < 1 || f.width * f.height > 16777216 || f.rgba.length !== f.width * f.height * 4 || f.width !== base.width || f.height !== base.height || f.scene !== rules.scene || !f.windowIdentity || f.windowIdentity !== base.windowIdentity)) return uncertain('帧尺寸、场景或目标窗口身份不一致');
  if ([rules.maxAnchorDelta, rules.maxRestoredDelta, rules.minEnabledDelta, rules.minBrightness].some(n => !Number.isFinite(n) || n < 0 || n > 1) || rules.minEnabledDelta <= rules.maxRestoredDelta) return uncertain('图像阈值无效或未区分变化与恢复');
  const pixels = (region: Region) => {
    if (![region.x, region.y, region.width, region.height].every(Number.isInteger) || region.x < 0 || region.y < 0 || region.width < 1 || region.height < 1 || region.x + region.width > base.width || region.y + region.height > base.height) return null;
    const indices: number[] = [];
    for (let y = region.y; y < region.y + region.height; y++) for (let x = region.x; x < region.x + region.width; x++) indices.push((y * base.width + x) * 4);
    return indices;
  };
  const anchor = pixels(rules.anchor), target = pixels(rules.target);
  if (!anchor || !target) return uncertain('ROI 超出窗口');
  if (target.length > base.width * base.height * 0.9) return uncertain('目标区域不能覆盖近乎整个窗口');
  const targetSet = new Set(target);
  if (anchor.some(p => targetSet.has(p))) return uncertain('场景锚点不得与 Mod 变化区域重叠');
  const difference = (a: Frame, b: Frame, region: number[]) => region.reduce((sum, i) => sum + [0, 1, 2].reduce((s, k) => s + Math.abs(a.rgba[i + k] - b.rgba[i + k]), 0), 0) / (region.length * 3 * 255);
  const brightness = (frame: Frame) => anchor.reduce((s, i) => s + frame.rgba[i] + frame.rgba[i + 1] + frame.rgba[i + 2], 0) / (anchor.length * 3 * 255);
  if (input.some(f => brightness(f) <= rules.minBrightness)) return uncertain('黑帧或场景锚点亮度不足');
  if (difference(base, frames.enabled, anchor) > rules.maxAnchorDelta || difference(base, frames.after, anchor) > rules.maxAnchorDelta) return uncertain('场景锚点变化，不能归因于 Mod');
  const enabledDelta = difference(base, frames.enabled, target), restoredDelta = difference(base, frames.after, target);
  const metrics = `enabledDelta=${enabledDelta.toFixed(6)}, restoredDelta=${restoredDelta.toFixed(6)}`;
  if (!runtime.fixtureLoaded || enabledDelta < rules.minEnabledDelta || restoredDelta > rules.maxRestoredDelta) return {status: 'failed', message: 'A/B/A 断言失败: ' + metrics, attribution: 'fixture', controlPassed: true, evidence: runtime.evidence};
  return {status: 'passed', message: '同窗口/场景锚点、A/B/A 变化和恢复、独立加载信号通过: ' + metrics, evidence: runtime.evidence};
}
