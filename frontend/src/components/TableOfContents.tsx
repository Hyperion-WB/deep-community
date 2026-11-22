import React, { useState, useEffect, useRef } from 'react';
import { ListFilter, ChevronRight, Hash, Bookmark } from 'lucide-react';
import { buildTocFromMarkdown, type TocHeading as TocItem } from '../utils/heading';
import { useTocSpy } from '../hooks/useTocSpy';

interface Props {
  contentMd: string;
  defaultOpen?: boolean;
  /** 章节较多时是否自动展开；小屏可传 false，避免一进文章就被长目录顶下去 */
  autoOpen?: boolean;
}

export const TableOfContents: React.FC<Props> = ({
  contentMd,
  defaultOpen = false,
  autoOpen = true,
}) => {
  // 章节足够多时默认展开，否则用户根本不知道有目录可点
  const [isOpen, setIsOpen] = useState(defaultOpen);
  const [autoOpened, setAutoOpened] = useState(false);
  const navRef = useRef<HTMLElement | null>(null);

  // 解析 Markdown 中的二级与三级标题（与正文渲染共用同一套 id 规则）
  const items: TocItem[] = React.useMemo(() => buildTocFromMarkdown(contentMd), [contentMd]);
  const { activeId, scrollTo } = useTocSpy(items);
  // 相对层级：只有 h4/h5 的帖子不应整列缩进成「三级」，
  // 以全文最小标题层级为基准做 0/1/2 级缩进。
  const minLevel = items.length ? Math.min(...items.map((i) => i.level)) : 2;

  useEffect(() => {
    if (autoOpen && !autoOpened && items.length >= 3) {
      setIsOpen(true);
      setAutoOpened(true);
    }
  }, [items.length, autoOpened, autoOpen]);

  // 高亮项始终留在目录可视区内：长文里章节多，导航内部也要跟着滚
  useEffect(() => {
    if (!isOpen || !activeId) return;
    const nav = navRef.current;
    if (!nav) return;
    const el = nav.querySelector<HTMLElement>(`[data-toc-id="${activeId}"]`);
    if (!el) return;
    // 必须用 rect 相对 nav 计算：按钮的 offsetParent 是外层卡片/页面而不是 nav，
    // offsetTop 拿到的是相对整页的绝对位置，赋给 scrollTop 会直接把目录甩到底部。
    const navRect = nav.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const elTop = elRect.top - navRect.top;
    // 高亮项本来就在可视区内就不动，否则正文每滚一屏目录都会轻微跳一下
    if (elTop >= 0 && elTop + elRect.height <= nav.clientHeight) return;
    const top = nav.scrollTop + elTop - nav.clientHeight / 2 + elRect.height / 2;
    nav.scrollTo({ top: Math.max(0, top), behavior: 'smooth' });
  }, [activeId, isOpen]);

  if (items.length < 1) return null;

  return (
    <div className="my-4 p-4 rounded-2xl surface border border-wb-border-subtle shadow-card select-none">
      <div
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between cursor-pointer group"
      >
        <div className="flex items-center gap-2 min-w-0">
          <ListFilter className="w-4 h-4 text-wb-text-primary shrink-0" />
          <span className="text-xs font-bold text-wb-text-primary tracking-wide truncate">
            文章目录
          </span>
          <span className="shrink-0 px-1.5 py-0.2 rounded-capsule bg-wb-bg-subtle text-3xs text-wb-text-muted font-mono border border-wb-border-subtle whitespace-nowrap">
            {items.length} 节
          </span>
        </div>
        <div className="flex items-center gap-1 shrink-0 text-2xs text-wb-text-muted group-hover:text-wb-text-primary transition-colors">
          <span className="hidden xl:inline">{isOpen ? '收起' : '展开'}</span>
          <ChevronRight
            className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
          />
        </div>
      </div>

      {isOpen && (
        <nav
          ref={navRef}
          className="mt-3 pt-3 border-t border-wb-border-subtle space-y-1 text-xs animate-fade-in max-h-64 overflow-y-auto relative thin-scrollbar"
        >
          {items.map((item, idx) => {
            const isActive = activeId === item.id;
            return (
              <button
                key={`${item.id}-${idx}`}
                type="button"
                data-toc-id={item.id}
                onClick={() => scrollTo(item.id, item.text)}
                className={`w-full text-left py-1.5 px-2.5 rounded-xl transition-all flex items-center gap-2 group cursor-pointer ${
                  isActive
                    ? 'bg-wb-text-primary text-wb-bg-page font-semibold shadow-sm'
                    : (item.level - minLevel) >= 1
                    ? 'pl-6 text-wb-text-secondary hover:bg-wb-bg-subtle text-2xs'
                    : 'text-wb-text-primary hover:bg-wb-bg-subtle font-medium'
                }`}
              >
                {isActive ? (
                  <Bookmark className="w-3 h-3 flex-shrink-0 fill-current animate-pulse" />
                ) : (
                  <Hash className="w-3 h-3 text-wb-text-muted group-hover:text-wb-text-primary flex-shrink-0" />
                )}
                <span className="truncate group-hover:underline">{item.text}</span>
              </button>
            );
          })}
        </nav>
      )}
    </div>
  );
};
