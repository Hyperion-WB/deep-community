import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { UI_PREFS_CHANGE_EVENT } from '../utils/appearance';

export interface SegmentItem {
  key: string;
  label: React.ReactNode;
}

interface Props {
  items: SegmentItem[];
  activeKey: string;
  onChange: (key: string) => void;
  id?: string;
  className?: string;
  /** 传入后滑块会跟随鼠标悬停项移动（用于动作型分段按钮） */
  onHoverItem?: (key: string | null) => void;
  /** 悬停模式下不强调选中项文字颜色 */
  emphasizeActive?: boolean;
  /** 尺寸：md 用于页面/导航，sm 用于窄条，xs 用于极窄的胶囊工具条 */
  size?: 'md' | 'sm' | 'xs';
}

/**
 * 胶囊分段控件
 *
 * 滑块用「实测 left/width + x/width 动画」实现，而不是 layoutId 布局投影：
 * 后者在宽度变化时会做缩放补偿，圆角胶囊容易出现上下 1~2px 的跳动；
 * 实测方案高度恒定，只做水平位移与宽度变化，切换永远平稳。
 */
export const SegmentedControl: React.FC<Props> = ({
  items,
  activeKey,
  onChange,
  id = 'segmented',
  className = '',
  onHoverItem,
  emphasizeActive = true,
  size = 'md',
}) => {
  const sizeCls =
    size === 'xs'
      ? { track: 'h-5 p-0', btn: 'h-5 px-1.5 text-3xs', thumb: 'top-0 bottom-0' }
      : size === 'sm'
        ? { track: 'h-6 p-0.5', btn: 'h-5 px-2 text-2xs', thumb: 'top-0.5 bottom-0.5' }
        : { track: 'h-9 p-1', btn: 'h-7 px-3.5 text-xs', thumb: 'top-1 bottom-1' };

  const containerRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Record<string, HTMLButtonElement | null>>({});
  const [thumb, setThumb] = useState<{ x: number; width: number } | null>(null);

  const measure = useCallback(() => {
    const el = itemRefs.current[activeKey];
    if (!el) {
      setThumb(null);
      return;
    }
    const x = el.offsetLeft;
    const width = el.offsetWidth;
    // 防止每帧测量触发无意义重渲染
    setThumb((prev) =>
      prev && Math.abs(prev.x - x) < 0.5 && Math.abs(prev.width - width) < 0.5 ? prev : { x, width }
    );
  }, [activeKey]);

  useLayoutEffect(() => {
    measure();
  }, [measure, items.length]);

  useEffect(() => {
    // 窗口尺寸、字体缩放、字体族加载都会改变控件宽度，需重新实测
    const handle = () => measure();
    window.addEventListener('resize', handle);
    window.addEventListener(UI_PREFS_CHANGE_EVENT, handle);
    if (document.fonts?.ready) {
      document.fonts.ready.then(handle).catch(() => undefined);
    }
    const observer = new ResizeObserver(handle);
    if (containerRef.current) observer.observe(containerRef.current);
    return () => {
      window.removeEventListener('resize', handle);
      window.removeEventListener(UI_PREFS_CHANGE_EVENT, handle);
      observer.disconnect();
    };
  }, [measure]);

  return (
    <div
      ref={containerRef}
      data-segment-id={id}
      onMouseLeave={() => onHoverItem?.(null)}
      className={`relative inline-flex items-center bg-wb-capsule-track border border-wb-border-subtle rounded-capsule select-none flex-shrink-0 max-w-full overflow-y-hidden overflow-x-auto no-scrollbar ${sizeCls.track} ${className}`}
      style={{ overflowY: 'hidden', scrollbarWidth: 'none' }}
    >
      {thumb && (
        <motion.div
          aria-hidden="true"
          className={`absolute left-0 rounded-capsule bg-wb-capsule-thumb shadow-capsule pointer-events-none ${sizeCls.thumb}`}
          initial={false}
          animate={{ x: thumb.x, width: thumb.width }}
          transition={{ type: 'spring', stiffness: 480, damping: 38, mass: 0.9 }}
        />
      )}

      {items.map((item) => {
        const isActive = item.key === activeKey;
        return (
          <button
            key={item.key}
            ref={(el) => {
              itemRefs.current[item.key] = el;
            }}
            type="button"
            role="tab"
            aria-selected={isActive}
            onMouseEnter={() => onHoverItem?.(item.key)}
            onFocus={() => onHoverItem?.(item.key)}
            onClick={() => onChange(item.key)}
            className={`relative z-10 font-medium rounded-capsule transition-colors duration-180 flex items-center justify-center select-none whitespace-nowrap flex-shrink-0 ${sizeCls.btn} ${
              isActive && emphasizeActive
                ? 'text-wb-text-primary font-semibold'
                : 'text-wb-text-secondary hover:text-wb-text-primary'
            }`}
          >
            <span className="inline-flex items-center gap-1.5 whitespace-nowrap">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
};
