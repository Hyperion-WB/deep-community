import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ArrowLeft, Scale, BookOpen, Edit3, Save, Eye, Loader2 } from 'lucide-react';
import { apiClient } from '../api/client';

/**
 * 免责与法律声明（公开页面，游客与登录用户均可访问）。
 * 正文当前留空占位——后续直接编辑下面的 LEGAL_DISCLAIMER_MD 常量即可，
 * 支持完整 Markdown（标题/列表/表格/链接/代码块/引用）。
 */
export const LEGAL_DISCLAIMER_MD = `> 本页内容待补充。管理员可直接在前端源码的 \`LEGAL_DISCLAIMER_MD\` 常量中填写 Markdown 正文。

`;

interface Props {
  onBack?: () => void;
  onGoRules?: () => void;
  embedded?: boolean;
  /** 是否显示编辑按钮（超级管理员） */
  canEdit?: boolean;
}

const mdComponents = {
  h1: ({ children }: any) => <h1 className="text-xl font-bold text-wb-text-primary mt-6 mb-3">{children}</h1>,
  h2: ({ children }: any) => <h2 className="text-base font-bold text-wb-text-primary mt-5 mb-2 pb-1 border-b border-wb-border-subtle">{children}</h2>,
  h3: ({ children }: any) => <h3 className="text-sm font-semibold text-wb-text-primary mt-4 mb-2">{children}</h3>,
  p: ({ children }: any) => <p className="text-xs leading-relaxed text-wb-text-secondary my-2">{children}</p>,
  ul: ({ children }: any) => <ul className="list-disc pl-5 space-y-1 text-xs text-wb-text-secondary">{children}</ul>,
  ol: ({ children }: any) => <ol className="list-decimal pl-5 space-y-1 text-xs text-wb-text-secondary">{children}</ol>,
  li: ({ children }: any) => <li className="leading-relaxed">{children}</li>,
  a: ({ href, children }: any) => <a href={href} className="text-wb-brand underline underline-offset-2" target="_blank" rel="noreferrer">{children}</a>,
  blockquote: ({ children }: any) => <blockquote className="pl-3 border-l-2 border-wb-border-strong text-wb-text-muted text-xs my-3">{children}</blockquote>,
  code: ({ children }: any) => <code className="px-1 py-0.5 rounded bg-wb-bg-subtle font-mono text-2xs">{children}</code>,
  table: ({ children }: any) => <div className="overflow-x-auto my-3"><table className="w-full text-xs border border-wb-border-subtle">{children}</table></div>,
  th: ({ children }: any) => <th className="px-2 py-1.5 border border-wb-border-subtle bg-wb-bg-subtle font-semibold text-left">{children}</th>,
  td: ({ children }: any) => <td className="px-2 py-1.5 border border-wb-border-subtle">{children}</td>,
  hr: () => <hr className="my-4 border-wb-border-subtle" />,
};

/** 两个公开页面之间的切换按钮（风格与现有胶囊按钮一致） */
export const LegalSwitch: React.FC<{ onGoRules?: () => void; onGoLegal?: () => void; current: 'rules' | 'legal' }> = ({
  onGoRules, onGoLegal, current,
}) => (
  <div className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs shrink-0">
    <button type="button" onClick={onGoRules}
      className={`wb-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule whitespace-nowrap transition-all ${current === 'rules' ? 'bg-wb-text-primary text-wb-bg-page font-semibold shadow-sm' : 'text-wb-text-secondary hover:text-wb-text-primary'}`}>
      <BookOpen className="w-3 h-3" /> 公约与入站准则
    </button>
    <button type="button" onClick={onGoLegal}
      className={`wb-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule whitespace-nowrap transition-all ${current === 'legal' ? 'bg-wb-text-primary text-wb-bg-page font-semibold shadow-sm' : 'text-wb-text-secondary hover:text-wb-text-primary'}`}>
      <Scale className="w-3 h-3" /> 免责与法律声明
    </button>
  </div>
);

export const LegalDisclaimer: React.FC<Props> = ({ onBack, onGoRules, embedded, canEdit }) => {
  const [md, setMd] = useState(LEGAL_DISCLAIMER_MD);
  const [title, setTitle] = useState('免责与法律声明');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/site-contents/legal');
      setTitle(res.data?.title || '免责与法律声明');
      setMd(res.data?.content || '');
      setDraft(res.data?.content || '');
    } catch {
      /* 公共接口失败时退回内置常量 */
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => { void load(); }, []);

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.put('/site-contents/legal', { title, content: draft });
      setMd(draft);
      setEditing(false);
      setPreview(false);
    } catch (err: any) {
      alert(err?.response?.data?.detail || '保存失败（仅超级管理员可编辑）');
    } finally {
      setSaving(false);
    }
  };

  const body = md.trim() || '';

  return (
  <div className={embedded ? '' : 'max-w-4xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-5 animate-fade-in'}>
    {!embedded && (
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-wb-border-subtle flex-wrap">
        <div className="flex items-center gap-2.5 flex-wrap">
          {onBack && (
            <button type="button" onClick={onBack}
              className="wb-pressable flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary transition-colors">
              <ArrowLeft className="w-3.5 h-3.5" /> 返回
            </button>
          )}
          <div className="flex items-center gap-2">
            <span className="text-xs text-wb-text-muted font-mono">规范准则</span>
            <span className="text-xs text-wb-text-muted font-mono">/</span>
            <span className="text-xs font-semibold text-wb-text-primary font-mono">免责与法律声明</span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {canEdit && !editing && (
            <button type="button" onClick={() => { setDraft(md); setEditing(true); }}
              className="wb-pressable h-8 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1.5">
              <Edit3 className="w-3 h-3" /> 编辑内容
            </button>
          )}
          <LegalSwitch current="legal" onGoRules={onGoRules || onBack} onGoLegal={undefined} />
        </div>
      </div>
    )}

    <div className="p-5 sm:p-7 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card">
      <div className="flex items-center gap-2 mb-4">
        <span className="w-8 h-8 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center">
          <Scale className="w-4 h-4 text-wb-text-primary" />
        </span>
        <div>
          <h1 className="text-sm font-bold text-wb-text-primary">免责与法律声明</h1>
          <p className="text-3xs text-wb-text-muted font-mono">DISCLAIMER &amp; LEGAL NOTICE</p>
        </div>
      </div>
      {editing && canEdit ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setPreview(false)}
              className={`wb-pressable h-8 px-3 rounded-capsule text-2xs inline-flex items-center gap-1.5 ${!preview ? 'bg-wb-text-primary text-wb-bg-page font-semibold' : 'bg-wb-bg-subtle text-wb-text-secondary'}`}>
              <Edit3 className="w-3 h-3" /> 编写
            </button>
            <button type="button" onClick={() => setPreview(true)}
              className={`wb-pressable h-8 px-3 rounded-capsule text-2xs inline-flex items-center gap-1.5 ${preview ? 'bg-wb-text-primary text-wb-bg-page font-semibold' : 'bg-wb-bg-subtle text-wb-text-secondary'}`}>
              <Eye className="w-3 h-3" /> 预览
            </button>
            <button type="button" onClick={() => void save()} disabled={saving}
              className="wb-pressable ml-auto h-8 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50">
              {saving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />} 保存并发布
            </button>
            <button type="button" onClick={() => { setEditing(false); setPreview(false); setDraft(md); }}
              className="wb-pressable h-8 px-3 rounded-capsule bg-wb-bg-subtle text-2xs text-wb-text-secondary">取消</button>
          </div>
          {preview ? (
            <article className="legal-prose min-h-[280px] p-3 rounded-2xl bg-wb-bg-subtle/50">
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents as any}>
                {draft}
              </ReactMarkdown>
            </article>
          ) : (
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              rows={18}
              placeholder="在此粘贴或撰写 Markdown 正文，支持标题、列表、表格、引用、代码块…"
              className="w-full p-3 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary font-mono leading-relaxed focus:outline-none focus:border-wb-border-strong resize-y"
            />
          )}
        </div>
      ) : (
        <article className="legal-prose">
          {loading ? (
            <p className="text-2xs text-wb-text-muted font-mono">加载中…</p>
          ) : body ? (
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={mdComponents as any}>
              {body}
            </ReactMarkdown>
          ) : (
            <p className="text-xs text-wb-text-muted py-6 text-center">
              内容待补充{canEdit ? '，点击右上角「编辑内容」即可在线填写' : ''}
            </p>
          )}
        </article>
      )}
    </div>
  </div>
  );
};
