/**
 * 图片缩略图地址。
 *
 * 帖子封面、九宫格、评论配图在列表里通常只占 100~400px，
 * 直接下发 1600 原图很浪费流量（实测一张 0.4MB，缩略图只要 20~40KB）。
 *
 * 复用后端 /users/avatar 的按需缩放接口：它只接受 /uploads/ 前缀、
 * 按 32 对齐生成派生图并落盘，nginx 再缓存 30 天。
 */
// 本站域名不做「外链」判定：从运行时 host 推导，避免把生产域名写死在源码里
const SITE_HOSTS: string[] = (() => {
  const hosts = new Set<string>();
  if (typeof window !== 'undefined' && window.location.host) hosts.add(window.location.host);
  const extra = (import.meta as any).env?.VITE_SITE_HOSTS as string | undefined;
  if (extra) extra.split(',').map((h) => h.trim()).filter(Boolean).forEach((h) => hosts.add(h));
  return [...hosts];
})();

/** 站外图片：实测单张可达 890KB，统一走后端代理缩放成 webp */
export const isExternalImage = (url: string): boolean =>
  /^https?:\/\//i.test(url) && !SITE_HOSTS.some((h) => url.includes(h));

export const thumbUrl = (url: string | null | undefined, width = 480): string => {
  const src = (url || '').trim();
  if (!src) return '';
  if (src.startsWith('/uploads/')) {
    return `/api/users/avatar?path=${encodeURIComponent(src)}&w=${width}`;
  }
  if (isExternalImage(src)) {
    // 列表/封面这类小尺寸场景走代理缩放；失败时由调用方 onError 回退原图
    return `/api/media/proxy?url=${encodeURIComponent(src)}&w=${width}`;
  }
  return src;
};

/** 生成 srcset：浏览器按容器宽度自动挑选 */
export const thumbSrcSet = (url: string | null | undefined, widths: number[] = [320, 640]): string => {
  const src = (url || '').trim();
  if (!src || !src.startsWith('/uploads/')) return '';
  return widths.map((w) => `${thumbUrl(src, w)} ${w}w`).join(', ');
};
