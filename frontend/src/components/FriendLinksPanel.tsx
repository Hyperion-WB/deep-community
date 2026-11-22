import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Check,
  ExternalLink,
  Eye,
  EyeOff,
  ImagePlus,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import type { FriendLink } from '../types';

/**
 * 后台「友情链接」管理：
 * 待审核申请 → 通过/拒绝；已上架条目 → 排序 / 显隐 / 换图标 / 删除。
 */
export const FriendLinksPanel: React.FC = () => {
  const toast = useToast();
  const [links, setLinks] = useState<FriendLink[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [siteName, setSiteName] = useState('');
  const [siteUrl, setSiteUrl] = useState('');
  const [desc, setDesc] = useState('');
  const [iconUrl, setIconUrl] = useState('');
  const [uploading, setUploading] = useState(false);

  const [rejectingId, setRejectingId] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState('');

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const replaceTargetRef = useRef<string | null>(null);
  const singleFileRef = useRef<HTMLInputElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiClient.get('/admin/links');
      setLinks(Array.isArray(res.data) ? res.data : []);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '友情链接加载失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const groups = useMemo(
    () => ({
      pending: links.filter((l) => l.status === 'pending'),
      approved: links.filter((l) => l.status === 'approved'),
      rejected: links.filter((l) => l.status === 'rejected'),
    }),
    [links]
  );

  const uploadIcon = async (file: File): Promise<string | null> => {
    const fd = new FormData();
    fd.append('file', file);
    setUploading(true);
    try {
      const res = await apiClient.post('/admin/links/upload-icon', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      return res.data?.icon_url || null;
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '图标上传失败');
      return null;
    } finally {
      setUploading(false);
    }
  };

  const handleCreate = async () => {
    if (!siteName.trim() || !siteUrl.trim()) {
      toast.warning('站名和网址必填');
      return;
    }
    setSaving(true);
    try {
      await apiClient.post('/admin/links', {
        site_name: siteName.trim(),
        url: siteUrl.trim(),
        description: desc.trim(),
        sort_order: (groups.approved.at(-1)?.sort_order || 0) + 1,
        visible: true,
        auto_icon: !iconUrl,
        icon_url: iconUrl || undefined,
      });
      toast.success('已添加，图标会自动抓取');
      setSiteName('');
      setSiteUrl('');
      setDesc('');
      setIconUrl('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '添加失败');
    } finally {
      setSaving(false);
    }
  };

  const patch = async (link: FriendLink, body: Record<string, unknown>, okMsg: string) => {
    try {
      await apiClient.put(`/admin/links/${link.id}`, body);
      toast.success(okMsg);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '更新失败');
    }
  };

  const handleApprove = async (link: FriendLink) => {
    try {
      await apiClient.post(`/admin/links/${link.id}/approve`, {});
      toast.success(`已上架「${link.site_name}」`);
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '操作失败');
    }
  };

  const handleReject = async (link: FriendLink) => {
    try {
      await apiClient.post(`/admin/links/${link.id}/reject`, { reason: rejectReason.trim() });
      toast.success('已拒绝');
      setRejectingId(null);
      setRejectReason('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '操作失败');
    }
  };

  const handleRefetch = async (link: FriendLink) => {
    try {
      await apiClient.post(`/admin/links/${link.id}/refetch-icon`);
      toast.success('图标已更新');
    } catch (err: any) {
      toast.warning(err?.response?.data?.detail || '没抓到图标，可以手动上传');
    } finally {
      await load();
    }
  };

  const handleDelete = async (link: FriendLink) => {
    if (!window.confirm(`确认删除「${link.site_name}」？`)) return;
    try {
      await apiClient.delete(`/admin/links/${link.id}`);
      toast.success('已删除');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '删除失败');
    }
  };

  const handleFilePicked = async (file: File) => {
    const url = await uploadIcon(file);
    if (!url) return;

    const replaceId = replaceTargetRef.current;
    replaceTargetRef.current = null;
    if (replaceId) {
      const target = links.find((l) => l.id === replaceId);
      if (target) await patch(target, { icon_url: url }, '图标已更换');
    } else {
      setIconUrl(url);
      toast.success('图标已上传，随友链一起保存');
    }
  };

  const rowActions = (link: FriendLink) => (
    <div className="flex items-center gap-1 shrink-0">
      <button
        type="button"
        onClick={() => patch(link, { visible: !link.visible }, link.visible ? '已隐藏' : '已显示')}
        title={link.visible ? '隐藏（不在前台展示）' : '显示'}
        className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
      >
        {link.visible ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
      </button>
      <button
        type="button"
        onClick={() => handleRefetch(link)}
        title="重新抓取图标"
        className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
      >
        <RefreshCw className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => {
          replaceTargetRef.current = link.id;
          singleFileRef.current?.click();
        }}
        title="手动上传图标"
        className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
      >
        <ImagePlus className="w-3.5 h-3.5" />
      </button>
      <button
        type="button"
        onClick={() => handleDelete(link)}
        title="删除"
        className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors"
      >
        <Trash2 className="w-3.5 h-3.5" />
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {/* 新增 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
        <div className="flex items-center gap-2">
          <Link2 className="w-4 h-4 text-wb-brand" />
          <h3 className="text-xs font-semibold text-wb-text-primary">新增友情链接</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <input
            value={siteName}
            onChange={(e) => setSiteName(e.target.value)}
            placeholder="站名，如：某某的博客"
            className="px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
          />
          <input
            value={siteUrl}
            onChange={(e) => setSiteUrl(e.target.value)}
            placeholder="网址，如：https://example.com"
            className="px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
          />
        </div>

        <input
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder="一句话介绍（可留空，后续也能改）"
          maxLength={200}
          className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
        />

        <div className="flex items-center gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => {
              replaceTargetRef.current = null;
              fileInputRef.current?.click();
            }}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-wb-border-strong bg-wb-bg-subtle text-xs text-wb-text-primary"
          >
            {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
            {iconUrl ? '重新上传图标' : '手动上传图标（可选）'}
          </button>
          {iconUrl && (
            <span className="flex items-center gap-2">
              <img loading="lazy" decoding="async" src={iconUrl} alt="" className="w-7 h-7 rounded-lg object-contain border border-wb-border-subtle bg-wb-bg-subtle" />
              <button type="button" onClick={() => setIconUrl('')} className="text-2xs text-wb-text-muted hover:text-wb-danger">
                移除
              </button>
            </span>
          )}
          <span className="text-2xs text-wb-text-muted">不传图标时，系统会自动去抓对方站点的 favicon</span>
        </div>

        <div className="flex justify-end">
          <button
            type="button"
            onClick={handleCreate}
            disabled={saving}
            className="wb-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
          >
            {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />}
            添加
          </button>
        </div>
      </div>

      {/* 待审核 */}
      {groups.pending.length > 0 && (
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-warn/30 shadow-card space-y-2">
          <div className="flex items-center gap-2 pb-2 border-b border-wb-border-subtle">
            <span className="w-1.5 h-1.5 rounded-full bg-wb-warn" />
            <h3 className="text-xs font-semibold text-wb-text-primary">待审核（{groups.pending.length}）</h3>
          </div>

          <div className="divide-y divide-wb-border-subtle">
            {groups.pending.map((link) => (
              <div key={link.id} className="py-3 space-y-2">
                <div className="flex items-center gap-3">
                  <img loading="lazy" decoding="async"
                    src={link.icon_url || ''}
                    alt=""
                    onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                    className="w-8 h-8 rounded-lg object-contain border border-wb-border-subtle bg-wb-bg-subtle shrink-0"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-semibold text-wb-text-primary truncate">{link.site_name}</div>
                    <a
                      href={link.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-2xs text-wb-text-muted hover:text-wb-text-primary inline-flex items-center gap-1 truncate max-w-full"
                    >
                      {link.url}
                      <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                    </a>
                    {link.description && (
                      <p className="text-2xs text-wb-text-muted truncate">{link.description}</p>
                    )}
                    {link.applicant_contact && (
                      <p className="text-2xs text-wb-text-muted">联系方式：{link.applicant_contact}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button
                      type="button"
                      onClick={() => handleApprove(link)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-wb-success/10 text-wb-success text-2xs font-semibold hover:bg-wb-success/20"
                    >
                      <Check className="w-3 h-3" /> 通过
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setRejectingId(rejectingId === link.id ? null : link.id);
                        setRejectReason('');
                      }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-wb-danger/10 text-wb-danger text-2xs font-semibold hover:bg-wb-danger/20"
                    >
                      <X className="w-3 h-3" /> 拒绝
                    </button>
                    <button
                      type="button"
                      onClick={() => handleDelete(link)}
                      title="删除"
                      className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {rejectingId === link.id && (
                  <div className="flex items-center gap-2 pl-11">
                    <input
                      value={rejectReason}
                      onChange={(e) => setRejectReason(e.target.value)}
                      placeholder="拒绝理由（选填，自己备忘）"
                      maxLength={200}
                      className="flex-1 px-3 py-1.5 text-2xs rounded-lg border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-primary"
                    />
                    <button
                      type="button"
                      onClick={() => handleReject(link)}
                      className="px-3 py-1.5 rounded-lg bg-wb-danger text-white text-2xs font-semibold"
                    >
                      确认拒绝
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* 已上架 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-2">
        <div className="flex items-center justify-between pb-2 border-b border-wb-border-subtle">
          <h3 className="text-xs font-semibold text-wb-text-primary">已上架（{groups.approved.length}）</h3>
          <button type="button" onClick={load} className="text-2xs text-wb-text-muted hover:text-wb-text-primary inline-flex items-center gap-1">
            <RefreshCw className="w-3 h-3" /> 刷新
          </button>
        </div>

        {loading ? (
          <div className="py-8 flex items-center justify-center gap-2 text-xs text-wb-text-muted">
            <Loader2 className="w-4 h-4 animate-spin" /> 加载中…
          </div>
        ) : groups.approved.length === 0 ? (
          <p className="py-8 text-center text-xs text-wb-text-muted">还没有友链，先在上方添加一个吧</p>
        ) : (
          <div className="divide-y divide-wb-border-subtle">
            {groups.approved.map((link) => (
              <div key={link.id} className="flex items-center gap-3 py-3">
                <img loading="lazy" decoding="async"
                  src={link.icon_url || ''}
                  alt=""
                  onError={(e) => { (e.currentTarget as HTMLImageElement).style.visibility = 'hidden'; }}
                  className="w-8 h-8 rounded-lg object-contain border border-wb-border-subtle bg-wb-bg-subtle shrink-0"
                />

                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs font-semibold text-wb-text-primary truncate">{link.site_name}</span>
                    {!link.visible && (
                      <span className="text-3xs px-1.5 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-muted border border-wb-border-subtle">
                        已隐藏
                      </span>
                    )}
                    {link.icon_status !== 'ok' && (
                      <span className="text-3xs px-1.5 py-0.5 rounded-capsule bg-wb-warn/10 text-wb-warn border border-wb-warn/20">
                        无图标
                      </span>
                    )}
                    {(link.click_count || 0) > 0 && (
                      <span className="text-3xs text-wb-text-muted font-mono">{link.click_count} 次点击</span>
                    )}
                  </div>
                  <a
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-2xs text-wb-text-muted hover:text-wb-text-primary inline-flex items-center gap-1 truncate max-w-full"
                  >
                    {link.url}
                    <ExternalLink className="w-2.5 h-2.5 shrink-0" />
                  </a>
                  {link.description && (
                    <p className="text-2xs text-wb-text-muted truncate">{link.description}</p>
                  )}
                </div>

                <input
                  type="number"
                  defaultValue={link.sort_order}
                  onBlur={(e) => {
                    const v = Number(e.target.value);
                    if (!Number.isNaN(v) && v !== link.sort_order) patch(link, { sort_order: v }, '排序已更新');
                  }}
                  title="排序（越小越靠前）"
                  className="w-14 h-8 px-2 text-xs text-center rounded-lg border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-primary"
                />

                {rowActions(link)}
              </div>
            ))}
          </div>
        )}

        <p className="text-2xs text-wb-text-muted pt-1">
          排序数字越小越靠前；前台首页右侧栏以胶囊形式展示，默认折叠，点击「全部友链」进入独立页面。
        </p>
      </div>

      {/* 已拒绝（折叠展示，便于回看） */}
      {groups.rejected.length > 0 && (
        <details className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card">
          <summary className="text-xs font-semibold text-wb-text-muted cursor-pointer">
            已拒绝（{groups.rejected.length}）
          </summary>
          <div className="divide-y divide-wb-border-subtle mt-2">
            {groups.rejected.map((link) => (
              <div key={link.id} className="flex items-center gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <span className="text-2xs text-wb-text-primary truncate">{link.site_name}</span>
                  <p className="text-2xs text-wb-text-muted truncate">
                    {link.url}
                    {link.reject_reason ? ` · ${link.reject_reason}` : ''}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleApprove(link)}
                  className="text-2xs text-wb-success hover:underline shrink-0"
                >
                  改为通过
                </button>
                <button type="button" onClick={() => handleDelete(link)} className="p-1 text-wb-text-muted hover:text-wb-danger shrink-0">
                  <Trash2 className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        </details>
      )}

      {/* 新增时的图标选择 */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) handleFilePicked(file);
        }}
      />
      {/* 行内替换图标 */}
      <input
        ref={singleFileRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file) handleFilePicked(file);
        }}
      />
    </div>
  );
};
