import React, { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Sun, Moon, Monitor, Type, Palette } from 'lucide-react';
import { FontSettingsModal } from './FontSettingsModal';
import { AppearanceSettingsModal } from './AppearanceSettingsModal';
import {
  PALETTE_CHANGE_EVENT,
  getPaletteMeta,
  getStoredPalette,
  syncMetaThemeColor,
} from '../utils/themePalette';
import { getUiPreferences } from '../utils/appearance';
import { crossFadePageGradient } from '../utils/gradientFade';

export type ThemePreference = 'light' | 'dark' | 'system';

export const ThemeCapsule: React.FC = () => {
  const transitioningRef = React.useRef(false);
  const [theme, setThemeState] = useState<ThemePreference>('system');
  const [isOpen, setIsOpen] = useState(false);
  const [isFontModalOpen, setIsFontModalOpen] = useState(false);
  const [isPaletteModalOpen, setIsPaletteModalOpen] = useState(false);
  const [paletteName, setPaletteName] = useState(() => getPaletteMeta(getStoredPalette()).name);
  const [menuAlign, setMenuAlign] = useState<'center' | 'right'>('center');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen && containerRef.current) {
      const rect = containerRef.current.getBoundingClientRect();
      const isMobile = window.innerWidth < 640;
      // 移动端一律右对齐到触发按钮：按钮本身靠近右侧，右对齐后弹层向左展开，
      // 不会像居中那样顶出屏幕（此前手机上会超出右边界）。
      if (isMobile) {
        // 移动端改为"以视口居中"的 fixed 弹层（见下方 max-sm:fixed 类），
        // 右对齐到触发按钮仍会因按钮靠右而把弹层顶出左边界。
        setMenuAlign('center');
        return;
      }
      const popupHalfWidth = 165;
      if (rect.left + rect.width / 2 + popupHalfWidth > window.innerWidth - 8) {
        setMenuAlign('right');
      } else {
        setMenuAlign('center');
      }
    }
  }, [isOpen]);

  const applyActualTheme = (pref: ThemePreference) => {
    let shouldBeDark = false;
    if (pref === 'system') {
      shouldBeDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    } else {
      shouldBeDark = pref === 'dark';
    }

    crossFadePageGradient(() => {
      if (shouldBeDark) {
        document.documentElement.classList.add('dark');
      } else {
        document.documentElement.classList.remove('dark');
      }
    });

    // 深浅模式切换会改变实际生效的背景色，同步更新浏览器/PWA 主题色
    window.requestAnimationFrame(syncMetaThemeColor);
  };

  useEffect(() => {
    const saved = localStorage.getItem('theme') as ThemePreference | null;
    const initial: ThemePreference = saved === 'light' || saved === 'dark' || saved === 'system' ? saved : 'system';
    setThemeState(initial);
    applyActualTheme(initial);

    // 监听操作系统深浅色变动 (当处于系统跟随模式时)
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleSystemChange = (e: MediaQueryListEvent) => {
      const currentSaved = localStorage.getItem('theme');
      if (!currentSaved || currentSaved === 'system') {
        if (e.matches) {
          document.documentElement.classList.add('dark');
        } else {
          document.documentElement.classList.remove('dark');
        }
      }
    };

    mediaQuery.addEventListener('change', handleSystemChange);
    return () => mediaQuery.removeEventListener('change', handleSystemChange);
  }, []);

  // 订阅配色方案变更（可能来自本面板，也可能来自个人主页设置）
  useEffect(() => {
    const handlePaletteChange = () => {
      setPaletteName(getPaletteMeta(getStoredPalette()).name);
    };
    window.addEventListener(PALETTE_CHANGE_EVENT, handlePaletteChange);
    return () => window.removeEventListener(PALETTE_CHANGE_EVENT, handlePaletteChange);
  }, []);

  // 点击外部自动收起弹窗
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handleToggle = (e: React.MouseEvent, target: ThemePreference) => {
    if (target === theme || transitioningRef.current) return;
    transitioningRef.current = true;
    window.setTimeout(() => { transitioningRef.current = false; }, 480);

    const x = e.clientX || window.innerWidth - 80;
    const y = e.clientY || 40;
    const maxRadius = Math.hypot(
      Math.max(x, window.innerWidth - x),
      Math.max(y, window.innerHeight - y)
    );

    const applyTheme = () => {
      setThemeState(target);
      localStorage.setItem('theme', target);
      applyActualTheme(target);
    };

    const reduceMotion =
      window.matchMedia('(prefers-reduced-motion: reduce)').matches ||
      getUiPreferences().motion !== 'full';
    if (reduceMotion || !document.startViewTransition) {
      document.documentElement.classList.add('theme-transitioning');
      applyTheme();
      setTimeout(() => document.documentElement.classList.remove('theme-transitioning'), 460);
      return;
    }

    // 双向水墨圆心扩散转场
    const transition = document.startViewTransition(applyTheme);
    transition.ready.then(() => {
      document.documentElement.animate(
        {
          clipPath: [
            `circle(0px at ${x}px ${y}px)`,
            `circle(${maxRadius}px at ${x}px ${y}px)`
          ]
        },
        {
          duration: 460,
          easing: 'cubic-bezier(0.32, 0.72, 0, 1)',
          pseudoElement: '::view-transition-new(root)'
        }
      );
    });
  };

  return (
    <div ref={containerRef} className="relative flex-shrink-0">
      {/* 单一紧凑胶囊触发按钮 (类似通知铃铛，彻底释放导航栏横向空间) */}
      <button
        type="button"
        onClick={() => setIsOpen((prev) => !prev)}
        title={`外观主题: ${theme === 'light' ? '浅色模式' : theme === 'dark' ? '深色模式' : '跟随系统'} (点击切换)`}
        className={`wb-pressable flex items-center justify-center w-8 h-8 sm:w-9 sm:h-9 rounded-capsule border transition-colors select-none ${
          isOpen
            ? 'bg-wb-capsule-track border-wb-border-strong text-wb-text-primary'
            : 'bg-wb-bg-subtle border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary'
        }`}
      >
        {theme === 'light' && <Sun className="w-3.5 h-3.5" />}
        {theme === 'dark' && <Moon className="w-3.5 h-3.5" />}
        {theme === 'system' && <Monitor className="w-3.5 h-3.5" />}
      </button>

      {/* 展开的浮动主题选择卡片 (默认水平居中对齐；边缘紧凑时自动靠右防溢出) */}
      <AnimatePresence>
        {isOpen && (
          <motion.div
            initial={{ opacity: 0, scale: 0.94, y: 6, x: menuAlign === 'center' ? '-50%' : 0 }}
            animate={{ opacity: 1, scale: 1, y: 0, x: menuAlign === 'center' ? '-50%' : 0 }}
            exit={{ opacity: 0, scale: 0.94, y: 6, x: menuAlign === 'center' ? '-50%' : 0 }}
            transition={{ duration: 0.16, ease: 'easeOut' }}
            className={`absolute top-full mt-2.5 z-50 p-1 frost border border-wb-border-subtle rounded-capsule shadow-xl flex items-center gap-1 select-none whitespace-nowrap max-sm:fixed max-sm:top-[4.75rem] max-sm:right-auto max-sm:mt-0 max-sm:max-w-[calc(100vw-2rem)] max-w-[calc(100vw-1.5rem)] overflow-x-auto no-scrollbar ${
              menuAlign === 'center' ? 'left-1/2' : 'right-0'
            }`}
          >
            {[
              { key: 'light', label: '浅色', icon: Sun },
              { key: 'dark', label: '深色', icon: Moon },
              { key: 'system', label: '系统', icon: Monitor },
            ].map((item) => {
              const Icon = item.icon;
              const isActive = theme === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={(e) => {
                    handleToggle(e, item.key as ThemePreference);
                    // 保持展开以便体验切换动效，点击页面其他地方自动收回
                  }}
                  className={`relative wb-pressable flex items-center gap-1.5 h-7 px-3 rounded-capsule text-xs font-medium select-none z-10 transition-colors ${
                    isActive ? 'text-wb-bg-page font-semibold' : 'text-wb-text-secondary hover:text-wb-text-primary'
                  }`}
                >
                  {isActive && (
                    <motion.div
                      layoutId="theme-capsule-active-indicator"
                      className="absolute inset-0 bg-wb-text-primary rounded-capsule -z-10 shadow-xs"
                      transition={{ type: 'spring', stiffness: 500, damping: 35 }}
                    />
                  )}
                  <Icon className="w-3.5 h-3.5" />
                  <span>{item.label}</span>
                </button>
              );
            })}

            <div className="w-px h-3.5 bg-wb-border-subtle mx-0.5" />

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setIsPaletteModalOpen(true);
              }}
              title={`个性化设置：配色与界面（当前配色 ${paletteName}）`}
              className="relative wb-pressable flex items-center gap-1.5 h-7 px-2.5 rounded-capsule text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle/80 select-none z-10 transition-colors"
            >
              <Palette className="w-3.5 h-3.5 text-wb-brand" />
              <span className="hidden sm:inline">主题</span>
            </button>

            <button
              type="button"
              onClick={() => {
                setIsOpen(false);
                setIsFontModalOpen(true);
              }}
              title="个性化设置：自定义系统字体"
              className="relative wb-pressable flex items-center gap-1.5 h-7 px-2.5 rounded-capsule text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle/80 select-none z-10 transition-colors"
            >
              <Type className="w-3.5 h-3.5 text-wb-brand" />
              <span className="hidden sm:inline">字体</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      <FontSettingsModal
        isOpen={isFontModalOpen}
        onClose={() => setIsFontModalOpen(false)}
      />

      <AppearanceSettingsModal
        isOpen={isPaletteModalOpen}
        onClose={() => setIsPaletteModalOpen(false)}
      />
    </div>
  );
};
