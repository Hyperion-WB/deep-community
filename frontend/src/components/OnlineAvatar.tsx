import React from 'react';

/**
 * 头像 + 在线绿点。
 *
 * 只用于「人的主视觉位」（个人主页大头像、导航栏自己的头像），不铺到信息流每张卡片：
 * 一屏几十个绿点反而吵，而且列表有 30 秒缓存，在线状态会被冻住。
 *
 * 绿点只在明确在线时渲染——离线不画空心圈，避免"所有人都有个点"的视觉噪音。
 */
export const OnlineAvatar: React.FC<{
  online?: boolean;
  /** 头像像素尺寸，用于按比例决定圆点大小 */
  size?: number;
  /** 描边色跟随所在背景，避免深色卡片上出现突兀的浅色光圈 */
  ringClassName?: string;
  children: React.ReactNode;
}> = ({ online = false, size = 40, ringClassName = 'ring-wb-bg-page', children }) => {
  const dotClass = size >= 56 ? 'w-3.5 h-3.5' : size >= 32 ? 'w-3 h-3' : 'w-2.5 h-2.5';

  return (
    <span className="relative inline-flex shrink-0">
      {children}
      {online && (
        <span
          role="img"
          aria-label="在线"
          title="在线"
          className={`absolute bottom-0 right-0 ${dotClass} rounded-full bg-wb-success ring-2 ${ringClassName}`}
        />
      )}
    </span>
  );
};
