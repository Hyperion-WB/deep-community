import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { ExternalLink, ShieldAlert, Check } from 'lucide-react';
import { useDialogA11y } from '../hooks/useDialogA11y';

type ExternalLinkRequest = { url: string; requireConfirmation: boolean };
const EXTERNAL_LINK_EVENT = 'geek_open_external_link';
const SKIP_WARNING_KEY = 'geek_skip_external_link_warning';
const HTTP_URL_RE = /^https?:\/\/[^/\\\s]/i;
// 聊天里的中文常常紧跟在链接后面；原规则会把整段中文也吞进 URL。
// URL 本身含汉字时，可使用百分号编码后的地址。
const TEXT_URL_RE = /(?<![A-Za-z0-9_+./@:%-])https?:\/\/[^\s<>"“”‘’，。！？；：、（）【】《》「」\p{Script=Han}]+/giu;

function parseHttpUrl(url: string): URL | null {
  if (!HTTP_URL_RE.test(url)) return null;
  try {
    const parsed = new URL(url);
    return parsed.hostname ? parsed : null;
  } catch {
    return null;
  }
}

function skipWarning() {
  try {
    return localStorage.getItem(SKIP_WARNING_KEY) === 'true';
  } catch {
    return false;
  }
}

export const openExternalLinkDirect = (url: string) => {
  const parsed = parseHttpUrl(trimUrlEnding(url));
  if (parsed) window.open(parsed.href, '_blank', 'noopener,noreferrer');
};

export const promptExternalLink = (url: string, requireConfirmation = false) => {
  const parsed = parseHttpUrl(url);
  if (!parsed) return;
  const normalizedUrl = parsed.href;
  if (!requireConfirmation && skipWarning()) {
    window.open(normalizedUrl, '_blank', 'noopener,noreferrer');
    return;
  }
  window.dispatchEvent(new CustomEvent<ExternalLinkRequest>(EXTERNAL_LINK_EVENT, {
    detail: { url: normalizedUrl, requireConfirmation },
  }));
};

export function trimUrlEnding(value: string) {
  const pairs = { ')': '(', ']': '[', '}': '{' } as const;
  const balance = { '(': 0, '[': 0, '{': 0 };
  for (const char of value) {
    if (char === '(' || char === '[' || char === '{') balance[char]++;
    if (char === ')' || char === ']' || char === '}') balance[pairs[char]]--;
  }
  let end = value.length;
  while (end > 0) {
    const char = value[end - 1];
    if (/[.,!?;:'"”’…]/.test(char) || /[）】》」]/.test(char)) end--;
    else if ((char === ')' || char === ']' || char === '}') && balance[pairs[char]] < 0) {
      balance[pairs[char]]++;
      end--;
    } else break;
  }
  return value.slice(0, end);
}

// 从全文识别 URL；折叠时只对完整落在可见范围内的 URL 提供跳转。
export function renderPlainTextLinks(
  text: string,
  renderText: (value: string) => React.ReactNode,
  visibleEnd = text.length,
): React.ReactNode[] {
  const parts: React.ReactNode[] = [];
  let offset = 0;
  for (const match of text.matchAll(TEXT_URL_RE)) {
    const start = match.index;
    if (start >= visibleEnd) break;
    const url = trimUrlEnding(match[0]);
    if (!parseHttpUrl(url)) continue;
    if (start > offset) parts.push(<React.Fragment key={`text-${offset}`}>{renderText(text.slice(offset, start))}</React.Fragment>);
    const end = start + url.length;
    if (end > visibleEnd) {
      parts.push(text.slice(start, visibleEnd));
      return parts;
    }
    parts.push(
      <button
        key={`link-${start}`}
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          openExternalLinkDirect(url);
        }}
        title={url}
        className="inline cursor-pointer break-all text-left text-inherit underline underline-offset-2 hover:opacity-75 select-none"
      >
        {url}
      </button>,
    );
    offset = end;
  }
  if (offset < visibleEnd) parts.push(<React.Fragment key={`text-${offset}`}>{renderText(text.slice(offset, visibleEnd))}</React.Fragment>);
  return parts;
}

export const ExternalLinkModal: React.FC = () => {
  const [request, setRequest] = useState<ExternalLinkRequest | null>(null);
  const [dontRemindAgain, setDontRemindAgain] = useState(false);
  const handleClose = () => setRequest(null);
  const dialogRef = useDialogA11y(Boolean(request), handleClose, 9999);

  useEffect(() => {
    const open = (nextRequest: ExternalLinkRequest) => {
      setRequest(nextRequest);
      setDontRemindAgain(false);
    };
    const handleOpen = (event: Event) => {
      const { detail } = event as CustomEvent<ExternalLinkRequest>;
      if (typeof detail?.url === 'string' && parseHttpUrl(detail.url)) open(detail);
    };

    // Markdown、个人简介等现有外链仍保留站点原本的提醒偏好。
    const handleDocumentClick = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      const rawHref = event.target.closest('a')?.getAttribute('href');
      const href = rawHref ? trimUrlEnding(rawHref) : '';
      const url = href ? parseHttpUrl(href) : null;
      if (!href || !url || url.hostname === window.location.hostname || skipWarning()) return;
      event.preventDefault();
      event.stopPropagation();
      open({ url: href, requireConfirmation: false });
    };

    window.addEventListener(EXTERNAL_LINK_EVENT, handleOpen);
    document.addEventListener('click', handleDocumentClick, true);
    return () => {
      window.removeEventListener(EXTERNAL_LINK_EVENT, handleOpen);
      document.removeEventListener('click', handleDocumentClick, true);
    };
  }, []);

  const handleProceed = () => {
    if (!request) return;
    if (!request.requireConfirmation && dontRemindAgain) {
      try {
        localStorage.setItem(SKIP_WARNING_KEY, 'true');
      } catch {
        // 存储不可用时仍允许已确认的本次跳转。
      }
    }
    const targetUrl = parseHttpUrl(request.url)?.href;
    handleClose();
    if (targetUrl) window.open(targetUrl, '_blank', 'noopener,noreferrer');
  };

  const targetHostname = request ? parseHttpUrl(request.url)?.hostname : '';

  return createPortal(
    <AnimatePresence>
      {request && (
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
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="跳转提醒"
            initial={{ opacity: 0, scale: 0.95, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 10 }}
            transition={{ type: 'spring', damping: 25, stiffness: 350 }}
            className="relative w-full max-w-md max-h-full overflow-y-auto overscroll-contain mx-auto bg-wb-bg-surface border border-wb-border-subtle rounded-3xl p-6 sm:p-7 shadow-2xl space-y-4 text-left z-10"
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
              <span className="min-w-0 flex-1 font-medium">{request.url}</span>
              <ExternalLink className="w-4 h-4 text-wb-text-muted shrink-0 opacity-70" />
            </div>

            {/* 安全风险警示说明 */}
            <p className="text-xs text-wb-text-muted leading-relaxed">
              目标网站 <strong className="text-wb-text-primary font-semibold font-mono">{targetHostname}</strong>，请确认无误后再继续，不要在陌生站点填写本站账号或支付信息。
            </p>

            {/* 底部操作与下次不再提醒开关 */}
            <div className="pt-2 flex flex-col sm:flex-row items-stretch sm:items-center gap-3 border-t border-wb-border-subtle/60">
              {!request.requireConfirmation && (
                <button
                  type="button"
                  role="switch"
                  aria-checked={dontRemindAgain}
                  onClick={() => setDontRemindAgain(!dontRemindAgain)}
                  className="flex items-center gap-2 cursor-pointer select-none text-xs text-wb-text-secondary hover:text-wb-text-primary"
                >
                  <span className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 transition-colors ${dontRemindAgain ? 'border-transparent bg-wb-text-primary' : 'border-wb-border-subtle bg-wb-bg-subtle'}`}>
                    <span className={`inline-block h-4 w-4 rounded-full bg-wb-bg-page shadow transition-transform ${dontRemindAgain ? 'translate-x-4' : 'translate-x-0'}`} />
                  </span>
                  下次不再提醒
                </button>
              )}

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
    </AnimatePresence>,
    document.body,
  );
};
