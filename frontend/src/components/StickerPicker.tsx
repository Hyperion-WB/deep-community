import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ImagePlus, Loader2, Trash2, X } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { SafeImage } from './SafeImage';

interface StickerItem {
  id: string;
  url: string;
  thumb_url: string;
  is_animated: boolean;
  source: string;
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  /** 选中表情后回调（直接把 url 作为图片发送） */
  onSelect: (url: string) => void;
}

/**
 * 我的表情面板。
 * 列表用缩略图（动图首帧）渲染，hover 才换成动图本体——
 * 一次铺开三十个动图会把浏览器直接卡住。
 */
export const StickerPicker: React.FC<Props> = ({ isOpen, onClose, onSelect }) => {
  const toast = useToast();
  const [items, setItems] = useState<StickerItem[]>([]);
  const [used, setUsed] = useState(0);
  const [limit, setLimit] = useState(30);
  const [loading, setLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/stickers/mine');
      setItems(Array.isArray(res.data?.items) ? res.data.items : []);
      setUsed(res.data?.used ?? 0);
      setLimit(res.data?.limit ?? 30);
    } catch {
      /* 未登录等情况静默 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) load();
  }, [isOpen, load]);

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
      toast.success('已删除');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '删除失败');
    }
  };

  // 点击面板外部关闭：面板现在是浮在视口中的独立层，不再依赖父容器的定位
  useEffect(() => {
    if (!isOpen) return;
    const onDown = (event: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    // fixed 定位而不是 absolute：评论输入框很窄，absolute 展开会被卡片边框裁掉一半
    <div
      ref={panelRef}
      className="fixed z-[120] bottom-24 left-1/2 -translate-x-1/2 w-[min(92vw,24rem)] p-4 rounded-2xl frost border border-wb-border-strong shadow-2xl space-y-3"
    >
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-wb-text-primary">我的表情</span>
        <div className="flex items-center gap-2">
          <span className="text-2xs text-wb-text-muted font-mono">
            {used}/{limit}
          </span>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {loading ? (
        <div className="py-8 flex items-center justify-center gap-2 text-2xs text-wb-text-muted">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载中…
        </div>
      ) : items.length === 0 ? (
        <p className="py-6 text-center text-2xs text-wb-text-muted leading-relaxed">
          还没有表情
          <br />
          点下方按钮上传，支持 GIF 动图
        </p>
      ) : (
        <div className="grid grid-cols-5 gap-2 max-h-56 overflow-y-auto pr-1">
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
                  onSelect(item.url);
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

      <button
        type="button"
        disabled={uploading || used >= limit}
        onClick={() => fileRef.current?.click()}
        className="w-full h-9 rounded-xl border border-dashed border-wb-border-strong text-2xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
      >
        {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
        {used >= limit ? `已达上限 ${limit} 个` : uploading ? '正在压缩并上传…' : '上传表情（GIF 会自动压缩）'}
      </button>

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
};
