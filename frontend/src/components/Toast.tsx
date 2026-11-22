import React, { createContext, useContext, useState, useCallback } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';
import { createPortal } from 'react-dom';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export interface ToastItem {
  id: string;
  type: ToastType;
  message: string;
  duration?: number;
}

export const formatToastMessage = (msg: any): string => {
  if (typeof msg === 'string') return msg;
  if (!msg) return '';
  if (Array.isArray(msg)) {
    return msg
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const loc = Array.isArray(item.loc) ? item.loc.join('.') : '';
          const m = item.msg || JSON.stringify(item);
          return loc ? `${loc}: ${m}` : m;
        }
        return String(item);
      })
      .join('; ');
  }
  if (typeof msg === 'object') {
    return msg.detail ? formatToastMessage(msg.detail) : (msg.msg || msg.message || JSON.stringify(msg));
  }
  return String(msg);
};

export interface ToastContextType {
  success: (msg: any, duration?: number) => void;
  error: (msg: any, duration?: number) => void;
  warning: (msg: any, duration?: number) => void;
  info: (msg: any, duration?: number) => void;
  toast: {
    success: (msg: any, duration?: number) => void;
    error: (msg: any, duration?: number) => void;
    warning: (msg: any, duration?: number) => void;
    info: (msg: any, duration?: number) => void;
  };
  addToast: (type: ToastType, message: any, duration?: number) => void;
  removeToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextType | null>(null);

export const useToast = () => {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error('useToast must be used within ToastProvider');
  }
  return ctx;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  const removeToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const addToast = useCallback((type: ToastType, rawMessage: any, duration = 3200) => {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const message = formatToastMessage(rawMessage);
    // 相同内容 3 秒内只弹一次，避免连续失败时刷屏
    setToasts((prev) => {
      const now = Date.now();
      const dup = prev.some((t) => t.message === message && now - (t as any).createdAt < 3000);
      if (dup) return prev;
      return [...prev.slice(-3), { id, type, message, duration, createdAt: now } as any];
    });
    if (duration > 0) {
      setTimeout(() => {
        removeToast(id);
      }, duration);
    }
  }, [removeToast]);

  const toast = {
    success: (msg: any, d?: number) => addToast('success', msg, d),
    error: (msg: any, d?: number) => addToast('error', msg, d),
    warning: (msg: any, d?: number) => addToast('warning', msg, d),
    info: (msg: any, d?: number) => addToast('info', msg, d),
  };

  const contextValue: ToastContextType = {
    ...toast,
    toast,
    addToast,
    removeToast,
  };

  const getIcon = (type: ToastType) => {
    switch (type) {
      case 'success':
        return <CheckCircle2 className="w-4 h-4 text-wb-success flex-shrink-0" />;
      case 'error':
        return <XCircle className="w-4 h-4 text-wb-danger flex-shrink-0" />;
      case 'warning':
        return <AlertTriangle className="w-4 h-4 text-wb-warn flex-shrink-0" />;
      default:
        return <Info className="w-4 h-4 text-wb-info flex-shrink-0" />;
    }
  };

  return (
    <ToastContext.Provider value={contextValue}>
      {children}
      {/* 浮动 Toast 容器：portal 到 body，避免被 portal 在 body 层的抽屉/弹窗遮住 */}
      {createPortal(
        <div role="status" aria-live="polite" aria-atomic="false" className="fixed top-5 inset-x-0 z-[9999] flex flex-col items-center pointer-events-none px-4 space-y-2">
        <AnimatePresence>
          {toasts.map((item) => (
            <motion.div
              key={item.id}
              initial={{ opacity: 0, y: -20, scale: 0.9 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -16, scale: 0.95 }}
              transition={{ type: 'spring', stiffness: 450, damping: 32 }}
              className="pointer-events-auto flex items-center gap-2.5 px-4 py-2.5 max-w-sm sm:max-w-md bg-wb-bg-surface/96 backdrop-blur-2xl border border-wb-border-strong rounded-capsule shadow-[0_10px_30px_rgba(0,0,0,0.18)] dark:shadow-[0_14px_36px_rgba(0,0,0,0.6)] text-xs text-wb-text-primary select-none font-sans"
            >
              {getIcon(item.type)}
              <span className="font-medium leading-relaxed break-words">{item.message}</span>
              <button
                type="button"
                onClick={() => removeToast(item.id)}
                className="ml-1 text-wb-text-muted hover:text-wb-text-primary p-0.5 rounded-full hover:bg-wb-bg-subtle transition-colors"
                title="关闭"
              >
                <X className="w-3 h-3" />
              </button>
            </motion.div>
          ))}
        </AnimatePresence>
        </div>,
        document.body
      )}
    </ToastContext.Provider>
  );
};
