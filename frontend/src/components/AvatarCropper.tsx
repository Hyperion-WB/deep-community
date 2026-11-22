import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, RotateCcw, X, ZoomIn } from 'lucide-react';

interface Props {
  /** 用户选中的原始文件；为空时不渲染 */
  file: File | null;
  /** 导出尺寸（正方形） */
  outputSize?: number;
  onCancel: () => void;
  onConfirm: (blob: Blob) => void;
}

const VIEW = 300; // 预览区边长（px）

/**
 * 头像裁剪。
 *
 * 头像框是正方形，直接拿用户整张图上传经常被裁掉半边脸。
 * 这里给一个「拖动 + 缩放」的裁剪框，确认后按正方形导出，
 * 拖出边界的部分会被自动夹回来，不会出现大片空白。
 */
export const AvatarCropper: React.FC<Props> = ({ file, outputSize = 512, onCancel, onConfirm }) => {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const dragRef = useRef<{ px: number; py: number; ox: number; oy: number } | null>(null);

  const [objectUrl, setObjectUrl] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [scale, setScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  // 载入图片
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setObjectUrl(url);
    setLoaded(false);
    setScale(1);
    setOffset({ x: 0, y: 0 });

    const img = new Image();
    img.onload = () => {
      imgRef.current = img;
      setLoaded(true);
    };
    img.src = url;

    return () => {
      URL.revokeObjectURL(url);
      imgRef.current = null;
    };
  }, [file]);

  // 绘制预览
  useEffect(() => {
    const canvas = canvasRef.current;
    const img = imgRef.current;
    if (!canvas || !img || !loaded) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = VIEW * dpr;
    canvas.height = VIEW * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, VIEW, VIEW);

    const base = Math.max(VIEW / img.width, VIEW / img.height);
    const w = img.width * base * scale;
    const h = img.height * base * scale;
    const maxX = Math.max(0, (w - VIEW) / 2);
    const maxY = Math.max(0, (h - VIEW) / 2);
    const ox = Math.min(maxX, Math.max(-maxX, offset.x));
    const oy = Math.min(maxY, Math.max(-maxY, offset.y));

    ctx.drawImage(img, VIEW / 2 - w / 2 + ox, VIEW / 2 - h / 2 + oy, w, h);
  }, [loaded, scale, offset, objectUrl]);

  if (!file) return null;

  // 导出正方形
  const handleConfirm = () => {
    const img = imgRef.current;
    if (!img) return;
    const out = document.createElement('canvas');
    out.width = outputSize;
    out.height = outputSize;
    const ctx = out.getContext('2d');
    if (!ctx) return;

    const k = outputSize / VIEW;
    const base = Math.max(VIEW / img.width, VIEW / img.height);
    const w = img.width * base * scale;
    const h = img.height * base * scale;
    const maxX = Math.max(0, (w - VIEW) / 2);
    const maxY = Math.max(0, (h - VIEW) / 2);
    const ox = Math.min(maxX, Math.max(-maxX, offset.x));
    const oy = Math.min(maxY, Math.max(-maxY, offset.y));

    // 白底：PNG 透明区域导出成 JPG 时不会变黑
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, outputSize, outputSize);
    ctx.drawImage(
      img,
      (VIEW / 2 - w / 2 + ox) * k,
      (VIEW / 2 - h / 2 + oy) * k,
      w * k,
      h * k
    );
    out.toBlob((blob) => blob && onConfirm(blob), 'image/jpeg', 0.92);
  };

  const stop = (e: React.SyntheticEvent) => e.stopPropagation();

  return createPortal(
    <div
      role="dialog"
      aria-label="裁剪头像"
      className="fixed inset-0 z-[220] flex items-center justify-center bg-black/80 backdrop-blur-md p-4"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onCancel();
      }}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-wb-bg-elevated border border-wb-border-subtle shadow-2xl p-4 space-y-3"
        onMouseDown={stop}
        onClick={stop}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-wb-text-primary">裁剪头像</h3>
          <button
            type="button"
            onClick={onCancel}
            className="p-1.5 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
            title="取消"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div
          className="relative mx-auto rounded-2xl overflow-hidden bg-wb-bg-subtle touch-none select-none"
          style={{ width: VIEW, height: VIEW, maxWidth: '100%' }}
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
            dragRef.current = { px: e.clientX, py: e.clientY, ox: offset.x, oy: offset.y };
          }}
          onPointerMove={(e) => {
            const d = dragRef.current;
            if (!d) return;
            setOffset({ x: d.ox + (e.clientX - d.px), y: d.oy + (e.clientY - d.py) });
          }}
          onPointerUp={() => {
            dragRef.current = null;
          }}
          onPointerCancel={() => {
            dragRef.current = null;
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: VIEW, height: VIEW, maxWidth: '100%' }}
            className="cursor-move"
          />
          {/* 圆形参考线 */}
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
            <div className="w-[248px] h-[248px] rounded-full ring-2 ring-white/70 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <ZoomIn className="w-4 h-4 text-wb-text-muted shrink-0" />
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={scale}
            onChange={(e) => setScale(Number(e.target.value))}
            className="flex-1 accent-wb-text-primary"
            aria-label="缩放"
          />
          <button
            type="button"
            onClick={() => {
              setScale(1);
              setOffset({ x: 0, y: 0 });
            }}
            className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
            title="重置"
          >
            <RotateCcw className="w-3.5 h-3.5" />
          </button>
        </div>

        <p className="text-3xs text-wb-text-muted text-center">
          拖动调整位置 · 滑杆缩放 · 圆形以外区域不会出现在头像里
        </p>

        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex-1 h-9 rounded-xl border border-wb-border-subtle text-xs font-semibold text-wb-text-secondary hover:bg-wb-bg-subtle transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!loaded}
            className="flex-1 h-9 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-bold inline-flex items-center justify-center gap-1.5 disabled:opacity-50 hover:opacity-90 transition-opacity"
          >
            <Check className="w-3.5 h-3.5" />
            使用这张
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
