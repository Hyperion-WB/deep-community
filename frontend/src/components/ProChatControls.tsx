import React, { useEffect, useRef, useState } from 'react';
import { Code2, Maximize2, Minimize2 } from 'lucide-react';
import type { StealthTheme } from './StealthWorkspaceCamouflage';

interface Props {
  isFullscreen: boolean;
  onToggleFullscreen: () => void;
  stealthTheme: StealthTheme;
  onThemeChange: (theme: StealthTheme) => void;
  /** 紧凑形态用于会话内悬浮工具条 */
  compact?: boolean;
}

const THEMES: { key: StealthTheme; name: string; color: string; shortcut: string }[] = [
  { key: 'vscode', name: 'VS Code 编辑器', color: 'bg-blue-500', shortcut: 'Alt+1' },
  { key: 'idea', name: 'IntelliJ IDEA', color: 'bg-amber-500', shortcut: 'Alt+2' },
  { key: 'feishu', name: '飞书工作协同', color: 'bg-sky-500', shortcut: 'Alt+3' },
  { key: 'excel', name: 'Excel 电子表格', color: 'bg-emerald-500', shortcut: 'Alt+4' },
  { key: 'word', name: 'Word 文档方案', color: 'bg-blue-700', shortcut: 'Alt+5' },
  { key: 'ppt', name: 'PPT 演示文稿', color: 'bg-orange-500', shortcut: 'Alt+6' },
];

/**
 * 专业版聊天专属控制条：全屏沉浸 + 六大工作软件摸鱼伪装。
 * 这个组件只由 Chat 的 isPro 分支渲染，经典版不会挂载、不会注册任何监听。
 */
export const ProChatControls: React.FC<Props> = ({
  isFullscreen,
  onToggleFullscreen,
  stealthTheme,
  onThemeChange,
  compact = false,
}) => {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handler);
    return () => window.removeEventListener('mousedown', handler);
  }, [open]);

  const size = compact ? 'w-7 h-7 rounded-md' : 'w-8 h-8 rounded-xl';
  const btn = `${size} flex items-center justify-center shrink-0 cursor-pointer border border-wb-border-subtle bg-wb-bg-surface text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle hover:border-wb-border-strong transition-all shadow-2xs`;

  return (
    <div className="flex items-center gap-1 select-none">
      <button
        type="button"
        onClick={onToggleFullscreen}
        className={btn}
        title={isFullscreen ? '退出全屏工作台 (Esc / F11)' : '全屏工作台沉浸模式 (F11)'}
        aria-label={isFullscreen ? '退出全屏工作台' : '全屏工作台'}
      >
        {isFullscreen
          ? <Minimize2 className="w-3.5 h-3.5 text-cyan-500" />
          : <Maximize2 className="w-3.5 h-3.5" />}
      </button>

      <div className="relative" ref={menuRef}>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className={btn}
          title="一键伪装工作软件 (VSCode/IDEA/飞书/Excel/Word/PPT)"
          aria-label="工作软件伪装"
        >
          <Code2 className="w-3.5 h-3.5 text-emerald-500" />
        </button>

        {open && (
          <div className={`absolute ${compact ? 'right-0' : 'left-0'} top-full mt-1.5 w-52 bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-2xl p-1.5 z-[150] text-3xs font-mono space-y-1 animate-in fade-in zoom-in-95 duration-150`}>
            <div className="px-2.5 py-1.5 text-wb-text-muted font-bold border-b border-wb-border-subtle flex items-center justify-between">
              <span>工作软件仿真皮肤</span>
              <span className="text-[9px] text-emerald-500 font-normal">Esc 退出</span>
            </div>
            {THEMES.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => { onThemeChange(item.key); setOpen(false); }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded-xl hover:bg-wb-bg-subtle text-left cursor-pointer transition-colors ${
                  stealthTheme === item.key ? 'bg-wb-bg-subtle text-wb-text-primary font-semibold' : 'text-wb-text-primary'
                }`}
              >
                <span className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${item.color}`} />
                  <span>{item.name}</span>
                </span>
                <kbd className="text-[9px] font-mono text-wb-text-muted">{item.shortcut}</kbd>
              </button>
            ))}
            {stealthTheme !== 'normal' && (
              <button
                type="button"
                onClick={() => { onThemeChange('normal'); setOpen(false); }}
                className="w-full px-2.5 py-1.5 rounded-xl hover:bg-wb-bg-subtle text-wb-danger text-left cursor-pointer border-t border-wb-border-subtle"
              >
                退出伪装，返回工作台
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
