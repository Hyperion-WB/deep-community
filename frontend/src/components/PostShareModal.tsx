import React, { useRef, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import QRCode from 'qrcode';
import {
  X,
  Share2,
  Copy,
  Check,
  Download,
  FileText,
  Heart,
  MessageSquare,
} from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { LevelBadge } from './LevelBadge';
import { getSmartDailyTitle } from '../utils/format';
import type { PostDetail as PostDetailType } from '../types';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  post: PostDetailType | null;
  readingMinutes?: number;
  wordCount?: number;
}

export const PostShareModal: React.FC<Props> = ({
  isOpen,
  onClose,
  post,
  readingMinutes = 3,
  wordCount = 500,
}) => {
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedText, setCopiedText] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [qrCodeDataUrl, setQrCodeDataUrl] = useState<string>('');
  const cardRef = useRef<HTMLDivElement>(null);

  const shareUrl = post ? `${window.location.origin}/p/${post.id}` : '';
  const displayTitle = post ? getSmartDailyTitle(post.title, post.content_md) : '';

  // 分享图取当前主题变量，避免用户切换配色后导出的仍是曜石色
  const cssVar = (name: string, fallback: string) => {
    if (typeof window === 'undefined') return fallback;
    const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return value || fallback;
  };

  useEffect(() => {
    if (shareUrl) {
      QRCode.toDataURL(shareUrl, {
        width: 180,
        margin: 1,
        color: {
          dark: cssVar('--wb-text-primary', '#0f172a'),
          light: '#ffffff',
        },
      })
        .then(setQrCodeDataUrl)
        .catch(() => {});
    }
  }, [shareUrl]);

  if (!isOpen || !post) return null;

  // 提取正文首段纯文本摘要
  const cleanExcerpt = post.content_md
    ? post.content_md
        .replace(/#+\s+/g, '')
        .replace(/\!\[.*?\]\(.*?\)/g, '')
        .replace(/\[(.*?)\]\(.*?\)/g, '$1')
        .replace(/[`*~_]/g, '')
        .trim()
        .slice(0, 160) + '...'
    : '探讨前沿架构演进与现代全栈开发实践。';

  const handleCopyLink = async () => {
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    } catch {
      const input = document.createElement('input');
      input.value = shareUrl;
      document.body.appendChild(input);
      input.select();
      document.execCommand('copy');
      document.body.removeChild(input);
      setCopiedLink(true);
      setTimeout(() => setCopiedLink(false), 2000);
    }
  };

  const handleCopyCardText = async () => {
    const textSnippet = `【${displayTitle}】\n作者：@${post.author_username}\n分类：${post.category_name || '综合讨论'}\n\n${cleanExcerpt}\n\n阅读全文：${shareUrl}`;
    try {
      await navigator.clipboard.writeText(textSnippet);
      setCopiedText(true);
      setTimeout(() => setCopiedText(false), 2000);
    } catch {}
  };

  // 生成 Canvas 导出图片
  const handleDownloadCard = async () => {
    setDownloading(true);
    try {
      const canvas = document.createElement('canvas');
      const scale = 2; // 高清视网膜 2x
      const width = 420;
      const height = 570;

      canvas.width = width * scale;
      canvas.height = height * scale;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      ctx.scale(scale, scale);

      // 绘制卡片背景
      const isDark = document.documentElement.classList.contains('dark');
      const bgGrad = ctx.createLinearGradient(0, 0, width, height);
      if (isDark) {
        bgGrad.addColorStop(0, cssVar('--wb-bg-surface', '#13171f'));
        bgGrad.addColorStop(1, cssVar('--wb-bg-page', '#090a0d'));
      } else {
        bgGrad.addColorStop(0, cssVar('--wb-bg-surface', '#ffffff'));
        bgGrad.addColorStop(1, cssVar('--wb-bg-page', '#f4f5f7'));
      }

      ctx.fillStyle = bgGrad;
      ctx.beginPath();
      ctx.roundRect(0, 0, width, height, 24);
      ctx.fill();

      // 边框
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.12)' : 'rgba(0, 0, 0, 0.1)';
      ctx.stroke();

      // 顶部 Header: 社区标志
      ctx.fillStyle = cssVar('--wb-text-primary', isDark ? '#f8fafc' : '#0f172a');
      ctx.font = 'bold 16px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillText('COMMUNITY · 极客空间', 28, 48);

      ctx.fillStyle = cssVar('--wb-text-muted', isDark ? '#94a3b8' : '#64748b');
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillText(
        `${post.category_name || '技术研讨'} · ${new Date(post.created_at).toLocaleDateString()} · 约 ${wordCount} 字`,
        28,
        74
      );

      // 分割线
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.08)' : 'rgba(0, 0, 0, 0.08)';
      ctx.beginPath();
      ctx.moveTo(28, 92);
      ctx.lineTo(width - 28, 92);
      ctx.stroke();

      // 大标题 (自动折行两行)
      ctx.fillStyle = cssVar('--wb-text-primary', isDark ? '#f8fafc' : '#0f172a');
      ctx.font = 'bold 18px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';

      const words = displayTitle.split('');
      let line = '';
      let lineCount = 0;
      let titleY = 126;

      for (let n = 0; n < words.length; n++) {
        const testLine = line + words[n];
        const metrics = ctx.measureText(testLine);
        if (metrics.width > width - 56 && n > 0) {
          ctx.fillText(line, 28, titleY);
          line = words[n];
          titleY += 26;
          lineCount++;
          if (lineCount >= 2) {
            line = line.slice(0, -2) + '...';
            break;
          }
        } else {
          line = testLine;
        }
      }
      ctx.fillText(line, 28, titleY);

      // 摘要正文
      const excerptY = titleY + 28;
      ctx.fillStyle = isDark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(0, 0, 0, 0.03)';
      ctx.beginPath();
      ctx.roundRect(28, excerptY, width - 56, 150, 16);
      ctx.fill();

      ctx.fillStyle = isDark ? '#cbd5e1' : '#334155';
      ctx.font = '13px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';

      const excerptWords = cleanExcerpt.split('');
      let eLine = '';
      let eY = excerptY + 30;
      let eCount = 0;
      for (let n = 0; n < excerptWords.length; n++) {
        const testLine = eLine + excerptWords[n];
        const metrics = ctx.measureText(testLine);
        if (metrics.width > width - 96 && n > 0) {
          ctx.fillText(eLine, 44, eY);
          eLine = excerptWords[n];
          eY += 22;
          eCount++;
          if (eCount >= 4) {
            eLine = eLine.slice(0, -3) + '...';
            break;
          }
        } else {
          eLine = testLine;
        }
      }
      ctx.fillText(eLine, 44, eY);

      // 作者信息栏与真实二维码绘制
      const authorY = 440;
      ctx.fillStyle = cssVar('--wb-text-primary', isDark ? '#f8fafc' : '#0f172a');
      ctx.font = 'bold 14px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillText(post.author_nickname || post.author_username, 28, authorY);

      ctx.fillStyle = cssVar('--wb-text-muted', isDark ? '#94a3b8' : '#64748b');
      ctx.font = '11px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillText(`@${post.author_username} · Lv.${post.author_level} 极客先锋`, 28, authorY + 18);

      // 互动数据指标
      ctx.fillText(
        `浏览 ${post.view_count || 0}   点赞 ${post.like_count || 0}   评论 ${post.comment_count || 0}`,
        28,
        authorY + 38
      );

      // 绘制右下角真实二维码
      if (qrCodeDataUrl) {
        const qrImg = new Image();
        qrImg.src = qrCodeDataUrl;
        await new Promise((resolve) => {
          if (qrImg.complete) return resolve(true);
          qrImg.onload = () => resolve(true);
          qrImg.onerror = () => resolve(false);
        });
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.roundRect(width - 28 - 66, authorY - 14, 66, 66, 10);
        ctx.fill();
        ctx.drawImage(qrImg, width - 28 - 63, authorY - 11, 60, 60);
      }

      // 底部专属水印印章
      ctx.strokeStyle = isDark ? 'rgba(255, 255, 255, 0.1)' : 'rgba(0, 0, 0, 0.1)';
      ctx.beginPath();
      ctx.moveTo(28, 510);
      ctx.lineTo(width - 28, 510);
      ctx.stroke();

      ctx.fillStyle = cssVar('--wb-text-muted', isDark ? '#94a3b8' : '#64748b');
      ctx.font = '10px -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", sans-serif';
      ctx.fillText('扫码或访问深度极客社区查阅完整互动讨论', 28, 538);

      // 触发下载
      const dataUrl = canvas.toDataURL('image/png');
      const a = document.createElement('a');
      a.href = dataUrl;
      a.download = `community-share-${post.id}.png`;
      a.click();
    } catch (e) {
      console.error(e);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <AnimatePresence>
      <div
        className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
        onClick={(e) => {
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.95, y: 10 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.95, y: 10 }}
          className="w-full max-w-md bg-wb-bg-surface border border-wb-border-strong rounded-3xl shadow-2xl flex flex-col overflow-hidden max-h-[90vh]"
        >
          {/* 弹窗顶栏 */}
          <div className="px-5 py-3.5 border-b border-wb-border-subtle flex items-center justify-between bg-wb-bg-surface/80">
            <div className="flex items-center gap-2">
              <Share2 className="w-4 h-4 text-wb-text-primary" />
              <h3 className="font-bold text-sm text-wb-text-primary">生成分享海报卡片</h3>
            </div>
            <button
              onClick={onClose}
              className="p-1 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* 卡片预览区域 */}
          <div className="p-4 sm:p-5 overflow-y-auto max-h-[60vh] flex flex-col items-center bg-wb-bg-subtle/30">
            <div
              ref={cardRef}
              className="w-full max-w-[360px] p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-strong shadow-card space-y-4 select-none"
            >
              {/* 卡片头部 */}
              <div className="flex items-center justify-between border-b border-wb-border-subtle pb-3">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-lg bg-wb-text-primary text-wb-bg-page flex items-center justify-center font-bold text-xs font-mono">
                    G
                  </div>
                  <div>
                    <span className="font-bold text-xs tracking-wider text-wb-text-primary font-mono block">
                      COMMUNITY
                    </span>
                    <span className="text-3xs text-wb-text-muted font-sans block">深度极客社区</span>
                  </div>
                </div>
                <span className="px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-secondary text-3xs font-mono border border-wb-border-subtle">
                  {post.category_name || '综合'}
                </span>
              </div>

              {/* 文章标题 */}
              <div>
                <h4 className="text-base font-bold text-wb-text-primary leading-snug line-clamp-2">
                  {displayTitle}
                </h4>
                <div className="flex items-center gap-2 text-2xs text-wb-text-muted font-mono mt-1">
                  <span>{new Date(post.created_at).toLocaleDateString()}</span>
                  <span>·</span>
                  <span>约 {wordCount} 字</span>
                  <span>·</span>
                  <span>{readingMinutes} 分钟</span>
                </div>
              </div>

              {/* 精彩正文摘录 */}
              <div className="p-3.5 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle text-xs text-wb-text-secondary leading-relaxed line-clamp-4 font-sans">
                {cleanExcerpt}
              </div>

              {/* 作者名片与统计 */}
              <div className="flex items-center justify-between pt-2 border-t border-wb-border-subtle text-xs">
                <div className="flex items-center gap-2.5">
                  <UserAvatar
                    username={post.author_username}
                    avatarUrl={post.author_avatar}
                    size="sm"
                  />
                  <div>
                    <div className="flex items-center gap-1.5">
                      <span className="font-bold text-xs text-wb-text-primary">
                        {post.author_nickname || post.author_username}
                      </span>
                      <LevelBadge level={post.author_level} size="sm" />
                    </div>
                    <span className="text-3xs text-wb-text-muted font-mono block">
                      @{post.author_username}
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3 text-2xs text-wb-text-muted font-mono">
                  <span className="flex items-center gap-1">
                    <Heart className="w-3 h-3 text-wb-danger" /> {post.like_count || 0}
                  </span>
                  <span className="flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" /> {post.comment_count || 0}
                  </span>
                </div>
              </div>

              {/* 底部极客微水印与真实扫码二维码 */}
              <div className="flex items-center justify-between pt-3 border-t border-dashed border-wb-border-subtle gap-3">
                <div className="space-y-0.5">
                  <span className="text-2xs font-semibold text-wb-text-primary block">
                    扫码查阅完整深度文章
                  </span>
                  <span className="text-3xs text-wb-text-muted block">
                    深度极客研讨 · 原创精选
                  </span>
                  <span className="font-mono text-wb-text-secondary text-3xs block">
                    #GeekCommunity
                  </span>
                </div>
                {qrCodeDataUrl ? (
                  <div className="p-1 rounded-xl bg-white border border-wb-border-subtle shadow-sm shrink-0">
                    <img loading="lazy" decoding="async"
                      src={qrCodeDataUrl}
                      alt="文章二维码"
                      className="w-14 h-14 object-contain rounded-lg"
                    />
                  </div>
                ) : (
                  <div className="w-14 h-14 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center text-3xs text-wb-text-muted shrink-0">
                    生成中...
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* 底部行动按键栏 */}
          <div className="p-4 border-t border-wb-border-subtle bg-wb-bg-surface flex flex-col sm:flex-row items-center gap-2.5">
            <button
              type="button"
              onClick={handleCopyLink}
              className="wb-pressable w-full sm:flex-1 h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle hover:border-wb-border-strong text-wb-text-primary text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              {copiedLink ? <Check className="w-3.5 h-3.5 text-wb-success" /> : <Copy className="w-3.5 h-3.5" />}
              <span>{copiedLink ? '链接已复制' : '复制文章链接'}</span>
            </button>

            <button
              type="button"
              onClick={handleCopyCardText}
              className="wb-pressable w-full sm:flex-1 h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle hover:border-wb-border-strong text-wb-text-primary text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors"
            >
              {copiedText ? <Check className="w-3.5 h-3.5 text-wb-success" /> : <FileText className="w-3.5 h-3.5" />}
              <span>{copiedText ? '卡片文案已复制' : '复制纯文本卡片'}</span>
            </button>

            <button
              type="button"
              onClick={handleDownloadCard}
              disabled={downloading}
              className="wb-pressable w-full sm:w-auto h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold flex items-center justify-center gap-1.5 shadow-sm hover:opacity-90 disabled:opacity-50"
            >
              <Download className="w-3.5 h-3.5" />
              <span>{downloading ? '生成中...' : '下载高清海报'}</span>
            </button>
          </div>
        </motion.div>
      </div>
    </AnimatePresence>
  );
};
