import React, { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { SmilePlus } from 'lucide-react';

export interface ReactionCounts {
  '👍'?: number;
  '❤️'?: number;
  '🚀'?: number;
  '💡'?: number;
  '🎉'?: number;
  '🔥'?: number;
  [key: string]: number | undefined;
}

export const REACTION_LIST = [
  { emoji: '👍', label: '赞同' },
  { emoji: '❤️', label: '喜爱' },
  { emoji: '🚀', label: '硬核' },
  { emoji: '💡', label: '启发' },
  { emoji: '🎉', label: '庆祝' },
  { emoji: '🔥', label: '点燃' },
];

interface Props {
  targetId: string;
  reactions: ReactionCounts;
  userReactions: string[]; // 用户已点反应
  onToggleReaction: (emoji: string) => void;
  className?: string;
  disabled?: boolean;
}

export const ReactionPicker: React.FC<Props> = ({
  reactions,
  userReactions,
  onToggleReaction,
  className = '',
  disabled = false,
}) => {
  const [showPicker, setShowPicker] = useState(false);

  return (
    <div className={`relative inline-flex items-center gap-1.5 flex-wrap ${className}`}>
      {/* 表情微气泡快捷触发按钮 */}
      <div className="relative shrink-0">
        <button
          type="button"
          disabled={disabled}
          onClick={() => setShowPicker((prev) => !prev)}
          title="添加极客表情反应"
          className="wb-pressable flex items-center justify-center h-7 px-2 text-xs rounded-capsule bg-wb-bg-subtle/80 hover:bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary transition-colors disabled:opacity-50 whitespace-nowrap shrink-0"
        >
          <SmilePlus className="w-3.5 h-3.5 mr-1 text-wb-text-muted shrink-0" />
          <span className="whitespace-nowrap">互动</span>
        </button>

        {/* 弹出表情选择器气泡 */}
        <AnimatePresence>
          {showPicker && (
            <>
              {/* 隐形遮罩关闭 */}
              <div
                className="fixed inset-0 z-30"
                onClick={() => setShowPicker(false)}
              />
              <motion.div
                initial={{ opacity: 0, scale: 0.85, y: 8 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.9, y: 4 }}
                transition={{ type: 'spring', stiffness: 500, damping: 30 }}
                className="absolute left-0 bottom-full mb-2 z-40 p-1.5 bg-wb-bg-surface/98 backdrop-blur-2xl border border-wb-border-strong rounded-capsule shadow-xl flex items-center gap-1 select-none whitespace-nowrap shrink-0"
              >
                {REACTION_LIST.map((item) => {
                  const isReacted = userReactions.includes(item.emoji);
                  return (
                    <button
                      key={item.emoji}
                      type="button"
                      onClick={() => {
                        onToggleReaction(item.emoji);
                        setShowPicker(false);
                      }}
                      className={`wb-pressable flex items-center justify-center w-8 h-8 rounded-full text-base transition-all shrink-0 ${
                        isReacted
                          ? 'bg-wb-capsule-track border border-wb-border-strong scale-110'
                          : 'hover:bg-wb-bg-subtle hover:scale-125'
                      }`}
                      title={`${item.label} (${item.emoji})`}
                    >
                      <span className="select-none">{item.emoji}</span>
                    </button>
                  );
                })}
              </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>

      {/* 已有表情反应药丸统计徽章 */}
      {REACTION_LIST.filter((r) => (reactions[r.emoji] || 0) > 0).map((r) => {
        const count = reactions[r.emoji] || 0;
        const isReacted = userReactions.includes(r.emoji);
        return (
          <button
            key={r.emoji}
            type="button"
            disabled={disabled}
            onClick={() => onToggleReaction(r.emoji)}
            className={`wb-pressable inline-flex items-center gap-1 h-7 px-2.5 rounded-capsule text-xs font-mono border transition-all whitespace-nowrap shrink-0 select-none ${
              isReacted
                ? 'bg-wb-text-primary text-wb-bg-page border-transparent font-bold shadow-sm'
                : 'bg-wb-bg-subtle/80 hover:bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle'
            }`}
          >
            <span>{r.emoji}</span>
            <span>{count}</span>
          </button>
        );
      })}
    </div>
  );
};
