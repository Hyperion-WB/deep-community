import React, { useState } from 'react';
import { Plus, ZoomIn } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';

/**
 * 评论配图：气泡里只放 96px 缩略图，点击才开大图。
 * 评论区本来就密，直接铺原图会把一屏评论撑成图片墙。
 *
 * 表情（kind=sticker）额外提供「收藏」，收藏即复制到自己的表情库（上限 30）。
 */
export const CommentMedia: React.FC<{
  url: string;
  kind?: string;
  onOpen: (src: string) => void;
}> = ({ url, kind, onOpen }) => {
  const isSticker = kind === 'sticker';
  const toast = useToast();
  const [collecting, setCollecting] = useState(false);

  const handleCollect = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (collecting) return;
    setCollecting(true);
    try {
      await apiClient.post('/stickers/collect', { url });
      toast.success('已收藏到「我的表情」');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '收藏失败，请先登录');
    } finally {
      setCollecting(false);
    }
  };

  return (
    <div
      className={`group/media relative mt-1.5 w-24 h-24 rounded-xl transition-colors ${
        isSticker ? 'hover:bg-wb-bg-subtle/60' : 'border border-wb-border-subtle hover:border-wb-border-strong'
      }`}
    >
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          onOpen(url);
        }}
        title={isSticker ? '查看表情' : '查看大图'}
        className="w-full h-full overflow-hidden rounded-xl"
      >
        <img
          src={url}
          alt=""
          loading="lazy"
          decoding="async"
          className={`w-full h-full ${isSticker ? 'object-contain' : 'object-cover'}`}
        />
        <span className="absolute right-1 top-1 p-0.5 rounded bg-black/45 text-white opacity-0 group-hover/media:opacity-100 transition-opacity">
          <ZoomIn className="w-2.5 h-2.5" />
        </span>
      </button>

      {isSticker && (
        <button
          type="button"
          onClick={handleCollect}
          title="收藏这个表情"
          className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-wb-text-primary text-wb-bg-page items-center justify-center shadow hidden group-hover/media:flex"
        >
          <Plus className="w-3 h-3" />
        </button>
      )}
    </div>
  );
};
