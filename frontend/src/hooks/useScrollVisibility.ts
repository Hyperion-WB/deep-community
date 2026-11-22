import { useEffect, useState } from 'react';

interface Options {
  /** 判定为"在滚动"的最小位移，过滤惯性抖动 */
  threshold?: number;
  /** 距顶多少像素内强制显示 */
  topSafe?: number;
  /** 停止滚动多久后重新显示（毫秒） */
  idleDelay?: number;
}

/**
 * 滚动时隐藏、向上滑或停止滚动时重新显示的通用判定。
 *
 * 之所以要"停止滚动也显示"：纯按方向判断时，用户往下翻到某处停住，
 * 底栏就一直不在，想评论还得先往上拨一下，很别扭。
 *
 * 性能：
 * - 监听 passive
 * - rAF 合并，一帧最多算一次
 * - setState 前先比较，值没变就不触发渲染
 */
export function useScrollVisibility({
  threshold = 24,
  topSafe = 72,
  idleDelay = 600,
}: Options = {}) {
  const [hidden, setHidden] = useState(false);

  useEffect(() => {
    let lastY = window.scrollY;
    let idleTimer: number | null = null;
    let ticking = false;

    const setIfChanged = (next: boolean) => {
      setHidden((prev) => (prev === next ? prev : next));
    };

    const clearIdle = () => {
      if (idleTimer !== null) {
        window.clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    const update = () => {
      ticking = false;
      const y = window.scrollY;
      const dy = y - lastY;

      if (y < topSafe) {
        setIfChanged(false);
        lastY = y;
        return;
      }
      if (Math.abs(dy) < threshold) return;

      lastY = y;
      setIfChanged(dy > 0);

      // 无论朝哪个方向，只要停下来就恢复显示
      clearIdle();
      idleTimer = window.setTimeout(() => setIfChanged(false), idleDelay);
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      clearIdle();
    };
  }, [threshold, topSafe, idleDelay]);

  return hidden;
}
