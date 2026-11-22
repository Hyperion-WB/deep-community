import React, { useRef, useState } from 'react';
import { Smile } from 'lucide-react';
import { EmojiStickerPanel } from './EmojiStickerPanel';

interface Props {
  /** 选中表情后由父组件负责插入到光标处（保持各编辑器的光标/选中逻辑） */
  onInsert: (text: string) => void;
  /** 工具栏按钮样式，默认与 Markdown 工具条里的图标按钮一致 */
  className?: string;
  title?: string;
  /** 需要带文字时传入（如反馈页的「表情」按钮），默认只有图标 */
  label?: string;
}

/**
 * 工具栏里的「插入表情」按钮。
 *
 * 与发帖/反馈的 Markdown 工具条（加粗、代码、插图…）排在一起，
 * 点开复用 EmojiStickerPanel（系统 emoji + 我的自定义表情），
 * 面板锚定按钮本身，位置固定，不会跟着光标跑。
 */
export const EmojiToolbarButton: React.FC<Props> = ({
  onInsert,
  className = 'p-1.5 rounded-xl hover:bg-wb-bg-surface text-wb-text-secondary hover:text-wb-text-primary transition-colors',
  title = '插入表情',
  label,
}) => {
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLButtonElement | null>(null);

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-label={title}
        aria-haspopup="dialog"
        aria-expanded={open}
        title={title}
        onClick={() => setOpen((v) => !v)}
        className={className}
      >
        <Smile className="w-3.5 h-3.5" />
        {label && <span>{label}</span>}
      </button>
      <EmojiStickerPanel
        isOpen={open}
        anchor={anchorRef.current}
        onClose={() => setOpen(false)}
        onSelectEmoji={(emoji) => onInsert(emoji)}
        onSelectSticker={(url) => onInsert(`![表情](${url})`)}
      />
    </>
  );
};
