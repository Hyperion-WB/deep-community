import React from 'react';
import { RotateCcw } from 'lucide-react';

/** 卡片/墙类组件的统一错误态，避免把「接口挂了」伪装成「没有数据」。 */
export const InlineErrorState: React.FC<{
  onRetry: () => void;
  label?: string;
  compact?: boolean;
}> = ({ onRetry, label = '加载失败，请稍后再试', compact = false }) => (
  <div
    role="alert"
    className={`flex flex-col items-center justify-center gap-2 text-center rounded-2xl border border-wb-border-subtle bg-wb-bg-subtle/50 ${compact ? 'py-4' : 'py-8'}`}
  >
    <span className="text-2xs text-wb-text-muted">{label}</span>
    <button
      type="button"
      onClick={onRetry}
      className="inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-colors"
    >
      <RotateCcw className="w-3 h-3" />
      重试
    </button>
  </div>
);
