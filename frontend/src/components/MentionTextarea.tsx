import React, { useEffect, useRef, useState } from 'react';
import { apiClient } from '../api/client';

interface Props {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** 匿名模式下禁用 @ 补全（与后端"匿名评论不产生提及"保持一致） */
  disabled?: boolean;
  required?: boolean;
  /** 透传外部键盘处理（如 Ctrl+Enter 发送），先处理自身导航再交给外部 */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  /** 透传粘贴处理（例如评论框的粘贴图片） */
  onPaste?: (e: React.ClipboardEvent<HTMLTextAreaElement>) => void;
}

interface Candidate {
  username: string;
  nickname?: string;
}

/**
 * 带 @ 补全的文本域。
 * 逻辑与 Chat.tsx 中的群聊 @ 一致：输入 @ 后弹出候选，上下键选择，回车/Tab 插入。
 */
export const MentionTextarea: React.FC<Props> = ({
  value,
  onChange,
  placeholder,
  rows = 3,
  className = '',
  textareaRef,
  disabled = false,
  required = false,
  onKeyDown: outerKeyDown,
  onPaste,
}) => {
  const innerRef = useRef<HTMLTextAreaElement | null>(null);
  const ref = textareaRef || innerRef;
  const [query, setQuery] = useState<string | null>(null);
  const [items, setItems] = useState<Candidate[]>([]);
  const [active, setActive] = useState(0);
  const [searched, setSearched] = useState(false);
  // 向上弹还是向下弹：输入框靠近视口顶部时空间不够，会被裁切
  const [dropUp, setDropUp] = useState(true);

  // 输入 @ 后按关键词拉候选（防抖 200ms）
  useEffect(() => {
    if (disabled || query === null) {
      setItems([]);
      setSearched(false);
      return;
    }
    setSearched(false);
    const t = setTimeout(async () => {
      try {
        const res = await apiClient.get('/users/search', { params: { q: query, limit: 6 } });
        const raw = Array.isArray(res.data) ? res.data : res.data?.items || [];
        setItems(raw.slice(0, 6));
        setActive(0);
        setSearched(true);
      } catch {
        setItems([]);
        setSearched(true);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, disabled]);

  const detect = (el: HTMLTextAreaElement) => {
    if (disabled) return;
    const before = el.value.slice(0, el.selectionStart ?? 0);
    const m = /@([A-Za-z0-9_\u4e00-\u9fa5]*)$/.exec(before);
    if (m) {
      // 上方不足 180px 时改为向下弹，避免浮层被视口顶部裁掉
      setDropUp(el.getBoundingClientRect().top > 180);
    }
    setQuery(m ? m[1] : null);
  };

  const insert = (name: string) => {
    const el = ref.current;
    if (!el) return;
    const pos = el.selectionStart ?? 0;
    const before = el.value.slice(0, pos);
    const after = el.value.slice(pos);
    const replaced = before.replace(/@([A-Za-z0-9_\u4e00-\u9fa5]*)$/, `@${name} `);
    onChange(replaced + after);
    setQuery(null);
    setItems([]);
    requestAnimationFrame(() => {
      el.focus();
      el.selectionStart = el.selectionEnd = replaced.length;
    });
  };

  // 键盘上下选择时，把选中项滚进可视区（否则只能看到前几个）
  const itemRefs = React.useRef<Array<HTMLButtonElement | null>>([]);
  React.useEffect(() => {
    if (query === null) return;
    itemRefs.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  // 展示用「可修改的昵称」；昵称含空格等无法被 @ 正则识别的字符时退回唯一用户名
  const mentionName = (u: { username: string; nickname?: string }) =>
    u.nickname && /^[A-Za-z0-9_\u4e00-\u9fa5]{2,32}$/.test(u.nickname)
      ? u.nickname
      : u.username;

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (query === null || items.length === 0) {
      outerKeyDown?.(e);
      return;
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => (i + 1) % items.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i - 1 + items.length) % items.length);
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      insert(mentionName(items[active]));
    } else if (e.key === 'Escape') {
      setQuery(null);
    } else {
      outerKeyDown?.(e);
    }
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={value}
        rows={rows}
        required={required}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => {
          onChange(e.target.value);
          detect(e.target);
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onClick={(e) => detect(e.currentTarget)}
        className={className}
      />
      {query !== null && (items.length > 0 || searched) && (
        <div className={`absolute z-30 left-0 w-56 max-h-48 overflow-y-auto p-1 rounded-xl frost-panel border border-wb-border-strong shadow-xl ${dropUp ? 'bottom-full mb-1' : 'top-full mt-1'}`}>
          {items.length === 0 && (
            <p className="px-2 py-1.5 text-2xs text-wb-text-muted">没有找到用户</p>
          )}
          {items.map((u, i) => (
            <button
              key={u.username}
              ref={(el) => {
                itemRefs.current[i] = el;
              }}
              type="button"
              onMouseDown={(e) => {
                e.preventDefault();
                insert(mentionName(u));
              }}
              className={`w-full text-left px-2 py-1.5 rounded-lg text-2xs transition-colors ${
                i === active
                  ? 'bg-wb-text-primary text-wb-bg-page'
                  : 'text-wb-text-primary hover:bg-wb-bg-subtle'
              }`}
            >
              @{mentionName(u)}
              {u.username !== mentionName(u) && (
                <span className="opacity-60 ml-1">@{u.username}</span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
