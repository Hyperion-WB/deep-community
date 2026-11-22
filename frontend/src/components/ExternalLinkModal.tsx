import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, ShieldAlert, Check } from 'lucide-react';

interface ExternalLinkModalState {
  isOpen: boolean;
  targetUrl: string;
}

// 全局事件调度器，方便任意组件直接唤起外链跳转确认
const EXTERNAL_LINK_EVENT = 'geek_open_external_link';

export const promptExternalLink = (url: string) => {
  try {
    const isSkip = localStorage.getItem('geek_skip_external_link_warning') === 'true';
    if (isSkip) {
      window.open(url, '_blank', 'noopener,noreferrer');
      return;
    }
    const evt = new CustomEvent(EXTERNAL_LINK_EVENT, { detail: { url } });
    window.dispatchEvent(evt);
  } catch {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
};

export const ExternalLinkModal: React.FC = () => {
  const [modalState, setModalState] = useState<ExternalLinkModalState>({
    isOpen: false,
    targetUrl: '',
  });
  const [dontRemindAgain, setDontRemindAgain] = useState(false);

  useEffect(() => {
    const handleOpen = (e: Event) => {
      const customEvent = e as CustomEvent<{ url: string }>;
      if (customEvent.detail?.url) {
        setModalState({
          isOpen: true,
          targetUrl: customEvent.detail.url,
        });
        setDontRemindAgain(false);
      }
    };

    window.addEventListener(EXTERNAL_LINK_EVENT, handleOpen);

    // 全局外链点击拦截器 (智能捕获 Markdown 中的外链、个人简介博客与开源链接等)
    const handleDocumentClick = (e: MouseEvent) => {
      const target = (e.target as HTMLElement).closest('a');
      if (!target || !target.href) return;

      const href = target.getAttribute('href');
      if (!href) return;

      // 仅拦截 http / https 绝对路径外链，忽略锚点、内部路由和 mailto
      if (href.startsWith('http://') || href.startsWith('https://')) {
        try {
          const currentHost = window.location.hostname;
          const targetHost = new URL(href).hostname;

          if (targetHost && targetHost !== currentHost) {
            const isSkip = localStorage.getItem('geek_skip_external_link_warning') === 'true';
            if (!isSkip) {
              e.preventDefault();
              e.stopPropagation();
              setModalState({
                isOpen: true,
                targetUrl: href,
              });
              setDontRemindAgain(false);
            }
          }
        } catch {
          // URL 解析容错
        }
      }
    };

    document.addEventListener('click', handleDocumentClick, true);

    return () => {
      window.removeEventListener(EXTERNAL_LINK_EVENT, handleOpen);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, []);

  const handleClose = () => {
    setModalState({ isOpen: false, targetUrl: '' });
  };

  const handleProceed = () => {
    if (dontRemindAgain) {
      localStorage.setItem('geek_skip_external_link_warning', 'true');
    }
    const dest = modalState.targetUrl;
    handleClose();
    if (dest) {
      window.open(dest, '_blank', 'noopener,noreferrer');
    }
  };

  let targetHostname = '';
  try {
    if (modalState.targetUrl) {
      targetHostname = new URL(modalState.targetUrl).hostname;
    }
  } catch {
    targetHostname = modalState.targetUrl;
  }

  return (
    <AnimatePresence>
      {modalState.isOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          {/* 背景模糊遮罩 */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={handleClose}
            className="fixed inset-0 bg-black/60 backdrop-blur-sm"
          />

          {/* 模态弹窗主体 (百分百贴合社区统一极客极简黑白灰风格与圆角胶囊规范) */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', damping: 25, stiffness: 350 }}
            className="relative w-full max-w-md mx-auto bg-wb-bg-surface border border-wb-border-subtle rounded-3xl p-6 sm:p-7 shadow-2xl space-y-4 text-left z-10"
          >
            {/* 标题与副标题 */}
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-wb-text-primary flex-shrink-0" />
                <h3 className="text-base sm:text-lg font-bold text-wb-text-primary tracking-tight">
                  跳转提醒
                </h3>
              </div>
              <p className="text-xs sm:text-[13px] text-wb-text-secondary leading-relaxed">
                即将离开本网站，出去后请注意保护自己！本站不对外链内容负责！
              </p>
            </div>

            {/* 目标链接展示卡片 (符合社区统一的 code/input 样式，统一支持暗色与浅色模式) */}
            <div className="p-3.5 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-primary font-mono text-xs sm:text-sm break-all select-all flex items-center justify-between gap-2 shadow-inner">
              <span className="flex-1 font-medium">{modalState.targetUrl}</span>
              <ExternalLink className="w-4 h-4 text-wb-text-muted shrink-0 opacity-70" />
            </div>

            {/* 安全风险警示说明 */}
            <p className="text-xs text-wb-text-muted leading-relaxed">
              目标网站 <strong className="text-wb-text-primary font-semibold font-mono">{targetHostname}</strong>，请确认无误后再继续，不要在陌生站点填写本站账号或支付信息。
            </p>

            {/* 底部操作与下次不再提醒开关 */}
            <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 border-t border-wb-border-subtle/60">
              {/* 下次不再提醒开关 */}
              <label className="flex items-center gap-2 cursor-pointer select-none group">
                <button
                  type="button"
                  onClick={() => setDontRemindAgain(!dontRemindAgain)}
                  className={`wb-pressable relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    dontRemindAgain ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                      dontRemindAgain ? 'translate-x-4' : 'translate-x-0'
                    }`}
                  />
                </button>
                <span className="text-xs text-wb-text-secondary group-hover:text-wb-text-primary transition-colors">
                  下次不再提醒
                </span>
              </label>

              {/* 按钮群组: 严格使用社区统一的胶囊规范 */}
              <div className="flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={handleClose}
                  className="wb-pressable px-4 py-2 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface hover:bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary text-xs font-medium transition-colors"
                >
                  返回上一页
                </button>

                <button
                  type="button"
                  onClick={handleProceed}
                  className="wb-pressable px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 text-xs font-semibold shadow-sm transition-all flex items-center gap-1.5"
                >
                  <span>立即跳转!</span>
                  <Check className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
};
