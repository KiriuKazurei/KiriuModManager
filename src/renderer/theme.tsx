import { useState, type MouseEvent } from 'react';
import { flushSync } from 'react-dom';
import {unwrap} from './ui';

type ThemeName = 'day' | 'night';

const REVEAL_MS = 400;

function preferredTheme(): ThemeName {
  const saved = localStorage.getItem('kmm-theme');
  if (saved === 'day' || saved === 'night') return saved;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'day' : 'night';
}

export function applyStoredTheme() {
  const theme=preferredTheme();document.documentElement.dataset.theme = theme;syncWindowTheme(theme);
}
function syncWindowTheme(theme:ThemeName){if(location.hash!=='#floating')void window.kmm.setWindowTheme(theme).then(unwrap).catch(error=>console.error('标题栏主题同步失败',error));}
function applyTheme(theme:ThemeName){document.documentElement.dataset.theme=theme;localStorage.setItem('kmm-theme',theme);syncWindowTheme(theme);}

export function ThemeControl() {
  const [theme, setTheme] = useState<ThemeName>(preferredTheme);
  const next: ThemeName = theme === 'night' ? 'day' : 'night';
  const commit = () => flushSync(() => { applyTheme(next); setTheme(next); });

  function toggle(event: MouseEvent<HTMLButtonElement>) {
    const root = document.documentElement;
    if (typeof document.startViewTransition !== 'function') { commit(); return; }
    const rect = event.currentTarget.getBoundingClientRect();
    const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
    const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
    root.classList.add('theme-switching');
    const transition = document.startViewTransition(commit);
    transition.ready.then(() => {
      root.animate(reduce
        ? {opacity: [0, 1]}
        : {clipPath: [`circle(0px at ${x}px ${y}px)`, `circle(${radius}px at ${x}px ${y}px)`]},
      {duration: reduce ? 200 : REVEAL_MS, easing: reduce ? 'ease' : 'linear', pseudoElement: '::view-transition-new(root)'});
    }, () => {});
    const settle = () => { if (!root.matches(':active-view-transition')) root.classList.remove('theme-switching'); };
    transition.finished.then(settle, settle);
  }

  return <button type="button" className="theme-toggle" aria-pressed={theme === 'day'} aria-label={next === 'day' ? '切换到日间' : '切换到夜间'} onClick={toggle}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {theme === 'night'
        ? <><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M4.9 4.9l1.4 1.4m11.4 11.4 1.4 1.4M4.9 19.1l1.4-1.4m11.4-11.4 1.4-1.4"/></>
        : <path d="M21 14.5A8.5 8.5 0 1 1 9.5 3 7 7 0 0 0 21 14.5z"/>}
    </svg>
  </button>;
}
