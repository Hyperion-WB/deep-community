import React, { useRef, useEffect } from 'react';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  onSelect: (emoji: string) => void;
  className?: string;
}

export const EMOJI_CATEGORIES = [
  {
    name: '常用神态',
    emojis: [
      '😀', '😃', '😄', '😁', '😆', '😅', '🤣', '😂',
      '🙂', '🙃', '😉', '😊', '😇', '🥰', '😍', '🤩',
      '😘', '😋', '😜', '🤪', '😎', '🥳', '😏', '🤔',
      '🤫', '🤐', '😴', '🤤', '😪',
      '😭', '😱', '😡', '🤬', '🤯', '🥵', '🥶', '🤡',
      '🤠', '🥹', '🥺', '🧐', '🤓', '👻', '💀', '💩',
    ],
  },
  {
    name: '手势互动',
    emojis: [
      '👍', '👎', '👏', '🙌', '💖', '🤝', '✌️', '🤞',
      '🤙', '🤟', '👊', '🙏', '💪', '👌', '👈', '👉',
      '👆', '👇', '👋', '✍️', '👌', '🤗', '🙋‍♂️', '🙋‍♀️',
      '👀', '🧑‍💻', '🎉', '🎊', '🍻', '🥂', '🍾', '💐',
    ],
  },
  {
    name: '极客技术',
    emojis: [
      '💻', '🖥️', '🧠', '🚀', '🔥', '⚡', '💡', '✨',
      '🦀', '🐍', '🐧', '☕', '🐳', '🌐', '📡', '💾',
      '⚙️', '🛠️', '📦', '🐛', '🔍', '🛡️', '🕹️', '🎮',
      '🎧', '🔋', '🔌', '📡', '🎯', '🏆', '💯', '⭐',
    ],
  },
  {
    name: '生活趣味',
    emojis: [
      '❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '💔',
      '☕', '🍵', '🧋', '🍺', '🍕', '🍔', '🍟', '🍜',
      '🍣', '🍦', '🍰', '🍉', '🍎', '🐱', '🐶', '🐼',
      '☀️', '🌙', '⭐', '🌈', '🌧️', '❄️', '📌', '🏷️',
    ],
  },
  {
    name: '符号标记',
    emojis: [
      '✅', '❌', '⚠️', '❗', '❓', '💯', '🔥', '✨',
      '⭐', '🌟', '💫', '⚡', '💥', '🎵', '🎶', '🔔',
      '🔕', '📢', '📣', '💬', '💭', '🕐', '📌', '🔖',
    ],
  },
  {
    name: '自然动物',
    emojis: [
      '🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼',
      '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🐔',
      '🐧', '🐦', '🐤', '🦆', '🦅', '🦉', '🐺', '🐴',
      '🦄', '🐝', '🐛', '🦋', '🐢', '🐍', '🐙', '🦀',
      '🐠', '🐟', '🐬', '🐳', '🦈', '🐊', '🐘', '🐫',
    ],
  },
  {
    name: '美食饮品',
    emojis: [
      '🍎', '🍊', '🍋', '🍌', '🍉', '🍇', '🍓', '🍒',
      '🍑', '🍍', '🥝', '🍅', '🥑', '🥕', '🌽', '🍞',
      '🥐', '🧀', '🥚', '🍳', '🥞', '🍗', '🍔', '🍟',
      '🍕', '🌭', '🍝', '🍜', '🍲', '🍛', '🍣', '🍱',
      '🍤', '🍡', '🍦', '🍰', '🎂', '🍫', '🍿', '🍩',
      '☕', '🍵', '🥤', '🍺', '🍻', '🥂', '🍷', '🍹',
    ],
  },
];

export const EmojiPicker: React.FC<Props> = ({ isOpen, onClose, onSelect, className = '' }) => {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      ref={containerRef}
      className={`absolute bottom-full mb-2 left-0 z-50 w-72 sm:w-80 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-3 space-y-2.5 font-sans select-none backdrop-blur-md ${className}`}
    >
      <div className="flex items-center justify-between pb-1.5 border-b border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary">
        <span>插入极客与常用表情</span>
        <button
          type="button"
          onClick={onClose}
          className="text-wb-text-muted hover:text-wb-text-primary p-0.5 rounded text-xs"
        >
          ✕
        </button>
      </div>

      <div className="max-h-56 overflow-y-auto space-y-2.5 pr-0.5" style={{ scrollbarWidth: 'thin' }}>
        {EMOJI_CATEGORIES.map((cat) => (
          <div key={cat.name} className="space-y-1">
            <div className="text-3xs font-medium text-wb-text-muted px-1">{cat.name}</div>
            <div className="grid grid-cols-8 gap-1">
              {cat.emojis.map((emoji, idx) => (
                <button
                  key={`${cat.name}-${idx}-${emoji}`}
                  type="button"
                  onClick={() => onSelect(emoji)}
                  className="w-7 h-7 sm:w-8 sm:h-8 flex items-center justify-center text-base sm:text-lg rounded-lg hover:bg-wb-bg-subtle hover:scale-110 active:scale-95 transition-transform cursor-pointer"
                >
                  {emoji}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
