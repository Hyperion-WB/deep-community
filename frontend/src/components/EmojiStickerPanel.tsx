import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ImagePlus, Loader2, Smile, Trash2, X } from 'lucide-react';
import { apiClient } from '../api/client';
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

type Tab = 'emoji' | 'sticker';

/**
 * 统一的表情面板：常用表情 + 我的表情。
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
    const width = Math.min(window.innerWidth * 0.94, 416);

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
    // 面板内容（我的表情列表）加载后高度会变，再校准一次
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
  const [hovered, setHovered] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/stickers/mine');
      setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      setUsed(res.data?.used ?? 0);
      setLimit(res.data?.limit ?? 30);
    } catch {
      /* 未登录时静默 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

  // 切页签、列表加载完成都会改变面板高度，需要重新贴合按钮
  useEffect(() => {
    if (!isOpen) return;
    const raf = window.requestAnimationFrame(reposition);
    return () => window.cancelAnimationFrame(raf);
  }, [isOpen, tab, items.length, loading, reposition]);

  useEffect(() => {
    if (!isOpen) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) {
        // 点的是触发按钮：交给按钮自己切换开合，否则 mousedown 先关、click 又开，按钮就永远关不掉面板
        if (anchor?.contains(event.target as Node)) return;
        onClose();
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
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
      className="fixed z-[130] w-[min(94vw,26rem)] rounded-2xl frost border border-wb-border-strong shadow-2xl overflow-hidden"
    >
      {/* 顶部两个页签 */}
      <div className="flex items-center justify-between px-3 pt-2.5 pb-0">
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
            <span className="ml-1 text-2xs opacity-70 font-mono">
              {used}/{limit}
            </span>
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

      <div className="p-3 max-h-[17rem] overflow-y-auto overscroll-contain">
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
            {items.map((item) => (
              <div
                key={item.id}
                className="group/sticker relative"
                onMouseEnter={() => setHovered(item.id)}
                onMouseLeave={() => setHovered(null)}
              >
                <button
                  type="button"
                  onClick={() => {
                    onSelectSticker(item.url);
                    onClose();
                  }}
                  className="w-full aspect-square rounded-lg hover:bg-wb-bg-subtle p-1 transition-colors"
                >
                  <SafeImage
                    src={item.is_animated && hovered === item.id ? item.url : item.thumb_url || item.url}
                    fallbackSrc={item.is_animated && hovered === item.id ? item.thumb_url : item.url}
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
        <div className="px-3 pb-3">
          <button
            type="button"
            disabled={uploading || used >= limit}
            onClick={() => fileRef.current?.click()}
            className="w-full h-9 rounded-xl border border-dashed border-wb-border-strong text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
            {used >= limit ? `已达上限 ${limit} 个` : uploading ? '正在压缩并上传…' : '上传表情（GIF 自动压缩）'}
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

  return typeof document !== 'undefined' ? createPortal(content, document.body) : content;
};
