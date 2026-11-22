import { useRef, useState } from 'react';
import type { DragEvent } from 'react';

/** 判断拖拽载荷里是否真的含有文件（纯文本拖选不应触发上传提示） */
function hasFiles(e: DragEvent): boolean {
  try {
    return Array.from(e.dataTransfer?.types || []).includes('Files');
  } catch {
    return false;
  }
}

/** 从 DataTransfer 里取第一张图片；与 Ctrl+V 共用同一套上传回调 */
function firstImage(e: DragEvent): File | null {
  const files = Array.from(e.dataTransfer?.files || []);
  return files.find((f) => f.type.startsWith('image/')) || null;
}

/**
 * 图片拖拽上传区：返回 dragging 状态与一组可直接展开到容器上的事件处理器。
 *
 * 用 enter/leave 计数避免子元素触发的 dragleave 让高亮闪烁；
 * 只对含文件的拖拽 preventDefault，纯文本拖拽保持浏览器默认行为，
 * 因此与 Ctrl+V 粘贴上传、文本选区拖拽互不冲突。
 */
export function useImageDrop(onFile: (file: File) => void) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const handlers = {
    onDragEnter: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    onDragOver: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'copy'; } catch { /* 忽略 */ }
      if (!dragging) setDragging(true);
    },
    onDragLeave: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    },
    onDrop: (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const file = firstImage(e);
      if (file) onFile(file);
    },
  };

  return { dragging, handlers, reset: () => { depth.current = 0; setDragging(false); } };
}

/** 拖拽进行时的高亮浮层，各输入区共用同一套视觉反馈 */
export const DROP_HINT_CLASS =
  'absolute inset-0 z-20 flex items-center justify-center gap-2 rounded-2xl ' +
  'border-2 border-dashed border-wb-brand bg-wb-brand/10 backdrop-blur-[2px] ' +
  'text-2xs font-semibold text-wb-brand pointer-events-none animate-in fade-in duration-150';
