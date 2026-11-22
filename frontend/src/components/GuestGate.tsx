import React, { useEffect, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { BookOpen, Scale, LogIn, Lock, X, LogOut } from 'lucide-react';
import { Modal } from './Modal';
import { LEGAL_DISCLAIMER_MD } from '../pages/LegalDisclaimer';
import { apiClient } from '../api/client';

interface Props {
  onOpenAuth: () => void;
  onGoRules: () => void;
  onGoLegal: () => void;
  /** 登录弹窗打开时门禁自动让位，避免两个弹窗叠在一起 */
  authOpen?: boolean;
}

/**
 * 游客门禁：
 * 1) 首次进入显示「免责与法律声明」弹窗（可关闭、可跳两个公开页面、可登录）；
 * 2) 关闭弹窗后整页只留框架 + 锁定提示「前面的区域以后再探索吧」，
 *    帖子内容完全不进 DOM。
 */
export const GuestGate: React.FC<Props> = ({ onOpenAuth, onGoRules, onGoLegal, authOpen }) => {
  const [md, setMd] = useState(LEGAL_DISCLAIMER_MD);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    apiClient.get('/site-contents/legal')
      .then((res) => setMd(res.data?.content || ''))
      .catch(() => undefined);
  }, []);

  /** 退出：能关就关，不能关就退回上一页 / 空白页，绝不留在内容页 */
  const handleExit = () => {
    window.close();
    window.setTimeout(() => {
      if (window.history.length > 1) window.history.back();
      else window.location.replace('about:blank');
    }, 160);
  };

  // 弹窗关掉后：只显示框架与锁定提示
  if (closed) {
    return (
      <div className="min-h-[62vh] flex flex-col items-center justify-center gap-6 px-6 py-16 text-center animate-fade-in">
        <span className="w-16 h-16 rounded-3xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center">
          <Lock className="w-7 h-7 text-wb-text-muted" />
        </span>
        <div className="space-y-2">
          <h2 className="text-base sm:text-lg font-bold text-wb-text-primary">前面的区域以后再探索吧</h2>
          <p className="text-2xs text-wb-text-muted font-mono tracking-wide">CONTENT LOCKED · 登录后即可继续浏览</p>
        </div>
        <div className="flex flex-wrap items-center justify-center gap-2.5">
          <button type="button" onClick={handleExit}
            className="wb-pressable h-10 px-5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary inline-flex items-center justify-center gap-1.5">
            <LogOut className="w-3.5 h-3.5" /> 退出
          </button>
          <button type="button" onClick={onOpenAuth}
            className="wb-pressable h-10 px-5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold inline-flex items-center justify-center gap-1.5 shadow-sm">
            <LogIn className="w-3.5 h-3.5" /> 登录 / 注册
          </button>
        </div>
        <button type="button" onClick={() => setClosed(false)}
          className="text-3xs text-wb-text-muted hover:text-wb-text-primary underline underline-offset-4">
          重新查看免责声明
        </button>
      </div>
    );
  }

  if (authOpen) return null;

  return (
    <>
      {/* 占位背景：确保帖子内容完全不出现在 DOM 中 */}
      <div className="max-w-4xl mx-auto px-4 py-16 text-center space-y-3 opacity-50">
        <Lock className="w-9 h-9 mx-auto text-wb-text-muted" />
        <p className="text-xs text-wb-text-muted font-mono tracking-widest">CONTENT LOCKED</p>
        <p className="text-2xs text-wb-text-muted">登录后即可浏览社区内容</p>
      </div>

      <Modal open onClose={() => setClosed(true)} maskClosable={false} zIndex={200} widthClass="max-w-2xl">
        <div className="space-y-5">
          {/* 头部 */}
          <div className="flex items-start gap-3">
            <span className="w-10 h-10 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center shrink-0">
              <Scale className="w-4.5 h-4.5 text-wb-text-primary" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="text-base font-bold text-wb-text-primary">免责与法律声明</h2>
              <p className="text-3xs text-wb-text-muted font-mono tracking-wide">请在继续使用本站前阅读</p>
            </div>
            <button type="button" onClick={() => setClosed(true)}
              aria-label="关闭"
              className="wb-pressable shrink-0 w-8 h-8 rounded-full bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-muted hover:text-wb-text-primary inline-flex items-center justify-center">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 正文 */}
          <div className="rounded-2xl bg-wb-bg-subtle/50 border border-wb-border-subtle px-5 py-4 max-h-[46vh] overflow-y-auto">
            {md.trim() ? (
              <div className="legal-prose">
                <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{md}</ReactMarkdown>
              </div>
            ) : (
              <p className="text-xs text-wb-text-muted py-6 text-center">免责与法律声明内容待管理员补充。</p>
            )}
          </div>

          <p className="text-2xs text-wb-text-muted leading-relaxed">
            本站内容由用户自行发布，浏览前请阅读社区公约与入站准则。继续访问即表示你已了解相关条款。
          </p>

          {/* 页面入口 */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            <button type="button" onClick={onGoRules}
              className="wb-pressable h-10 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary inline-flex items-center justify-center gap-1.5">
              <BookOpen className="w-3.5 h-3.5" /> 公约与入站准则
            </button>
            <button type="button" onClick={onGoLegal}
              className="wb-pressable h-10 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary inline-flex items-center justify-center gap-1.5">
              <Scale className="w-3.5 h-3.5" /> 免责与法律声明全文
            </button>
          </div>

          <button type="button" onClick={onOpenAuth}
            className="wb-pressable w-full h-11 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold inline-flex items-center justify-center gap-2 shadow-sm">
            <LogIn className="w-4 h-4" /> 登录 / 注册
          </button>
        </div>
      </Modal>
    </>
  );
};
