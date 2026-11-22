import React, { useState, useMemo } from 'react';
import { Check, Copy } from 'lucide-react';

interface Props {
  language?: string;
  value: string;
}

const LANGUAGE_MAP: Record<string, { label: string; dotColor: string }> = {
  ts: { label: 'TypeScript', dotColor: 'bg-sky-500' },
  typescript: { label: 'TypeScript', dotColor: 'bg-sky-500' },
  tsx: { label: 'React TSX', dotColor: 'bg-cyan-500' },
  js: { label: 'JavaScript', dotColor: 'bg-yellow-400' },
  javascript: { label: 'JavaScript', dotColor: 'bg-yellow-400' },
  jsx: { label: 'React JSX', dotColor: 'bg-yellow-500' },
  py: { label: 'Python', dotColor: 'bg-blue-500' },
  python: { label: 'Python', dotColor: 'bg-blue-500' },
  rust: { label: 'Rust', dotColor: 'bg-amber-600' },
  rs: { label: 'Rust', dotColor: 'bg-amber-600' },
  go: { label: 'Go', dotColor: 'bg-cyan-600' },
  golang: { label: 'Go', dotColor: 'bg-cyan-600' },
  sql: { label: 'SQL', dotColor: 'bg-emerald-500' },
  bash: { label: 'Bash', dotColor: 'bg-emerald-400' },
  sh: { label: 'Shell', dotColor: 'bg-emerald-400' },
  zsh: { label: 'Zsh', dotColor: 'bg-emerald-400' },
  json: { label: 'JSON', dotColor: 'bg-amber-500' },
  yaml: { label: 'YAML', dotColor: 'bg-rose-400' },
  yml: { label: 'YAML', dotColor: 'bg-rose-400' },
  html: { label: 'HTML', dotColor: 'bg-orange-500' },
  css: { label: 'CSS', dotColor: 'bg-indigo-400' },
  dockerfile: { label: 'Dockerfile', dotColor: 'bg-blue-400' },
  docker: { label: 'Docker', dotColor: 'bg-blue-400' },
  markdown: { label: 'Markdown', dotColor: 'bg-purple-400' },
  md: { label: 'Markdown', dotColor: 'bg-purple-400' },
  c: { label: 'C', dotColor: 'bg-slate-400' },
  cpp: { label: 'C++', dotColor: 'bg-blue-600' },
  java: { label: 'Java', dotColor: 'bg-red-500' },
};

export const CodeBlock: React.FC<Props> = ({ language = 'text', value }) => {
  const [copied, setCopied] = useState(false);

  const langKey = (language || 'text').toLowerCase().trim();
  const langConfig = LANGUAGE_MAP[langKey] || {
    label: language ? language.toUpperCase() : 'CODE',
    dotColor: 'bg-wb-text-muted',
  };

  const lines = useMemo(() => {
    // 移除末尾单个换行符以防多出一行空白行号
    const clean = value.endsWith('\n') ? value.slice(0, -1) : value;
    return clean.split('\n');
  }, [value]);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {}
  };

  return (
    <div className="wb-code-surface relative group my-4 rounded-2xl overflow-hidden border border-wb-border-subtle bg-wb-bg-surface font-mono text-xs md:text-sm shadow-sm">
      {/* 顶部工具栏：终端点 + 语言徽标 + 行数统计 + 一键复制代码 */}
      <div className="wb-code-toolbar flex items-center justify-between px-3.5 py-2 border-b border-wb-border-subtle bg-wb-bg-subtle text-wb-text-muted select-none">
        <div className="flex items-center gap-2">
          {/* 终端极客控制三色点 */}
          <div className="flex items-center gap-1.5 mr-1">
            <span className="w-2.5 h-2.5 rounded-full bg-red-400/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-amber-400/80" />
            <span className="w-2.5 h-2.5 rounded-full bg-emerald-400/80" />
          </div>

          <div className="wb-code-badge inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md bg-wb-bg-surface border border-wb-border-subtle text-2xs font-semibold tracking-wide">
            <span className={`w-1.5 h-1.5 rounded-full ${langConfig.dotColor}`} />
            <span className="text-wb-text-primary">{langConfig.label}</span>
          </div>

          <span className="text-3xs text-wb-text-muted/70 font-mono hidden sm:inline">
            {lines.length} 行
          </span>
        </div>

        <button
          onClick={handleCopy}
          type="button"
          aria-label="复制代码"
          className={`wb-pressable inline-flex items-center gap-1.5 text-2xs px-2.5 py-1 rounded-capsule border transition-all cursor-pointer ${
            copied
              ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-600 dark:text-emerald-400 font-semibold'
              : 'bg-wb-bg-surface border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary'
          }`}
        >
          {copied ? <Check className="w-3 h-3 text-emerald-500" /> : <Copy className="w-3 h-3" />}
          <span>{copied ? '已复制' : '复制代码'}</span>
        </button>
      </div>

      {/* 代码内容：左列不可选行号 + 右列代码 */}
      <div className="flex overflow-x-auto p-4 text-xs md:text-sm font-mono">
        {/* 行号列：select-none 确保鼠标划词复制代码时绝对不带行号 */}
        <div
          className="wb-code-lines select-none pr-3.5 text-right text-wb-text-muted/30 font-mono flex-shrink-0 border-r border-wb-border-subtle/50 tabular-nums leading-6"
          aria-hidden="true"
        >
          {lines.map((_, i) => (
            <div key={i}>{i + 1}</div>
          ))}
        </div>

        {/* 代码正文列 */}
        <pre className="wb-code-text pl-3.5 flex-1 m-0 p-0 bg-transparent text-wb-text-primary font-mono select-text whitespace-pre leading-6 overflow-x-auto">
          <code>{value}</code>
        </pre>
      </div>
    </div>
  );
};
