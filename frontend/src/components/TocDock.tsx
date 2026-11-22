import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ListFilter, X, Hash, Bookmark } from 'lucide-react';
import { buildTocFromMarkdown } from '../utils/heading';
import { useTocSpy } from '../hooks/useTocSpy';

/**
 * 小屏专用：悬浮「目录」入口 + 底部抽屉。
 *
 * 桌面端左侧栏本来就是 sticky，可以边读边点；但在手机/平板上大纲目录会随正文滚走，
 * 文章一长就必须回到顶部才能再次跳转。这里用固定按钮承载目录，读到任何位置都能一点即达。
 */
export const TocDock: React.FC<{ contentMd: string }> = ({ contentMd }) => {
  const items = useMemo(() => buildTocFromMarkdown(contentMd), [contentMd]);
  const [open, setOpen] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);
  const { activeId, scrollTo } = useTocSpy(items);

  // 打开抽屉时把当前章节滚到可视区，长目录也能立刻定位
  useEffect(() => {
    if (!open) return;
    const nav = navRef.current;
    if (!nav || !activeId) return;
    const el = nav.querySelector<HTMLElement>(`[data-toc-id="${activeId}"]`);
    if (!el) return;
    // 与桌面目录同一口径：offsetTop 不是相对 nav 的，必须用 rect 换算
    const navRect = nav.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elTop = elRect.top - navRect.top;
    if (elTop >= 0 && elTop + elRect.height <= nav.clientHeight) return;
    nav.scrollTop = Math.max(
      0,
      nav.scrollTop + elTop - nav.clientHeight / 2 + elRect.height / 2
    );
  }, [open, activeId]);

  // Esc 关闭，符合全站弹层习惯
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  if (items.length < 2) return null;

  const jump = (id: string) => {
    setOpen(false);
    // 等抽屉收起再滚动，避免 fixed 遮罩层影响平滑滚动的视觉落点
    requestAnimationFrame(() => scrollTo(id));
  };

  return (
    <>
      {/* 悬浮入口：移动端底部导航在 bottom-3，返回顶部按钮在右下，这里放左下避免重叠 */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="打开文章目录"
        className="lg:hidden fixed left-4 bottom-24 z-40 h-10 pl-3 pr-3.5 rounded-capsule frost border border-wb-border-strong shadow-card flex items-center gap-1.5 text-2xs font-semibold text-wb-text-secondary active:scale-95 transition-all"
      >
        <ListFilter className="w-3.5 h-3.5" />
        <span>目录</span>
        <span className="font-mono text-3xs text-wb-text-muted">{items.length}</span>
      </button>

      {open &&
        createPortal(
          <div
            className="lg:hidden fixed inset-0 z-[120] flex items-end"
            role="dialog"
            aria-modal="true"
            aria-label="文章目录"
          >
            <div
              className="absolute inset-0 bg-black/50 animate-fade-in"
              onClick={() => setOpen(false)}
            />
            <div className="relative w-full max-h-[72vh] rounded-t-3xl bg-wb-bg-surface border-t border-wb-border-subtle shadow-2xl flex flex-col animate-fade-in">
              <div className="flex items-center justify-between px-4 pt-3 pb-2 border-b border-wb-border-subtle">
                <div className="flex items-center gap-2">
                  <ListFilter className="w-4 h-4 text-wb-text-primary" />
                  <span className="text-xs font-bold text-wb-text-primary">文章导读大纲目录</span>
                  <span className="px-1.5 py-0.2 rounded-capsule bg-wb-bg-subtle text-3xs text-wb-text-muted font-mono border border-wb-border-subtle">
                    {items.length} 章节
                  </span>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="关闭目录"
                  className="p-1.5 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <nav ref={navRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
                {items.map((item, idx) => {
                  const isActive = activeId === item.id;
                  return (
                    <button
                      key={`${item.id}-${idx}`}
                      type="button"
                      data-toc-id={item.id}
                      onClick={() => jump(item.id)}
                      className={`w-full text-left py-2 px-3 rounded-xl transition-all flex items-center gap-2 ${
                        isActive
                          ? 'bg-wb-text-primary text-wb-bg-page font-semibold'
                          : item.level === 3
                          ? 'pl-7 text-wb-text-secondary text-2xs'
                          : 'text-wb-text-primary font-medium text-xs'
                      }`}
                    >
                      {isActive ? (
                        <Bookmark className="w-3 h-3 flex-shrink-0 fill-current" />
                      ) : (
                        <Hash className="w-3 h-3 text-wb-text-muted flex-shrink-0" />
                      )}
                      <span className="truncate">{item.text}</span>
                    </button>
                  );
                })}
              </nav>
              <div className="px-4 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] border-t border-wb-border-subtle text-3xs text-wb-text-muted">
                目录会跟随阅读位置高亮当前章节
              </div>
            </div>
          </div>,
          document.body
        )}
    </>
  );
};
