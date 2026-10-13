import { useEffect, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent } from 'react';

export const SIDEBAR_DEFAULT = 248;
const SIDEBAR_MIN = 200, SIDEBAR_MAX = 380, SIDEBAR_COLLAPSED = 64, KEY_STEP = 16;
const clamp = (value: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, Math.round(value)));

export function useSidebarLayout() {
  const [width, setWidth] = useState(() => clamp(Number(localStorage.getItem('kmm-sidebar-width')) || SIDEBAR_DEFAULT));
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem('kmm-sidebar-collapsed') === '1');
  useEffect(() => localStorage.setItem('kmm-sidebar-width', String(width)), [width]);
  useEffect(() => localStorage.setItem('kmm-sidebar-collapsed', collapsed ? '1' : '0'), [collapsed]);

  function startResize(event: PointerEvent<HTMLDivElement>) {
    const handle = event.currentTarget, startX = event.clientX, startWidth = width;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('sidebar-resizing');
    const move = (e: globalThis.PointerEvent) => setWidth(clamp(startWidth + e.clientX - startX));
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('sidebar-resizing');
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }
  function resizeByKey(event: KeyboardEvent<HTMLDivElement>) {
    const delta = event.key === 'ArrowLeft' ? -KEY_STEP : event.key === 'ArrowRight' ? KEY_STEP : 0;
    if (!delta) return;
    event.preventDefault();
    setWidth(value => clamp(value + delta));
  }

  return {
    collapsed,
    toggle: () => setCollapsed(value => !value),
    shellStyle: { '--sidebar-width': `${collapsed ? SIDEBAR_COLLAPSED : width}px` } as CSSProperties,
    resizerProps: {
      role: 'separator', 'aria-orientation': 'vertical' as const, 'aria-label': '调整侧边栏宽度',
      'aria-valuemin': SIDEBAR_MIN, 'aria-valuemax': SIDEBAR_MAX, 'aria-valuenow': width, tabIndex: 0,
      onPointerDown: startResize, onKeyDown: resizeByKey, onDoubleClick: () => setWidth(SIDEBAR_DEFAULT),
    },
  };
}
