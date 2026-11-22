import React, { useCallback, useEffect, useState } from 'react';
import { ShieldAlert, Check, X } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { InlineErrorState } from './InlineErrorState';

interface ReviewItem {
  id: number;
  post_id: string;
  title: string;
  hits: string;
  status: string;
  created_at: string;
  author_username?: string;
}

/** 敏感词打回待审队列：管理员复核是否误伤，并记录处理结论。 */
export const SensitiveReviewPanel: React.FC = () => {
  const toast = useToast();
  const [status, setStatus] = useState('pending');
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(false);
    try {
      const res = await apiClient.get('/admin/sensitive-reviews', { params: { status } });
      setItems(Array.isArray(res.data) ? res.data : []);
    } catch { setError(true); }
    finally { setLoading(false); }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const resolve = async (id: number, next: string) => {
    setBusy(id);
    try {
      await apiClient.post(`/admin/sensitive-reviews/${id}/resolve`, { status: next });
      toast.success(next === 'dismissed' ? '已判定为误伤' : '已标记处理');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '操作失败');
    } finally { setBusy(null); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <ShieldAlert className="w-4 h-4 text-wb-warn" />
        <h3 className="font-semibold text-sm text-wb-text-primary">内容复审队列</h3>
      </div>
      <p className="text-2xs text-wb-text-muted">
        定时发布被敏感词拦截的文章会退回草稿并登记在此。复核结论仅作记录，作者仍需修改后重新发布。
      </p>

      <div className="flex items-center gap-1.5" role="tablist" aria-label="待审状态">
        {[['pending', '待处理'], ['resolved', '已处理'], ['dismissed', '误伤']].map(([k, label]) => (
          <button
            key={k}
            type="button"
            role="tab"
            aria-selected={status === k}
            onClick={() => setStatus(k)}
            className={`px-2.5 py-1.5 min-h-[36px] rounded-capsule border text-2xs font-medium transition-colors ${
              status === k ? 'bg-wb-text-primary text-wb-bg-page border-transparent'
                : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error ? (
        <InlineErrorState label="待审队列加载失败" onRetry={() => void load()} />
      ) : loading ? (
        <div className="h-20 rounded-2xl bg-wb-bg-subtle animate-pulse" />
      ) : items.length === 0 ? (
        <p className="text-xs text-wb-text-muted py-6 text-center">当前没有记录</p>
      ) : (
        <div className="space-y-2">
          {items.map(it => (
            <div key={it.id} className="p-3.5 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-2">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-xs font-semibold text-wb-text-primary truncate">{it.title || '（无标题）'}</p>
                  <p className="text-3xs text-wb-text-muted font-mono">
                    @{it.author_username || '未知'} · {new Date(it.created_at).toLocaleString('zh-CN')}
                  </p>
                </div>
                <span className="text-3xs px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-muted shrink-0">{it.status}</span>
              </div>
              {it.hits && <p className="text-3xs text-wb-warn break-words">命中：{it.hits}</p>}
              {status === 'pending' && (
                <div className="flex items-center gap-2 pt-1">
                  <button type="button" disabled={busy === it.id} onClick={() => void resolve(it.id, 'resolved')} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-wb-bg-subtle hover:bg-wb-success/10 border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-success transition-colors disabled:opacity-50">
                    <Check className="w-3 h-3" /> 已处理
                  </button>
                  <button type="button" disabled={busy === it.id} onClick={() => void resolve(it.id, 'dismissed')} className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-wb-bg-subtle hover:bg-wb-warn/10 border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-warn transition-colors disabled:opacity-50">
                    <X className="w-3 h-3" /> 判定误伤
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
