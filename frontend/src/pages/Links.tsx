import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, Heart, Link2, Loader2, Plus, Sparkles, X } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from '../components/Toast';
import { isDeepLoveLink } from '../components/FriendLinksCard';
import { usePortalMode } from '../utils/portalMode';
import type { FriendLink, UserProfile } from '../types';

interface Props {
  user: UserProfile | null;
  onBack: () => void;
  onRequireAuth: () => void;
}

const FALLBACK_COLORS = [
  'bg-wb-brand/15 text-wb-brand',
  'bg-wb-info/15 text-wb-info',
  'bg-wb-success/15 text-wb-success',
  'bg-wb-warn/15 text-wb-warn',
  'bg-wb-danger/15 text-wb-danger',
];

const colorFor = (name: string) => {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return FALLBACK_COLORS[Math.abs(hash) % FALLBACK_COLORS.length];
};

const LinkLogo: React.FC<{ link: FriendLink; size?: number }> = ({ link, size = 40 }) => {
  const [failed, setFailed] = useState(false);
  const showImage = link.icon_url && !failed;
  return (
    <span
      style={{ width: size, height: size }}
      className={`flex items-center justify-center rounded-xl overflow-hidden shrink-0 border border-wb-border-subtle ${
        showImage ? 'bg-wb-bg-subtle' : colorFor(link.site_name)
      }`}
    >
      {showImage ? (
        <img
          src={link.icon_url}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="w-full h-full object-contain p-1"
        />
      ) : (
        <span className="text-sm font-bold select-none">{(link.site_name || '?').slice(0, 1).toUpperCase()}</span>
      )}
    </span>
  );
};

export const Links: React.FC<Props> = ({ user, onBack, onRequireAuth }) => {
  const toast = useToast();
  const [portalMode] = usePortalMode();
  const isPro = portalMode === 'pro';
  const [links, setLinks] = useState<FriendLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [applyOpen, setApplyOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const [siteName, setSiteName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [contact, setContact] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/links');
      setLinks(Array.isArray(res.data) ? res.data : []);
    } catch {
      /* 静默：列表为空时展示空状态即可 */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // 深情 / 特邀伙伴单独成区，专业版用更密的网格
  const { deepLoveLinks, regularLinks } = useMemo(() => {
    const visible = links.filter((l) => l.visible !== false);
    const deep: FriendLink[] = [];
    const regular: FriendLink[] = [];
    visible.forEach((l) => (isDeepLoveLink(l) ? deep : regular).push(l));
    return { deepLoveLinks: deep, regularLinks: regular };
  }, [links]);

  const openApply = () => {
    if (!user) {
      onRequireAuth();
      return;
    }
    setApplyOpen(true);
  };

  const handleSubmit = async () => {
    if (!siteName.trim() || !siteUrl.trim()) {
      toast.warning('站名和网址必填');
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/links/apply', {
        site_name: siteName.trim(),
        url: siteUrl.trim(),
        description: desc.trim(),
        contact: contact.trim(),
      });
      toast.success('已提交，站长审核通过后会出现在这里');
      setApplyOpen(false);
      setSiteName('');
      setSiteUrl('');
      setDesc('');
      setContact('');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '提交失败');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={isPro
      ? 'max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-6 animate-fade-in'
      : 'max-w-4xl mx-auto px-4 py-6 space-y-5 animate-fade-in'}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="wb-pressable inline-flex items-center justify-center p-2 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
          </button>
          <div className="min-w-0">
            <h1 className="text-base font-bold text-wb-text-primary flex items-center gap-2">
              <Link2 className="w-4 h-4" /> 友情链接
            </h1>
            <p className="text-2xs text-wb-text-muted">一起把好内容分享出去</p>
          </div>
        </div>

        <button
          type="button"
          onClick={openApply}
          className="wb-pressable inline-flex items-center gap-1.5 h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm shrink-0"
        >
          <Plus className="w-3.5 h-3.5" /> 申请友链
        </button>
      </div>

      {loading ? (
        <div className="py-16 flex items-center justify-center gap-2 text-xs text-wb-text-muted">
          <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
        </div>
      ) : links.length === 0 ? (
        <div className="p-12 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-2">
          <Link2 className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
          <p className="text-xs text-wb-text-muted">还没有友情链接，欢迎第一个申请</p>
        </div>
      ) : (
        <div className="space-y-8">
          {/* 深情友链 · 精选伙伴（专业版样式：粉金微光特写展区） */}
          {deepLoveLinks.length > 0 && (
            <div className="space-y-3">
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="p-1.5 rounded-lg bg-rose-500/10 text-rose-500">
                    <Heart className="w-4 h-4 fill-current" />
                  </span>
                  <div>
                    <h2 className="text-sm font-bold text-wb-text-primary flex items-center gap-1.5">
                      <span>深情友链</span>
                      <span className="px-1.5 py-0.2 rounded text-[10px] font-semibold bg-rose-500/15 text-rose-500">精选伙伴</span>
                    </h2>
                    <p className="text-3xs text-wb-text-muted">本站特别推荐的深度技术好友与核心开源作者</p>
                  </div>
                </div>
                <span className="text-3xs text-wb-text-muted font-mono shrink-0">{deepLoveLinks.length} 站</span>
              </div>
              <div className={`grid grid-cols-1 ${isPro ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'sm:grid-cols-2'} gap-3`}>
                {deepLoveLinks.map((link) => (
                  <a
                    key={link.id}
                    href={`/api/links/${link.id}/visit`}
                    target="_blank"
                    rel="noopener noreferrer nofollow"
                    className="relative group p-4 rounded-2xl bg-gradient-to-br from-rose-500/[0.04] to-wb-bg-surface border border-rose-500/30 hover:border-rose-500/60 transition-all shadow-2xs hover:shadow-md flex flex-col justify-between overflow-hidden"
                  >
                    <div className="flex items-start gap-3">
                      <LinkLogo link={link} size={42} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center justify-between gap-1">
                          <span className="text-xs font-bold text-wb-text-primary truncate group-hover:text-rose-500 transition-colors">{link.site_name}</span>
                          <ExternalLink className="w-3.5 h-3.5 text-rose-400 opacity-60 group-hover:opacity-100 shrink-0" />
                        </div>
                        <p className="text-2xs text-wb-text-secondary line-clamp-2 mt-1 leading-relaxed">
                          {link.description || '博主常年输出优质技术思考'}
                        </p>
                      </div>
                    </div>
                    <div className="mt-3 pt-2.5 border-t border-rose-500/15 flex items-center justify-between text-3xs text-wb-text-muted">
                      <span className="flex items-center gap-1 text-rose-500 font-medium"><Sparkles className="w-3 h-3" /> 站长深情推荐</span>
                      {link.click_count ? <span className="font-mono">{link.click_count} 次访问</span> : null}
                    </div>
                  </a>
                ))}
              </div>
            </div>
          )}

          {/* 常规技术伙伴 */}
          <div className={`grid grid-cols-1 ${isPro ? 'sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4' : 'sm:grid-cols-2'} gap-3`}>
            {regularLinks.map((link) => (
              <a
                key={link.id}
                href={`/api/links/${link.id}/visit`}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="surface wb-pressable flex items-start gap-3 p-4 rounded-2xl border border-wb-border-subtle hover:border-wb-border-strong transition-all group"
              >
                <LinkLogo link={link} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-xs font-semibold text-wb-text-primary truncate group-hover:underline">
                      {link.site_name}
                    </span>
                    <ExternalLink className="w-3 h-3 text-wb-text-muted shrink-0" />
                  </div>
                  <p className="text-2xs text-wb-text-muted line-clamp-2 mt-0.5">
                    {link.description || link.url}
                  </p>
                </div>
              </a>
            ))}
          </div>
        </div>
      )}

      {applyOpen && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in">
          <div className="w-full max-w-md rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl">
            <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-wb-border-subtle">
              <h3 className="text-sm font-bold text-wb-text-primary">申请友情链接</h3>
              <button
                type="button"
                onClick={() => setApplyOpen(false)}
                className="p-1.5 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="p-5 space-y-3">
              <input
                value={siteName}
                onChange={(e) => setSiteName(e.target.value)}
                placeholder="站点名称"
                maxLength={64}
                className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
              />
              <input
                value={siteUrl}
                onChange={(e) => setSiteUrl(e.target.value)}
                placeholder="网址，如：https://example.com"
                className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
              />
              <textarea
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder="一句话介绍你的站点（选填）"
                maxLength={200}
                rows={3}
                className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30 resize-none"
              />
              <input
                value={contact}
                onChange={(e) => setContact(e.target.value)}
                placeholder="联系方式（邮箱 / TG，选填）"
                maxLength={120}
                className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
              />
              <p className="text-2xs text-wb-text-muted leading-relaxed">
                提交后会进入审核，站长通过即会上架。系统会自动抓取你站点的图标；如果抓不到，站长也可以手动补一张。
              </p>
            </div>

            <div className="px-5 py-4 border-t border-wb-border-subtle flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setApplyOpen(false)}
                className="px-4 py-2 rounded-capsule text-xs text-wb-text-secondary hover:text-wb-text-primary"
              >
                取消
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={submitting}
                className="wb-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
              >
                {submitting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                提交申请
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
