import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Minus, Plus, RotateCcw, X, Download, Loader2, Check, Locate } from 'lucide-react';
import { useOverlayEscape } from '../hooks/useDialogA11y';
import { acquireScrollLock, isTopOverlay } from '../utils/overlay';
import { cdnUrl, getCompatibleImageSource } from '../utils/cdn';
import { downloadImageAs, SAVE_FORMAT_OPTIONS } from '../utils/imageDownload';
import type { SaveFormat } from '../utils/imageDownload';

interface Props {
  /** 图片地址；为空时不渲染 */
  src: string | null;
  alt?: string;
  onClose: () => void;
  /** 图集切换（不传则不显示左右按钮） */
  onPrev?: () => void;
  onNext?: () => void;
  index?: number;
  total?: number;
  /** 定位：关闭查看器并跳回这条图片在聊天记录中的原始位置 */
  onLocate?: () => void;
}

const MIN_SCALE = 1;
const MAX_SCALE = 4;

/**
 * 图片大图预览。
 *
 * 支持：滚轮缩放（1~4 倍）、双击 1x/2.5x 切换、放大后拖动平移、
 * 左右方向键 / 按钮切换图集、ESC 或点击背景关闭。
 *
 * 聊天图片与评论配图此前用的是「只能看不能缩放」的简化版，
 * 这里统一成一套，避免不同入口体验不一致。
 */
export const ImageLightbox: React.FC<Props> = ({
  src,
  alt,
  onClose,
  onPrev,
  onNext,
  index = 0,
  total = 0,
  onLocate,
}) => {
  const [scale, setScale] = useState(1);
  // 保存为 JPG / PNG / 原图 WebP
  const [saveMenuOpen, setSaveMenuOpen] = useState(false);
  const [savingFormat, setSavingFormat] = useState<SaveFormat | null>(null);
  const [saveNote, setSaveNote] = useState('');

  const handleSave = async (format: SaveFormat) => {
    if (!src || savingFormat) return;
    setSaveMenuOpen(false);
    setSavingFormat(format);
    try {
      const downloadSrc = format === 'webp' && currentSrc === compatiblePreview ? src : currentSrc || src;
      const result = await downloadImageAs(downloadSrc, format);
      const label = format === 'jpeg' ? 'JPG' : format === 'png' ? 'PNG' : 'WebP';
      setSaveNote(result.fallback ? '该图受跨域限制，已保存为原始格式' : `已保存为 ${label}（${result.filename}）`);
    } catch {
      setSaveNote('保存失败，可右键图片另存为');
    } finally {
      setSavingFormat(null);
      window.setTimeout(() => setSaveNote(''), 2800);
    }
  };

  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);
  const [imgState, setImgState] = useState<'loading' | 'loaded' | 'error'>('loading');
  const [retryKey, setRetryKey] = useState(0);
  // 按原图、既有派生图、PNG 首帧的顺序加载。
  const [srcIndex, setSrcIndex] = useState(0);
  const { candidates, compatiblePreview } = React.useMemo(() => {
    const raw = (src || '').trim();
    const compatible = getCompatibleImageSource(raw);
    const local = compatible?.localPath || (raw.startsWith('/uploads/') ? raw : undefined);
    const derived = local && `/api/users/avatar?path=${encodeURIComponent(local.split('?')[0])}&w=1024`;
    const candidates = Array.from(new Set([cdnUrl(raw), raw, local, derived, compatible?.preview].filter(Boolean)));
    return { candidates, compatiblePreview: compatible?.preview };
  }, [src]);
  const currentSrc = candidates[Math.min(srcIndex, Math.max(0, candidates.length - 1))] || '';
  const dragRef = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  // 双指缩放
  const pointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ dist: number; scale: number } | null>(null);

  // 换图 / 关闭时复位缩放，避免下一张图还停在放大状态
  useEffect(() => {
    setScale(1);
    setOffset({ x: 0, y: 0 });
    setImgState('loading');
    setRetryKey(0);
    setSrcIndex(0);
  }, [src]);

  useEffect(() => {
    if (scale <= 1.01 && (offset.x !== 0 || offset.y !== 0)) setOffset({ x: 0, y: 0 });
  }, [scale, offset.x, offset.y]);

  const open = Boolean(src);
  const overlayId = useOverlayEscape(open, () => {
    if (saveMenuOpen) setSaveMenuOpen(false);
    else onClose();
  }, 200);

  useEffect(() => {
    if (open) return acquireScrollLock();
  }, [open]);

  // 键盘：ESC 关闭、左右切换
  useEffect(() => {
    if (!open || (!onPrev && !onNext)) return;
    const onKey = (e: KeyboardEvent) => {
      if (!isTopOverlay(overlayId) || e.defaultPrevented) return;
      if (e.key === 'ArrowLeft') onPrev?.();
      if (e.key === 'ArrowRight') onNext?.();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, overlayId, onPrev, onNext]);

  // 滚轮缩放：passive:false 才能阻止页面跟着滚
  useEffect(() => {
    if (!open) return;
    const onWheel = (e: WheelEvent) => {
      if (!isTopOverlay(overlayId)) return;
      e.preventDefault();
      const step = e.deltaMode === 1 ? 0.08 : 0.0016;
      setScale((s) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s - e.deltaY * step)));
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [open, overlayId]);

  if (!src) return null;

  const pinchDistance = () => {
    const pts = Array.from(pointersRef.current.values());
    if (pts.length < 2) return 0;
    return Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
  };

  const toggleZoom = () => {
    if (scale > 1) {
      setScale(1);
      setOffset({ x: 0, y: 0 });
    } else {
      setScale(2.5);
    }
  };

  return createPortal(
    <div
      role="dialog"
      aria-label="图片预览"
      className="fixed inset-0 z-[200] flex items-center justify-center bg-black/90 backdrop-blur-md p-4 animate-in fade-in duration-150"
      onClick={() => {
        if (saveMenuOpen) { setSaveMenuOpen(false); return; }
        onClose();
      }}
      style={{ touchAction: 'none' }}
    >
      {/* 顶部工具条 */}
      <div
        className="absolute top-3 right-3 flex items-center gap-1.5 z-10"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={() => setScale((s) => Math.max(MIN_SCALE, s - 0.5))}
          disabled={scale <= 1}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors disabled:opacity-35"
          title="缩小"
        >
          <Minus className="w-4 h-4" />
        </button>
        <span className="min-w-[46px] text-center text-2xs font-mono text-white/80 select-none">
          {Math.round(scale * 100)}%
        </span>
        <button
          type="button"
          onClick={() => setScale((s) => Math.min(MAX_SCALE, s + 0.5))}
          disabled={scale >= MAX_SCALE}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors disabled:opacity-35"
          title="放大"
        >
          <Plus className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => {
            setScale(1);
            setOffset({ x: 0, y: 0 });
          }}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="还原"
        >
          <RotateCcw className="w-4 h-4" />
        </button>
        <button
          type="button"
          onClick={() => setSaveMenuOpen((v) => !v)}
          disabled={!!savingFormat}
          className={`w-9 h-9 rounded-full flex items-center justify-center transition-colors ${saveMenuOpen ? 'bg-white/25 text-white' : 'bg-white/10 hover:bg-white/20 text-white'}`}
          title="保存图片（可选 JPG / PNG / WebP）"
          aria-label="保存图片"
          aria-expanded={saveMenuOpen}
        >
          {savingFormat ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="w-9 h-9 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 保存格式菜单：整张图在 canvas 里重绘后再下载，无需后端转码 */}
      {saveMenuOpen && (
        <div
          className="absolute top-14 right-3 z-20 w-52 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-1.5 text-xs"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="px-2.5 py-1.5 text-3xs font-semibold text-wb-text-muted">保存为</div>
          {SAVE_FORMAT_OPTIONS.map((opt) => (
            <button
              key={opt.key}
              type="button"
              onClick={() => void handleSave(opt.key)}
              className="w-full text-left px-2.5 py-2 rounded-xl hover:bg-wb-bg-subtle transition-colors"
            >
              <span className="text-2xs font-semibold text-wb-text-primary">{opt.label}</span>
              <span className="block text-3xs text-wb-text-muted mt-0.5">{opt.hint}</span>
            </button>
          ))}
        </div>
      )}

      {saveNote && (
        <div className="absolute top-16 left-1/2 -translate-x-1/2 z-20 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-black/70 text-white text-2xs whitespace-nowrap">
          <Check className="w-3 h-3" />{saveNote}
        </div>
      )}

      {/* 图集切换 */}
      {onPrev && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPrev();
          }}
          className="absolute left-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center z-10"
          title="上一张"
        >
          <ChevronLeft className="w-5 h-5" />
        </button>
      )}
      {onNext && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNext();
          }}
          className="absolute right-3 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center z-10"
          title="下一张"
        >
          <ChevronRight className="w-5 h-5" />
        </button>
      )}

      {/* 加载中：骨架 + 转圈，避免大图没下来时一片黑 */}
      {imgState === 'loading' && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 pointer-events-none">
          <span className="w-8 h-8 border-2 border-white/70 border-t-transparent rounded-full animate-spin" />
          <span className="text-2xs text-white/60">图片加载中…</span>
        </div>
      )}

      {/* 加载失败：给出重试入口，而不是留一块空白 */}
      {imgState === 'error' && (
        <div className="flex flex-col items-center gap-3 px-6 text-center">
          <span className="text-sm text-white/80">图片加载失败</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setImgState('loading');
              setSrcIndex(0);
              setRetryKey((k) => k + 1);
            }}
            className="px-4 h-9 rounded-full bg-white/15 hover:bg-white/25 text-white text-xs font-semibold transition-colors"
          >
            点击重试
          </button>
          <a
            href={src}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(e) => e.stopPropagation()}
            className="text-2xs text-white/50 underline"
          >
            在新窗口打开
          </a>
        </div>
      )}

      <img
        key={`${retryKey}-${srcIndex}`}
        src={currentSrc}
        alt={alt || ''}
        draggable={false}
        onLoad={() => setImgState('loaded')}
        onError={() => {
          if (srcIndex < candidates.length - 1) {
            setSrcIndex((i) => i + 1);
            setImgState('loading');
          } else {
            setImgState('error');
          }
        }}
        onClick={(e) => e.stopPropagation()}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setSaveMenuOpen(true);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          toggleZoom();
        }}
        onPointerDown={(e) => {
          pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
          if (pointersRef.current.size === 2) {
            pinchRef.current = { dist: pinchDistance(), scale };
            dragRef.current = null;
            setDragging(false);
            return;
          }
          if (scale <= 1) return;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
          setDragging(true);
        }}
        onPointerMove={(e) => {
          if (!pointersRef.current.has(e.pointerId)) return;
          pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

          // 双指：按两指距离比例缩放
          if (pointersRef.current.size === 2 && pinchRef.current) {
            const dist = pinchDistance();
            if (pinchRef.current.dist > 0 && dist > 0) {
              const next = pinchRef.current.scale * (dist / pinchRef.current.dist);
              setScale(Math.min(MAX_SCALE, Math.max(MIN_SCALE, next)));
            }
            return;
          }

          const d = dragRef.current;
          if (!d) return;
          setOffset({ x: d.ox + (e.clientX - d.x), y: d.oy + (e.clientY - d.y) });
        }}
        onPointerUp={(e) => {
          pointersRef.current.delete(e.pointerId);
          if (pointersRef.current.size < 2) pinchRef.current = null;
          dragRef.current = null;
          setDragging(false);
        }}
        onPointerCancel={(e) => {
          pointersRef.current.delete(e.pointerId);
          if (pointersRef.current.size < 2) pinchRef.current = null;
          dragRef.current = null;
          setDragging(false);
        }}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          transition: dragging ? 'none' : 'transform 0.16s ease-out',
          cursor: scale > 1 ? (dragging ? 'grabbing' : 'grab') : 'zoom-in',
          opacity: imgState === 'loaded' ? 1 : 0,
        }}
        className="max-h-[85vh] max-w-[92vw] rounded-2xl shadow-2xl object-contain select-none"
      />

      {/* 定位到聊天记录（微信式：看完图直接跳回原消息位置） */}
      {onLocate && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); onLocate(); }}
          className="absolute bottom-11 left-1/2 -translate-x-1/2 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-white/12 hover:bg-white/22 text-white text-2xs font-medium shadow-lg backdrop-blur-sm transition-colors z-10"
          title="定位到这条图片在聊天中的位置"
        >
          <Locate className="w-3.5 h-3.5" /> 定位到聊天记录
        </button>
      )}

      {/* 底部说明 */}
      <div
        className="absolute bottom-3 left-0 right-0 text-center text-2xs text-white/55 select-none pointer-events-none"
        onClick={(e) => e.stopPropagation()}
      >
        {total > 1 ? `${index + 1} / ${total} · ` : ''}
        滚轮 / 双击 / 双指缩放 · 放大后可拖动{total > 1 ? ' · 左右键切换' : ''} · ESC 关闭
      </div>
    </div>,
    document.body
  );
};
