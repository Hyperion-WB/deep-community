import React, { useState } from 'react';
import { ImageOff } from 'lucide-react';
import { getCompatibleImageSource } from '../utils/cdn';

/**
 * 带加载失败兜底的 <img>。
 *
 * /uploads/ 资源可能因本地卷缺失 + 对象存储回源失败而 404，
 * 裸 <img> 会显示破图。这里按「缩略图 → 原图 → 占位」三级降级，
 * 占位保持原尺寸与圆角，不会撑破布局。
 */
interface Props extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | null;
  /** 缩略图失败时尝试的备用地址（通常传原图） */
  fallbackSrc?: string;
  /** 原图与备用图都无法解码时，尝试本站上传图的 PNG 首帧。 */
  compatiblePreview?: boolean;
  /** 完全失败时自定义占位内容 */
  fallback?: React.ReactNode;
  /** 占位容器额外类名（一般传与 img 相同的尺寸/圆角类） */
  wrapperClassName?: string;
}

export const SafeImage: React.FC<Props> = ({
  src, fallbackSrc, compatiblePreview, fallback, className = '', wrapperClassName = '', alt = '', srcSet, ...rest
}) => {
  const original = compatiblePreview ? getCompatibleImageSource(src) : undefined;
  const alternate = compatiblePreview ? getCompatibleImageSource(fallbackSrc) : undefined;
  const primary = original?.localPath || src;
  const backup = alternate?.localPath || fallbackSrc;
  const sources = Array.from(new Set([primary, backup, alternate?.preview, original?.preview].filter(Boolean)));
  if (srcSet && primary && (!backup || backup === primary)) sources.splice(1, 0, primary);
  const sourcesKey = JSON.stringify([sources, srcSet]);
  const [failure, setFailure] = useState({ sourcesKey, attempt: 0 });
  if (failure.sourcesKey !== sourcesKey) setFailure({ sourcesKey, attempt: 0 });
  const attempt = failure.attempt;
  const current = sources[attempt];

  if (!current) {
    if (fallback) return <>{fallback}</>;
    return (
      <span className={`inline-flex items-center justify-center bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted ${className} ${wrapperClassName}`}
            role="img" aria-label={`${alt} 加载失败`}>
        <ImageOff className="w-1/3 h-1/3 opacity-70" />
      </span>
    );
  }

  // 动图不要 lazy：滚动时浏览器可能把离屏的 GIF 解码结果回收，
  // 回到视口重新解码会让动画从第一帧重播，看上去就是「闪烁」。
  const isGif = /\.gif(\?|#|$)/i.test(current || '');

  return (
    <img
      {...rest}
      key={`${sourcesKey}-${attempt}`}
      srcSet={attempt === 0 ? srcSet : undefined}
      src={current}
      alt={alt}
      className={className}
      loading={rest.loading ?? (isGif ? 'eager' : 'lazy')}
      decoding={rest.decoding ?? (isGif ? 'sync' : 'async')}
      onError={() => setFailure({ sourcesKey, attempt: attempt + 1 })}
    />
  );
};
