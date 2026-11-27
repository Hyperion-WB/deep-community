import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, Check, ImagePlus, Loader2, Pencil, Plus, Settings2, Smile, Trash2, X } from 'lucide-react';
import { apiClient, formatApiErrorDetail, UPLOAD_TIMEOUT } from '../api/client';
import { useOverlayEscape } from '../hooks/useDialogA11y';
import { useToast } from './Toast';
import { EMOJI_CATEGORIES } from './EmojiPicker';
import { SafeImage } from './SafeImage';

interface StickerItem {
  id: string;
  url: string;
  thumb_url: string;
  is_animated: boolean;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 触发面板的按钮：面板贴着它弹出，而不是飘在屏幕中间 */
  anchor?: HTMLElement | null;
  /** 选中 emoji：插入到文本框 */
  onSelectEmoji: (emoji: string) => void;
  /** 选中自定义表情：作为一张图发送 */
  onSelectSticker: (url: string) => void;
}

type Tab = 'emoji' | 'sticker' | 'official';

type OfficialSeries = { id: string; name: string; items: StickerItem[] };
type OfficialCatalog = { series: OfficialSeries[]; can_manage: boolean };
const OFFICIAL_API = '/stickers/official';
const EDIT_BUTTON = 'shrink-0 p-1.5 rounded-lg text-wb-text-secondary hover:bg-wb-bg-subtle disabled:opacity-30';

/**
 * 统一的表情面板：常用表情、我的表情、官方表情。
 *
 * 用 createPortal 挂到 body，fixed 定位——评论输入框很窄，
 * 之前 absolute 展开会被卡片裁掉一半；挂在 body 上也避免了两份评论输入区各渲染一个面板。
 */
export const EmojiStickerPanel: React.FC<Props> = ({
  isOpen,
  onClose,
  anchor,
  onSelectEmoji,
  onSelectSticker,
}) => {
  const toast = useToast();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // 贴着触发按钮定位：优先显示在按钮上方，空间不足则落到下方，
  // 并夹在视口内，避免在小屏上被裁掉
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const reposition = useCallback(() => {
    const width = panelRef.current?.offsetWidth || Math.min(window.innerWidth - 16, 416);

    // 没有锚点（例如评论输入区直接把面板挂在按钮上）时，
    // 回退到「视口下方居中」，保证面板一定可见，而不是跑到屏幕外
    if (!anchor) {
      const height = panelRef.current?.offsetHeight || 360;
      setPos({
        left: Math.max(8, (window.innerWidth - width) / 2),
        top: Math.max(8, window.innerHeight - height - 140),
      });
      return;
    }

    const rect = anchor.getBoundingClientRect();
    const height = panelRef.current?.offsetHeight || 360;
    const margin = 8;

    let left = rect.left;
    left = Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin));

    let top = rect.top - height - 10;
    if (top < margin) top = rect.bottom + 10;
    top = Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin));

    setPos({ top, left });
  }, [anchor]);

  useLayoutEffect(() => {
    if (!isOpen) {
      setPos(null);
      return;
    }
    reposition();
    const raf = window.requestAnimationFrame(reposition);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
    };
  }, [isOpen, reposition]);

  const [tab, setTab] = useState<Tab>('emoji');
  const [items, setItems] = useState<StickerItem[]>([]);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(60);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [preview, setPreview] = useState<{ item: StickerItem; left: number; top: number; size: number } | null>(null);

  const showPreview = (item: StickerItem, target: HTMLElement) => {
    const rect = target.getBoundingClientRect();
    const gap = 8;
    const size = Math.min(144, window.innerWidth - 2 * gap, window.innerHeight - 2 * gap);
    const preferredTop = rect.top >= size + 2 * gap ? rect.top - size - gap : rect.bottom + gap;
    setPreview({
      item, size,
      left: Math.max(gap, Math.min(rect.left + (rect.width - size) / 2, window.innerWidth - size - gap)),
      top: Math.max(gap, Math.min(preferredTop, window.innerHeight - size - gap)),
    });
  };

  useLayoutEffect(() => {
    setPreview(null);
    if (!isOpen) return;
    const clearPreview = () => setPreview(null);
    window.addEventListener('resize', clearPreview);
    window.addEventListener('scroll', clearPreview, true);
    return () => {
      window.removeEventListener('resize', clearPreview);
      window.removeEventListener('scroll', clearPreview, true);
    };
  }, [isOpen, tab]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/stickers/mine');
      setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      setUsed(res.data?.used ?? 0);
      setLimit(res.data?.limit ?? 60);
    } catch {
      /* 未登录时静默 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  const [catalog, setCatalog] = useState<OfficialCatalog | null>(null);
  const [officialLoading, setOfficialLoading] = useState(false);
  const [officialError, setOfficialError] = useState(false);
  const [manage, setManage] = useState(false);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [uploadErrors, setUploadErrors] = useState<{ filename: string | null; message: string }[]>([]);

  const loadOfficial = useCallback(async () => {
    setOfficialLoading(true);
    setOfficialError(false);
    try {
      const { data } = await apiClient.get<OfficialCatalog>(OFFICIAL_API);
      setCatalog(data);
      if (!data.can_manage) setManage(false);
    } catch {
      setOfficialError(true);
    } finally {
      setOfficialLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen && tab === 'official') void loadOfficial();
  }, [isOpen, tab, loadOfficial]);

  const mutateOfficial = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      await loadOfficial();
    } catch (err: any) {
      toast.error(formatApiErrorDetail(err?.response?.data?.detail));
      if (err?.response?.status === 409 || err?.response?.status === 403) await loadOfficial();
    } finally {
      setBusy(false);
    }
  };

  const saveSeries = (event: React.FormEvent) => {
    event.preventDefault();
    if (busy || !name.trim() || editId === null) return;
    const payload = { name: name.trim() };
    void mutateOfficial(async () => {
      if (editId) await apiClient.patch(`${OFFICIAL_API}/series/${editId}`, payload);
      else await apiClient.post(`${OFFICIAL_API}/series`, payload);
      setEditId(null);
      setName('');
    });
  };

  const moveSeries = (index: number, step: number) => {
    const ids = catalog?.series.map((series) => series.id);
    const target = index + step;
    if (busy || !ids || target < 0 || target >= ids.length) return;
    [ids[index], ids[target]] = [ids[target], ids[index]];
    void mutateOfficial(async () => {
      await apiClient.put(`${OFFICIAL_API}/series/order`, { ids });
    });
  };

  const uploadOfficial = (id: string, files: File[]) => {
    if (busy || !files.length) return;
    setUploadErrors([]);
    if (files.length > 20 || files.reduce((size, file) => size + file.size, 0) > 24 * 1024 * 1024) {
      toast.error('每批最多上传 20 张图片，总大小不能超过 24 MB');
      return;
    }
    const body = new FormData();
    files.forEach((file) => body.append('files', file));
    void mutateOfficial(async () => {
      const { data } = await apiClient.post<{ uploaded: number; errors: typeof uploadErrors }>(
        `${OFFICIAL_API}/series/${id}/upload`, body,
        { headers: { 'Content-Type': 'multipart/form-data' }, timeout: UPLOAD_TIMEOUT },
      );
      setUploadErrors(data.errors);
      if (data.uploaded) toast.success(`已上传 ${data.uploaded} 张官方表情`);
    });
  };

  // 切页签、列表加载完成都会改变面板高度，需要重新贴合按钮
  useEffect(() => {
    if (!isOpen) return;
    const observer = new ResizeObserver(reposition);
    if (panelRef.current) observer.observe(panelRef.current);
    return () => observer.disconnect();
  }, [isOpen, reposition]);

  useOverlayEscape(isOpen, onClose, 130);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        // 点的是触发按钮：交给按钮自己切换开合，否则 mousedown 先关、click 又开，按钮就永远关不掉面板
        if (anchor?.contains(event.target as Node)) return;
        onClose();
      }
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen, onClose, anchor]);

  const handleUpload = async (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      await apiClient.post('/stickers/upload', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success('已加入我的表情');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      await apiClient.delete(`/stickers/${id}`);
      setItems((prev) => prev.filter((s) => s.id !== id));
      setUsed((n) => Math.max(0, n - 1));
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '删除失败');
    }
  };

  if (!isOpen) return null;

  // data-overlay 标记为浮层：文章页有一个 window 级滚轮接管（PostDetailPopup），
  // 只对 data-overlay / role=dialog 内的元素放行，否则滚轮会被拿去滚正文
  const content = (
    <div
      ref={panelRef}
      data-overlay="1"
      style={pos ? { top: pos.top, left: pos.left } : { top: -9999, left: -9999 }}
      className="fixed z-[130] flex h-[23rem] max-h-[calc(100dvh-1rem)] w-[min(calc(100vw-1rem),26rem)] flex-col rounded-2xl frost border border-wb-border-strong shadow-2xl overflow-hidden"
    >
      <div className="flex shrink-0 items-center justify-between px-2 sm:px-3 pt-2.5 pb-0">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setTab('emoji')}
            className={`px-3 py-1.5 rounded-capsule text-xs font-semibold transition-colors ${
              tab === 'emoji'
                ? 'bg-wb-text-primary text-wb-bg-page'
                : 'text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle'
            }`}
          >
            常用表情
          </button>
          <button
            type="button"
            onClick={() => setTab('sticker')}
            className={`px-3 py-1.5 rounded-capsule text-xs font-semibold transition-colors ${
              tab === 'sticker'
                ? 'bg-wb-text-primary text-wb-bg-page'
                : 'text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle'
            }`}
          >
            我的表情
          </button>
          <button
            type="button"
            onClick={() => setTab('official')}
            className={`px-2 sm:px-3 py-1.5 whitespace-nowrap rounded-capsule text-xs font-semibold transition-colors ${
              tab === 'official'
                ? 'bg-wb-text-primary text-wb-bg-page'
                : 'text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle'
            }`}
          >
            官方表情
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="p-1.5 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      <div key={tab} className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 [scrollbar-gutter:stable]">
        {tab === 'emoji' ? (
          <div className="space-y-3">
            {EMOJI_CATEGORIES.map((cat) => (
              <div key={cat.name} className="space-y-1.5">
                <p className="text-3xs text-wb-text-muted font-semibold">{cat.name}</p>
                <div className="grid grid-cols-9 gap-1">
                  {cat.emojis.map((emoji, idx) => (
                    <button
                      key={`${cat.name}-${idx}`}
                      type="button"
                      onClick={() => onSelectEmoji(emoji)}
                      className="h-8 rounded-lg text-lg leading-none hover:bg-wb-bg-subtle transition-colors flex items-center justify-center"
                    >
                      {emoji}
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : tab === 'official' ? (
          <div className="space-y-3">
            {officialLoading && !catalog ? (
              <div className="py-10 flex items-center justify-center gap-2 text-2xs text-wb-text-muted">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
              </div>
            ) : officialError ? (
              <div className="py-8 text-center text-xs text-wb-text-muted">
                加载官方表情失败
                <button type="button" onClick={() => void loadOfficial()} className="ml-2 underline">重试</button>
              </div>
            ) : catalog && (
              <>
                {catalog.can_manage && (
                  <div className="flex items-center justify-end gap-1">
                    {busy && <Loader2 aria-label="处理中" className="w-4 h-4 animate-spin" />}
                    <button
                      type="button" aria-label="管理官方表情" title="管理官方表情" aria-pressed={manage}
                      onClick={() => { setManage(!manage); setEditId(null); setUploadErrors([]); }}
                      className={`${EDIT_BUTTON} ${manage ? 'bg-wb-bg-subtle' : ''}`}
                    >
                      <Settings2 className="w-4 h-4" />
                    </button>
                    {manage && (
                      <button
                        type="button" aria-label="新建系列" title="新建系列" disabled={busy}
                        onClick={() => { setEditId(''); setName(''); }} className={EDIT_BUTTON}
                      >
                        <Plus className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                )}
                {catalog.can_manage && manage && editId !== null && (
                  <form onSubmit={saveSeries} className="flex items-center gap-1">
                    <input
                      autoFocus value={name} maxLength={60} onChange={(event) => setName(event.target.value)}
                      placeholder="系列名称" aria-label="系列名称"
                      className="min-w-0 flex-1 rounded-lg border border-wb-border-strong bg-wb-bg-subtle px-2 py-1 text-xs"
                    />
                    <button type="submit" aria-label="保存" title="保存" disabled={busy || !name.trim()} className={EDIT_BUTTON}>
                      <Check className="w-4 h-4" />
                    </button>
                    <button type="button" aria-label="取消" title="取消" onClick={() => setEditId(null)} className={EDIT_BUTTON}>
                      <X className="w-4 h-4" />
                    </button>
                  </form>
                )}
                {manage && uploadErrors.length > 0 && (
                  <ul role="status" className="space-y-1 break-words text-xs text-wb-danger">
                    {uploadErrors.map(({ filename, message }, index) => (
                      <li key={index}>{filename || '图片'}：{message}</li>
                    ))}
                  </ul>
                )}
                {!catalog.series.some((series) => series.items.length || (catalog.can_manage && manage)) && (
                  <p className="py-10 text-center text-xs text-wb-text-muted">暂无官方表情</p>
                )}
                {catalog.series.map((series, index) => {
                  const editing = catalog.can_manage && manage;
                  if (!editing && !series.items.length) return null;
                  return (
                    <section key={series.id} className="space-y-1.5">
                      <div className="flex items-center gap-1">
                        <h3 className="min-w-0 flex-1 break-words text-xs font-semibold text-wb-text-secondary">{series.name}</h3>
                        {editing && (
                          <>
                            <button type="button" aria-label="改名" title="改名" disabled={busy} className={EDIT_BUTTON}
                              onClick={() => { setEditId(series.id); setName(series.name); }}>
                              <Pencil className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" aria-label="上移系列" title="上移系列" className={EDIT_BUTTON}
                              disabled={busy || index === 0} onClick={() => moveSeries(index, -1)}>
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                            <button type="button" aria-label="下移系列" title="下移系列" className={EDIT_BUTTON}
                              disabled={busy || index === catalog.series.length - 1} onClick={() => moveSeries(index, 1)}>
                              <ArrowDown className="w-3.5 h-3.5" />
                            </button>
                            <label title="批量上传表情" className={`relative ${EDIT_BUTTON} ${busy ? 'opacity-30' : 'cursor-pointer focus-within:ring-1'}`}>
                              <ImagePlus className="w-3.5 h-3.5" />
                              <input
                                type="file" aria-label={`批量上传表情至${series.name}`} multiple disabled={busy}
                                accept="image/gif,image/png,image/jpeg,image/webp" className="sr-only"
                                onChange={(event) => {
                                  const files = Array.from(event.currentTarget.files ?? []);
                                  event.currentTarget.value = '';
                                  uploadOfficial(series.id, files);
                                }}
                              />
                            </label>
                          </>
                        )}
                      </div>
                      <div className="grid grid-cols-6 gap-1.5">
                        {series.items.map((item, stickerIndex) => (
                          <button
                            key={item.id} type="button" aria-label={`${series.name}表情${stickerIndex + 1}`}
                            onClick={() => { onSelectSticker(item.url); onClose(); }}
                            onMouseEnter={(event) => showPreview(item, event.currentTarget)} onMouseLeave={() => setPreview(null)}
                            onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showPreview(item, event.currentTarget); }}
                            onBlur={() => setPreview(null)}
                            className="aspect-square min-w-0 rounded-lg p-1 hover:bg-wb-bg-subtle transition-colors"
                          >
                            <SafeImage
                              src={item.thumb_url || item.url} fallbackSrc={item.url}
                              compatiblePreview alt="" loading="lazy" className="w-full h-full object-contain"
                            />
                          </button>
                        ))}
                      </div>
                    </section>
                  );
                })}
              </>
            )}
          </div>
        ) : loading ? (
          <div className="py-10 flex items-center justify-center gap-2 text-2xs text-wb-text-muted">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
          </div>
        ) : items.length === 0 ? (
          <div className="py-10 text-center space-y-1">
            <Smile className="w-7 h-7 mx-auto text-wb-text-muted stroke-1" />
            <p className="text-2xs text-wb-text-muted">还没有表情</p>
            <p className="text-3xs text-wb-text-muted">点下方按钮上传，支持 GIF 动图</p>
          </div>
        ) : (
          <div className="grid grid-cols-6 gap-1.5">
            {items.map((item, index) => (
              <div key={item.id} className="group/sticker relative">
                <button
                  type="button"
                  aria-label={`我的表情${index + 1}`}
                  onMouseEnter={(event) => showPreview(item, event.currentTarget)} onMouseLeave={() => setPreview(null)}
                  onFocus={(event) => { if (event.currentTarget.matches(':focus-visible')) showPreview(item, event.currentTarget); }}
                  onBlur={() => setPreview(null)}
                  onClick={() => {
                    onSelectSticker(item.url);
                    onClose();
                  }}
                  className="w-full aspect-square rounded-lg hover:bg-wb-bg-subtle p-1 transition-colors"
                >
                  <SafeImage
                    src={item.thumb_url || item.url}
                    fallbackSrc={item.url}
                    compatiblePreview
                    alt=""
                    loading="lazy"
                    className="w-full h-full object-contain"
                  />
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(item.id)}
                  title="删除表情"
                  className="absolute -top-1 -right-1 p-1 rounded-full bg-wb-danger text-white opacity-0 group-hover/sticker:opacity-100 transition-opacity"
                >
                  <Trash2 className="w-2.5 h-2.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {tab === 'sticker' && (
        <div className="shrink-0 px-3 pb-3">
          <button
            type="button"
            disabled={uploading || used >= limit}
            onClick={() => fileRef.current?.click()}
            className="w-full h-9 rounded-xl border border-dashed border-wb-border-strong text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
            {uploading ? '正在压缩并上传…' : `上传表情（${used}/${limit}）`}
          </button>
        </div>
      )}

      <input
        ref={fileRef}
        type="file"
        accept="image/gif,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) handleUpload(file);
        }}
      />
    </div>
  );

  return typeof document !== 'undefined' ? createPortal(
    <>
      {content}
      {preview && (
        <div
          aria-hidden="true"
          className="pointer-events-none fixed z-[131] flex items-center justify-center rounded-xl border border-wb-border-strong bg-wb-bg-page p-2 shadow-xl"
          style={{ top: preview.top, left: preview.left, width: preview.size, height: preview.size }}
        >
          <SafeImage
            key={preview.item.id}
            src={preview.item.url}
            fallbackSrc={preview.item.thumb_url}
            compatiblePreview alt="" loading="eager" className="w-full h-full object-contain"
          />
        </div>
      )}
    </>,
    document.body,
  ) : content;
};
