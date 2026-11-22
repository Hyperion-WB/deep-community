import React from 'react';

export const Skeleton: React.FC<{ className?: string }> = ({ className = '' }) => {
  return (
    <div
      className={`animate-pulse bg-wb-bg-subtle/80 rounded-xl ${className}`}
    />
  );
};

export const PostCardSkeleton: React.FC = () => {
  return (
    <div className="p-4 md:p-5 rounded-2xl surface border border-wb-border-subtle shadow-card space-y-2.5 select-none min-h-[112px]">
      {/* 头部作者信息骨架 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Skeleton className="w-9 h-9 rounded-full" />
          <div className="space-y-1.5">
            <Skeleton className="w-24 h-3.5" />
            <Skeleton className="w-16 h-2.5" />
          </div>
        </div>
        <Skeleton className="w-14 h-5 rounded-capsule" />
      </div>

      {/* 标题骨架 */}
      <Skeleton className="w-4/5 h-5 rounded-lg" />

      {/* 摘要文字骨架 */}
      <div className="space-y-2">
        <Skeleton className="w-full h-3 rounded" />
        <Skeleton className="w-5/6 h-3 rounded" />
      </div>

      {/* 底部互动栏骨架 */}
      <div className="pt-2 border-t border-wb-border-subtle flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Skeleton className="w-12 h-4 rounded-md" />
          <Skeleton className="w-12 h-4 rounded-md" />
          <Skeleton className="w-12 h-4 rounded-md" />
        </div>
        <Skeleton className="w-16 h-4 rounded-md" />
      </div>
    </div>
  );
};

export const PostDetailSkeleton: React.FC = () => {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 space-y-6 select-none animate-fade-in">
      <div className="p-6 sm:p-8 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-6">
        <div className="flex items-center gap-3">
          <Skeleton className="w-10 h-10 rounded-full" />
          <div className="space-y-2 flex-1">
            <Skeleton className="w-32 h-4" />
            <Skeleton className="w-20 h-3" />
          </div>
          <Skeleton className="w-20 h-7 rounded-capsule" />
        </div>
        <Skeleton className="w-3/4 h-8 rounded-xl" />
        <div className="space-y-3 pt-4 border-t border-wb-border-subtle">
          <Skeleton className="w-full h-4" />
          <Skeleton className="w-full h-4" />
          <Skeleton className="w-5/6 h-4" />
          <Skeleton className="w-2/3 h-4" />
          <Skeleton className="w-full h-32 rounded-2xl" />
        </div>
      </div>
    </div>
  );
};
