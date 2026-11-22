import { apiClient } from '../api/client';

const KEY = 'wb:cdn_domain';
const UPLOAD_IMAGE_PATH = /\/uploads\/((?:stickers|[0-9]{4}\/[0-9]{2})\/[a-f0-9]{32}\.(?:webp|png|gif))$/;

/** 启动时从服务端读取公开 CDN 域名（只在配置了对象存储镜像时有值）。 */
export const initCdn = async (): Promise<void> => {
  // 无条件先清理：旧版本可能把 R2 自定义域存进 localStorage，
  // 即使后端已停发，已在线用户不刷新就会继续跨域请求并 403
  try { localStorage.removeItem(KEY); } catch { /* 忽略 */ }
  try {
    const res = await apiClient.get('/meta/public');
    const domain = (res.data?.cdn_domain || '').trim().replace(/\/$/, '');
    if (!domain || !res.data?.cdn_enabled) return;
    // 双保险：只允许与当前站点同源的域名，杜绝任何跨域直连
    const u = new URL(domain, window.location.origin);
    if (u.origin === window.location.origin) localStorage.setItem(KEY, u.origin);
  } catch { /* 接口失败时保持同源 */ }
};

/** 大图优先同源 /uploads/；仅在后端显式开启同源 CDN 时才拼接域名。 */
export const cdnUrl = (url: string | null | undefined): string => {
  const src = (url || '').trim();
  if (!src || !src.startsWith('/uploads/')) return src;
  try {
    const domain = localStorage.getItem(KEY);
    if (domain) return `${domain}${src}`;
  } catch {}
  return src;
};

/** 对象存储来源由兼容预览接口校验。 */
export const getCompatibleImageSource = (src: string | null | undefined) => {
  const raw = src?.trim();
  if (!raw || !/^(?:\/|https?:\/\/)/i.test(raw)) return;
  try {
    const url = new URL(raw, window.location.origin);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) return;
    const match = url.pathname.match(UPLOAD_IMAGE_PATH);
    if (!match) return;
    const endpoint = `/api/posts/media/compat/${match[1]}`;
    if (url.origin === window.location.origin && match.index === 0) {
      return { localPath: url.pathname + url.search, preview: endpoint };
    }
    return { localPath: undefined, preview: `${endpoint}?source=${encodeURIComponent(url.origin + url.pathname)}` };
  } catch {
    return undefined;
  }
};
