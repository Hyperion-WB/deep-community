import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Sparkles, TriangleAlert } from 'lucide-react';
import { TEXTURE_PRESETS, type TextureId } from '../utils/appearance';

interface Props {
  value: TextureId;
  onChange: (value: TextureId) => void;
  onBrightConfirm?: () => void;
}

/**
 * 背景质感选择器：胶囊按钮 + 二级菜单（网格预设）
 * 相比原来的横向分段控件，能容纳更多预设，也不会在窄屏被挤压。
 */
export const TexturePicker: React.FC<Props> = ({ value, onChange, onBrightConfirm }) => {
  const [open, setOpen] = useState(false);
  const [pendingBright, setPendingBright] = useState<TextureId | null>(null);
  const [anchor, setAnchor] = useState<{ left: number; top: number } | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const current = TEXTURE_PRESETS.find((item) => item.value === value) || TEXTURE_PRESETS[0];

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      // 面板是 Portal 到 body 的，不在 wrapRef 内，必须单独判断，
      // 否则按下鼠标就会触发"点击外部"把面板关掉，click 永远到不了预设按钮
      const inTrigger = wrapRef.current?.contains(target);
      const inPanel = panelRef.current?.contains(target);
      if (!inTrigger && !inPanel) setOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [open]);

  // 面板通过 Portal 渲染到 body：弹窗内容区有 overflow，内联绝对定位会被裁切
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const el = buttonRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const width = Math.min(352, window.innerWidth - 24);
      const left = Math.max(12, Math.min(rect.right - width, window.innerWidth - width - 12));
      // 手机端交给 CSS 贴底，内联 top/left 会覆盖 max-sm 类，把面板顶出屏幕导致底部选项被裁
      if (window.innerWidth < 640) {
        setIsMobile(true);
        setAnchor({ left: 12, top: 0 });
      } else {
        setIsMobile(false);
        setAnchor({ left, top: rect.bottom + 8 });
      }
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  const handlePick = (item: (typeof TEXTURE_PRESETS)[number]) => {
    if (item.bright) {
      setPendingBright(item.value);
      setOpen(false);
      return;
    }
    onChange(item.value);
    setOpen(false);
  };

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className="wb-pressable inline-flex items-center gap-1.5 h-7 pl-2.5 pr-2 rounded-capsule border border-wb-border-strong bg-wb-bg-subtle text-wb-text-primary hover:border-wb-brand/50 text-xs font-medium transition-colors"
      >
        <span>{current.label}</span>
        {current.bright && <TriangleAlert className="w-3 h-3 text-wb-warn" />}
        <ChevronDown className={`w-3.5 h-3.5 text-wb-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open &&
        anchor &&
        createPortal(
        <div
          ref={panelRef}
          role="listbox"
          style={isMobile ? undefined : { left: anchor.left, top: anchor.top }}
          className="fixed z-[120] w-[22rem] max-w-[calc(100vw-1.5rem)] p-2 rounded-2xl frost border border-wb-border-strong shadow-2xl space-y-1
                     max-sm:inset-x-3 max-sm:bottom-4 max-sm:top-auto max-sm:w-auto
                     max-sm:max-h-[72vh] max-sm:overflow-y-auto max-sm:overscroll-contain
                     max-sm:pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))]"
        >
          <div className="flex items-center justify-between px-1 pb-1">
            <span className="text-2xs font-semibold text-wb-text-muted">背景质感</span>
            <span className="text-3xs text-wb-text-muted">{TEXTURE_PRESETS.length} 种预设</span>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5 max-h-[46vh] overflow-y-auto overscroll-contain max-sm:max-h-none max-sm:overflow-visible">
            {TEXTURE_PRESETS.map((item) => {
              const active = item.value === value;
              return (
                <button
                  key={item.value}
                  type="button"
                  role="option"
                  aria-selected={active}
                  onClick={() => handlePick(item)}
                  className={`text-left p-2 rounded-xl border transition-colors ${
                    active
                      ? 'border-wb-brand/60 bg-wb-brand/12 ring-1 ring-wb-brand/25'
                      : 'border-wb-border-subtle hover:border-wb-border-strong hover:bg-wb-bg-subtle/60'
                  }`}
                >
                  <div className="flex items-center gap-1">
                    <span
                      className={`text-xs font-semibold ${
                        item.bright ? 'text-wb-warn' : 'text-wb-text-primary'
                      }`}
                    >
                      {item.label}
                    </span>
                    {item.bright && (
                      <span className="inline-flex items-center gap-0.5 px-1 py-px rounded text-[10px] font-bold bg-wb-warn/15 text-wb-warn border border-wb-warn/30">
                        <Sparkles className="w-2.5 h-2.5" />
                        特效
                      </span>
                    )}
                  </div>
                  <p className="text-3xs text-wb-text-muted leading-snug mt-0.5 line-clamp-2">
                    {item.desc}
                  </p>
                </button>
              );
            })}
          </div>
        </div>,
        document.body
      )}

      {pendingBright &&
        createPortal(
          <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/60">
            <div
              role="dialog"
              aria-modal="true"
              className="w-full max-w-md rounded-3xl frost-panel border border-wb-border-strong shadow-2xl overflow-hidden"
            >
              <div className="px-6 pt-5 pb-4 border-b border-wb-border-subtle flex items-start gap-3">
                <div className="p-2 rounded-xl bg-wb-warn/15 text-wb-warn border border-wb-warn/25 shrink-0">
                  <TriangleAlert className="w-5 h-5" />
                </div>
                <div className="space-y-1">
                  <h3 className="text-sm font-bold text-wb-text-primary">前方高能：闪光弹模式</h3>
                  <p className="text-2xs text-wb-text-muted">这不是演习，这是真的会很亮。</p>
                </div>
              </div>

              <div className="px-6 py-4 space-y-2.5 text-xs text-wb-text-secondary leading-relaxed">
                <p>
                  打开之后，页面背后会跑起一层 WebGL 流体：色彩一直在缓慢流动，
                  鼠标拖一下还会炸开一簇新的颜色。很好玩，也很容易让人忘记自己在干什么。
                </p>
                <p>使用建议（认真的）：</p>
                <ul className="space-y-1 pl-4 list-disc marker:text-wb-warn/70">
                  <li>白天用最好看，深夜全屏盯着会比较费眼；</li>
                  <li>投屏/开会前记得换回「极光」，不然同事会记恨你；</li>
                  <li>截图分享效果极佳，但别拿它当长时间阅读背景。</li>
                </ul>
                <p className="text-2xs text-wb-warn/90 leading-relaxed">
                  严肃提醒：若你对闪烁或强光敏感，或有光敏性癫痫史，请勿使用此背景。
                  使用中出现眼部不适，请立即切回「极光」或「纯色」。
                </p>
              </div>

              <div className="px-6 pb-5 pt-1 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setPendingBright(null)}
                  className="wb-pressable px-3.5 py-1.5 rounded-capsule border border-wb-border-strong bg-wb-bg-subtle text-wb-text-primary text-xs font-semibold"
                >
                  算了，低调点
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const next = pendingBright;
                    setPendingBright(null);
                    if (next) {
                      onChange(next);
                      onBrightConfirm?.();
                    }
                  }}
                  className="wb-pressable px-3.5 py-1.5 rounded-capsule bg-wb-warn text-white text-xs font-bold"
                >
                  我就要闪
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
};
