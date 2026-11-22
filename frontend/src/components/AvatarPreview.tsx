import { SafeImage } from './SafeImage';
import React, { useEffect } from 'react';
import { createPortal } from 'react-dom';

interface Props {
  /** 头像地址；为空时不渲染 */
  src: string | null;
  /** 展示在图片下方的名称（昵称或群名） */
  name?: string;
  /** 自定义底部提示，默认「点击任意处或按 ESC 关闭」 */
  hint?: string;
  onClose: () => void;
}

/**
 * 头像大图预览。
 *
 * 个人主页、群聊头部共用：点击头像后在遮罩层里放大展示，
 * 点击遮罩或按 ESC 关闭，避免误触后无法退出。
 */
export const AvatarPreview: React.FC<Props> = ({ src, name, hint, onClose }) => {
  useEffect(() => {
    if (!src) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [src, onClose]);

  if (!src) return null;

  return createPortal(
    <div
      role="dialog"
      aria-label={name ? `${name} 的头像` : '头像预览'}
      onClick={onClose}
      className="fixed inset-0 z-[200] flex flex-col items-center justify-center gap-4 bg-black/85 backdrop-blur-md p-6 cursor-zoom-out select-none"
      style={{ WebkitTapHighlightColor: 'transparent' }}
    >
      <SafeImage
        src={src}
        compatiblePreview
        alt={name || '头像'}
        className="max-h-[68vh] max-w-[72vw] sm:max-w-[420px] rounded-3xl object-contain shadow-2xl ring-1 ring-white/15 bg-white/5"
      />
      <div className="text-center space-y-1 pointer-events-none">
        {name && <p className="text-sm font-semibold text-white/90">{name}</p>}
        <p className="text-2xs text-white/45">{hint || '点击任意处或按 ESC 关闭'}</p>
      </div>
    </div>,
    document.body
  );
};
