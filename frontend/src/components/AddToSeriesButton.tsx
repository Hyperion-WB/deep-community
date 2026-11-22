import React, { useCallback, useEffect, useState } from 'react';
import { BookOpen, Plus, Check } from 'lucide-react';
import { Modal } from './Modal';
import { useToast } from './Toast';
import { apiClient } from '../api/client';

interface SeriesBrief {
  id: string;
  title: string;
  author_username: string;
  items: { post_id: string }[];
}

/** 文章详情页「加入专栏」：一键把当前文章编入自己的技术合集。 */
export const AddToSeriesButton: React.FC<{ postId: string }> = ({ postId }) => {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [list, setList] = useState<SeriesBrief[]>([]);
  const [newTitle, setNewTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const myName = (() => {
    try { return JSON.parse(localStorage.getItem('geek_user') || '{}')?.username || ''; } catch { return ''; }
  })();

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/posts/series/all', { params: { page: 1, size: 50 } });
      const all = Array.isArray(res.data) ? res.data : [];
      setList(all.filter((s: SeriesBrief) => !myName || s.author_username === myName));
    } catch { setList([]); }
  }, [myName]);

  useEffect(() => { if (open) void load(); }, [open, load]);

  const addTo = async (seriesId: string, title: string) => {
    setBusy(true);
    try {
      await apiClient.post(`/posts/series/${seriesId}/items`, { post_id: postId, sort_order: 0 });
      toast.success(`已加入专栏「${title}」`);
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '加入失败');
    } finally { setBusy(false); }
  };

  const createAndAdd = async () => {
    const title = newTitle.trim();
    if (title.length < 2) return toast.error('标题至少 2 个字');
    setBusy(true);
    try {
      const res = await apiClient.post('/posts/series', { title, description: '' });
      const id = res.data?.id;
      if (!id) throw new Error('创建失败');
      await apiClient.post(`/posts/series/${id}/items`, { post_id: postId, sort_order: 0 });
      toast.success(`已创建并加入「${title}」`);
      setNewTitle('');
      setOpen(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '创建失败');
    } finally { setBusy(false); }
  };

  return (
    <>
      <div className="relative group">
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label="加入专栏"
          title="加入专栏"
          className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs"
        >
          <BookOpen className="w-4 h-4" />
        </button>
        <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none transition-all duration-200 shadow-xl z-30">
          加入专栏
        </div>
      </div>

      <Modal open={open} onClose={() => setOpen(false)} widthClass="max-w-md" labelledBy="add-series-title">
        <div className="rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-4">
          <div className="flex items-center gap-2">
            <BookOpen className="w-4 h-4 text-wb-text-primary" />
            <h3 id="add-series-title" className="font-semibold text-sm text-wb-text-primary">加入专栏</h3>
          </div>

          <div className="space-y-1.5 max-h-[280px] overflow-y-auto overscroll-contain">
            {list.length === 0 && <p className="text-2xs text-wb-text-muted py-3">你还没有专栏，可以在下方新建</p>}
            {list.map(s => {
              const already = (s.items || []).some(i => i.post_id === postId);
              return (
                <button
                  key={s.id}
                  type="button"
                  disabled={busy || already}
                  onClick={() => void addTo(s.id, s.title)}
                  className="w-full min-h-[44px] flex items-center gap-2 px-3 py-2 rounded-2xl border border-wb-border-subtle hover:bg-wb-bg-subtle text-left transition-colors disabled:opacity-50"
                >
                  <span className="flex-1 text-xs font-medium text-wb-text-primary truncate">{s.title}</span>
                  {already ? <span className="text-3xs text-wb-success inline-flex items-center gap-1"><Check className="w-3 h-3" />已加入</span>
                    : <span className="text-3xs text-wb-text-muted">加入</span>}
                </button>
              );
            })}
          </div>

          <div className="flex items-center gap-2 pt-1 border-t border-wb-border-subtle">
            <input
              value={newTitle}
              onChange={e => setNewTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') void createAndAdd(); }}
              placeholder="新建专栏并加入"
              aria-label="新建专栏标题"
              maxLength={100}
              className="min-w-0 flex-1 px-3 py-2 min-h-[44px] rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs outline-none focus:border-wb-border-strong"
            />
            <button type="button" disabled={busy} onClick={() => void createAndAdd()} className="inline-flex items-center gap-1 px-3 py-2 min-h-[44px] rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50">
              <Plus className="w-3.5 h-3.5" /> 新建
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};
