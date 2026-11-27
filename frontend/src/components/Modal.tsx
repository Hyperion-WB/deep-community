import React, { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { useOverlayEscape } from '../hooks/useDialogA11y';
import { acquireScrollLock, isTopOverlay } from '../utils/overlay';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  /** 卡片最大宽度类，默认 max-w-lg */
  widthClass?: string;
  /** 点击遮罩是否关闭 */
  maskClosable?: boolean;
  labelledBy?: string;
  zIndex?: number;
}

/**
 * 统一弹窗基座
 * - Portal 到 body：不受祖先 transform 影响，遮罩永远铺满视口
 * - ESC 关闭 / 遮罩关闭 / 打开时锁定背景滚动
 * - 焦点进入弹窗、Tab 循环，关闭后焦点归还
 * - 遮罩与卡片各自带进出场动画，AnimatePresence 会等退出完成
 */
export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  children,
  widthClass = 'max-w-lg',
  maskClosable = true,
  labelledBy,
  zIndex = 120,
}) => {
  const overlayId = useOverlayEscape(open, onClose, zIndex);
  const cardRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;

    // ESC 统一交给全局覆盖层栈，避免一次按键关掉多个叠加层
    const handleKey = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !isTopOverlay(overlayId)) return;
      const root = cardRef.current;
      if (!root) return;
      const focusables = root.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])'
      );
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };

    document.addEventListener('keydown', handleKey, true);
    const releaseLock = acquireScrollLock();
    // 焦点移入弹窗，避免键盘用户还停留在背后页面
    const focusTimer = window.setTimeout(() => {
      if (!isTopOverlay(overlayId)) return;
      const root = cardRef.current;
      const target = root?.querySelector<HTMLElement>(
        'button:not([disabled]), input, textarea, select, a[href]'
      );
      target?.focus?.();
    }, 30);

    return () => {
      document.removeEventListener('keydown', handleKey, true);
      window.clearTimeout(focusTimer);
      releaseLock();
      if (cardRef.current?.contains(document.activeElement) || document.activeElement === document.body) {
        previouslyFocused?.focus();
      }
    };
  }, [open, overlayId]);

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="modal-mask"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.16, ease: 'easeOut' }}
          style={{ zIndex }}
          className="fixed inset-0 flex items-center justify-center p-4 bg-black/60"
          onMouseDown={(event) => {
            if (maskClosable && event.target === event.currentTarget) onClose();
          }}
        >
          <motion.div
            ref={cardRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            initial={{ opacity: 0, scale: 0.96, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
            className={`w-full ${widthClass} max-h-[86vh] flex flex-col overflow-hidden frost-panel border border-wb-border-strong rounded-3xl shadow-2xl will-change-transform`}
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};
