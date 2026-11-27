import { ChevronRight, FileText, Pencil } from 'lucide-react';
import type { PostSimple } from '../types';
import { formatEast8Date } from '../utils/format';

interface DailyNewsBarProps {
  post: PostSimple | null;
  onRead: (id: string) => void;
  onWrite?: () => void;
}

export function DailyNewsBar({ post, onRead, onWrite }: DailyNewsBarProps) {
  return (
    <section aria-label="每日早报" className="flex min-w-0 items-center gap-2 rounded-xl border border-wb-brand/20 bg-wb-bg-surface px-2.5 py-1.5 sm:px-3">
      <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-xs font-semibold text-wb-brand">
        <FileText className="hidden h-3.5 w-3.5 sm:block" aria-hidden="true" />
        每日早报
      </span>
      {post ? (
        <button type="button" title={post.title} onClick={() => onRead(post.id)} className="min-w-0 flex-1 truncate text-left text-xs font-semibold text-wb-text-primary hover:underline sm:text-sm">
          {post.title}
        </button>
      ) : (
        <span className="min-w-0 flex-1 truncate text-xs text-wb-text-muted">暂无早报</span>
      )}
      {post?.created_at && (
        <time dateTime={post.created_at} className="hidden shrink-0 text-xs tabular-nums text-wb-text-muted lg:inline">{formatEast8Date(post.created_at)}</time>
      )}
      {onWrite && (
        <button type="button" onClick={onWrite} aria-label="写新早报" title="写新早报" className="inline-flex min-h-8 shrink-0 items-center gap-1 rounded-lg px-1.5 text-xs font-semibold text-wb-brand hover:bg-wb-brand/10">
          <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
          <span className="hidden whitespace-nowrap sm:inline">写新早报</span>
        </button>
      )}
      {post && (
        <button type="button" onClick={() => onRead(post.id)} aria-label="阅读早报" className="inline-flex min-h-8 shrink-0 items-center gap-0.5 whitespace-nowrap rounded-lg bg-wb-brand/10 px-2 text-xs font-semibold text-wb-brand hover:bg-wb-brand/20">
          <span className="sm:hidden">阅读</span><span className="hidden sm:inline">阅读早报</span>
          <ChevronRight className="h-3.5 w-3.5" aria-hidden="true" />
        </button>
      )}
    </section>
  );
}
