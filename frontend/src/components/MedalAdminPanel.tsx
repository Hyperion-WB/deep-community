import React, { useCallback, useEffect, useState } from 'react';
import { Award, Loader2, Plus, Search, Trash2 } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';
import { MEDAL_ICON_KEYS, MedalIcon } from './MedalIcon';
import { CustomDropdown } from './CustomDropdown';

interface Def {
  code: string;
  name: string;
  subtitle: string;
  description: string;
  icon: string;
  category: string;
  series: string | null;
  tier: number;
  custom: boolean;
}

interface GrantRow {
  user_id: string;
  username: string;
  nickname: string;
  code: string;
  name: string;
  icon: string;
  tier: number;
  reason: string;
  unlocked_at: string | null;
}

interface SearchHit {
  id: string;
  username: string;
  nickname: string;
}

const TIER_LABEL = ['铜', '银', '金', '钻'];

export const MedalAdminPanel: React.FC = () => {
  const toast = useToast();
  const [defs, setDefs] = useState<Def[]>([]);
  const [grants, setGrants] = useState<GrantRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [grantPage, setGrantPage] = useState(1);
  const [grantHasMore, setGrantHasMore] = useState(false);
  // 颁发记录默认折叠：一屏几十条既占地方又没必要，点开再看
  const [grantsExpanded, setGrantsExpanded] = useState(false);

  // 创建
  const [name, setName] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('award');
  const [tier, setTier] = useState(2);
  const [creating, setCreating] = useState(false);

  // 颁发
  const [username, setUsername] = useState('');
  const [target, setTarget] = useState<{ id: string; username: string } | null>(null);
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [code, setCode] = useState('');
  const [reason, setReason] = useState('');
  const [granting, setGranting] = useState(false);
  const [titleText, setTitleText] = useState('');
  const [settingTitle, setSettingTitle] = useState(false);

  const load = useCallback(async (page = 1) => {
    try {
      const [d, g] = await Promise.all([
        apiClient.get<Def[]>('/admin/achievements/defs'),
        apiClient.get<GrantRow[]>('/admin/achievements/grants', { params: { limit: 20 + page * 20 } }),
      ]);
      setDefs(Array.isArray(d.data) ? d.data : []);
      const list = Array.isArray(g.data) ? g.data : [];
      setGrants(list);
      setGrantHasMore(list.length >= 20 + page * 20);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '勋章数据加载失败');
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!name.trim()) {
      toast.warning('请填写勋章名称');
      return;
    }
    setCreating(true);
    try {
      await apiClient.post('/admin/achievements/defs', {
        name: name.trim(),
        subtitle: subtitle.trim(),
        description: description.trim(),
        icon: icon || 'award',
        tier,
      });
      toast.success(`已创建勋章「${name.trim()}」`);
      setName('');
      setSubtitle('');
      setDescription('');
      setIcon('award');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '创建失败');
    } finally {
      setCreating(false);
    }
  };

  const pickUser = (u: SearchHit) => {
    setTarget({ id: u.id, username: u.username });
    setHits([]);
    toast.success(
      `已选中 @${u.username}${u.nickname && u.nickname !== u.username ? `（${u.nickname}）` : ''}`
    );
  };

  const handleFindUser = async () => {
    const keyword = username.trim().replace(/^@/, '');
    if (!keyword) return;
    setSearching(true);
    try {
      // 后端并没有 GET /users/{username} 这个路由（旧实现必然 404，所以「名字正确也查不到」），
      // 统一走 /users/search：同时模糊匹配用户名、昵称与简介，大小写不敏感，支持中文昵称。
      const res = await apiClient.get('/users/search', { params: { q: keyword, limit: 8 } });
      const list: SearchHit[] = Array.isArray(res.data) ? res.data : [];
      setHits(list);
      if (list.length === 0) {
        setTarget(null);
        toast.error('未找到该用户，可试试用户名或昵称的关键字');
      } else if (list.length === 1) {
        pickUser(list[0]);
      }
    } catch (err: any) {
      setTarget(null);
      setHits([]);
      toast.error(err?.response?.data?.detail || '查找失败');
    } finally {
      setSearching(false);
    }
  };

  const handleDeleteDef = async (definition: Def) => {
    if (!window.confirm(`确认删除自定义勋章「${definition.name}」？已颁发的记录也会一并移除。`)) return;
    try {
      await apiClient.delete(`/admin/achievements/defs/${encodeURIComponent(definition.code)}`);
      toast.success(`已删除「${definition.name}」`);
      if (code === definition.code) setCode('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '删除失败');
    }
  };

  const handleGrant = async () => {
    if (!target) {
      toast.warning('请先选择接收人');
      return;
    }
    if (!code) {
      toast.warning('请选择要颁发的勋章');
      return;
    }
    setGranting(true);
    try {
      const res = await apiClient.post('/admin/achievements/grant', {
        user_id: target.id,
        codes: [code],
        reason: reason.trim(),
      });
      toast.success(`已授予 @${target.username}：${(res.data?.granted || []).join('、') || '无变化'}`);
      setReason('');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '颁发失败');
    } finally {
      setGranting(false);
    }
  };

  const handleSetTitle = async () => {
    if (!target) return;
    setSettingTitle(true);
    try {
      await apiClient.post('/admin/achievements/title', { user_id: target.id, title: titleText.trim() });
      toast.success(titleText.trim() ? `已设置称号：${titleText.trim()}` : '已清除称号');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '设置失败');
    } finally {
      setSettingTitle(false);
    }
  };

  const handleRevoke = async (row: GrantRow) => {
    if (!window.confirm(`确认撤销 @${row.username} 的「${row.name}」？`)) return;
    try {
      await apiClient.post('/admin/achievements/revoke', { user_id: row.user_id, code: row.code });
      toast.success('已撤销');
      await load();
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '撤销失败');
    }
  };

  if (loading) {
    return (
      <div className="p-10 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center text-xs text-wb-text-muted">
        正在加载勋章数据…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 颁发 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-wb-brand" />
          <h3 className="text-xs font-semibold text-wb-text-primary">颁发勋章（仅超级管理员）</h3>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div className="flex items-center gap-2">
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleFindUser();
              }}
              placeholder="输入用户名或昵称，如 admin"
              className="flex-1 px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
            />
            <button
              type="button"
              disabled={searching}
              onClick={handleFindUser}
              className="wb-pressable px-3 py-2 rounded-xl border border-wb-border-strong bg-wb-bg-subtle text-wb-text-primary text-xs font-semibold flex items-center gap-1 disabled:opacity-50"
            >
              {searching ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Search className="w-3.5 h-3.5" />
              )}
              查找
            </button>
          </div>

          <CustomDropdown
            value={code}
            onChange={(value) => setCode(String(value))}
            placeholder="选择勋章…"
            options={defs
              .filter((d) => !d.category.includes('hidden'))
              .map((d) => ({
                value: d.code,
                label: d.name,
                description: `${TIER_LABEL[d.tier]}级${d.custom ? ' · 自定义' : ''}`,
              }))}
          />
        </div>

        {/* 命中多个用户时列出候选，避免同名/昵称相近选错人 */}
        {hits.length > 0 && (
          <div className="rounded-xl border border-wb-border-subtle divide-y divide-wb-border-subtle overflow-hidden">
            {hits.map((hit) => (
              <button
                key={hit.id}
                type="button"
                onClick={() => pickUser(hit)}
                className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-wb-bg-subtle transition-colors"
              >
                <span className="min-w-0 flex items-baseline gap-2">
                  <span className="text-xs text-wb-text-primary truncate">@{hit.username}</span>
                  {hit.nickname && hit.nickname !== hit.username && (
                    <span className="text-2xs text-wb-text-muted truncate">{hit.nickname}</span>
                  )}
                </span>
                <span className="text-2xs text-wb-text-muted shrink-0">选择</span>
              </button>
            ))}
          </div>
        )}

        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="颁发理由（可选，会展示在勋章详情里）"
          className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary focus:outline-none focus:ring-2 focus:ring-wb-brand/30"
        />

        <div className="flex items-center justify-between gap-3">
          <span className="text-2xs text-wb-text-muted">
            {target ? `接收人：@${target.username}` : '尚未选择接收人'}
          </span>
          <button
            type="button"
            disabled={granting}
            onClick={handleGrant}
            className="wb-pressable px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"
          >
            {granting && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            颁发
          </button>
        </div>
      </div>

      {/* 自定义勋章 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
        <div className="flex items-center gap-2">
          <Plus className="w-4 h-4 text-wb-brand" />
          <h3 className="text-xs font-semibold text-wb-text-primary">创建自定义勋章</h3>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="名称（必填）"
            className="col-span-2 px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary"
          />
          <input
            value={subtitle}
            onChange={(e) => setSubtitle(e.target.value)}
            placeholder="英文副标题"
            className="px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary"
          />
          <div className="px-2 py-1.5 rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 flex items-center gap-1 overflow-x-auto no-scrollbar">
            {MEDAL_ICON_KEYS.slice(0, 12).map((key) => (
              <button
                key={key}
                type="button"
                onClick={() => setIcon(key)}
                title={key}
                className={`shrink-0 w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                  icon === key ? 'bg-wb-brand/20 text-wb-brand' : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                <MedalIcon name={key} className="w-3.5 h-3.5" />
              </button>
            ))}
          </div>
        </div>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="描述 / 颁发条件（可选）"
          className="w-full px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary"
        />
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-1.5">
            {TIER_LABEL.map((label, index) => (
              <button
                key={label}
                type="button"
                onClick={() => setTier(index)}
                className={`px-2.5 py-1 rounded-capsule text-2xs font-semibold border transition-colors ${
                  tier === index
                    ? 'border-wb-brand/60 bg-wb-brand/12 text-wb-text-primary'
                    : 'border-wb-border-subtle text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
          <button
            type="button"
            disabled={creating}
            onClick={handleCreate}
            className="wb-pressable px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-50 flex items-center gap-1.5"
          >
            {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
            创建
          </button>
        </div>
      </div>

      {/* 自定义勋章列表（可删除；内置勋章不在此列，避免误删种子数据） */}
      {defs.some((d) => d.custom) && (
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-2">
          <div className="flex items-center gap-2">
            <Trash2 className="w-4 h-4 text-wb-brand" />
            <h3 className="text-xs font-semibold text-wb-text-primary">自定义勋章（可删除）</h3>
          </div>
          <div className="divide-y divide-wb-border-subtle">
            {defs
              .filter((d) => d.custom)
              .map((d) => (
                <div key={d.code} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0 flex items-center gap-2">
                    <MedalIcon name={d.icon} className="w-4 h-4 text-wb-brand shrink-0" />
                    <div className="min-w-0">
                      <div className="text-xs text-wb-text-primary truncate">
                        {d.name}
                        <span className="ml-1 text-2xs text-wb-text-muted">
                          {TIER_LABEL[d.tier] ?? ''}
                        </span>
                      </div>
                      {d.description && (
                        <div className="text-2xs text-wb-text-muted truncate">{d.description}</div>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleDeleteDef(d)}
                    title="删除该勋章"
                    className="shrink-0 p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
          </div>
          <p className="text-2xs text-wb-text-muted">
            删除后该勋章的颁发记录会一并移除，且无法恢复；内置勋章不可删除。
          </p>
        </div>
      )}

      {/* 设置称号 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
        <div className="flex items-center gap-2">
          <Award className="w-4 h-4 text-wb-brand" />
          <h3 className="text-xs font-semibold text-wb-text-primary">设置佩戴称号</h3>
        </div>
        <div className="flex flex-col sm:flex-row gap-2">
          <input
            value={titleText}
            onChange={(e) => setTitleText(e.target.value)}
            placeholder="称号文本，如：终端行者（留空则清除）"
            maxLength={48}
            className="flex-1 px-3 py-2 text-xs rounded-xl border border-wb-border-strong bg-wb-bg-subtle/50 text-wb-text-primary"
          />
          <button
            type="button"
            disabled={!target || settingTitle}
            onClick={handleSetTitle}
            className="wb-pressable px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-50"
          >
            {settingTitle ? '设置中…' : target ? `应用到 @${target.username}` : '请先查找用户'}
          </button>
        </div>
        <p className="text-2xs text-wb-text-muted">称号会显示在对方主页与帖子作者名片上；留空提交即清除。</p>
      </div>

      {/* 最近颁发 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold text-wb-text-primary">
            最近颁发
            {grants.length > 0 && (
              <span className="ml-1.5 text-2xs font-normal text-wb-text-muted">{grants.length} 条</span>
            )}
          </h3>
          <div className="flex items-center gap-3">
            {grantsExpanded && (
              <button
                type="button"
                disabled={!grantHasMore}
                onClick={() => {
                  const next = grantPage + 1;
                  setGrantPage(next);
                  load(next);
                }}
                className="text-2xs text-wb-text-muted hover:text-wb-text-primary disabled:opacity-40"
              >
                加载更多
              </button>
            )}
            <button
              type="button"
              onClick={() => setGrantsExpanded((v) => !v)}
              className="text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary"
            >
              {grantsExpanded ? '收起' : '展开查看'}
            </button>
          </div>
        </div>
        {!grantsExpanded ? null : grants.length === 0 ? (
          <p className="text-2xs text-wb-text-muted py-4 text-center">还没有颁发记录</p>
        ) : (
          <div className="divide-y divide-wb-border-subtle">
            {grants.map((row) => (
              <div key={`${row.user_id}-${row.code}`} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex items-center gap-2">
                  <span className="text-base">{row.icon}</span>
                  <div className="min-w-0">
                    <div className="text-xs text-wb-text-primary truncate">
                      @{row.username} · {row.name}
                      <span className="ml-1 text-2xs text-wb-text-muted">{TIER_LABEL[row.tier]}</span>
                    </div>
                    {row.reason && <div className="text-2xs text-wb-text-muted truncate">{row.reason}</div>}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => handleRevoke(row)}
                  className="shrink-0 p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors"
                  title="撤销"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
