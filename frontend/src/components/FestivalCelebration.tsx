import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Sparkles, X } from 'lucide-react';

export interface FestivalPayload {
  code: string;
  name: string;
  icon: string;
  wish?: string;
}

const CONFETTI_COLORS = ['#F2B95C', '#E36A6A', '#5BA8A0', '#7C8CF8', '#F08FBF'];

/** 节日勋章庆祝：全屏撒花 + 徽章弹入，仅当天首次进入触发一次。 */
export const FestivalCelebration: React.FC<{ data: FestivalPayload | null; onClose: () => void }> = ({
  data,
  onClose,
}) => {
  useEffect(() => {
    if (!data) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [data, onClose]);

  if (!data) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="节日限定勋章"
      className="fixed inset-0 z-[300] flex items-center justify-center p-6 bg-black/75 backdrop-blur-md"
      onClick={onClose}
    >
      <div className="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
        {Array.from({ length: 32 }).map((_, i) => (
          <span
            key={i}
            className="wb-confetti"
            style={{
              left: `${(i * 37) % 100}%`,
              background: CONFETTI_COLORS[i % CONFETTI_COLORS.length],
              animationDelay: `${(i % 8) * 0.18}s`,
              animationDuration: `${2.6 + (i % 5) * 0.3}s`,
            }}
          />
        ))}
      </div>

      <div
        className="relative text-center space-y-4 max-w-sm w-full rounded-3xl border border-white/15 bg-white/10 px-6 py-8 backdrop-blur-xl shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="absolute right-3 top-3 p-2 rounded-full text-white/70 hover:text-white hover:bg-white/10"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-center justify-center gap-1.5 text-[11px] font-semibold tracking-[0.2em] text-white/70">
          <Sparkles className="w-3.5 h-3.5" />
          今日限定
        </div>

        <div className="text-[76px] leading-none select-none animate-[wb-pop_0.6s_cubic-bezier(0.34,1.56,0.64,1)]">
          {data.icon}
        </div>

        <div className="space-y-1">
          <p className="text-xs text-white/60">获得节日勋章</p>
          <h2 className="text-2xl font-black text-white tracking-tight">{data.name}</h2>
        </div>

        {data.wish && <p className="text-xs text-white/75 leading-relaxed">{data.wish}</p>}

        <p className="text-[11px] text-white/45">仅限今天佩戴，明天自动归还给节日</p>

        <button
          type="button"
          onClick={onClose}
          className="w-full mt-2 py-2.5 min-h-[44px] rounded-xl bg-white text-slate-900 text-sm font-bold hover:bg-white/90 transition-colors"
        >
          收下勋章
        </button>
      </div>
    </div>,
    document.body
  );
};
