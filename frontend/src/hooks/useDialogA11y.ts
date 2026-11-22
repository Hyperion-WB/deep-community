import { useEffect, useId, useRef } from 'react';
import { acquireScrollLock, registerEsc } from '../utils/overlay';

/**
 * 手写弹窗的无障碍与交互补全：
 * - role="dialog" / aria-modal 由调用方绑定；
 * - Esc 关闭、背景滚动锁定、Tab 焦点循环、关闭后焦点归还触发元素。
 *
 * 用法：
 *   const dialogRef = useDialogA11y(open, onClose);
 *   <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="...">
 */
export function useDialogA11y(open: boolean, onClose: () => void) {
  const overlayId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    if (!open) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const releaseLock = acquireScrollLock();
    const unregisterEsc = registerEsc(overlayId, () => onCloseRef.current());

    const getFocusable = (): HTMLElement[] => {
      const root = containerRef.current;
      if (!root) return [];
      return Array.from(
        root.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
    };

    // ESC 由全局栈处理
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);

    // 等一帧再聚焦，确保弹窗内容已完成渲染
    const focusTimer = window.setTimeout(() => {
      const focusable = getFocusable();
      (focusable[0] || containerRef.current)?.focus?.();
    }, 30);

    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      unregisterEsc();
      releaseLock();
      window.clearTimeout(focusTimer);
      previouslyFocused?.focus?.();
    };
  }, [open, overlayId]);

  return containerRef;
}
