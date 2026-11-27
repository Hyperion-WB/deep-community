import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { BookOpen, ChevronDown, Plus, Layers, Trash2, X, GripVertical, ArrowDownUp } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { InlineErrorState } from './InlineErrorState';
import type { UserProfile } from '../types';

interface Chapter {
  id: number;
  post_id: string;
  post_title: string;
  sort_order: number;
}

interface Series {
  id: string;
  author_id: string;
  author_username: string;
  author_nickname?: string | null;
  title: string;
  description: string;
  cover_image?: string | null;
  chapter_count: number;
  items: Chapter[];
}

const SERIES_ORDER_KEY = 'wb_series_order';

/** 专栏 / 文章合集：多个专栏可独立折叠，支持倒序与拖拽排序，展开带高度动画避免页面跳动。 */
export const SeriesPanel: React.FC<{ onSelectPost: (id: string) => void; viewer?: UserProfile | null; myOnly?: boolean; title?: string }> = ({
  onSelectPost,
  viewer,
  myOnly = false,
  title = '专栏',
}) => {
  const toast = useToast();
  const [list, setList] = useState<Series[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  // 多专栏场景：每个专栏独立展开/收起，互不干扰
  const [openIds, setOpenIds] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [addFor, setAddFor] = useState<string | null>(null);
  const [postId, setPostId] = useState('');
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDesc, setEditDesc] = useState('');
  // 排序：专栏列表倒序开关 + 拖拽后的自定义顺序；章节可按专栏单独倒序显示
  const [seriesDesc, setSeriesDesc] = useState(false);
  const [seriesOrder, setSeriesOrder] = useState<string[]>(() => {
    try { return JSON.parse(localStorage.getItem(SERIES_ORDER_KEY) || '[]'); } catch { return []; }
  });
  const [chapterDesc, setChapterDesc] = useState<Record<string, boolean>>({});
  const [dragSeriesIdx, setDragSeriesIdx] = useState<number | null>(null);
  const [dragChapter, setDragChapter] = useState<{ seriesId: string; index: number } | null>(null);
  const [dropHint, setDropHint] = useState<string | null>(null);

  const isLogged = !!viewer;
  const isStaff = !!viewer && ['super_admin', 'admin', 'moderator', 'auditor'].includes(viewer.role);
  const load = useCallback(async (signal?: AbortSignal) => {
    setError(false);
    try {
      const res = await apiClient.get(myOnly ? '/posts/series/mine' : '/posts/series/all', {
        params: { page: 1, size: 50 }, signal,
      });
      if (!signal?.aborted) setList(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (!signal?.aborted) setError(true);
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, [myOnly]);

  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      controller = new AbortController();
      void load(controller.signal);
    };
    refresh();
    window.addEventListener('wb:series-changed', refresh);
    return () => {
      window.removeEventListener('wb:series-changed', refresh);
      controller?.abort();
    };
  }, [load]);

  // 倒序开关与自定义拖拽顺序叠加：自定义顺序优先，未记录的按原顺序追加
  const orderedList = useMemo(() => {
    const base = [...list];
    if (seriesOrder.length) {
      const pos = new Map(seriesOrder.map((id, i) => [id, i]));
      base.sort((a, b) => (pos.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (pos.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    }
    return seriesDesc ? base.reverse() : base;
  }, [list, seriesDesc, seriesOrder]);

  const persistOrder = (ids: string[]) => {
    setSeriesOrder(ids);
    try { localStorage.setItem(SERIES_ORDER_KEY, JSON.stringify(ids)); } catch { /* 忽略 */ }
  };

  const toggleOpen = (id: string) => {
    setOpenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const create = async () => {
    if (newTitle.trim().length < 2) return toast.error('标题至少 2 个字');
    setBusy(true);
    try {
      await apiClient.post('/posts/series', { title: newTitle.trim(), description: newDesc.trim() });
      toast.success('专栏已创建');
      setNewTitle(''); setNewDesc(''); setCreating(false);
      window.dispatchEvent(new Event('wb:series-changed'));
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '创建失败');
    } finally { setBusy(false); }
  };

  const addChapter = async (s: Series) => {
    const id = postId.trim();
    if (!/^[0-9a-f-]{36}$/i.test(id)) return toast.error('请填写有效的文章 ID');
    setBusy(true);
    try {
      await apiClient.post(`/posts/series/${s.id}/items`, { post_id: id });
      toast.success('文章已编入目录');
      setPostId(''); setAddFor(null);
      window.dispatchEvent(new Event('wb:series-changed'));
      setOpenIds(prev => new Set(prev).add(s.id));
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '添加失败');
    } finally { setBusy(false); }
  };

  const saveSeriesInfo = async (id: string) => {
    if (editTitle.trim().length < 2) return toast.error('标题至少 2 个字');
    setBusy(true);
    try {
      await apiClient.put(`/posts/series/${id}`, { title: editTitle.trim(), description: editDesc.trim() });
      toast.success('专栏信息已更新');
      setEditId(null);
      window.dispatchEvent(new Event('wb:series-changed'));
    } catch (e: any) { toast.error(e?.response?.data?.detail || '保存失败'); }
    finally { setBusy(false); }
  };

  const commitChapterOrder = async (s: Series, items: Chapter[]) => {
    setBusy(true);
    try {
      await apiClient.put(`/posts/series/${s.id}/items/order`, { post_ids: items.map(i => i.post_id) });
      window.dispatchEvent(new Event('wb:series-changed'));
    } catch (e: any) { toast.error(e?.response?.data?.detail || '排序失败'); }
    finally { setBusy(false); }
  };

  const moveChapter = (s: Series, index: number, delta: number) => {
    const items = [...(s.items || [])];
    const next = index + delta;
    if (next < 0 || next >= items.length) return;
    [items[index], items[next]] = [items[next], items[index]];
    void commitChapterOrder(s, items);
  };

  /** 拖拽章节：显示层可能倒序，索引要映射回真实 sort_order 序列 */
  const dropChapter = (s: Series, displayIndex: number) => {
    if (!dragChapter || dragChapter.seriesId !== s.id) { setDragChapter(null); setDropHint(null); return; }
    const len = s.items.length;
    const toReal = (i: number) => (chapterDesc[s.id] ? len - 1 - i : i);
    const from = toReal(dragChapter.index);
    const to = toReal(displayIndex);
    setDragChapter(null);
    setDropHint(null);
    if (from === to || from < 0 || to < 0 || from >= len || to >= len) return;
    const items = [...s.items];
    const [moved] = items.splice(from, 1);
    items.splice(to, 0, moved);
    void commitChapterOrder(s, items);
  };

  const dropSeries = (targetIdx: number) => {
    if (dragSeriesIdx === null || dragSeriesIdx === targetIdx) { setDragSeriesIdx(null); setDropHint(null); return; }
    const ids = orderedList.map(x => x.id);
    const [moved] = ids.splice(dragSeriesIdx, 1);
    ids.splice(targetIdx, 0, moved);
    persistOrder(ids);
    setDragSeriesIdx(null);
    setDropHint(null);
  };

  return (
    <div className="p-5 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <BookOpen className="w-4 h-4 text-wb-text-primary shrink-0" />
          <h3 className="font-semibold text-sm text-wb-text-primary truncate">{title}</h3>
          {list.length > 1 && <span className="text-3xs text-wb-text-muted font-mono shrink-0">{list.length} 个</span>}
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={() => setSeriesDesc(v => !v)}
            title={seriesDesc ? '当前：最新创建的在前，点击切换' : '当前：最早创建的在前，点击切换'}
            aria-label="切换专栏倒序"
            className={`inline-flex items-center gap-1 h-8 px-2 rounded-capsule border text-3xs transition-colors ${
              seriesDesc ? 'bg-wb-text-primary text-wb-bg-page border-transparent' : 'bg-wb-bg-subtle border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary'}`}
          >
            <ArrowDownUp className="w-3 h-3" /> 倒序
          </button>
          {isLogged && (
            <button
              type="button"
              onClick={() => setCreating(v => !v)}
              aria-label="创建专栏"
              className="p-2 min-w-[44px] min-h-[44px] rounded-capsule bg-wb-bg-subtle hover:bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors flex items-center justify-center"
            >
              <Plus className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {list.length > 1 && (
        <p className="text-3xs text-wb-text-muted">可拖动专栏卡片调整顺序，多个专栏可同时展开</p>
      )}

      {creating && (
        <div className="space-y-2 p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle">
          <input
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
            placeholder="专栏标题"
            aria-label="专栏标题"
            className="w-full px-3 py-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-xs outline-none focus:border-wb-border-strong"
          />
          <textarea
            value={newDesc}
            onChange={e => setNewDesc(e.target.value)}
            placeholder="简介（可选）"
            aria-label="专栏简介"
            rows={2}
            className="w-full px-3 py-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-xs outline-none focus:border-wb-border-strong resize-none"
          />
          <button
            type="button"
            disabled={busy}
            onClick={() => void create()}
            className="w-full py-2 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
          >
            创建
          </button>
        </div>
      )}

      {error ? (
        <InlineErrorState compact label="专栏加载失败" onRetry={() => window.dispatchEvent(new Event('wb:series-changed'))} />
      ) : loading ? (
        <div className="h-12 rounded-xl bg-wb-bg-subtle animate-pulse" />
      ) : list.length === 0 ? (
        <p className="text-2xs text-wb-text-muted py-2">还没有专栏</p>
      ) : (
        <div className="space-y-2">
          {orderedList.map((s, sIdx) => {
            const canManage = !!viewer && (viewer.id === s.author_id || isStaff);
            const isOpen = openIds.has(s.id);
            const shown = chapterDesc[s.id] ? [...(s.items || [])].reverse() : (s.items || []);
            return (
              <div
                key={s.id}
                draggable={isLogged && dragChapter === null}
                onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; setDragSeriesIdx(sIdx); }}
                onDragOver={(e) => {
                  if (dragSeriesIdx === null) return;
                  e.preventDefault();
                  setDropHint(`series-${s.id}`);
                }}
                onDragLeave={() => setDropHint(null)}
                onDrop={(e) => { e.preventDefault(); dropSeries(sIdx); }}
                onDragEnd={() => { setDragSeriesIdx(null); setDropHint(null); }}
                className={`rounded-2xl border bg-wb-bg-subtle/40 overflow-hidden transition-colors ${
                  dropHint === `series-${s.id}` ? 'border-wb-brand' : 'border-wb-border-subtle'}`}
              >
                <div className="w-full flex items-center gap-1.5 px-2.5 min-h-[44px]">
                  {isLogged && (
                    <GripVertical className="w-3.5 h-3.5 text-wb-text-muted/60 shrink-0 cursor-grab" aria-hidden />
                  )}
                  <button
                    type="button"
                    onClick={() => toggleOpen(s.id)}
                    aria-expanded={isOpen}
                    className="flex items-center gap-2 flex-1 min-w-0 text-left py-2.5 hover:opacity-80 transition-opacity"
                  >
                    <Layers className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                    <div className="min-w-0 flex-1">
                      <p className="text-xs font-semibold text-wb-text-primary truncate">{s.title}</p>
                      <p className="text-3xs text-wb-text-muted truncate">
                        @{s.author_username} · {s.chapter_count} 篇
                      </p>
                    </div>
                    <ChevronDown className={`w-3.5 h-3.5 text-wb-text-muted shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
                  </button>
                </div>

                {/* 高度动画 + 内部最大高度滚动：展开不再瞬间撑高 sticky 侧栏造成页面跳动 */}
                <AnimatePresence initial={false}>
                  {isOpen && (
                    <motion.div
                      key="body"
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.22, ease: 'easeOut' }}
                      className="overflow-hidden"
                    >
                      <div className="px-3 pb-3 space-y-1.5 max-h-[320px] overflow-y-auto overscroll-contain">
                        <div className="flex items-center justify-between gap-2 pb-1">
                          <button type="button"
                            onClick={() => setChapterDesc(prev => ({ ...prev, [s.id]: !prev[s.id] }))}
                            className="text-3xs text-wb-text-muted hover:text-wb-text-primary inline-flex items-center gap-1">
                            <ArrowDownUp className="w-3 h-3" /> {chapterDesc[s.id] ? '倒序中' : '正序中'}
                          </button>
                          {canManage && <span className="text-3xs text-wb-text-muted">可拖动章节排序</span>}
                        </div>

                        {canManage && editId === s.id ? (
                          <div className="space-y-1.5 pb-1">
                            <input value={editTitle} onChange={e => setEditTitle(e.target.value)} aria-label="专栏标题"
                              className="w-full px-2 py-1.5 rounded-lg bg-wb-bg-surface border border-wb-border-subtle text-2xs outline-none" />
                            <textarea value={editDesc} onChange={e => setEditDesc(e.target.value)} aria-label="专栏简介" rows={2}
                              className="w-full px-2 py-1.5 rounded-lg bg-wb-bg-surface border border-wb-border-subtle text-2xs outline-none resize-none" />
                            <div className="flex gap-1.5">
                              <button type="button" disabled={busy} onClick={() => void saveSeriesInfo(s.id)} className="px-2 py-1.5 rounded-lg bg-wb-text-primary text-wb-bg-page text-3xs font-semibold">保存</button>
                              <button type="button" onClick={() => setEditId(null)} className="px-2 py-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-3xs">取消</button>
                            </div>
                          </div>
                        ) : (
                          s.description && <p className="text-3xs text-wb-text-secondary pb-1">{s.description}</p>
                        )}

                        {shown.length === 0 && <p className="text-3xs text-wb-text-muted">暂无章节</p>}
                        {shown.map((it, i) => (
                          <div key={it.id}
                            draggable={canManage && !busy}
                            onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; setDragChapter({ seriesId: s.id, index: i }); }}
                            onDragOver={(e) => {
                              if (!dragChapter || dragChapter.seriesId !== s.id) return;
                              e.preventDefault(); e.stopPropagation();
                              setDropHint(`${s.id}-${i}`);
                            }}
                            onDrop={(e) => { e.preventDefault(); e.stopPropagation(); dropChapter(s, i); }}
                            onDragEnd={() => { setDragChapter(null); setDropHint(null); }}
                            className={`flex items-center gap-1 group/chapter rounded-lg transition-colors ${
                              dropHint === `${s.id}-${i}` ? 'bg-wb-brand/10' : ''}`}
                          >
                            {canManage && <GripVertical className="w-3 h-3 text-wb-text-muted/60 shrink-0 cursor-grab" aria-hidden />}
                            <button type="button" onClick={() => onSelectPost(it.post_id)}
                              className="min-w-0 flex-1 text-left text-3xs text-wb-text-secondary hover:text-wb-text-primary py-1.5 px-2 rounded-lg hover:bg-wb-bg-surface border border-transparent hover:border-wb-border-subtle transition-colors truncate">
                              {chapterDesc[s.id] ? shown.length - i : i + 1}. {it.post_title}
                            </button>
                            {canManage && (
                              <>
                                <button type="button" aria-label="上移章节" disabled={busy} onClick={() => moveChapter(s, chapterDesc[s.id] ? shown.length - 1 - i : i, -1)} className="p-1 rounded text-wb-text-muted hover:text-wb-text-primary disabled:opacity-40">↑</button>
                                <button type="button" aria-label="下移章节" disabled={busy} onClick={() => moveChapter(s, chapterDesc[s.id] ? shown.length - 1 - i : i, 1)} className="p-1 rounded text-wb-text-muted hover:text-wb-text-primary disabled:opacity-40">↓</button>
                                <button type="button" aria-label={`从专栏移除 ${it.post_title}`}
                                  onClick={async () => {
                                    try {
                                      await apiClient.delete(`/posts/series/${s.id}/items/${it.post_id}`);
                                      toast.success('已从目录移除');
                                      window.dispatchEvent(new Event('wb:series-changed'));
                                    } catch (e: any) { toast.error(e?.response?.data?.detail || '移除失败'); }
                                  }}
                                  className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 opacity-0 group-hover/chapter:opacity-100 transition-opacity">
                                  <X className="w-3 h-3" />
                                </button>
                              </>
                            )}
                          </div>
                        ))}

                        {canManage && (
                          <div className="flex items-center gap-3 pt-1">
                            <button type="button"
                              onClick={() => { setEditId(s.id); setEditTitle(s.title); setEditDesc(s.description || ''); }}
                              className="text-3xs text-wb-text-muted hover:text-wb-text-primary">编辑信息</button>
                            <button type="button"
                              onClick={async () => {
                                try {
                                  await apiClient.delete(`/posts/series/${s.id}`);
                                  toast.success('专栏已删除');
                                  setOpenIds(prev => { const n = new Set(prev); n.delete(s.id); return n; });
                                  window.dispatchEvent(new Event('wb:series-changed'));
                                } catch (e: any) { toast.error(e?.response?.data?.detail || '删除失败'); }
                              }}
                              className="inline-flex items-center gap-1 text-3xs text-wb-text-muted hover:text-wb-danger">
                              <Trash2 className="w-3 h-3" /> 删除该专栏
                            </button>
                          </div>
                        )}
                        {canManage && (
                          addFor === s.id ? (
                            <div className="flex gap-1.5 pt-1">
                              <input value={postId} onChange={e => setPostId(e.target.value)} placeholder="文章 ID" aria-label="要编入的文章 ID"
                                className="min-w-0 flex-1 px-2 py-1.5 rounded-lg bg-wb-bg-surface border border-wb-border-subtle text-3xs outline-none" />
                              <button type="button" disabled={busy} onClick={() => void addChapter(s)} className="px-2 py-1.5 rounded-lg bg-wb-bg-surface border border-wb-border-subtle text-3xs font-semibold">加入</button>
                            </div>
                          ) : (
                            <button type="button" onClick={() => setAddFor(s.id)} className="text-3xs text-wb-text-muted hover:text-wb-text-primary pt-1">+ 添加文章到目录</button>
                          )
                        )}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
