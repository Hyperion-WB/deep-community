import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import { Modal } from './Modal';
import { AlertTriangle, Info, X } from 'lucide-react';

export interface ConfirmOptions {
  title?: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

interface ConfirmContextType {
  confirm: (options?: ConfirmOptions | string) => Promise<boolean>;
}

const ConfirmContext = createContext<ConfirmContextType | null>(null);

export const useConfirm = () => {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error('useConfirm must be used within ConfirmProvider');
  }
  return ctx.confirm;
};

export const ConfirmProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [options, setOptions] = useState<ConfirmOptions>({});
  const resolveRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((opts?: ConfirmOptions | string): Promise<boolean> => {
    return new Promise((resolve) => {
      // 并发保护：上一个确认尚未处理时，立即以 false 释放旧的 Promise，
      // 避免调用方 await 永远挂起
      if (resolveRef.current) {
        const stale = resolveRef.current;
        resolveRef.current = null;
        stale(false);
      }
      resolveRef.current = resolve;
      if (typeof opts === 'string') {
        setOptions({
          title: '操作确认',
          description: opts,
          confirmText: '确定',
          cancelText: '取消',
          danger: false,
        });
      } else {
        setOptions({
          title: opts?.title || '操作确认',
          description: opts?.description || '您确定要继续此操作吗？',
          confirmText: opts?.confirmText || '确定',
          cancelText: opts?.cancelText || '取消',
          danger: opts?.danger ?? false,
        });
      }
      setIsOpen(true);
    });
  }, []);

  const handleConfirm = () => {
    setIsOpen(false);
    if (resolveRef.current) {
      resolveRef.current(true);
      resolveRef.current = null;
    }
  };

  const handleCancel = () => {
    setIsOpen(false);
    if (resolveRef.current) {
      resolveRef.current(false);
      resolveRef.current = null;
    }
  };

  const modalElement = (
    <Modal open={isOpen} onClose={handleCancel} widthClass="max-w-sm sm:max-w-md">
      <div className="relative p-6">
        <button
          type="button"
          onClick={handleCancel}
          className="absolute top-5 right-5 p-1.5 text-wb-text-muted hover:text-wb-text-primary rounded-xl hover:bg-wb-bg-subtle transition-colors"
          title="关闭"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="flex items-start gap-3.5 mb-4">
          <div
            className={`p-2.5 rounded-2xl flex-shrink-0 ${
              options.danger
                ? 'bg-wb-danger/10 text-wb-danger border border-wb-danger/20'
                : 'bg-wb-bg-surface text-wb-text-primary border border-wb-border-subtle'
            }`}
          >
            {options.danger ? (
              <AlertTriangle className="w-5 h-5" />
            ) : (
              <Info className="w-5 h-5" />
            )}
          </div>
          <div className="space-y-1.5 pr-6">
            <h3 className="text-base font-semibold text-wb-text-primary tracking-tight">
              {options.title}
            </h3>
            {options.description && (
              <p className="text-xs sm:text-sm text-wb-text-secondary leading-relaxed">
                {options.description}
              </p>
            )}
          </div>
        </div>

        <div className="mt-6 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={handleCancel}
            className="wb-pressable px-4 py-2 text-xs font-medium rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-colors"
          >
            {options.cancelText}
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            className={`wb-pressable px-4 py-2 text-xs font-semibold rounded-capsule transition-all shadow-sm ${
              options.danger
                ? 'bg-wb-danger hover:opacity-90 text-white'
                : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90'
            }`}
          >
            {options.confirmText}
          </button>
        </div>
      </div>
    </Modal>
  );

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {modalElement}
    </ConfirmContext.Provider>
  );
};
