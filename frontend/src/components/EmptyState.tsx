import React from 'react';

interface Props {
  icon?: React.ReactNode;
  title: string;
  hint?: string;
  action?: React.ReactNode;
  /** 紧凑模式：用于卡片内部的小空态 */
  compact?: boolean;
}

/**
 * 全站统一空态。
 * 此前各页面各写一套（图标大小、padding、语气都不同），抽出来复用后风格自然一致。
 */
export const EmptyState: React.FC<Props> = ({ icon, title, hint, action, compact = false }) => (
  <div
    className={`text-center text-wb-text-muted flex flex-col items-center justify-center gap-1.5 ${
      compact ? 'py-5' : 'py-8'
    }`}
  >
    {icon && (
      <div className="relative mb-1 flex items-center justify-center">
        {/* 柔和光斑 + 极细描边圆：给空态一个视觉锚点，不再是孤零零一个图标 */}
        <span
          aria-hidden
          className="absolute h-12 w-12 rounded-full"
          style={{
            background:
              'radial-gradient(circle, color-mix(in srgb, var(--wb-text-primary) 8%, transparent), transparent 70%)',
          }}
        />
        <span
          aria-hidden
          className="absolute h-9 w-9 rounded-full border border-dashed"
          style={{ borderColor: 'color-mix(in srgb, var(--wb-text-primary) 14%, transparent)' }}
        />
        <div className="relative opacity-45 [&>svg]:w-5 [&>svg]:h-5">{icon}</div>
      </div>
    )}
    <p className="text-xs">{title}</p>
    {hint && <p className="text-3xs text-wb-text-muted/70">{hint}</p>}
    {action && <div className="pt-1">{action}</div>}
  </div>
);
