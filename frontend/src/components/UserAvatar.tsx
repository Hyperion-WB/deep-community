import React, { useEffect, useRef, useState, useMemo } from 'react';

interface Props {
  username?: string | null;
  avatarUrl?: string | null;
  size?: number | 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  alt?: string;
  /** 首屏关键头像：立即加载并提高抓取优先级，避免 LCP 被懒加载拖慢 */
  priority?: boolean;
}

// 质感冷曜石与钛金属高对比极客色系
const PALETTES = [
  { bg: '#0d1117', fg: '#e6edf3' },
  { bg: '#161b22', fg: '#58a6ff' },
  { bg: '#1f242c', fg: '#7ee787' },
  { bg: '#181a20', fg: '#d2a8ff' },
  { bg: '#12161f', fg: '#ffa657' },
  { bg: '#1b1f24', fg: '#f0883e' },
  { bg: '#141820', fg: '#79c0ff' },
  { bg: '#1e2229', fg: '#f3f4f6' },
];

/**
 * DJB2 字符串哈希算法
 */
function hashString(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash; // Convert to 32bit integer
  }
  return Math.abs(hash);
}

export const UserAvatar: React.FC<Props> = ({
  username = '',
  avatarUrl,
  size = 'md',
  className = '',
  alt,
  priority = false,
}) => {
  const [imgError, setImgError] = useState(false);

  const cleanUsername = (username || 'geek').trim();

  // 尺寸映射 (像素)
  const pixelSize = useMemo(() => {
    if (typeof size === 'number') return size;
    switch (size) {
      case 'xs': return 22;
      case 'sm': return 30;
      case 'md': return 38;
      case 'lg': return 52;
      case 'xl': return 72;
      default: return 38;
    }
  }, [size]);

  // 生成 GitHub 风格 5x5 轴对称哈希矩阵
  const { grid, colors } = useMemo(() => {
    const hash = hashString(cleanUsername);
    const colorIndex = hash % PALETTES.length;
    const colors = PALETTES[colorIndex];

    // 5 行 x 3 列 = 15 个独立判断点，左右对称复制到第 4、5 列
    const grid: boolean[][] = [];
    for (let r = 0; r < 5; r++) {
      const row: boolean[] = [];
      for (let c = 0; c < 3; c++) {
        // 利用 hash 的不同位判断是否填充
        const bit = ((hash >> (r * 3 + c)) & 1) === 1;
        row.push(bit);
      }
      // 对称镜像: 0 1 2 1 0
      grid.push([row[0], row[1], row[2], row[1], row[0]]);
    }
    return { grid, colors };
  }, [cleanUsername]);

  // 本站头像走按需缩放接口：64 / 128 / 256 三档，避免 20px 的头像也下发 512 原图
  const isLocalUpload = Boolean(avatarUrl && avatarUrl.startsWith('/uploads'));
  const variantW = pixelSize <= 40 ? 64 : pixelSize <= 80 ? 128 : 256;
  const [useOriginalSrc, setUseOriginalSrc] = useState(false);
  // 缩放图请求被限流（429）时先延迟重试一次，直接退回原图会让头像列表更慢更卡
  const [retryTick, setRetryTick] = useState(0);
  const retryTimerRef = useRef<number | null>(null);
  useEffect(() => () => {
    if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
  }, []);
  const imgSrc = isLocalUpload && !useOriginalSrc
    ? `/api/users/avatar?path=${encodeURIComponent(avatarUrl as string)}&w=${variantW}${retryTick ? `&r=${retryTick}` : ''}`
    : avatarUrl;

  const isValidUrl =
    avatarUrl &&
    avatarUrl.trim() !== '' &&
    !avatarUrl.includes('default_avatar') &&
    !imgError &&
    (avatarUrl.startsWith('http') || avatarUrl.startsWith('/uploads') || avatarUrl.startsWith('data:image'));

  if (isValidUrl) {
    return (
      <img data-avatar
        src={imgSrc as string}
        alt={alt || cleanUsername}
        loading={priority ? 'eager' : 'lazy'}
        fetchPriority={priority ? 'high' : 'auto'}
        decoding="async"
        onError={() => {
          // 首次失败大概率是被限流（429）或瞬时断网：先延迟重试同一张派生图；
          // 仍失败才退回原图，最后才降级成 Identicon。
          if (isLocalUpload && !useOriginalSrc) {
            if (retryTick === 0) {
              if (retryTimerRef.current) window.clearTimeout(retryTimerRef.current);
              retryTimerRef.current = window.setTimeout(() => setRetryTick(1), 800);
              return;
            }
            setUseOriginalSrc(true);
            return;
          }
          setImgError(true);
        }}
        className={`rounded-capsule object-cover flex-shrink-0 select-none ${className}`}
        style={{ width: `${pixelSize}px`, height: `${pixelSize}px` }}
      />
    );
  }

  // 纯 SVG GitHub 官方同构 Identicon 渲染 (0 外部依赖，永不出错)
  const cellSize = 14;
  const padding = 5;
  const totalViewBox = cellSize * 5 + padding * 2;

  return (
    <svg
      viewBox={`0 0 ${totalViewBox} ${totalViewBox}`}
      width={pixelSize}
      height={pixelSize}
      className={`rounded-capsule flex-shrink-0 select-none overflow-hidden shadow-sm border border-wb-border-subtle ${className}`}
      aria-label={cleanUsername}
    >
      <title>{cleanUsername}</title>
      {/* 质感底色 */}
      <rect width={totalViewBox} height={totalViewBox} fill={colors.bg} />
      
      {/* 5x5 对称像素块 */}
      {grid.map((row, rIdx) =>
        row.map((isFilled, cIdx) => {
          if (!isFilled) return null;
          return (
            <rect
              key={`${rIdx}-${cIdx}`}
              x={padding + cIdx * cellSize}
              y={padding + rIdx * cellSize}
              width={cellSize}
              height={cellSize}
              fill={colors.fg}
              rx={1}
            />
          );
        })
      )}
    </svg>
  );
};
