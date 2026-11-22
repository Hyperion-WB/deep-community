import React from 'react';

interface Props {
  level: number;
  status?: string;
  role?: string;
  size?: 'sm' | 'md';
}

export const LevelBadge: React.FC<Props> = ({ level, status, role, size = 'sm' }) => {
  const isProbation = status === 'probation';
  const sizeClass = size === 'sm' ? 'text-3xs px-2 py-0.5' : 'text-xs px-2.5 py-1';

  // 优先级最高的管理员专属徽章 (黑白冷钛极客风，无花哨彩色)
  if (role === 'super_admin' || role === 'admin') {
    return (
      <span className={`inline-flex items-center gap-1 font-mono font-bold rounded-capsule bg-wb-text-primary text-wb-bg-page border border-wb-text-primary shadow-sm ${sizeClass}`}>
        <span>★</span> 超级管理员
      </span>
    );
  }

  if (role === 'moderator') {
    return (
      <span className={`inline-flex items-center gap-1 font-mono font-semibold rounded-capsule bg-wb-capsule-track text-wb-text-primary border border-wb-border-strong ${sizeClass}`}>
        <span>◆</span> 版主
      </span>
    );
  }

  if (role === 'auditor') {
    return (
      <span className={`inline-flex items-center gap-1 font-mono font-medium rounded-capsule bg-wb-bg-subtle text-wb-text-primary border border-wb-border-subtle ${sizeClass}`}>
        <span>◈</span> 审计仲裁
      </span>
    );
  }

  if (isProbation) {
    return (
      <span className={`inline-flex items-center font-mono font-medium rounded-capsule bg-wb-bg-subtle text-wb-text-muted border border-wb-border-subtle ${sizeClass}`}>
        见习 Lv.0
      </span>
    );
  }

  // 纯黑白钛金属等级层阶
  let badgeStyle = "bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle";
  if (level >= 5) {
    badgeStyle = "bg-wb-text-primary text-wb-bg-page font-bold shadow-sm";
  } else if (level >= 3) {
    badgeStyle = "bg-wb-capsule-track text-wb-text-primary border-wb-border-strong font-semibold";
  }

  return (
    <span className={`inline-flex items-center font-mono font-semibold rounded-capsule border ${badgeStyle} ${sizeClass}`}>
      Lv.{level}
    </span>
  );
};

