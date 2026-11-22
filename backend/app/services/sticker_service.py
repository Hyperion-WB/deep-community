"""自定义表情包处理。

和普通图片（统一转 WebP 静态）不同，表情包要保住动图：
- 动图统一**重新编码为动态 WebP**：逐帧缩放后保存，既能把大 GIF 压到很小，
  又能保留透明通道（GIF 直接量化成 P 模式会丢透明，深色评论区会露出白块）；
- 静态图缩到 320px 存 WebP；
- 另存一张首帧缩略图（64px），面板列表用它渲染，hover 时才播动图——
  否则一次打开三十个动图会直接卡死。

尺寸策略：上传允许较大原图（≤ 5MB、边长 ≤ 1200），由服务端按多档尺寸重试压缩，
直到体积落到 512KB 以内，用户不需要自己先压一遍。
"""

import io
import os
import uuid
from typing import Optional, Tuple

from PIL import Image, ImageSequence

from app.core.config import settings

MAX_UPLOAD_BYTES = 8 * 1024 * 1024      # 原始文件上限（压缩后再存，8MB 足够覆盖常见表情包）
MAX_OUTPUT_BYTES = 512 * 1024           # 压缩后上限
MAX_INPUT_SIDE = 1200                   # 原图边长上限

# 压缩阶梯：从大到小试，第一个满足体积要求的就采用
ANIMATED_SIDE_STEPS = (480, 400, 320, 256, 200, 160)
STATIC_SIDE_STEPS = (320, 256, 200, 160)
THUMB_SIDE = 64
STICKER_SUBDIR = "stickers"


class StickerError(ValueError):
    """表情包不合法（格式 / 尺寸 / 体积）"""


def _save_bytes(data: bytes, ext: str) -> str:
    rel_dir = os.path.join(settings.UPLOAD_DIR, STICKER_SUBDIR)
    os.makedirs(rel_dir, exist_ok=True)
    name = f"{uuid.uuid4().hex}.{ext}"
    with open(os.path.join(rel_dir, name), "wb") as f:
        f.write(data)
    return f"/uploads/{STICKER_SUBDIR}/{name}"


def _is_animated(img: Image.Image) -> bool:
    try:
        return bool(getattr(img, "is_animated", False)) and getattr(img, "n_frames", 1) > 1
    except Exception:
        return False


def _build_thumb(img: Image.Image) -> str:
    """用首帧生成方形缩略图（webp），供面板列表使用。"""
    frame = img.copy()
    frame.thumbnail((THUMB_SIDE, THUMB_SIDE))
    buf = io.BytesIO()
    frame.convert("RGBA").save(buf, format="WEBP", quality=80)
    return _save_bytes(buf.getvalue(), "webp")


def _render_animated_webp(img: Image.Image, max_side: int, quality: int = 72) -> bytes:
    """逐帧缩放后编码为动态 WebP（保留 alpha，体积远小于 GIF）。"""
    frames = []
    durations = []
    for frame in ImageSequence.Iterator(img):
        rgba = frame.convert("RGBA")
        w, h = rgba.size
        if max(w, h) > max_side:
            scale = max_side / max(w, h)
            rgba = rgba.resize((max(1, int(w * scale)), max(1, int(h * scale))), Image.LANCZOS)
        frames.append(rgba)
        durations.append(max(20, int(frame.info.get("duration", 80) or 80)))

    buf = io.BytesIO()
    frames[0].save(
        buf,
        format="WEBP",
        save_all=True,
        append_images=frames[1:],
        duration=durations,
        loop=img.info.get("loop", 0) or 0,
        quality=quality,
        method=4,
        allow_mixed=True,
    )
    return buf.getvalue()


def process_sticker(data: bytes) -> Tuple[str, str, int, int, int, bool]:
    """处理上传的表情图，返回 (url, thumb_url, width, height, size, is_animated)。"""
    if not data:
        raise StickerError("文件为空")
    if len(data) > MAX_UPLOAD_BYTES:
        raise StickerError(f"原图不能超过 {MAX_UPLOAD_BYTES // 1024 // 1024}MB")

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise StickerError("这不是一张可识别的图片")

    width, height = img.size
    if max(width, height) > MAX_INPUT_SIDE:
        raise StickerError(f"图片边长不能超过 {MAX_INPUT_SIDE}px，请先缩小一些")

    if _is_animated(img):
        # 动图：按阶梯重编码，直到体积达标
        for side in ANIMATED_SIDE_STEPS:
            payload = _render_animated_webp(img, side)
            if len(payload) <= MAX_OUTPUT_BYTES:
                url = _save_bytes(payload, "webp")
                thumb = _build_thumb(img)
                out_w = min(width, side) if width >= height else max(1, int(width * side / height))
                out_h = min(height, side) if height >= width else max(1, int(height * side / width))
                return url, thumb, out_w, out_h, len(payload), True
        raise StickerError("这个动图太复杂了，压不到 512KB 以内，请换一个短一点的")

    # 静态图：逐档缩小直到体积达标
    base = img.convert("RGBA")
    for side in STATIC_SIDE_STEPS:
        frame = base.copy()
        frame.thumbnail((side, side))
        buf = io.BytesIO()
        frame.save(buf, format="WEBP", quality=82)
        payload = buf.getvalue()
        if len(payload) <= MAX_OUTPUT_BYTES:
            url = _save_bytes(payload, "webp")
            thumb = _build_thumb(frame)
            return url, thumb, frame.size[0], frame.size[1], len(payload), False

    raise StickerError("图片压缩后仍然过大，请换一张更简单的图")


def load_local_upload(url: str) -> Optional[bytes]:
    """读取本站 /uploads/ 下的文件（收藏别人的表情时用来复制）。"""
    if not url or not url.startswith("/uploads/"):
        return None
    rel = url.replace("/uploads/", "", 1)
    safe = os.path.normpath(rel)
    if safe.startswith("..") or os.path.isabs(safe):
        return None
    path = os.path.join(settings.UPLOAD_DIR, safe)
    if not os.path.isfile(path):
        return None
    try:
        with open(path, "rb") as f:
            return f.read()
    except Exception:
        return None
