/**
 * 上传前在浏览器端压缩图片。
 *
 * 目的：真正拖慢「上传」的往往不是服务端 WebP 转码，而是把 8MB 原图从手机/宽带上行。
 *
 * 提速的关键点：
 * 1. `createImageBitmap(file, { resizeWidth, resizeHeight })` 让浏览器在解码阶段直接缩放，
 *    比「先解码原图再用 drawImage 缩放」少一次全尺寸位图遍历，大图能快 2~3 倍；
 * 2. 优先用 `OffscreenCanvas`（不进 DOM，省去布局与合成开销），不可用时回退普通 canvas；
 * 3. 阈值从 1.5MB 降到 300KB，中等图也会被压到目标体积，进一步减少上行时间。
 *
 * 体积的关键点：默认最长边 1600、质量 0.78，视觉上几乎无损，体积通常比原图小 80%~90%。
 *
 * 约定：
 * - 动图 GIF 不处理（避免失活）
 * - 任何异常都回退原文件，绝不阻塞上传
 */

/** 与后端 MAX_IMAGE_SIZE_MB / MAX_GIF_SIZE_MB 保持一致 */
export const MAX_IMAGE_UPLOAD_MB = 5;
export const MAX_GIF_UPLOAD_MB = 20;

/**
 * 上传前本地预检：明确告诉用户超的是哪个上限、超了多少，
 * 避免大 GIF 传到一半才被后端 413 打断（弱网下体感就是"卡住/失败"）。
 */
export function validateUploadFile(file: File): string | null {
  if (!file.type.startsWith('image/')) return '只能上传图片文件';
  const isGif = file.type === 'image/gif';
  const limitMb = isGif ? MAX_GIF_UPLOAD_MB : MAX_IMAGE_UPLOAD_MB;
  if (file.size > limitMb * 1024 * 1024) {
    const sizeMb = (file.size / 1024 / 1024).toFixed(1);
    return `${isGif ? '动图' : '图片'} ${sizeMb}MB 超过上限 ${limitMb}MB`;
  }
  return null;
}

export async function precompressImage(
  file: File,
  maxDimension = 1600,
  quality = 0.78
): Promise<File> {
  try {
    if (!file.type.startsWith('image/') || file.type === 'image/gif') return file;
    if (typeof createImageBitmap !== 'function') return file;

    // 小图且尺寸本就不超限时没必要重编码
    if (file.size < 300 * 1024 && file.type === 'image/webp') return file;

    // 先读尺寸（轻量解码），决定是否需要缩放
    const probe = await createImageBitmap(file);
    const longest = Math.max(probe.width, probe.height);
    const scale = Math.min(1, maxDimension / longest);
    const width = Math.max(1, Math.round(probe.width * scale));
    const height = Math.max(1, Math.round(probe.height * scale));

    // 尺寸本来就不大，且体积也可接受：直接用原文件
    if (scale === 1 && file.size < 600 * 1024) {
      probe.close?.();
      return file;
    }
    probe.close?.();

    // 重新解码，让浏览器在解码阶段就缩放到目标尺寸（比 drawImage 缩放快）
    const bitmap = await createImageBitmap(file, {
      resizeWidth: width,
      resizeHeight: height,
      resizeQuality: 'high',
    });

    let blob: Blob | null = null;

    if (typeof OffscreenCanvas !== 'undefined') {
      try {
        const off = new OffscreenCanvas(width, height);
        const octx = off.getContext('2d');
        if (octx) {
          octx.drawImage(bitmap, 0, 0, width, height);
          blob = await off.convertToBlob({ type: 'image/webp', quality });
        }
      } catch {
        blob = null;
      }
    }

    if (!blob) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        bitmap.close?.();
        return file;
      }
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, width, height);
      blob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/webp', quality)
      );
    }
    bitmap.close?.();

    if (!blob || blob.size >= file.size) return file;

    const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], name, { type: 'image/webp', lastModified: Date.now() });
  } catch {
    return file;
  }
}
