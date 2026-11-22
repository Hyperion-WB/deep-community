import React, { useEffect, useRef, useState } from 'react';
import { UI_PREFS_CHANGE_EVENT, getUiPreferences, type TextureId } from '../utils/appearance';

/**
 * 背景层
 *
 * 1) 慢速动态质感（光晕 / 极光 / 光斑）：纯 CSS transform 动画，走合成线程，
 *    周期 80~110 秒，位移不超过 5%，几乎不占 GPU。
 * 2) 闪光弹：接入 WebGL 流体（public/fluid.js，Pavel Dobryakov MIT，
 *    导出 window.createGX404Fluid），按需懒加载，不进入主包。
 */

type FluidEngine = {
  start: (id: string | number, x: number, y: number) => void;
  move: (id: string | number, x: number, y: number) => void;
  end: (id: string | number) => void;
  resize: () => void;
  setPaused: (value: boolean) => void;
};

declare global {
  interface Window {
    createGX404Fluid?: (canvas: HTMLCanvasElement) => FluidEngine;
  }
}

const DRIFT_TEXTURES: TextureId[] = ['glow', 'aurora', 'bokeh'];

const loadFluidScript = (): Promise<void> =>
  new Promise((resolve, reject) => {
    if (window.createGX404Fluid) {
      resolve();
      return;
    }
    const existing = document.querySelector<HTMLScriptElement>('script[data-fluid-engine]');
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('fluid load failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = '/fluid.js';
    script.async = true;
    script.dataset.fluidEngine = 'true';
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('fluid load failed'));
    document.head.appendChild(script);
  });

export const BackgroundTextureLayer: React.FC = () => {
  const [texture, setTexture] = useState<TextureId>(() => getUiPreferences().texture);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const sync = () => setTexture(getUiPreferences().texture);
    window.addEventListener(UI_PREFS_CHANGE_EVENT, sync);
    return () => window.removeEventListener(UI_PREFS_CHANGE_EVENT, sync);
  }, []);

  useEffect(() => {
    if (texture !== 'flashbang') return;
    const canvas = canvasRef.current;
    if (!canvas) return;

    // 关闭动效 / 系统减弱动效：不启动 WebGL，保留静态底色即可
    const reduceMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      getUiPreferences().motion !== 'full';
    if (reduceMotion) {
      canvas.style.display = 'none';
      return;
    }

    let engine: FluidEngine | null = null;
    let disposed = false;
    const activePointers = new Set<number>();

    const handlePointerDown = (event: PointerEvent) => {
      if (!engine || disposed) return;
      const target = event.target as Element | null;
      // 交互控件不要抢事件，避免影响正常点击
      if (target?.closest?.('a, button, input, textarea, select, [role="button"]')) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      activePointers.add(event.pointerId);
      engine.start(event.pointerId, event.clientX, event.clientY);
    };
    const handlePointerMove = (event: PointerEvent) => {
      if (!engine || !activePointers.has(event.pointerId)) return;
      engine.move(event.pointerId, event.clientX, event.clientY);
    };
    const handlePointerUp = (event: PointerEvent) => {
      activePointers.delete(event.pointerId);
      engine?.end(event.pointerId);
    };
    const handleResize = () => engine?.resize();
    const handleVisibility = () => engine?.setPaused(document.visibilityState === 'hidden');

    loadFluidScript()
      .then(() => {
        if (disposed || !window.createGX404Fluid) return;
        engine = window.createGX404Fluid(canvas);
        // 开场：中部撒几簇颜色，和参考网页一致
        const count = window.innerWidth < 600 ? 3 : 4;
        for (let i = 0; i < count; i += 1) {
          window.setTimeout(() => {
            if (disposed || !engine) return;
            const x = window.innerWidth * (0.2 + (0.6 * (i + Math.random())) / count);
            const y = window.innerHeight * (0.3 + Math.random() * 0.4);
            engine.start(`intro${i}`, x, y);
            engine.end(`intro${i}`);
          }, i * 220);
        }
        window.addEventListener('pointerdown', handlePointerDown, { passive: true });
        window.addEventListener('pointermove', handlePointerMove, { passive: true });
        window.addEventListener('pointerup', handlePointerUp, { passive: true });
        window.addEventListener('pointercancel', handlePointerUp, { passive: true });
        window.addEventListener('resize', handleResize, { passive: true });
        document.addEventListener('visibilitychange', handleVisibility);
      })
      .catch(() => {
        canvas.style.display = 'none';
      });

    return () => {
      disposed = true;
      window.removeEventListener('pointerdown', handlePointerDown);
      window.removeEventListener('pointermove', handlePointerMove);
      window.removeEventListener('pointerup', handlePointerUp);
      window.removeEventListener('pointercancel', handlePointerUp);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('visibilitychange', handleVisibility);
      try {
        engine?.setPaused(true);
      } catch {
        /* ignore */
      }
      activePointers.clear();
    };
  }, [texture]);

  const showDrift = DRIFT_TEXTURES.includes(texture);

  return (
    <>
      {showDrift && <div className="wb-texture-drift" aria-hidden="true" />}
      {texture === 'flashbang' && (
        <canvas ref={canvasRef} className="wb-texture-canvas" aria-hidden="true" />
      )}
    </>
  );
};
