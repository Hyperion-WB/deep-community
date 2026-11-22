import React, { useState } from 'react';
import { ChevronDown, FileText } from 'lucide-react';
import { apiClient } from '../api/client';

interface Item {
  id: string;
  title: string;
  comment_count?: number;
  score?: number;
  reason?: string;
}

interface Props {
  postId: string;
  categoryId?: number | null;
  // categoryId 保留在 Props 中以便调用方传参，内部改由后端打分
  categoryName?: string;
  onSelectPost?: (id: string) => void;
}

/**
 * 相似文章推荐：默认收起，首次展开时才请求，避免每次进文章都多打一次接口。
 * 取同分类的最新文章，排除自身。
 */
export const RelatedPosts: React.FC<Props> = ({ postId, categoryName, onSelectPost }) => {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState<Item[]>([]);

  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (!next || loaded || loading) return;
    setLoading(true);
    try {
      const res = await apiClient.get(`/posts/${postId}/related`, { params: { limit: 4 } });
      setItems(((res.data?.items || []) as Item[]));
    } catch {
      setItems([]);
    } finally {
      setLoading(false);
      setLoaded(true);
    }
  };

  return (
    <div className="rounded-2xl surface border border-wb-border-subtle shadow-card overflow-hidden">
      <button
        type="button"
        onClick={toggle}
        className="w-full flex items-center justify-between px-4 py-2.5 text-xs font-semibold text-wb-text-primary hover:bg-wb-bg-subtle/50 transition-colors"
      >
        <span className="flex items-center gap-1.5">
          <FileText className="w-3.5 h-3.5 text-wb-text-muted" />
          相似文章推荐
        </span>
        <ChevronDown className={`w-3.5 h-3.5 text-wb-text-muted transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="px-3 pb-3 space-y-1 animate-fade-in">
          {loading ? (
            <p className="text-2xs text-wb-text-muted px-1 py-2">加载中…</p>
          ) : items.length === 0 ? (
            <p className="text-2xs text-wb-text-muted px-1 py-2">
              {categoryName ? `「${categoryName}」下暂时没有其它文章` : '暂时没有可推荐的文章'}
            </p>
          ) : (
            items.map((item) => (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelectPost?.(item.id)}
                className="block w-full text-left px-2 py-1.5 rounded-lg text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
              >
                <span className="line-clamp-2 leading-snug">{item.title}</span>
                <span className="text-3xs text-wb-text-muted/80 font-mono flex items-center gap-1.5">
                  {item.reason && <span className="px-1 rounded bg-wb-bg-subtle">{item.reason}</span>}
                  {typeof item.comment_count === 'number' && item.comment_count > 0 && (
                    <span>{item.comment_count} 条讨论</span>
                  )}
                </span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
