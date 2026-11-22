import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Terminal, ArrowRight, X } from 'lucide-react';

/**
 * 明确的「命令上下文」导航入口。
 *
 * 之前是全局连续键入 404 / game 就跳走，导致正文里写「404」「game」被误触发。
 * 现在只有显式打开命令条（Ctrl/Cmd+K，或在非输入态按 /）后，
 * 在命令条里输入指令并回车才会跳转；普通文本输入完全不受影响。
 */
const COMMANDS: Record<string, string> = {
  '404': '/404', 'game': '/404', 'go 404': '/404', 'go game': '/404',
  '游戏': '/404', '摸鱼': '/404', '游乐场': '/404', '404游戏': '/404',
};

interface Props {
  open: boolean;
  onClose: () => void;
}

export const GameCommandBar: React.FC<Props> = ({ open, onClose }) => {
  const [value, setValue] = useState('');
  const [hint, setHint] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) { setValue(''); setHint(''); return; }
    const t = window.setTimeout(() => inputRef.current?.focus(), 30);
    return () => window.clearTimeout(t);
  }, [open]);

  if (!open) return null;

  const submit = () => {
    const raw = value.trim().toLowerCase().replace(/^[/>]+/, '').trim();
    const target = COMMANDS[raw];
    if (!target) {
      setHint('未知命令，试试 404 或 game');
      return;
    }
    onClose();
    if (window.location.pathname.replace(/\/+$/, '') !== target) {
      window.location.assign(target);
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-[400] flex items-start justify-center bg-black/45 backdrop-blur-sm px-4 pt-[18vh]"
         onClick={onClose}>
      <div className="w-full max-w-lg rounded-2xl frost-panel border border-wb-border-strong shadow-2xl overflow-hidden animate-in fade-in zoom-in-95 duration-150"
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-wb-border-subtle">
          <Terminal className="w-4 h-4 text-wb-brand shrink-0" />
          <span className="text-3xs font-mono tracking-widest text-wb-text-muted">COMMAND</span>
          <button type="button" onClick={onClose} aria-label="关闭命令栏"
            className="ml-auto p-1 rounded-lg text-wb-text-muted hover:bg-wb-bg-subtle">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex items-center gap-2 px-4 py-3">
          <span className="text-sm font-mono text-wb-brand">&gt;</span>
          <input
            ref={inputRef}
            value={value}
            onChange={(e) => { setValue(e.target.value); setHint(''); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              if (e.key === 'Escape') { e.preventDefault(); onClose(); }
            }}
            placeholder="输入 404 或 game 后回车"
            className="flex-1 bg-transparent text-sm text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none"
          />
          <button type="button" onClick={submit}
            className="wb-pressable h-8 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold inline-flex items-center gap-1">
            前往 <ArrowRight className="w-3 h-3" />
          </button>
        </div>
        <div className="px-4 pb-3 text-3xs text-wb-text-muted">
          {hint
            ? <span className="text-wb-danger">{hint}</span>
            : '打开方式：Ctrl / ⌘ + K，或在页面空白处按 / 。普通输入中的 404、game 不会触发跳转。'}
        </div>
      </div>
    </div>, document.body
  );
};
