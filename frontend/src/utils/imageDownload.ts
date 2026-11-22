/**
 * 站内图片保存：把 WebP 在浏览器里转成 JPG / PNG 再下载。
 *
 * 走 canvas 重绘，不依赖后端重新编码。仅对同源图片可转码；
 * 跨域图片（或浏览器拒绝 canvas）会自动降级为「原图下载」。
 */

export type SaveFormat = 'jpeg' | 'png' | 'webp';

const MIME: Record<SaveFormat, string> = {
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
};

const EXT: Record<SaveFormat, string> = {
  jpeg: 'jpg',
  png: 'png',
  webp: 'webp',
};

export const SAVE_FORMAT_OPTIONS: { key: SaveFormat; label: string; hint: string }[] = [
  { key: 'jpeg', label: 'JPG 图片', hint: '通用性最好，体积略大' },
  { key: 'png', label: 'PNG 图片', hint: '无损，保留透明背景' },
  { key: 'webp', label: '原图 WebP', hint: '体积最小，不重复压缩' },
];

/** 单张 canvas 的像素上限，超过就等比缩小，避免移动端 OOM / iOS 尺寸限制 */
const MAX_CANVAS_PIXELS = 16_000_000;

export interface SaveResult {
  /** 是否因为跨域或转码失败而退回原图下载 */
  fallback: boolean;
  filename: string;
}

/**
 * 把 CDN 域名的图片地址归一化回本站同源路径。
 * 灯箱展示走 CDN 加速，但下载必须同源：
 *  - CSP 的 connect-src 只允许 'self'，fetch 跨域 CDN 会被直接拒绝
 *  - 跨域 <a download> 的 download 属性会被浏览器忽略，变成「打开图片」
 *  - canvas 转码也需要同源，否则画布被污染无法导出
 * /uploads/ 与 /api/media/proxy 在本站 nginx 都有对应路由。
 */
function toSameOrigin(url: string): string {
  try {
    const u = new URL(url, window.location.href);
    if (u.origin !== window.location.origin && /^\/(uploads\/|api\/media\/proxy)/.test(u.pathname)) {
      return u.pathname + u.search;
    }
  } catch {}
  return url;
}

function buildFilename(url: string, format: SaveFormat): string {
  const raw = decodeURIComponent(url.split('?')[0].split('/').pop() || 'image');
  const base = raw.replace(/\.[^.]+$/, '').replace(/[^\w\u4e00-\u9fa5-]/g, '_').slice(0, 48);
  return `${base || 'image'}.${EXT[format]}`;
}

function triggerDownload(href: string, filename: string): void {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** 直接下载原始文件（不重绘），用于「原图」选项与跨域降级。
 *  优先 fetch 成 blob 再下载：配置 CDN 后图片可能是跨域地址，
 *  直接给 <a download> 时浏览器会忽略 download 属性变成「打开图片」。 */
async function downloadOriginal(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) throw new Error('fetch failed');
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, filename);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
  } catch {
    // 跨域被拒时退回直链，至少让用户能看到/另存原图
    triggerDownload(url, filename);
  }
}

/**
 * 把图片按指定格式保存到本地。
 * @param url 图片地址（建议传经过 cdnUrl() 处理的同源地址）
 * @param format jpeg / png / webp（原图）
 * @param quality JPEG / WebP 质量，默认 0.92
 */
export async function downloadImageAs(
  url: string,
  format: SaveFormat,
  quality = 0.92
): Promise<SaveResult> {
  const imageUrl = toSameOrigin(url);
  const filename = buildFilename(imageUrl, format);

  // 原图：不经过 canvas，避免二次有损压缩
  if (format === 'webp') {
    await downloadOriginal(imageUrl, filename);
    return { fallback: false, filename };
  }

  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.decoding = 'async';
  img.src = imageUrl;

  try {
    if (typeof img.decode === 'function') {
      await img.decode();
    } else {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error('image load failed'));
      });
    }
  } catch {
    await downloadOriginal(imageUrl, filename);
    return { fallback: true, filename };
  }

  const naturalW = img.naturalWidth || img.width;
  const naturalH = img.naturalHeight || img.height;
  if (!naturalW || !naturalH) {
    void downloadOriginal(imageUrl, filename);
    return { fallback: true, filename };
  }

  const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (naturalW * naturalH)));
  const width = Math.max(1, Math.round(naturalW * scale));
  const height = Math.max(1, Math.round(naturalH * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    await downloadOriginal(imageUrl, filename);
    return { fallback: true, filename };
  }

  // JPG 不支持透明通道，透明区域会被编码成黑色；先铺白底
  if (format === 'jpeg') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
  }
  ctx.drawImage(img, 0, 0, width, height);

  try {
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, MIME[format], quality);
    });
    if (!blob) throw new Error('toBlob returned null');
    const objectUrl = URL.createObjectURL(blob);
    triggerDownload(objectUrl, filename);
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1500);
    return { fallback: false, filename };
  } catch {
    // canvas 被跨域污染 / 浏览器不支持该编码 → 退回原图，保证用户至少能存下来
    await downloadOriginal(imageUrl, filename);
    return { fallback: true, filename };
  }
}
