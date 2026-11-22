import React, { useMemo } from 'react';
import { ListFilter, X, Hash, ChevronRight } from 'lucide-react';
import { Modal } from './Modal';
import { buildTocFromMarkdown } from '../utils/heading';
import { useTocSpy } from '../hooks/useTocSpy';

interface Props {
  open: boolean;
  onClose: () => void;
  contentMd: string;
}

/**
 * 手机端文章目录：独立的底部面板，不再内嵌在正文里。
 *
 * 之前用 <details> 嵌在正文上方，展开会改变正文高度，叠加目录内部的
 * overflow 滚动，在 iOS 上表现为页面错乱/卡住。改成 Modal 面板后
 * 与正文布局完全解耦：点章节 → 关面板 → 滚到标题。
 */
export const MobileTocSheet: React.FC<Props> = ({ open, onClose, contentMd }) => {
  const items = useMemo(() => buildTocFromMarkdown(contentMd || ''), [contentMd]);
  const { scrollTo } = useTocSpy(items);

  const pick = (id: string) => {
    onClose();
    // 等关闭动画与滚动锁释放后再滚，避免被面板遮罩影响
    window.setTimeout(() => scrollTo(id), 380);
  };

  return (
    <Modal open={open} onClose={onClose} widthClass="max-w-md" labelledBy="mobile-toc-title">
      <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl flex flex-col max-h-[72vh]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-wb-border-subtle shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <ListFilter className="w-4 h-4 text-wb-text-primary shrink-0" />
            <h3 id="mobile-toc-title" className="text-sm font-semibold text-wb-text-primary">文章目录</h3>
            <span className="shrink-0 px-1.5 py-0.2 rounded-capsule bg-wb-bg-subtle text-3xs text-wb-text-muted font-mono border border-wb-border-subtle">
              {items.length} 节
            </span>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭目录"
            className="p-2 -mr-1 rounded-capsule text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <nav className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2 space-y-0.5">
          {items.length === 0 && (
            <p className="text-2xs text-wb-text-muted py-6 text-center">这篇文章没有小标题</p>
          )}
          {items.map((item, idx) => (
            <button
              key={`${item.id}-${idx}`}
              type="button"
              onClick={() => pick(item.id)}
              className={`w-full min-h-[44px] text-left px-3 py-2 rounded-xl flex items-center gap-2 transition-colors hover:bg-wb-bg-subtle active:bg-wb-bg-subtle ${
                item.level === 3 ? 'pl-7 text-2xs text-wb-text-secondary' : 'text-xs font-medium text-wb-text-primary'
              }`}
            >
              <Hash className="w-3 h-3 shrink-0 text-wb-text-muted" />
              <span className="truncate flex-1">{item.text}</span>
              <ChevronRight className="w-3 h-3 shrink-0 text-wb-text-muted/60" />
            </button>
          ))}
        </nav>

        <div className="px-4 py-2.5 border-t border-wb-border-subtle shrink-0">
          <p className="text-3xs text-wb-text-muted">点击章节会关闭目录并跳到对应位置</p>
        </div>
      </div>
    </Modal>
  );
};
