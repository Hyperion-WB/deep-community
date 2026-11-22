import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Shield,
  ArrowLeft,
  Edit3,
  CheckCircle2,
  Users,
  X,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { apiClient } from '../api/client';
import { LegalSwitch } from './LegalDisclaimer';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { useToast } from '../components/Toast';
import { UserAvatar } from '../components/UserAvatar';
import { LevelBadge } from '../components/LevelBadge';
import { formatEast8Date, formatEast8Time } from '../utils/format';
import type { UserProfile } from '../types';

interface EndorsementItem {
  id: number;
  user_id: string;
  username: string;
  nickname?: string | null;
  avatar_url?: string | null;
  level: number;
  stance: string;
  comment: string;
  created_at?: string | null;
}

interface RulesData {
  id: number;
  title: string;
  content: string;
  version: number;
  updated_at?: string | null;
  endorsements_count: number;
  user_endorsed: boolean;
  user_endorsement?: {
    id: number;
    stance: string;
    comment: string;
    created_at?: string | null;
  } | null;
  recent_endorsements: EndorsementItem[];
}

interface Props {
  user: UserProfile | null;
  onBack: () => void;
  onRequireAuth: () => void;
  onGoLegal?: () => void;
  onSelectUser?: (username: string) => void;
}

export const CommunityRules: React.FC<Props> = ({
  user,
  onBack,
  onRequireAuth,
  onSelectUser,
  onGoLegal,
}) => {
  const toast = useToast();
  const [data, setData] = useState<RulesData | null>(null);
  const [loading, setLoading] = useState(true);

  // 管理员编辑状态
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [previewTab, setPreviewTab] = useState<'write' | 'preview'>('write');

  // 用户表态与签署状态
  const [showPledgeModal, setShowPledgeModal] = useState(false);
  const pledgeDialogRef = useDialogA11y(showPledgeModal, () => setShowPledgeModal(false));
  const [pledgeStance, setPledgeStance] = useState<'pledge' | 'support'>('pledge');
  const [pledgeComment, setPledgeComment] = useState('恪守极客自治公约，共同守护纯粹交流空间');
  const [submittingPledge, setSubmittingPledge] = useState(false);

  const isAdmin = user?.role === 'super_admin' || user?.role === 'admin';

  const fetchRules = async () => {
    try {
      setLoading(true);
      const res = await apiClient.get('/rules');
      setData(res.data);
      setEditTitle(res.data.title || '');
      setEditContent(res.data.content || '');
      if (res.data.user_endorsement) {
        setPledgeStance((res.data.user_endorsement.stance as any) || 'pledge');
        setPledgeComment(res.data.user_endorsement.comment || '恪守极客自治公约，共同守护纯粹交流空间');
      }
    } catch (err: any) {
      toast.error('加载社区公约失败，请重试');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRules();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  // 保存公约 (管理员)
  const handleSaveRules = async () => {
    if (!editTitle.trim()) {
      toast.warning('请输入公约标题');
      return;
    }
    if (!editContent.trim()) {
      toast.warning('请输入公约正文内容');
      return;
    }
    try {
      setSaving(true);
      const res = await apiClient.put('/rules', {
        title: editTitle.trim(),
        content: editContent.trim(),
      });
      toast.success(res.data.message || '公约更新成功');
      setIsEditing(false);
      fetchRules();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '保存公约失败');
    } finally {
      setSaving(false);
    }
  };

  // 提交公约表态/签署
  const handlePledgeSubmit = async () => {
    if (!user) {
      onRequireAuth();
      return;
    }
    try {
      setSubmittingPledge(true);
      const res = await apiClient.post('/rules/endorse', {
        stance: pledgeStance,
        comment: pledgeComment.trim() || '恪守极客自治公约，共同守护纯粹交流空间',
      });
      toast.success(res.data.message || '已成功签署并表态承诺恪守公约');
      setShowPledgeModal(false);
      fetchRules();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '表态提交失败');
    } finally {
      setSubmittingPledge(false);
    }
  };

  // 撤销签署表态
  const handleRevokePledge = async () => {
    if (!user) return;
    try {
      setSubmittingPledge(true);
      const res = await apiClient.delete('/rules/endorse');
      toast.success(res.data.message || '已撤回公约签署');
      setShowPledgeModal(false);
      fetchRules();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '撤回失败');
    } finally {
      setSubmittingPledge(false);
    }
  };

  if (loading && !data) {
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center space-y-4">
        <div className="inline-block animate-spin w-6 h-6 border-2 border-wb-text-primary border-t-transparent rounded-full" />
        <p className="text-xs text-wb-text-muted font-mono tracking-wider">正在加载社区准则与自治公约...</p>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-3 sm:px-6 py-4 sm:py-6 space-y-6">
      {/* 顶部导航与元信息条 */}
      <div className="flex items-center justify-between gap-3 pb-3 border-b border-wb-border-subtle">
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBack}
            className="wb-pressable flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary transition-colors cursor-pointer"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>返回</span>
          </button>
          <div className="flex items-center gap-2">
            <span className="text-xs text-wb-text-muted font-mono">规范准则</span>
            <span className="text-xs text-wb-text-muted font-mono">/</span>
            <span className="text-xs font-semibold text-wb-text-primary font-mono tracking-tight">
              公约与入站必读
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap justify-end">
          <LegalSwitch
            current="rules"
            onGoLegal={onGoLegal || onBack}
            onGoRules={undefined}
          />
          {data && (
            <span className="text-2xs font-mono px-2 py-0.5 rounded-md bg-wb-bg-subtle text-wb-text-muted border border-wb-border-subtle">
              v{data.version} · {formatEast8Date(data.updated_at)}
            </span>
          )}
          {isAdmin && (
            <button
              type="button"
              onClick={() => setIsEditing(!isEditing)}
              className="wb-pressable flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer"
            >
              <Edit3 className="w-3.5 h-3.5" />
              <span>{isEditing ? '返回阅读' : '编辑公约'}</span>
            </button>
          )}
        </div>
      </div>

      {/* 管理员在线编辑工作台 */}
      {isEditing && isAdmin ? (
        <div className="p-4 sm:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-strong space-y-4 shadow-card">
          <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
            <div>
              <h2 className="text-sm font-bold text-wb-text-primary font-mono">管理员公约编辑模式</h2>
              <p className="text-2xs text-wb-text-muted mt-0.5">
                在此更新全站公约与行为守则，保存后全站立即同步生效，禁止使用 Emoji 表情符号。
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewTab(previewTab === 'write' ? 'preview' : 'write')}
                className="px-3 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary transition-colors cursor-pointer"
              >
                {previewTab === 'write' ? '实时预览' : '返回编辑'}
              </button>
              <button
                type="button"
                disabled={saving}
                onClick={handleSaveRules}
                className="px-4 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
              >
                {saving ? '正在发布...' : '保存并全站发布'}
              </button>
            </div>
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-xs font-semibold text-wb-text-secondary mb-1">公约主标题</label>
              <input
                type="text"
                value={editTitle}
                onChange={(e) => setEditTitle(e.target.value)}
                placeholder="例如：极客社区自治公约与入站必读规范"
                className="w-full px-3.5 py-2 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-text-primary"
              />
            </div>

            {previewTab === 'write' ? (
              <div>
                <label className="block text-xs font-semibold text-wb-text-secondary mb-1">
                  公约 Markdown 正文 (支持标准 Markdown 语法，禁止 Emoji)
                </label>
                <textarea
                  rows={22}
                  value={editContent}
                  onChange={(e) => setEditContent(e.target.value)}
                  placeholder="在此输入完整的公约与入站必读规范..."
                  className="w-full p-4 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle text-xs font-mono text-wb-text-primary focus:outline-none focus:border-wb-text-primary leading-relaxed resize-y"
                />
              </div>
            ) : (
              <div className="p-4 sm:p-6 rounded-2xl bg-wb-bg-subtle/50 border border-wb-border-subtle min-h-[350px]">
                <h1 className="text-xl font-bold text-wb-text-primary mb-4 pb-2 border-b border-wb-border-subtle">
                  {editTitle}
                </h1>
                <ReactMarkdown
                  remarkPlugins={[remarkGfm, remarkBreaks]}
                  components={markdownComponents}
                >
                  {editContent}
                </ReactMarkdown>
              </div>
            )}
          </div>
        </div>
      ) : (
        <>
          {/* 顶栏：共守者签署与表态概览卡片 */}
          <div className="p-5 sm:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-wb-text-primary" />
                  <h2 className="text-sm sm:text-base font-bold text-wb-text-primary tracking-tight font-mono">
                    极客自治公约 · 共同守约承诺
                  </h2>
                </div>
                <p className="text-xs text-wb-text-muted leading-relaxed">
                  已有 <span className="font-mono font-semibold text-wb-text-primary">{data?.endorsements_count || 0}</span> 位极客签署承诺恪守社区准则，共同守护理性、纯粹、实证的高质量技术讨论生态。
                </p>
              </div>

              <div className="shrink-0 flex items-center gap-2">
                {data?.user_endorsed ? (
                  <div className="flex items-center gap-2">
                    <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-medium">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                      <span>已签署守约</span>
                    </span>
                    <button
                      type="button"
                      onClick={() => setShowPledgeModal(true)}
                      className="px-3 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary transition-colors cursor-pointer"
                    >
                      更新表态
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      if (!user) {
                        onRequireAuth();
                      } else {
                        setShowPledgeModal(true);
                      }
                    }}
                    className="wb-pressable px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer flex items-center gap-1.5"
                  >
                    <CheckCircle2 className="w-3.5 h-3.5" />
                    <span>签署公约与表态</span>
                  </button>
                )}
              </div>
            </div>

            {/* 若当前用户已签署，展示其专属承诺引语 */}
            {data?.user_endorsed && data.user_endorsement && (
              <div className="p-3.5 rounded-2xl bg-wb-bg-subtle/70 border border-wb-border-subtle flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <span className="text-2xs font-mono font-semibold px-2 py-0.5 rounded bg-wb-bg-page border border-wb-border-subtle text-wb-text-primary">
                      {data.user_endorsement.stance === 'pledge' ? '承诺恪守' : '认同支持'}
                    </span>
                    <span className="text-2xs text-wb-text-muted font-mono">
                      签署于 {formatEast8Time(data.user_endorsement.created_at)}
                    </span>
                  </div>
                  <p className="text-xs text-wb-text-secondary italic">
                    “{data.user_endorsement.comment}”
                  </p>
                </div>
                <button
                  type="button"
                  onClick={handleRevokePledge}
                  disabled={submittingPledge}
                  title="撤回签署"
                  className="text-2xs text-wb-text-muted hover:text-wb-danger transition-colors cursor-pointer whitespace-nowrap p-1"
                >
                  撤回
                </button>
              </div>
            )}
          </div>

          {/* 公约核心正文阅读区 */}
          <article className="p-6 sm:p-8 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-6">
            <ReactMarkdown
              remarkPlugins={[remarkGfm, remarkBreaks]}
              components={markdownComponents}
            >
              {data?.content || ''}
            </ReactMarkdown>
          </article>

          {/* 底部：公约共守者名录与近期表态极客 */}
          <div className="p-5 sm:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-wb-text-primary" />
                <h3 className="text-sm font-bold text-wb-text-primary font-mono">
                  公约共守者名录 (近期签署成员)
                </h3>
              </div>
              <span className="text-xs text-wb-text-muted font-mono">
                共 {data?.endorsements_count || 0} 位极客
              </span>
            </div>

            {(!data?.recent_endorsements || data.recent_endorsements.length === 0) ? (
              <div className="py-8 text-center text-xs text-wb-text-muted font-mono">
                暂无签署记录，成为第一位公约共守者
              </div>
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                {data.recent_endorsements.map((signer) => (
                  <div
                    key={signer.id}
                    className="p-3 rounded-2xl bg-wb-bg-subtle/50 border border-wb-border-subtle flex items-start gap-3 hover:bg-wb-bg-subtle transition-colors"
                  >
                    <div
                      onClick={() => onSelectUser?.(signer.username)}
                      className="cursor-pointer shrink-0"
                    >
                      <UserAvatar
                        username={signer.username}
                        avatarUrl={signer.avatar_url}
                        size="sm"
                      />
                    </div>
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex items-center justify-between gap-1">
                        <div
                          onClick={() => onSelectUser?.(signer.username)}
                          className="flex items-center gap-1.5 cursor-pointer hover:underline truncate"
                        >
                          <span className="text-xs font-semibold text-wb-text-primary truncate">
                            {signer.nickname || signer.username}
                          </span>
                          <LevelBadge level={signer.level} size="sm" />
                        </div>
                        <span className="text-3xs text-wb-text-muted font-mono shrink-0">
                          {formatEast8Time(signer.created_at)}
                        </span>
                      </div>
                      <p className="text-2xs text-wb-text-secondary truncate leading-relaxed">
                        {signer.comment}
                      </p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* 签署与表态模态弹窗 */}
      <AnimatePresence>
        {showPledgeModal && (
          <div
            ref={pledgeDialogRef}
            role="dialog"
            aria-modal="true"
            aria-label="签署社区公约"
            className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm"
            onClick={() => setShowPledgeModal(false)}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              onClick={(e) => e.stopPropagation()}
              className="w-full max-w-md rounded-3xl bg-wb-bg-surface border border-wb-border-strong p-6 shadow-2xl space-y-5"
            >
              <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-wb-text-primary" />
                  <h3 className="text-sm font-bold text-wb-text-primary font-mono">
                    公约表态与签署承诺
                  </h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowPledgeModal(false)}
                  className="p-1 rounded-capsule text-wb-text-muted hover:text-wb-text-primary transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>

              <div className="space-y-4 text-xs">
                <div>
                  <label className="block text-xs font-semibold text-wb-text-secondary mb-1.5">
                    表态立场
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setPledgeStance('pledge')}
                      className={`p-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                        pledgeStance === 'pledge'
                          ? 'border-wb-text-primary bg-wb-text-primary text-wb-bg-page font-semibold'
                          : 'border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'
                      }`}
                    >
                      承诺恪守公约
                    </button>
                    <button
                      type="button"
                      onClick={() => setPledgeStance('support')}
                      className={`p-2.5 rounded-xl border text-center transition-all cursor-pointer ${
                        pledgeStance === 'support'
                          ? 'border-wb-text-primary bg-wb-text-primary text-wb-bg-page font-semibold'
                          : 'border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'
                      }`}
                    >
                      认同社区精神
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-wb-text-secondary mb-1.5">
                    个人守约宣言 (限 200 字)
                  </label>
                  <textarea
                    rows={3}
                    maxLength={200}
                    value={pledgeComment}
                    onChange={(e) => setPledgeComment(e.target.value)}
                    placeholder="例如：恪守极客自治公约，共同守护纯粹交流空间"
                    className="w-full p-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-primary focus:outline-none focus:border-wb-text-primary leading-relaxed resize-none"
                  />
                </div>

                <div className="p-3 rounded-xl bg-wb-bg-subtle/60 border border-wb-border-subtle text-2xs text-wb-text-muted leading-relaxed">
                  签署后您的昵称将加入公约共守者名录，代表您自愿维护技术社区理性实证的讨论氛围，坚决抵制人身攻击与恶意戾气。
                </div>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-wb-border-subtle">
                <button
                  type="button"
                  onClick={() => setShowPledgeModal(false)}
                  className="px-4 py-2 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary transition-colors cursor-pointer"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={submittingPledge}
                  onClick={handlePledgeSubmit}
                  className="px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity disabled:opacity-50 cursor-pointer"
                >
                  {submittingPledge ? '提交中...' : '确认签署'}
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>
    </div>
  );
};

// 严谨高质感纯黑白 Markdown 渲染组件映射 (零 Emoji，高工业质感)
const markdownComponents = {
  h1: ({ children }: any) => (
    <h1 className="text-xl sm:text-2xl font-bold text-wb-text-primary mt-6 mb-3 tracking-tight font-mono border-b border-wb-border-subtle pb-2">
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 className="text-base sm:text-lg font-bold text-wb-text-primary mt-6 mb-2.5 tracking-tight font-mono flex items-center gap-2">
      <span className="w-1.5 h-4 bg-wb-text-primary rounded-full inline-block" />
      <span>{children}</span>
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 className="text-sm sm:text-base font-bold text-wb-text-primary mt-4 mb-2 tracking-tight font-mono">
      {children}
    </h3>
  ),
  p: ({ children }: any) => (
    <p className="my-2.5 text-xs sm:text-sm text-wb-text-secondary leading-relaxed">
      {children}
    </p>
  ),
  ul: ({ children }: any) => (
    <ul className="list-disc list-inside space-y-1.5 my-3 pl-2 text-xs sm:text-sm text-wb-text-secondary leading-relaxed">
      {children}
    </ul>
  ),
  ol: ({ children }: any) => (
    <ol className="list-decimal list-inside space-y-1.5 my-3 pl-2 text-xs sm:text-sm text-wb-text-secondary leading-relaxed">
      {children}
    </ol>
  ),
  li: ({ children }: any) => (
    <li className="text-wb-text-secondary text-xs sm:text-sm leading-relaxed">
      {children}
    </li>
  ),
  strong: ({ children }: any) => (
    <strong className="font-semibold text-wb-text-primary">
      {children}
    </strong>
  ),
  blockquote: ({ children }: any) => (
    <blockquote className="border-l-2 border-wb-text-primary pl-4 py-2 my-3 text-wb-text-secondary bg-wb-bg-subtle/50 rounded-r-xl text-xs sm:text-sm italic">
      {children}
    </blockquote>
  ),
  table: ({ children }: any) => (
    <div className="overflow-x-auto my-4 border border-wb-border-subtle rounded-2xl shadow-sm">
      <table className="min-w-full divide-y divide-wb-border-subtle text-xs text-left">
        {children}
      </table>
    </div>
  ),
  thead: ({ children }: any) => (
    <thead className="bg-wb-bg-subtle text-wb-text-primary font-semibold font-mono">
      {children}
    </thead>
  ),
  th: ({ children }: any) => (
    <th className="px-4 py-3 font-semibold text-wb-text-primary border-r last:border-r-0 border-wb-border-subtle whitespace-nowrap">
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td className="px-4 py-2.5 text-wb-text-secondary border-t border-wb-border-subtle border-r last:border-r-0 leading-relaxed">
      {children}
    </td>
  ),
  code: ({ className, children, ...props }: any) =>
    (!className?.includes('language-') && !String(children).includes('\n')) ? (
      <code
        className="px-1.5 py-0.5 rounded bg-wb-bg-subtle font-mono text-2xs text-wb-text-primary font-semibold border border-wb-border-subtle"
        {...props}
      >
        {children}
      </code>
    ) : (
      <pre className="p-4 my-3 rounded-2xl bg-wb-bg-subtle text-wb-text-primary font-mono text-xs overflow-x-auto border border-wb-border-subtle leading-relaxed">
        <code>{children}</code>
      </pre>
    ),
  hr: () => <hr className="my-6 border-wb-border-subtle" />,
};

export default CommunityRules;
