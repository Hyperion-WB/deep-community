import React, { useCallback, useEffect, useRef, useState } from 'react';
import { RotateCcw } from 'lucide-react';
import type { MiniGameProps } from './MiniGames';

const BEST_PREFIX = 'wb:404:best:';
const readBest = (g: string) => {
  try { return Number(localStorage.getItem(BEST_PREFIX + g) || '0'); } catch { return 0; }
};
const writeBest = (g: string, s: number) => {
  try { if (s > readBest(g)) localStorage.setItem(BEST_PREFIX + g, String(s)); } catch {}
};

/**
 * 断网奔袭：直接嵌入 Chromium 原版小恐龙（T-Rex Runner）。
 *
 * 页面资源位于 /dino/：
 *   - offline.js       Chromium offline.js 原版（BSD-3-Clause，Copyright 2014 The Chromium Authors）
 *   - index.css        原版样式
 *   - offline-sprite-1x/2x.png  原版精灵图
 *
 * 用 iframe 隔离，避免原版代码里的 document.onkeydown / 全局单例影响站内其它组件；
 * 分数通过 postMessage 回传给父页面做排行榜上报。
 */
export const DinoRun: React.FC<MiniGameProps> = ({ onScore }) => {
  const [score, setScore] = useState(0);
  const [over, setOver] = useState(false);
  const [best, setBest] = useState(() => readBest('dino'));
  const [reloadKey, setReloadKey] = useState(0);
  const reportedRef = useRef(false);
  const frameRef = useRef<HTMLIFrameElement | null>(null);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const data = e.data as { type?: string; score?: number; over?: boolean } | null;
      if (!data || data.type !== 'wb-dino') return;

      const nextScore = Math.max(0, Math.round(data.score || 0));
      setScore(nextScore);
      setOver(!!data.over);

      if (!data.over) {
        // 重开一局后允许再次上报
        reportedRef.current = false;
        return;
      }
      if (!reportedRef.current && nextScore > 0) {
        reportedRef.current = true;
        writeBest('dino', nextScore);
        setBest((b) => Math.max(b, nextScore));
        onScore(nextScore);
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [onScore]);

  const restart = useCallback(() => {
    reportedRef.current = false;
    setScore(0);
    setOver(false);
    setReloadKey((n) => n + 1);
  }, []);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-2xs font-mono">
        <span className="text-wb-text-secondary">距离 <b className="text-wb-text-primary">{score}</b></span>
        <span className="text-wb-text-muted">最高 {Math.max(best, score)}</span>
      </div>

      <div className="rounded-2xl overflow-hidden border border-wb-border-subtle bg-[#f7f7f8]">
        <iframe
          ref={frameRef}
          key={reloadKey}
          src="/dino/index.html"
          title="断网奔袭"
          className="block w-full border-0"
          style={{ height: 208 }}
        />
      </div>

      <p className="text-3xs text-wb-text-muted text-center">
        空格 / ↑ 跳跃（先点一下游戏区获取焦点），手机点屏幕即可
      </p>

      {over && (
        <div className="text-center space-y-2">
          <p className="text-xs font-semibold">撞上了，跑了 {score} 米</p>
          <button
            type="button"
            onClick={restart}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold"
          >
            <RotateCcw className="w-3.5 h-3.5" /> 再来一局
          </button>
        </div>
      )}
    </div>
  );
};
