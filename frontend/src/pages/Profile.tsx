import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { createPortal } from 'react-dom';
import { AvatarPreview } from '../components/AvatarPreview';
import { CheckinHeatmap } from '../components/CheckinHeatmap';
import { AvatarCropper } from '../components/AvatarCropper';
import {
  Calendar,
  Award,
  Clock,
  Check,
  User,
  Lock,
  FileText,
  AlertTriangle,
  Shield,
  Save,
  KeyRound,
  Eye,
  Heart,
  MessageSquare,
  ChevronRight,
  PenTool,
  Bookmark,
  Upload,
  UserPlus,
  UserCheck,
  ShieldAlert,
  ShieldOff,
  ArrowLeft,
  BellOff,
  History,
  Trash2,
  Archive,
  Edit3,
  Sparkles,
  MapPin,
  Globe,
  Code2,
  SlidersHorizontal,
  Type,
  Palette,
  ExternalLink,
} from 'lucide-react';

const GithubIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg className={className} viewBox="0 0 24 24" fill="currentColor">
    <path fillRule="evenodd" clipRule="evenodd" d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z" />
  </svg>
);

import { apiClient } from '../api/client';
import type { UserProfile, PostSimple, BlockedUserItem } from '../types';
import { MyReports } from '../components/MyReports';
import { LevelBadge } from '../components/LevelBadge';
import { SegmentedControl } from '../components/SegmentedControl';
import { CustomDropdown } from '../components/CustomDropdown';
import { UserAvatar } from '../components/UserAvatar';
import { OnlineAvatar } from '../components/OnlineAvatar';
import { FollowListModal } from '../components/FollowListModal';
import { TitleCard } from '../components/TitleCard';
import { HonorWall } from '../components/HonorWall';
import { PasswordHint } from '../components/PasswordHint';
import { FontSettingsModal } from '../components/FontSettingsModal';
import { AppearanceSettingsModal } from '../components/AppearanceSettingsModal';
import { PALETTE_CHANGE_EVENT, getPaletteMeta, getStoredPalette } from '../utils/themePalette';
import { useToast } from '../components/Toast';
import { usePortalMode } from '../utils/portalMode';
import { useConfirm } from '../components/ConfirmModal';
import { getReadingHistory, clearReadingHistory, removeReadingHistoryItem, type ReadingHistoryItem } from '../utils/history';
import { getSmartDailyTitle } from '../utils/format';
import { GiteeBindCard } from '../components/GiteeBindCard';
import { CollectionFolderManager } from '../components/CollectionFolderManager';
import { SeriesPanel } from '../components/SeriesPanel';

interface Props {
  user: UserProfile | null;
  targetUsername?: string | null;
  onBack?: () => void;
  onRefresh: () => void;
  onUserUpdated?: (user: UserProfile) => void;
  onSelectPost?: (postId: string) => void;
  onGoWrite?: () => void;
  onEditDraft?: (draftId: string) => void;
  onStartChat?: (targetUserId: string, targetUsername: string) => void;
  onRequireAuth?: () => void;
  onSelectUser?: (username: string) => void;
}

const PRESET_AVATARS = [
  { id: 'av-1', label: '深曜石', bg: 'bg-zinc-900', text: 'text-zinc-100', symbol: '●' },
  { id: 'av-2', label: '极夜环', bg: 'bg-zinc-800', text: 'text-zinc-200', symbol: '◎' },
  { id: 'av-3', label: '钛金属', bg: 'bg-zinc-700', text: 'text-zinc-100', symbol: '▲' },
  { id: 'av-4', label: '冷灰核', bg: 'bg-zinc-600', text: 'text-zinc-100', symbol: '◆' },
  { id: 'av-5', label: '象牙白', bg: 'bg-zinc-200', text: 'text-zinc-900', symbol: '■' },
  { id: 'av-6', label: '微晶阵', bg: 'bg-zinc-100', text: 'text-zinc-800', symbol: '◈' },
];

const PROFILE_PAGE = 'mx-auto w-full min-w-0 max-w-6xl space-y-4 px-3 py-4 sm:px-5 sm:py-5';
const PROFILE_SURFACE = 'min-w-0 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface shadow-card';
const PROFILE_INTRO = 'flex min-w-0 flex-wrap items-start justify-between gap-x-4 gap-y-3';
const PROFILE_IDENTITY = 'flex min-w-0 flex-[1_1_20rem] items-start gap-3';
const PROFILE_TOOLS = 'flex min-w-0 flex-wrap items-center gap-2';
const PROFILE_ACTION = 'wb-pressable inline-flex min-h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-capsule px-3 text-xs transition-colors';

const PROFILE_TABS = [
  { key: 'overview', label: '成长与特权' },
  { key: 'history', label: '浏览足迹' },
  { key: 'my_posts', label: '我的发布' },
  { key: 'my_favorites', label: '我的收藏' },
  { key: 'edit_profile', label: '修改资料' },
  { key: 'security', label: '密码与安全' },
  { key: 'privacy', label: '偏好与隐私' },
  { key: 'my_reports', label: '我的举报' },
] as const;
type ProfileTab = (typeof PROFILE_TABS)[number]['key'];
const PROFILE_TAB_ITEMS = [...PROFILE_TABS];
const PROFILE_TAB_OPTIONS = PROFILE_TABS.map(({ key, label }) => ({ value: key, label }));

const ProfileHeading = ({ onBack, isPublic = false }: { onBack?: () => void; isPublic?: boolean }) => (
  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-wb-border-subtle px-3 py-2.5 sm:px-4">
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <h1 className="flex items-center gap-2 text-base font-bold text-wb-text-primary">
        <User className="h-4 w-4 shrink-0 text-wb-brand" aria-hidden="true" />
        个人主页
      </h1>
      <span className="text-xs text-wb-text-muted">{isPublic ? '公开档案' : '我的档案'}</span>
    </div>
    {onBack && (
      <button
        type="button"
        onClick={onBack}
        className={`${PROFILE_ACTION} border border-wb-border-subtle bg-wb-bg-subtle font-medium text-wb-text-secondary hover:border-wb-border-strong hover:text-wb-text-primary`}
      >
        <ArrowLeft className="h-3.5 w-3.5 shrink-0" aria-hidden="true" /> 返回上一级
      </button>
    )}
  </div>
);

const ProfileStats = ({ profile, posts, onOpenFollows }: {
  profile: UserProfile;
  posts: number;
  onOpenFollows: (username: string, type: 'followers' | 'following') => void;
}) => (
  <div className="flex flex-wrap items-center gap-x-5 gap-y-1 border-t border-wb-border-subtle pt-2 text-xs">
    {([
      ['followers', '粉丝', profile.followers_count ?? 0],
      ['following', '关注', profile.following_count ?? 0],
    ] as const).map(([key, label, count]) => (
      <button
        key={key}
        type="button"
        onClick={() => onOpenFollows(profile.username, key)}
        className="group inline-flex min-h-7 items-center gap-1.5 text-wb-text-secondary hover:text-wb-text-primary"
      >
        <span className="font-mono text-sm font-bold text-wb-text-primary group-hover:underline">{count}</span>
        {label}
      </button>
    ))}
    <div className="inline-flex min-h-7 items-center gap-1.5 text-wb-text-secondary">
      <span className="font-mono text-sm font-bold text-wb-text-primary">{profile.posts_count ?? posts}</span>
      公开发布
    </div>
  </div>
);

const ProfileIdentity = ({ profile, own = false, hideIpLocation = false, onPreview }: {
  profile: UserProfile;
  own?: boolean;
  hideIpLocation?: boolean;
  onPreview: (preview: { src: string; name: string }) => void;
}) => {
  const name = profile.nickname || profile.username;
  const avatarUrl = profile.avatar_url;
  const avatar = <UserAvatar username={profile.username} avatarUrl={avatarUrl} size={52} className="border border-wb-border-subtle" />;
  const techTags = [...new Set(profile.tech_stack?.split(/[,，]/).map((tag) => tag.trim()).filter(Boolean))];
  const linkClass = 'inline-flex items-center gap-1 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle px-2 py-1 font-mono text-2xs text-wb-text-secondary hover:border-wb-border-strong hover:text-wb-text-primary';

  return (
    <div className={PROFILE_IDENTITY}>
      <OnlineAvatar online={own ? profile.is_online !== false : Boolean(profile.is_online)} size={52} ringClassName="ring-wb-bg-surface">
        {avatarUrl ? (
          <button type="button" onClick={() => onPreview({ src: avatarUrl, name })} aria-label={`查看 ${name} 的头像`} className="inline-flex cursor-zoom-in rounded-full">
            {avatar}
          </button>
        ) : avatar}
      </OnlineAvatar>
      <div className="min-w-0 space-y-1.5">
        <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
          <h2 className="min-w-0 text-lg font-bold leading-tight text-wb-text-primary [overflow-wrap:anywhere]">{name}</h2>
          {profile.nickname && <span className="min-w-0 font-mono text-xs text-wb-text-muted [overflow-wrap:anywhere]">@{profile.username}</span>}
          {(profile.gender === 'male' || profile.gender === 'female') && (
            <span title={profile.gender === 'male' ? '男' : '女'} className={`inline-flex h-5 w-5 shrink-0 select-none items-center justify-center rounded-full border text-xs font-bold leading-none ${
              profile.gender === 'male' ? 'border-wb-info/20 bg-wb-info/10 text-wb-info' : 'border-wb-danger/20 bg-wb-danger/10 text-wb-danger'
            }`}>
              {profile.gender === 'male' ? '♂' : '♀'}
            </span>
          )}
          <LevelBadge level={profile.level} status={profile.status} role={profile.role} size="sm" />
          {profile.equipped_title && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle px-2 py-0.5 text-xs font-semibold text-wb-text-primary">
              <Sparkles className="h-3 w-3 shrink-0 text-wb-warn" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">{profile.equipped_title}</span>
            </span>
          )}
        </div>
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 font-mono text-xs text-wb-text-muted">
          {own && profile.email && <span className="min-w-0 [overflow-wrap:anywhere]">{profile.email}</span>}
          <span>注册于 {new Date(profile.created_at).toLocaleDateString()}</span>
          {profile.ip_location && (
            <span className="inline-flex min-w-0 items-center gap-1 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle px-2 py-0.5 text-2xs text-wb-text-secondary">
              <MapPin className="h-3 w-3 shrink-0 text-wb-text-muted" aria-hidden="true" />
              <span className="min-w-0 [overflow-wrap:anywhere]">IP 属地: {profile.ip_location}{own && hideIpLocation && <span className="text-wb-text-muted">（仅自己可见）</span>}</span>
            </span>
          )}
        </div>
        {profile.bio && <p className="text-xs leading-relaxed text-wb-text-secondary [overflow-wrap:anywhere]">{profile.bio}</p>}
        {(profile.github_url || profile.blog_url || techTags.length > 0) && (
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 pt-0.5">
            {profile.github_url && (
              <a href={profile.github_url.startsWith('http') ? profile.github_url : `https://github.com/${profile.github_url}`} target="_blank" rel="noopener noreferrer" className={linkClass}>
                <GithubIcon className="h-3 w-3" /> GitHub
              </a>
            )}
            {profile.blog_url && (
              <a href={profile.blog_url.startsWith('http') ? profile.blog_url : `https://${profile.blog_url}`} target="_blank" rel="noopener noreferrer" className={linkClass}>
                <Globe className="h-3 w-3" aria-hidden="true" /> 个人站点
              </a>
            )}
            {techTags.length > 0 && (
              <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Code2 className="h-3 w-3 shrink-0 text-wb-text-muted" aria-hidden="true" />
                {techTags.map((tag) => <span key={tag} className="min-w-0 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle px-2 py-0.5 font-mono text-2xs text-wb-text-secondary [overflow-wrap:anywhere]">{tag}</span>)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const Profile: React.FC<Props> = ({
  user,
  targetUsername,
  onBack,
  onRefresh,
  onUserUpdated,
  onSelectPost,
  onGoWrite,
  onEditDraft,
  onStartChat,
  onRequireAuth,
  onSelectUser,
}) => {
  const toast = useToast();
  const [portalMode, changePortalMode] = usePortalMode();
  const confirmModal = useConfirm();
  const [deactivateModalOpen, setDeactivateModalOpen] = useState(false);
  const [deactivateInput, setDeactivateInput] = useState('');
  const [deactivateError, setDeactivateError] = useState('');
  const [deactivating, setDeactivating] = useState(false);

  // 更换/绑定邮箱（邮箱验证码）
  const [emailEditing, setEmailEditing] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailCode, setEmailCode] = useState('');
  const [emailCodeSending, setEmailCodeSending] = useState(false);
  const [emailCooldown, setEmailCooldown] = useState(0);
  const [emailSubmitting, setEmailSubmitting] = useState(false);
  const [emailMsg, setEmailMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 验证码重发倒计时（用 setTimeout 递归，组件卸载自动清理）
  useEffect(() => {
    if (emailCooldown <= 0) return;
    const timer = setTimeout(() => setEmailCooldown((v) => v - 1), 1000);
    return () => clearTimeout(timer);
  }, [emailCooldown]);

  // 重置头像为默认字母徽章 (显式清空 avatar_url)
  const [resettingAvatar, setResettingAvatar] = useState(false);
  const handleResetAvatar = async () => {
    setResettingAvatar(true);
    try {
      const res = await apiClient.put('/users/me', { avatar_url: '' });
      setUploadedAvatarUrl('');
      setAvatarUrl('');
      setProfileMsg({ type: 'success', text: '头像已重置为默认徽章' });
      if (onUserUpdated) onUserUpdated(res.data);
      onRefresh();
    } catch (err: any) {
      setProfileMsg({ type: 'error', text: err.response?.data?.detail || '重置失败' });
    } finally {
      setResettingAvatar(false);
    }
  };

  // 邀请码签发 (个人主页成长与特权)
  const [inviteQuota, setInviteQuota] = useState<any>(null);
  const [myInviteCodes, setMyInviteCodes] = useState<any[]>([]);
  const [generatingInvite, setGeneratingInvite] = useState(false);
  const [inviteGenerateError, setInviteGenerateError] = useState('');

  const fetchMyInvites = React.useCallback(async () => {
    try {
      const res = await apiClient.get('/users/me/invite-codes');
      setInviteQuota(res.data);
      setMyInviteCodes(res.data?.codes || []);
    } catch {
      setInviteQuota({ eligible: false });
    }
  }, []);

  const handleGenerateMyInvite = async () => {
    setGeneratingInvite(true);
    setInviteGenerateError('');
    try {
      await apiClient.post('/users/me/invite-codes', { count: 1 });
      showToast('邀请码生成成功，请及时分享给受邀者');
      void fetchMyInvites();
    } catch (err: any) {
      setInviteGenerateError(err.response?.data?.detail || '生成失败，请稍后重试');
    } finally {
      setGeneratingInvite(false);
    }
  };

  // 注销弹窗打开时锁定背景滚动（与其他全站弹窗行为一致）
  useEffect(() => {
    if (!deactivateModalOpen) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, [deactivateModalOpen]);
  const isOtherUser = Boolean(targetUsername && targetUsername !== user?.username);

  const showToast = (msg: string) => {
    toast.info(msg);
  };

  const [activeSubTab, setActiveSubTab] = useState<'overview' | 'history' | 'edit_profile' | 'security' | 'my_posts' | 'my_favorites' | 'privacy' | 'my_reports'>('overview');
  const [historyList, setHistoryList] = useState<ReadingHistoryItem[]>([]);
  const [isFontModalOpen, setIsFontModalOpen] = useState(false);
  const [isPaletteModalOpen, setIsPaletteModalOpen] = useState(false);
  const [paletteName, setPaletteName] = useState(() => getPaletteMeta(getStoredPalette()).name);

  // 配色方案可能来自快捷胶囊或本页设置，保持名称同步
  useEffect(() => {
    const handlePaletteChange = () => {
      setPaletteName(getPaletteMeta(getStoredPalette()).name);
    };
    window.addEventListener(PALETTE_CHANGE_EVENT, handlePaletteChange);
    return () => window.removeEventListener(PALETTE_CHANGE_EVENT, handlePaletteChange);
  }, []);

  // 邀请码配额：成长与特权页激活时拉取
  useEffect(() => {
    if (isOtherUser || !user) return;
    if (activeSubTab === 'overview') {
      void fetchMyInvites();
    }
  }, [activeSubTab, isOtherUser, user?.id, fetchMyInvites]);

  useEffect(() => {
    if (activeSubTab === 'history') {
      const list = getReadingHistory();
      setHistoryList(list);
      if (list.length > 0) {
        const ids = list.map((item) => item.id);
        apiClient
          .post('/posts/batch-status', { post_ids: ids })
          .then((res) => {
            const statusMap = res.data || {};
            let hasChanged = false;
            const validList = list.filter((item) => {
              if (statusMap[item.id] === 'deleted') {
                removeReadingHistoryItem(item.id);
                hasChanged = true;
                return false;
              }
              return true;
            });
            if (hasChanged) {
              setHistoryList(validList);
            }
          })
          .catch(() => {});
      }
    }
  }, [activeSubTab]);

  const formatVisitedTime = (timestamp: number) => {
    const diffSec = Math.floor((Date.now() - timestamp) / 1000);
    if (diffSec < 60) return '刚刚';
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)} 分钟前`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)} 小时前`;
    if (diffSec < 86400 * 3) return `${Math.floor(diffSec / 86400)} 天前`;
    const d = new Date(timestamp);
    return `${d.getMonth() + 1}月${d.getDate()}日`;
  };

  // 他人主页状态
  const [targetProfile, setTargetProfile] = useState<UserProfile | null>(null);
  const [targetPosts, setTargetPosts] = useState<PostSimple[]>([]);
  const [loadingTarget, setLoadingTarget] = useState(false);
  const [followLoading, setFollowLoading] = useState(false);
  const [blockLoading, setBlockLoading] = useState(false);

  // 本人免打扰与黑名单管理
  const [dndEnabled, setDndEnabled] = useState<boolean>(user?.dnd_enabled || false);
  const [savingDnd, setSavingDnd] = useState(false);
  const [blockedUsers, setBlockedUsers] = useState<BlockedUserItem[]>([]);
  const [loadingBlocks, setLoadingBlocks] = useState(false);

  // 打卡状态
  const [checking, setChecking] = useState(false);
  const [checkedInLocally, setCheckedInLocally] = useState(false);
  const [checkinSuccess, setCheckinSuccess] = useState<string | null>(null);

  const hasCheckedInToday = Boolean(user?.has_checked_in_today || checkedInLocally);

  // 资料编辑表单
  const [nickname, setNickname] = useState(user?.nickname || '');
  const [bio, setBio] = useState(user?.bio || '');
  const [avatarUrl, setAvatarUrl] = useState(user?.avatar_url || '');
  // 已上传头像的内部直链 (R2/uploads) —— 仅用于预览，不回显到输入框，避免暴露存储直链
  const [uploadedAvatarUrl, setUploadedAvatarUrl] = useState('');
  const [gender, setGender] = useState<'male' | 'female' | 'secret'>(
    user?.gender === 'male' || user?.gender === 'female' ? user.gender : 'secret'
  );
  const [techStack, setTechStack] = useState(user?.tech_stack || '');
  const [githubUrl, setGithubUrl] = useState(user?.github_url || '');
  const [blogUrl, setBlogUrl] = useState(user?.blog_url || '');
  const [savingProfile, setSavingProfile] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [profileMsg, setProfileMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 首页浏览偏好 (无限滚动 vs 普通分页，仿照 linux.sb)
  const [infiniteScroll, setInfiniteScroll] = useState<boolean>(() => {
    try {
      const saved = localStorage.getItem('geek_home_infinite_scroll');
      return saved !== null ? saved === 'true' : true;
    } catch {
      return true;
    }
  });

  const handleToggleInfiniteScroll = (enabled: boolean) => {
    setInfiniteScroll(enabled);
    try {
      localStorage.setItem('geek_home_infinite_scroll', String(enabled));
      window.dispatchEvent(new CustomEvent('geek_infinite_scroll_change', { detail: enabled }));
    } catch {}
    showToast(enabled ? '已开启首页无限滚动模式' : '已恢复首页普通分页导航模式');
  };

  // 密码修改表单
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [savingPassword, setSavingPassword] = useState(false);
  const [passwordMsg, setPasswordMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // 我的发布与草稿箱
  const [postsFilter, setPostsFilter] = useState<'published' | 'draft'>('published');
  const [myPosts, setMyPosts] = useState<PostSimple[]>([]);
  const [loadingPosts, setLoadingPosts] = useState(false);
  const [myDrafts, setMyDrafts] = useState<any[]>([]);
  const [loadingDrafts, setLoadingDrafts] = useState(false);

  const fetchMyPosts = async () => {
    setLoadingPosts(true);
    try {
      const res = await apiClient.get('/users/me/posts?status=published');
      if (Array.isArray(res.data)) {
        setMyPosts(res.data);
      }
    } catch {}
    finally {
      setLoadingPosts(false);
    }
  };

  const fetchMyDrafts = async () => {
    setLoadingDrafts(true);
    try {
      const res = await apiClient.get('/posts/drafts');
      if (Array.isArray(res.data)) {
        setMyDrafts(res.data);
      }
    } catch {}
    finally {
      setLoadingDrafts(false);
    }
  };

  const handleWithdrawMyPost = async (e: React.MouseEvent, postId: string) => {
    e.stopPropagation();
    const ok = await confirmModal({
      title: '下架文章',
      description: '确定要下架这篇文章吗？下架后将移出社区公共版块，并完整保存在您的草稿箱中，可随时重新编辑上架。',
      confirmText: '下架存为草稿',
      danger: false,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/posts/${postId}?action=draft`);
      removeReadingHistoryItem(postId);
      showToast('文章已成功下架并转存至草稿箱！');
      setMyPosts((prev) => prev.filter((p) => p.id !== postId));
      fetchMyDrafts();
    } catch (err: any) {
      showToast(err.response?.data?.detail || '下架失败');
    }
  };

  const handleRepublishDraft = async (e: React.MouseEvent, draftId: string) => {
    e.stopPropagation();
    const ok = await confirmModal({
      title: '重新上架',
      description: '确定重新上架此文章并发布到社区吗？',
      confirmText: '立即上架',
      danger: false,
    });
    if (!ok) return;
    try {
      await apiClient.put(`/posts/${draftId}`, { status: 'published' });
      showToast('文章已成功重新上架发布！');
      setMyDrafts((prev) => prev.filter((d) => d.id !== draftId));
      try {
        const raw = localStorage.getItem('geek_community_drafts_v1');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) {
            localStorage.setItem('geek_community_drafts_v1', JSON.stringify(list.filter((item: any) => item.id !== draftId)));
          }
        }
      } catch {}
      fetchMyPosts();
      setPostsFilter('published');
    } catch (err: any) {
      showToast(err.response?.data?.detail || '上架失败，请检查文章标题与正文是否完整');
    }
  };

  const handleDeleteDraft = async (e: React.MouseEvent, draftId: string) => {
    e.stopPropagation();
    const ok = await confirmModal({
      title: '彻底删除草稿',
      description: '确定彻底删除该草稿吗？删除后文章及历史记录将无法恢复。',
      confirmText: '彻底删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/posts/${draftId}?action=delete`);
      removeReadingHistoryItem(draftId);
      showToast('草稿已彻底删除');
      setMyDrafts((prev) => prev.filter((d) => d.id !== draftId));
      try {
        const raw = localStorage.getItem('geek_community_drafts_v1');
        if (raw) {
          const list = JSON.parse(raw);
          if (Array.isArray(list)) {
            localStorage.setItem('geek_community_drafts_v1', JSON.stringify(list.filter((item: any) => item.id !== draftId)));
          }
        }
      } catch {}
    } catch (err: any) {
      showToast(err.response?.data?.detail || '删除失败');
    }
  };

  // 我的收藏
  const [myFavorites, setMyFavorites] = useState<PostSimple[]>([]);
  // 收藏夹分组
  const [favGroup, setFavGroup] = useState('全部');
  const [folderManagerOpen, setFolderManagerOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<string | null>(null);
  const [groupInput, setGroupInput] = useState('');
  const favGroups = Array.from(new Set(myFavorites.map((p: any) => p.group_name || '默认收藏')));
  const shownFavorites = favGroup === '全部'
    ? myFavorites
    : myFavorites.filter((p: any) => (p.group_name || '默认收藏') === favGroup);
  const saveGroup = async (postId: string) => {
    const name = groupInput.trim().slice(0, 32) || '默认收藏';
    try {
      await apiClient.put(`/users/me/collections/${postId}/group`, { group_name: name });
      setMyFavorites((prev) => prev.map((x: any) => x.id === postId ? { ...x, group_name: name } : x));
      setEditingGroup(null); setGroupInput('');
      toast.success('分组已更新');
    } catch { toast.error('分组更新失败'); }
  };
  const [loadingFavorites, setLoadingFavorites] = useState(false);

  // 关注与粉丝名单弹窗
  const [followModalOpen, setFollowModalOpen] = useState(false);
  const [followModalUser, setFollowModalUser] = useState<string>('');
  const [followModalTab, setFollowModalTab] = useState<'following' | 'followers'>('following');

  // 细粒度隐私偏好开关
  const [hideFollowing, setHideFollowing] = useState<boolean>(Boolean(user?.hide_following));
  const [hideFollowers, setHideFollowers] = useState<boolean>(Boolean(user?.hide_followers));
  const [hideFavorites, setHideFavorites] = useState<boolean>(Boolean(user?.hide_favorites));
  const [hideIpLocation, setHideIpLocation] = useState<boolean>(Boolean(user?.hide_ip_location));
  const [hideOnlineStatus, setHideOnlineStatus] = useState<boolean>(Boolean(user?.hide_online_status));
  const [openPostInNewTab, setOpenPostInNewTab] = useState(() => {
    try { return localStorage.getItem('wb_open_post_in_new_tab') === 'true' || Boolean((user as any)?.open_post_in_new_tab); } catch { return false; }
  });
  const [savingPrivacy, setSavingPrivacy] = useState(false);

  useEffect(() => {
    if (user) {
      setNickname(user.nickname || '');
      setBio(user.bio || '');
      // 上传的头像 (内部 /uploads/ 路径) 不回显直链，输入框留空表示"保持当前头像"
      const raw = user.avatar_url || '';
      if (raw.includes('/uploads/')) {
        setUploadedAvatarUrl(raw);
        setAvatarUrl('');
      } else {
        setUploadedAvatarUrl('');
        setAvatarUrl(raw);
      }
      setHideFollowing(Boolean(user.hide_following));
      setHideFollowers(Boolean(user.hide_followers));
      setHideFavorites(Boolean(user.hide_favorites));
      setHideIpLocation(Boolean(user.hide_ip_location));
      setHideOnlineStatus(Boolean(user.hide_online_status));
    }
  }, [user]);

  // 实际生效头像：输入框新值优先，否则为已上传头像（直链不外显）
  const effectiveAvatar = avatarUrl.trim() || uploadedAvatarUrl;

  // 点击头像放大查看（自己主页与别人主页共用）
  const [avatarPreview, setAvatarPreview] = useState<{ src: string; name: string } | null>(null);
  // 选图后先进裁剪弹窗，避免整张原图被直接切成头像
  const [cropFile, setCropFile] = useState<File | null>(null);

  const handleOpenFollowModal = (u: string, tab: 'following' | 'followers') => {
    setFollowModalUser(u);
    setFollowModalTab(tab);
    setFollowModalOpen(true);
  };

  const handleUpdatePrivacySetting = async (
    key: 'hide_following' | 'hide_followers' | 'hide_favorites' | 'hide_ip_location' | 'hide_online_status' | 'open_post_in_new_tab',
    newVal: boolean
  ) => {
    if (!user) return;
    if (key === 'hide_following') setHideFollowing(newVal);
    if (key === 'hide_followers') setHideFollowers(newVal);
    if (key === 'hide_favorites') setHideFavorites(newVal);
    if (key === 'hide_ip_location') setHideIpLocation(newVal);
    if (key === 'hide_online_status') setHideOnlineStatus(newVal);
    if (key === 'open_post_in_new_tab') {
      setOpenPostInNewTab(newVal);
      // 同步给首页点击逻辑（跨标签也生效）
      try { localStorage.setItem('wb_open_post_in_new_tab', String(newVal)); } catch {}
    }

    setSavingPrivacy(true);
    try {
      const res = await apiClient.put('/users/me/privacy', { [key]: newVal });
      if (onUserUpdated) onUserUpdated(res.data);
      showToast('隐私设置已生效保存');
    } catch {
      showToast('设置失败');
      if (key === 'hide_following') setHideFollowing(!newVal);
      if (key === 'hide_followers') setHideFollowers(!newVal);
      if (key === 'hide_favorites') setHideFavorites(!newVal);
      if (key === 'hide_ip_location') setHideIpLocation(!newVal);
      if (key === 'hide_online_status') setHideOnlineStatus(!newVal);
      if (key === 'open_post_in_new_tab') {
        setOpenPostInNewTab(!newVal);
        try { localStorage.setItem('wb_open_post_in_new_tab', String(!newVal)); } catch {}
      }
    } finally {
      setSavingPrivacy(false);
    }
  };

  useEffect(() => {
    if (activeSubTab === 'my_posts' && user) {
      fetchMyPosts();
      fetchMyDrafts();
    } else if (activeSubTab === 'my_favorites' && user) {
      setLoadingFavorites(true);
      apiClient.get('/users/me/collections')
        .then((res) => {
          if (Array.isArray(res.data)) {
            setMyFavorites(res.data);
          } else {
            setMyFavorites([]);
          }
        })
        .catch(() => {
          setMyFavorites([]);
        })
        .finally(() => setLoadingFavorites(false));
    }
  }, [activeSubTab, user]);

  // 加载他人公开资料与文章
  useEffect(() => {
    if (isOtherUser && targetUsername) {
      setLoadingTarget(true);
      apiClient.get(`/users/profile/${targetUsername}`)
        .then((res) => {
          setTargetProfile(res.data);
          return apiClient.get(`/users/${targetUsername}/posts`);
        })
        .then((pRes) => {
          if (pRes && Array.isArray(pRes.data)) {
            setTargetPosts(pRes.data);
          }
        })
        .catch(() => {})
        .finally(() => {
          setLoadingTarget(false);
        });
    }
  }, [isOtherUser, targetUsername]);

  // 加载本人黑名单列表
  useEffect(() => {
    if (!isOtherUser && activeSubTab === 'privacy' && user) {
      setLoadingBlocks(true);
      apiClient.get('/users/me/blocks')
        .then((res) => {
          if (Array.isArray(res.data)) {
            setBlockedUsers(res.data);
          }
        })
        .catch(() => {})
        .finally(() => setLoadingBlocks(false));
    }
  }, [isOtherUser, activeSubTab, user]);

  // 关注 / 取关操作
  const handleToggleFollow = async () => {
    if (!user) {
      onRequireAuth?.();
      return;
    }
    if (!targetProfile) return;
    setFollowLoading(true);
    try {
      if (targetProfile.is_following) {
        await apiClient.delete(`/users/${targetProfile.username}/follow`);
        setTargetProfile({
          ...targetProfile,
          is_following: false,
          followers_count: Math.max(0, (targetProfile.followers_count || 1) - 1),
        });
      } else {
        await apiClient.post(`/users/${targetProfile.username}/follow`);
        setTargetProfile({
          ...targetProfile,
          is_following: true,
          followers_count: (targetProfile.followers_count || 0) + 1,
        });
        toast.success(`已成功关注 @${targetProfile.username}`);
      }
      onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '关注操作失败');
    } finally {
      setFollowLoading(false);
    }
  };

  // 拉黑 / 解除拉黑操作
  const handleToggleBlock = async () => {
    if (!user) {
      onRequireAuth?.();
      return;
    }
    if (!targetProfile) return;
    if (!targetProfile.is_blocked) {
      const ok = await confirmModal({
        title: '加入黑名单',
        description: `确定要将 @${targetProfile.username} 加入黑名单吗？拉黑后对方将无法向您发送私信，无法查看您的动态。`,
        confirmText: '加入黑名单',
        danger: true,
      });
      if (!ok) return;
    }
    setBlockLoading(true);
    try {
      if (targetProfile.is_blocked) {
        await apiClient.delete(`/users/${targetProfile.username}/block`);
        setTargetProfile({
          ...targetProfile,
          is_blocked: false,
        });
        toast.info(`已将 @${targetProfile.username} 移出黑名单`);
      } else {
        await apiClient.post(`/users/${targetProfile.username}/block`);
        setTargetProfile({
          ...targetProfile,
          is_blocked: true,
          is_following: false,
        });
        toast.warning(`已将 @${targetProfile.username} 列入黑名单`);
      }
      onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '黑名单操作失败');
    } finally {
      setBlockLoading(false);
    }
  };

  // 解除黑名单 (个人设置中调用)
  const handleUnblockUser = async (uUsername: string) => {
    try {
      await apiClient.delete(`/users/${uUsername}/block`);
      setBlockedUsers((prev) => prev.filter((u) => u.username !== uUsername));
      toast.info(`已解除对 @${uUsername} 的拉黑`);
      onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '解除拉黑失败');
    }
  };

  // 切换免打扰模式
  const handleToggleDnd = async () => {
    setSavingDnd(true);
    try {
      const nextVal = !dndEnabled;
      await apiClient.put('/users/me/dnd', { dnd_enabled: nextVal });
      setDndEnabled(nextVal);
      if (user && onUserUpdated) {
        onUserUpdated({ ...user, dnd_enabled: nextVal });
      }
      toast.success(nextVal ? '已开启全局免打扰模式' : '已恢复消息接收通知');
      onRefresh();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '更新免打扰设置失败');
    } finally {
      setSavingDnd(false);
    }
  };

  if (!isOtherUser && !user) {
    return (
      <div className="py-24 text-center text-xs text-wb-text-muted space-y-3">
        <p>请先登录账号以管理您的个人主页与社交设置</p>
        {onRequireAuth && (
          <button
            type="button"
            onClick={onRequireAuth}
            className="wb-pressable h-9 px-5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm"
          >
            通行证登录 / 注册
          </button>
        )}
      </div>
    );
  }

  // 签到
  const handleCheckin = async () => {
    if (hasCheckedInToday) {
      toast.info('今日已完成签到打卡');
      return;
    }
    setChecking(true);
    try {
      const res = await apiClient.post('/users/checkin');
      setCheckedInLocally(true);
      setCheckinSuccess(`打卡成功！获得 +${res.data.exp_gained} 经验 (连续打卡 ${res.data.continuous_days} 天)`);
      toast.success(`打卡成功！+${res.data.exp_gained} EXP (连续 ${res.data.continuous_days} 天)`);
      onRefresh();
    } catch (err: any) {
      if (err.response?.data?.detail?.includes('今日已经完成签到') || err.response?.data?.detail?.includes('已完成签到')) {
        setCheckedInLocally(true);
      }
      toast.warning(err.response?.data?.detail || '今日已完成签到');
    } finally {
      setChecking(false);
    }
  };

  // 选图：先打开裁剪，用户确认后再上传
  const handleAvatarFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const picked = Array.from(e.target.files || []);
    // 必须先复制再清空：直接读 FileList 会被 value='' 一起清掉
    e.target.value = '';
    if (!picked.length) return;
    setCropFile(picked[0]);
  };

  // 裁剪确认后上传（导出已是 512 正方形，无需再压缩）
  const handleAvatarCropped = async (blob: Blob) => {
    setCropFile(null);
    const formData = new FormData();
    formData.append('file', new File([blob], 'avatar.jpg', { type: 'image/jpeg' }));

    setUploadingAvatar(true);
    setProfileMsg(null);
    try {
      const res = await apiClient.post('/users/me/avatar', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      const newAvatarUrl = res.data.avatar_url;
      // 上传成功后直链仅入预览缓存，不回显到输入框（避免暴露对象存储直链）
      setUploadedAvatarUrl(newAvatarUrl);
      setAvatarUrl('');
      setProfileMsg({ type: 'success', text: '新头像上传成功并已即时生效！' });
      if (onUserUpdated && user) {
        onUserUpdated({ ...user, avatar_url: newAvatarUrl });
      }
      onRefresh();
    } catch (err: any) {
      setProfileMsg({ type: 'error', text: err.response?.data?.detail || '头像上传失败' });
    } finally {
      setUploadingAvatar(false);
    }
  };

  // 保存个人资料
  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    setProfileMsg(null);
    setSavingProfile(true);

    try {
      // 清空昵称：后端语义中空值 = 不修改，会静默吞掉用户意图；给出明确提示
      if (!nickname.trim() && (user?.nickname || user?.username)) {
        showToast('昵称不能为空，已保留当前昵称');
      }
      const res = await apiClient.put('/users/me', {
        nickname: nickname.trim() || undefined,
        bio,
        avatar_url: avatarUrl.trim() || undefined,
        gender,
        tech_stack: techStack.trim(),
        github_url: githubUrl.trim(),
        blog_url: blogUrl.trim(),
      });
      setProfileMsg({ type: 'success', text: '个人资料已更新！' });
      if (onUserUpdated) onUserUpdated(res.data);
      onRefresh();

    } catch (err: any) {
      setProfileMsg({ type: 'error', text: err.response?.data?.detail || '更新失败，请重试' });
    } finally {
      setSavingProfile(false);
    }
  };

  // 自助注销账号（应用内弹窗）
  // 第三方登录（GitHub / Gitee）注册的账号没有可用密码，改用「输入用户名」确认
  const isOAuthAccount = ['github', 'gitee'].includes((user?.register_channel || 'public').toLowerCase());

  const handleDeactivateAccount = async () => {
    const confirmValue = deactivateInput.trim();
    if (!confirmValue) {
      setDeactivateError(isOAuthAccount ? '请输入你的用户名以确认' : '请输入登录密码以确认');
      return;
    }
    setDeactivating(true);
    setDeactivateError('');
    try {
      const payload = isOAuthAccount
        ? { confirm_username: confirmValue }
        : { password: confirmValue };
      await apiClient.post('/users/me/deactivate', payload);
      setDeactivateModalOpen(false);
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      showToast('账号已进入 10 天注销缓冲期，期间可联系超级管理员恢复');
      setTimeout(() => { window.location.href = '/'; }, 1200);
    } catch (err: any) {
      setDeactivateError(err.response?.data?.detail || '注销失败，请重试');
    } finally {
      setDeactivating(false);
    }
  };

  // 修改密码
  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setPasswordMsg(null);

    if (newPassword !== confirmPassword) {
      setPasswordMsg({ type: 'error', text: '两次输入的新密码不一致' });
      return;
    }
    if (newPassword.length < 8) {
      setPasswordMsg({ type: 'error', text: '新密码长度至少需要 8 位' });
      return;
    }
    // 与后端保持一致的前置校验：仅允许可见 ASCII 字符，禁止中文/Emoji/空格等
    if (!/^[\x21-\x7E]{8,64}$/.test(newPassword)) {
      setPasswordMsg({ type: 'error', text: '密码仅支持不含空格的英文、数字与英文符号（长度 8~64 位），不支持中文' });
      return;
    }
    // 与后端 password_policy 对齐：必须同时含字母和数字
    if (!/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
      setPasswordMsg({ type: 'error', text: '密码需同时包含字母和数字' });
      return;
    }

    setSavingPassword(true);
    try {
      const res = await apiClient.put('/users/me/password', {
        old_password: oldPassword,
        new_password: newPassword,
      });
      // 改密成功后服务端已自增 token_version，本地会话即刻失效，
      // 必须清除凭证并引导重新登录，避免"显示成功但后续操作全部 401"
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      window.dispatchEvent(new CustomEvent('auth:expired'));
      setPasswordMsg({ type: 'success', text: res.data.message || '密码修改成功！请使用新密码重新登录' });
      setTimeout(() => { window.location.href = '/'; }, 1500);
      return;
    } catch (err: any) {
      setPasswordMsg({ type: 'error', text: err.response?.data?.detail || '原密码错误或修改失败' });
    } finally {
      setSavingPassword(false);
    }
  };

  // 向新邮箱发送绑定验证码
  const handleSendBindCode = async () => {
    const target = newEmail.trim();
    if (!/^\S+@\S+\.\S+$/.test(target)) {
      setEmailMsg({ type: 'error', text: '请输入有效的邮箱地址' });
      return;
    }
    setEmailMsg(null);
    setEmailCodeSending(true);
    try {
      const res = await apiClient.post('/auth/email/code', { email: target, purpose: 'bind_email' });
      setEmailCooldown(Number(res.data?.cooldown_seconds) || 60);
      if (res.data?.dev_code) setEmailCode(String(res.data.dev_code));
      setEmailMsg({ type: 'success', text: res.data?.message || '验证码已发送' });
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.response?.data?.detail || '验证码发送失败' });
    } finally {
      setEmailCodeSending(false);
    }
  };

  // 提交新邮箱 + 验证码
  const handleBindEmail = async () => {
    if (!emailCode.trim()) {
      setEmailMsg({ type: 'error', text: '请输入邮箱验证码' });
      return;
    }
    setEmailSubmitting(true);
    try {
      const res = await apiClient.post('/users/me/email/bind', {
        email: newEmail.trim(),
        code: emailCode.trim(),
      });
      if (user && onUserUpdated) {
        onUserUpdated({ ...user, email: res.data.email, email_verified: true });
      }
      onRefresh();
      setEmailEditing(false);
      setNewEmail('');
      setEmailCode('');
      setEmailCooldown(0);
      setEmailMsg({ type: 'success', text: res.data.message || '邮箱已更新并完成验证' });
      toast.success('邮箱已更新并完成验证');
    } catch (err: any) {
      setEmailMsg({ type: 'error', text: err.response?.data?.detail || '邮箱绑定失败' });
    } finally {
      setEmailSubmitting(false);
    }
  };

  if (isOtherUser) {
    if (loadingTarget) {
      return (
        <div className="max-w-4xl mx-auto px-4 py-20 text-center text-xs text-wb-text-muted space-y-3">
          <div className="w-6 h-6 border-2 border-wb-text-primary border-t-transparent rounded-full animate-spin mx-auto" />
          <p>正在拉取极客公开主页与创作轨迹...</p>
        </div>
      );
    }

    if (!targetProfile) {
      return (
        <div className="max-w-4xl mx-auto px-4 py-20 text-center text-xs text-wb-text-muted space-y-3">
          <p>未找到该极客主页或对方已注销</p>
          {onBack && (
            <button
              type="button"
              onClick={onBack}
              className="wb-pressable inline-flex items-center gap-1.5 h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> 返回上一页
            </button>
          )}
        </div>
      );
    }

    return (
      <div className={`${PROFILE_PAGE} animate-fade-in`}>
        <header className={PROFILE_SURFACE}>
          <ProfileHeading isPublic onBack={onBack} />
          <div className="space-y-3 px-3 py-3 sm:px-4">
            <div className={PROFILE_INTRO}>
              <ProfileIdentity profile={targetProfile} onPreview={setAvatarPreview} />
              <div className={PROFILE_TOOLS}>
                <button
                  type="button"
                  onClick={handleToggleFollow}
                  disabled={followLoading}
                  className={`wb-pressable inline-flex h-9 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-capsule px-3 text-xs font-semibold transition-colors ${
                    targetProfile.is_following
                      ? 'border border-wb-border-strong bg-wb-bg-subtle text-wb-text-primary'
                      : 'bg-wb-text-primary text-wb-bg-page shadow-sm'
                  }`}
                >
                {targetProfile.is_following ? (
                  <>
                    <UserCheck className="w-3.5 h-3.5 shrink-0" />
                    <span className="whitespace-nowrap">已关注</span>
                  </>
                ) : (
                  <>
                    <UserPlus className="w-3.5 h-3.5 shrink-0" />
                    <span className="whitespace-nowrap">关注极客</span>
                  </>
                )}
              </button>

              {onStartChat && (
                <button
                  type="button"
                  onClick={() => {
                    if (!user) {
                      onRequireAuth?.();
                      return;
                    }
                    onStartChat(targetProfile.id, targetProfile.username);
                  }}
                  className={`${PROFILE_ACTION} border border-wb-border-subtle bg-wb-bg-subtle font-medium text-wb-text-primary hover:border-wb-border-strong`}
                >
                  <MessageSquare className="w-3.5 h-3.5 shrink-0" />
                  <span className="whitespace-nowrap">发私信</span>
                </button>
              )}

              <button
                type="button"
                onClick={handleToggleBlock}
                disabled={blockLoading}
                title={targetProfile.is_blocked ? '移出黑名单' : '加入黑名单'}
                className={`${PROFILE_ACTION} ${
                  targetProfile.is_blocked
                    ? 'border border-wb-danger/30 bg-wb-danger/10 font-medium text-wb-danger'
                    : 'border border-wb-border-subtle text-wb-text-muted hover:bg-wb-bg-subtle hover:text-wb-danger'
                }`}
              >
                {targetProfile.is_blocked ? (
                  <>
                    <ShieldOff className="w-3.5 h-3.5 shrink-0" />
                    <span className="whitespace-nowrap">已拉黑</span>
                  </>
                ) : (
                  <>
                    <ShieldAlert className="w-3.5 h-3.5 shrink-0" />
                    <span className="hidden sm:inline whitespace-nowrap">拉黑</span>
                  </>
                )}
              </button>
              </div>
            </div>
            <ProfileStats profile={targetProfile} posts={targetPosts.length} onOpenFollows={handleOpenFollowModal} />
          </div>
        </header>

        {/* 动态内容或隐私防护 */}
        <div className="min-w-0 space-y-4">
          {targetProfile.is_blocked_by ? (
            <div className="p-12 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3">
              <ShieldAlert className="w-10 h-10 text-wb-text-muted mx-auto stroke-1" />
              <h4 className="text-base font-bold text-wb-text-primary">受限访问</h4>
              <p className="text-xs text-wb-text-muted">对方开启了隐私保护或已设置受限，暂无法查看其发表的内容动态</p>
            </div>
          ) : (
            <>
              {/* 极客荣誉成就勋章墙 */}
              <HonorWall userId={targetProfile.id} title={`荣誉墙 · @${targetProfile.username}`} />
              <TitleCard
                userId={targetProfile.id}
                currentTitle={targetProfile.equipped_title}
                canEdit={false}
                profile={targetProfile}
              />

              {targetProfile.is_blocked && (
                <div className="p-3.5 rounded-2xl bg-wb-danger/10 border border-wb-danger/20 text-xs text-wb-danger flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <ShieldAlert className="w-4 h-4 flex-shrink-0" />
                    <span>您已将该用户加入黑名单，对方发来的私信将被自动拦截，且不会产生通知</span>
                  </div>
                  <button
                    type="button"
                    onClick={handleToggleBlock}
                    className="font-bold underline hover:opacity-80 flex-shrink-0"
                  >
                    解除拉黑
                  </button>
                </div>
              )}

              <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
                <div className="flex items-center justify-between pb-2 border-b border-wb-border-subtle">
                  <h3 className="text-sm font-bold text-wb-text-primary flex items-center gap-2">
                    <FileText className="w-4 h-4" />
                    <span>Ta 发表的讨论与文章 ({targetPosts.length})</span>
                  </h3>
                </div>

                {targetPosts.length > 0 ? (
                  <div className="space-y-3">
                    {targetPosts.map((p) => (
                      <article
                        key={p.id}
                        onClick={() => onSelectPost && onSelectPost(p.id)}
                        className="wb-pressable cursor-pointer p-4 md:p-5 rounded-2xl bg-wb-bg-subtle/50 border border-wb-border-subtle hover:border-wb-border-strong transition-all flex items-center justify-between gap-4 group"
                      >
                        <div className="space-y-1.5 flex-1">
                          <div className="flex items-center gap-2 text-2xs text-wb-text-muted">
                            <span>{new Date(p.created_at).toLocaleDateString()}</span>
                            {p.category_name && <span>· {p.category_name}</span>}
                            {p.is_pinned && (
                              <span className="px-2 py-0.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold text-3xs">
                                置顶
                              </span>
                            )}
                          </div>
                          <h4 className="font-semibold text-sm text-wb-text-primary group-hover:underline line-clamp-1">
                            {p.title}
                          </h4>
                          <div className="flex items-center gap-4 text-xs text-wb-text-secondary font-mono">
                            <span className="flex items-center gap-1">
                              <Eye className="w-3.5 h-3.5" /> {p.view_count}
                            </span>
                            <span className="flex items-center gap-1">
                              <Heart className="w-3.5 h-3.5" /> {p.like_count}
                            </span>
                            <span className="flex items-center gap-1">
                              <MessageSquare className="w-3.5 h-3.5" /> {p.comment_count}
                            </span>
                          </div>
                        </div>
                        <ChevronRight className="w-4 h-4 text-wb-text-muted transition-transform group-hover:translate-x-0.5" />
                      </article>
                    ))}
                  </div>
                ) : (
                  <div className="py-12 text-center space-y-2">
                    <FileText className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
                    <p className="text-xs text-wb-text-secondary">该极客暂未公开发布任何文章</p>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        {/* 他人主页同样需要挂载预览层：之前只有本人的 return 里才有，
            导致别人的头像显示放大光标但点击无反应 */}
        <AvatarPreview
          src={avatarPreview?.src ?? null}
          name={avatarPreview?.name}
          onClose={() => setAvatarPreview(null)}
        />
      </div>
    );
  }

  // 接下来 100% 确认是本人登录状态:
  if (!user) {
    return (
      <div className="py-24 text-center text-xs text-wb-text-muted space-y-3">
        <p>请先登录账号以管理您的个人主页与社交设置</p>
        {onRequireAuth && (
          <button
            type="button"
            onClick={onRequireAuth}
            className="wb-pressable h-9 px-5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm"
          >
            通行证登录 / 注册
          </button>
        )}
      </div>
    );
  }

  // 等级进度计算 (针对本人)
  const nextLevelExp = [1, 100, 300, 800, 2000, 5000, 10000][user.level] || 10000;
  const prevLevelExp = [0, 1, 100, 300, 800, 2000, 5000][user.level] || 0;
  const progressPercent = Math.min(100, Math.max(0, Math.round(((user.experience - prevLevelExp) / (nextLevelExp - prevLevelExp)) * 100)));

  return (
    <div className={`${PROFILE_PAGE} animate-fade-in`}>
      <header className={PROFILE_SURFACE}>
        <ProfileHeading />
        <div className="space-y-3 px-3 py-3 sm:px-4">
          <div className={PROFILE_INTRO}>
            <ProfileIdentity profile={user} own hideIpLocation={hideIpLocation} onPreview={setAvatarPreview} />
            <div className={PROFILE_TOOLS}>
              <button
                type="button"
                onClick={handleCheckin}
                disabled={hasCheckedInToday || checking}
                className={`wb-pressable inline-flex h-9 shrink-0 select-none items-center gap-1.5 whitespace-nowrap rounded-capsule px-3 text-xs font-semibold shadow-sm transition-all ${
                  hasCheckedInToday
                    ? 'border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-muted opacity-85 cursor-default'
                    : 'bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-50 cursor-pointer'
                }`}
              >
                {hasCheckedInToday ? (
                  <>
                    <Check className="h-3.5 w-3.5 shrink-0 text-wb-success" />
                    <span className="whitespace-nowrap">今日已打卡</span>
                  </>
                ) : (
                  <>
                    <Calendar className="h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-nowrap">{checking ? '打卡中...' : '每日打卡 (+5 EXP)'}</span>
                  </>
                )}
              </button>
            </div>
          </div>
          <ProfileStats profile={user} posts={myPosts.length} onOpenFollows={handleOpenFollowModal} />
        </div>

        {checkinSuccess && (
          <div className="mx-3 mb-3 flex items-center gap-2 rounded-xl border border-wb-border-subtle bg-wb-bg-subtle px-3 py-2 text-xs font-medium text-wb-text-primary animate-fade-in sm:mx-4">
            <Check className="h-4 w-4" />
            <span>{checkinSuccess}</span>
          </div>
        )}

        {/* 见习期转正动态卡片 (本人专属) */}
        {user.status === 'probation' && (
          <div className="p-4 rounded-2xl bg-wb-bg-subtle/80 border border-wb-border-strong space-y-2">
            <div className="flex items-center justify-between text-xs">
              <span className="font-semibold text-wb-text-primary flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5" /> 见习会员转正考核
              </span>
              <span className="font-mono text-wb-text-secondary">
                已活跃: {user.active_days} / 5 天 (还需 {Math.max(0, 5 - user.active_days)} 天自动晋升正式会员)
              </span>
            </div>
            <div className="w-full bg-wb-border-subtle h-2 rounded-capsule overflow-hidden">
              <div
                className="bg-wb-text-primary h-full rounded-capsule transition-all duration-500"
                style={{ width: `${Math.min(100, (user.active_days / 5) * 100)}%` }}
              />
            </div>
          </div>
        )}
      </header>

      {/* 模块切换：窄屏下拉，宽屏分段 */}
      <nav aria-label="个人主页模块" className={`${PROFILE_SURFACE} px-3 py-2 sm:px-4`}>
        <div className="sm:hidden">
          <CustomDropdown
            ariaLabel="个人主页模块"
            value={activeSubTab}
            onChange={(value: string) => setActiveSubTab(value as ProfileTab)}
            placeholder="选择个人主页模块"
            options={PROFILE_TAB_OPTIONS}
            className="w-full"
          />
        </div>
        <div className="hidden min-w-0 overflow-x-auto sm:flex" style={{ overflowY: 'hidden', scrollbarWidth: 'none' }}>
          <SegmentedControl
            id="profile-tabs"
            items={PROFILE_TAB_ITEMS}
            activeKey={activeSubTab}
            onChange={(key) => setActiveSubTab(key as ProfileTab)}
          />
        </div>
      </nav>

      {/* 内容区域 */}
      <AnimatePresence mode="wait">
        {/* 1. 成长概览与等级特权表 */}
        {activeSubTab === 'overview' && (
          <motion.div
            key="overview"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            {/* 经验等级推进 */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Award className="w-4 h-4 text-wb-text-primary" />
                  <h3 className="font-semibold text-sm text-wb-text-primary">
                    等级与经验值体系
                  </h3>
                </div>
                <span className="text-xs font-mono text-wb-text-secondary">
                  {user.experience} / {nextLevelExp} EXP
                </span>
                <span className="text-3xs text-wb-text-muted font-mono">
                  {(user as any).created_at
                    ? `加入于 ${new Date((user as any).created_at).toLocaleDateString('zh-CN')}`
                    : ''}
                  {typeof user.active_days === 'number' ? ` · 活跃 ${user.active_days} 天` : ''}
                </span>
              </div>

              <div className="space-y-1.5">
                <div className="w-full bg-wb-bg-subtle h-2.5 rounded-capsule overflow-hidden border border-wb-border-subtle">
                  <div
                    className="bg-wb-text-primary h-full rounded-capsule transition-all duration-500"
                    style={{ width: `${progressPercent}%` }}
                  />
                </div>
                <div className="flex justify-between text-2xs text-wb-text-muted font-mono">
                  <span>Lv.{user.level}</span>
                  <span>升级进度 {progressPercent}%</span>
                  <span>Lv.{Math.min(6, user.level + 1)}</span>
                </div>
              </div>

              {/* GitHub 风格打卡热力图 */}
              <CheckinHeatmap username={user.username} canMakeup />
            </div>

            {/* 极客荣誉与成就勋章墙 */}
            <HonorWall userId={user.id} title="荣誉墙" />
            <TitleCard
              userId={user.id}
              currentTitle={user.equipped_title}
              canEdit
              onUpdated={onUserUpdated}
              profile={user}
            />

            {/* 社区等级特权对比表 */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Shield className="w-4 h-4 text-wb-text-primary" />
                  <h3 className="font-semibold text-sm text-wb-text-primary">
                    社区各等级特权一览表
                  </h3>
                </div>
                <span className="text-3xs text-wb-text-muted font-mono sm:hidden">
                  ← 左右滑动查阅 →
                </span>
              </div>

              <div
                className="overflow-x-auto overflow-y-hidden no-scrollbar -mx-5 px-5 sm:mx-0 sm:px-0"
                style={{ overflowY: 'hidden', scrollbarWidth: 'none' }}
              >
                <table className="min-w-[540px] w-full text-left text-xs border-collapse font-sans">
                  <thead>
                    <tr className="border-b border-wb-border-subtle text-wb-text-secondary whitespace-nowrap">
                      <th className="py-2.5 px-3 font-semibold">等级阶段</th>
                      <th className="py-2.5 px-3 font-semibold">所需经验</th>
                      <th className="py-2.5 px-3 font-semibold">每日匿名发言额度</th>
                      <th className="py-2.5 px-3 font-semibold">核心功能权限</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-wb-border-subtle text-wb-text-primary font-mono">
                    <tr className={user.level === 0 ? 'bg-wb-bg-subtle/70 font-semibold' : ''}>
                      <td className="py-2.5 px-3 font-sans">Lv.0 见习会员</td>
                      <td className="py-2.5 px-3">0 EXP</td>
                      <td className="py-2.5 px-3">0 次/日</td>
                      <td className="py-2.5 px-3 font-sans text-wb-text-muted">仅可公开评论，暂不可发帖与投票</td>
                    </tr>
                    <tr className={user.level === 1 ? 'bg-wb-bg-subtle/70 font-semibold' : ''}>
                      <td className="py-2.5 px-3 font-sans">Lv.1 正式会员</td>
                      <td className="py-2.5 px-3">1 EXP</td>
                      <td className="py-2.5 px-3">3 次/日</td>
                      <td className="py-2.5 px-3 font-sans">解锁发帖、投票与匿名评论</td>
                    </tr>
                    <tr className={user.level === 2 ? 'bg-wb-bg-subtle/70 font-semibold' : ''}>
                      <td className="py-2.5 px-3 font-sans">Lv.2 进阶极客</td>
                      <td className="py-2.5 px-3">100 EXP</td>
                      <td className="py-2.5 px-3">5 次/日</td>
                      <td className="py-2.5 px-3 font-sans">解锁私聊与实时 Typing 广播</td>
                    </tr>
                    <tr className={user.level === 3 ? 'bg-wb-bg-subtle/70 font-semibold' : ''}>
                      <td className="py-2.5 px-3 font-sans">Lv.3 资深先锋</td>
                      <td className="py-2.5 px-3">300 EXP</td>
                      <td className="py-2.5 px-3">8 次/日</td>
                      <td className="py-2.5 px-3 font-sans">支持多选高级投票创建</td>
                    </tr>
                    <tr className={user.level === 4 ? 'bg-wb-bg-subtle/70 font-semibold' : ''}>
                      <td className="py-2.5 px-3 font-sans">Lv.4 核心领航</td>
                      <td className="py-2.5 px-3">800 EXP</td>
                      <td className="py-2.5 px-3">12 次/日</td>
                      <td className="py-2.5 px-3 font-sans">高权重内容曝光与免审通道</td>
                    </tr>
                    <tr className={user.level >= 5 ? 'bg-wb-bg-subtle/70 font-semibold' : ''}>
                      <td className="py-2.5 px-3 font-sans">Lv.5 ~ 6 社区导师</td>
                      <td className="py-2.5 px-3">2000+ EXP</td>
                      <td className="py-2.5 px-3">20 次/日</td>
                      <td className="py-2.5 px-3 font-sans">最高荣誉徽章与自治巡查特权</td>
                    </tr>
                  </tbody>
                </table>
              </div>
            </div>

            {/* 邀请码签发 (Lv.3+ / 管理角色；规则见卡片说明) */}
            {!isOtherUser && (
              <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3.5 text-xs">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  <h4 className="font-bold text-sm text-wb-text-primary flex items-center gap-1.5">
                    <KeyRound className="w-4 h-4 text-wb-text-primary" />
                    邀请码签发
                  </h4>
                  {inviteQuota?.eligible && (
                    <span className="text-2xs font-mono text-wb-text-muted">
                      本窗口剩余:
                      <span className="text-wb-text-primary font-bold ml-1">
                        {inviteQuota.limit === null ? '不限量' : `${inviteQuota.remaining}/${inviteQuota.limit}`}
                      </span>
                      <span className="ml-2">时效 {inviteQuota.valid_days} 天</span>
                    </span>
                  )}
                </div>

                {inviteQuota?.eligible ? (
                  <>
                    <p className="text-2xs text-wb-text-muted leading-relaxed">
                      {inviteQuota.limit === null
                        ? '超级管理员不限量签发，邀请码 30 天有效，可使新用户免除见习期直升正式会员。'
                        : user?.role && ['admin', 'moderator'].includes(user.role)
                        ? `管理角色每 72 小时可签发 ${inviteQuota.limit} 枚邀请码，30 天有效，可使新用户直升正式会员。`
                        : `Lv.${inviteQuota.level} 用户每 72 小时可生成 ${inviteQuota.limit} 枚限时邀请码（${inviteQuota.valid_days} 天 / 72 小时内有效），受邀者直升正式会员。`}
                    </p>
                    <button
                      type="button"
                      onClick={handleGenerateMyInvite}
                      disabled={generatingInvite || (inviteQuota.limit !== null && inviteQuota.remaining <= 0)}
                      className="wb-pressable inline-flex items-center gap-1.5 h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 disabled:opacity-40 transition-opacity"
                    >
                      <KeyRound className="w-3.5 h-3.5" />
                      <span>{generatingInvite ? '生成中...' : `生成邀请码${inviteQuota.limit !== null ? ` (剩 ${inviteQuota.remaining} 枚)` : ''}`}</span>
                    </button>
                    {inviteGenerateError && <p className="text-2xs text-wb-danger">{inviteGenerateError}</p>}
                    {myInviteCodes.length > 0 && (
                      <div className="p-3 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle font-mono text-2xs space-y-1.5 max-h-48 overflow-y-auto">
                        {myInviteCodes.map((c) => (
                          <div key={c.code} className="flex items-center justify-between gap-2">
                            <span className={c.is_used ? 'text-wb-text-muted line-through' : 'text-wb-text-primary'}>{c.code}</span>
                            <span className={`text-3xs shrink-0 ${c.is_used ? 'text-wb-text-muted' : 'text-wb-success dark:text-wb-success'}`}>
                              {c.is_used ? '已使用' : `有效至 ${c.expires_at ? c.expires_at.slice(0, 10) : '--'}`}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-2xs text-wb-text-muted leading-relaxed">
                    邀请码签发需 <span className="text-wb-text-primary font-semibold">Lv.3 及以上</span>（Lv.3~5 每 72 小时 1 枚、Lv.6 每 72 小时 3 枚，72 小时时效）。
                    当前等级 Lv.{user?.level ?? 0}，继续活跃提升等级后解锁。
                  </p>
                )}
              </div>
            )}
          </motion.div>
        )}

        {/* 浏览足迹 / 阅读历史 */}
        {activeSubTab === 'history' && (
          <motion.div
            key="history"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-4"
          >
            <div className="flex items-center justify-between px-1">
              <div className="flex items-center gap-2">
                <History className="w-4 h-4 text-wb-text-primary" />
                <h3 className="text-sm font-semibold text-wb-text-primary">
                  最近阅读足迹 ({historyList.length})
                </h3>
                <span className="text-2xs text-wb-text-muted hidden sm:inline">
                  本地安全存储 · 随时回溯
                </span>
              </div>
              {historyList.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    clearReadingHistory();
                    setHistoryList([]);
                    showToast('已清空所有浏览足迹');
                  }}
                  className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle hover:border-wb-danger/30 text-xs text-wb-text-muted hover:text-wb-danger transition-colors cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>清空足迹</span>
                </button>
              )}
            </div>

            {historyList.length === 0 ? (
              <div className="p-12 text-center rounded-3xl bg-wb-bg-surface border border-wb-border-subtle space-y-3">
                <div className="w-12 h-12 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center mx-auto text-wb-text-muted">
                  <History className="w-6 h-6" />
                </div>
                <div className="text-sm font-medium text-wb-text-primary">暂无阅读足迹</div>
                <p className="text-xs text-wb-text-muted max-w-sm mx-auto">
                  在社区浏览任何前沿技术探讨或架构文章，足迹都将自动沉淀在此，方便随时继续研读。
                </p>
                {onBack && (
                  <button
                    type="button"
                    onClick={onBack}
                    className="wb-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity cursor-pointer"
                  >
                    <span>去主页探索文章</span>
                    <ChevronRight className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
            ) : (
              <div className="space-y-2.5">
                {historyList.map((item) => (
                  <div
                    key={item.id}
                    onClick={() => onSelectPost?.(item.id)}
                    className="wb-pressable cursor-pointer p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle hover:border-wb-border-strong hover:shadow-card transition-all flex items-center justify-between gap-4 group"
                  >
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2 flex-wrap">
                        {item.category_name && (
                          <span className="px-2 py-0.5 rounded-md bg-wb-bg-subtle text-2xs font-medium text-wb-text-secondary border border-wb-border-subtle">
                            {item.category_name}
                          </span>
                        )}
                        <span className="text-2xs font-mono text-wb-text-muted flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {formatVisitedTime(item.visited_at)}
                        </span>
                        {item.reading_time_minutes && (
                          <span className="text-2xs font-mono text-wb-text-muted hidden sm:inline">
                            · 约 {item.reading_time_minutes} 分钟
                          </span>
                        )}
                      </div>

                      <h4 className="text-sm font-semibold text-wb-text-primary group-hover:text-wb-info transition-colors line-clamp-1">
                        {getSmartDailyTitle(item.title)}
                      </h4>

                      <div className="text-xs text-wb-text-muted flex items-center gap-1.5">
                        <span>作者: @{item.author_nickname || item.author_username}</span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 flex-shrink-0">
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const updated = removeReadingHistoryItem(item.id);
                          setHistoryList(updated);
                        }}
                        title="移除此条记录"
                        className="p-2 rounded-xl text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors opacity-0 group-hover:opacity-100 sm:opacity-100"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                      <ChevronRight className="w-4 h-4 text-wb-text-muted group-hover:text-wb-text-primary group-hover:translate-x-0.5 transition-all" />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </motion.div>
        )}

        {/* 2. 修改个人资料 */}
        {activeSubTab === 'edit_profile' && (
          <motion.div
            key="edit_profile"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="p-5 md:p-7 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-6"
          >
            <GiteeBindCard key={user?.id} bound={user?.gitee_bound} />
            <SeriesPanel key={user?.id} onSelectPost={(id) => onSelectPost?.(id)} viewer={user} myOnly title="我的专栏" />
            <div className="flex items-center gap-2">
              <User className="w-4 h-4 text-wb-text-primary" />
              <h3 className="font-semibold text-sm text-wb-text-primary">
                编辑个人档案与个性签名
              </h3>
            </div>

            {profileMsg && (
              <div
                className={`p-3 rounded-2xl text-xs flex items-center gap-2 ${
                  profileMsg.type === 'success'
                    ? 'bg-wb-bg-subtle border border-wb-border-strong text-wb-text-primary'
                    : 'bg-wb-danger/10 border border-wb-danger/20 text-wb-danger'
                }`}
              >
                <Check className="w-3.5 h-3.5" />
                <span>{profileMsg.text}</span>
              </div>
            )}

            <form onSubmit={handleSaveProfile} className="space-y-4">
              {/* 用户名称 (通行证全局唯一，注册后不可更改) */}
              <div>

                <label className="block text-xs font-medium text-wb-text-secondary mb-1">
                  用户名称 (通行证全局唯一标识 · 不可修改)
                </label>
                <div className="relative">
                  <input
                    type="text"
                    disabled
                    value={`@${user.username}`}
                    className="w-full h-10 px-3.5 text-xs bg-wb-bg-subtle/50 border border-wb-border-subtle rounded-2xl text-wb-text-muted cursor-not-allowed font-mono select-none"
                  />
                  <span className="absolute right-3 top-2.5 px-2 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle font-mono text-3xs text-wb-text-muted">
                    固定通行证
                  </span>
                </div>
                <span className="text-2xs text-wb-text-muted mt-1 block">
                  用户名作为社区底层唯一通行证标识，用于登录验证与唯一识别，注册后不可更改
                </span>
              </div>

              {/* 用户昵称 (可修改，每个月限修改 3 次) */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-wb-text-secondary">
                    用户昵称 (对外公开展示名称)
                  </label>
                  <span className="text-2xs font-mono font-medium text-wb-text-primary px-2 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle">
                    本月剩余修改次数: {user.remaining_nickname_changes ?? 3} / 3 次
                  </span>
                </div>
                <input
                  type="text"
                  value={nickname}
                  onChange={(e) => setNickname(e.target.value)}
                  placeholder="设置对外展示的昵称 (如: 极客老张)"
                  maxLength={32}
                  className="w-full h-10 px-3.5 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                />
                <span className="text-2xs text-wb-text-muted mt-1 block">
                  对外公开展示的友好称谓，发帖与评论均优先显示此名称。每个自然月限修改 3 次，下月 1 号自动刷新
                </span>
              </div>


              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-wb-text-secondary">绑定邮箱</label>
                  <span
                    className={`text-2xs font-medium px-2 py-0.5 rounded-capsule border ${
                      user.email_verified
                        ? 'text-wb-success dark:text-wb-success bg-wb-success/10 border-wb-success/20'
                        : 'text-wb-warn dark:text-wb-warn bg-wb-warn/10 border-wb-warn/20'
                    }`}
                  >
                    {user.email_verified ? '已验证' : '未验证'}
                  </span>
                </div>
                <input
                  type="email"
                  disabled
                  value={user.email}
                  className="w-full h-10 px-3.5 text-xs bg-wb-bg-subtle/50 border border-wb-border-subtle rounded-2xl text-wb-text-muted cursor-not-allowed font-mono"
                />
                <div className="flex items-center justify-between gap-2 mt-1">
                  <span className="text-2xs text-wb-text-muted">
                    用于找回密码与安全通知，更换需验证新邮箱
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      setEmailEditing((v) => !v);
                      setEmailMsg(null);
                    }}
                    className="text-2xs font-semibold text-wb-text-primary hover:underline shrink-0"
                  >
                    {emailEditing ? '取消' : '更换邮箱'}
                  </button>
                </div>

                {emailEditing && (
                  <div className="mt-2 space-y-2 p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle">
                    <input
                      type="email"
                      value={newEmail}
                      onChange={(e) => setNewEmail(e.target.value)}
                      placeholder="新邮箱地址"
                      className="w-full h-9 px-3 text-xs bg-wb-bg-surface border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
                    />
                    <div className="flex gap-2">
                      <input
                        type="text"
                        inputMode="numeric"
                        autoComplete="one-time-code"
                        maxLength={8}
                        value={emailCode}
                        onChange={(e) => setEmailCode(e.target.value.replace(/\s/g, ''))}
                        placeholder="6 位验证码"
                        className="flex-1 min-w-0 h-9 px-3 text-xs bg-wb-bg-surface border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary tracking-[0.2em]"
                      />
                      <button
                        type="button"
                        onClick={handleSendBindCode}
                        disabled={emailCodeSending || emailCooldown > 0}
                        className="shrink-0 px-3 h-9 rounded-xl text-2xs font-semibold bg-wb-text-primary text-wb-bg-page disabled:opacity-40"
                      >
                        {emailCodeSending ? '发送中...' : emailCooldown > 0 ? `${emailCooldown}s 后重发` : '发送验证码'}
                      </button>
                    </div>
                    {emailMsg && (
                      <p
                        className={`text-2xs ${
                          emailMsg.type === 'error' ? 'text-wb-danger' : 'text-wb-success dark:text-wb-success'
                        }`}
                      >
                        {emailMsg.text}
                      </p>
                    )}
                    <button
                      type="button"
                      onClick={handleBindEmail}
                      disabled={emailSubmitting}
                      className="w-full h-9 rounded-xl text-xs font-semibold bg-wb-text-primary text-wb-bg-page disabled:opacity-40"
                    >
                      {emailSubmitting ? '提交中...' : '确认更换邮箱'}
                    </button>
                  </div>
                )}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-wb-text-secondary">
                    个性简介 / 签名
                  </label>
                  <span className="text-2xs text-wb-text-muted font-mono">
                    {bio.length} / 200 字
                  </span>
                </div>
                <textarea
                  rows={3}
                  maxLength={200}
                  value={bio}
                  onChange={(e) => setBio(e.target.value)}
                  placeholder="介绍一下你关注的技术领域、极客折腾经历或社区态度..."
                  className="w-full p-3 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary resize-none transition-colors"
                />
              </div>

              {/* 性别选择 */}
              <div>
                <label className="block text-xs font-medium text-wb-text-secondary mb-1.5">
                  性别
                </label>
                <div className="grid grid-cols-3 gap-2.5 max-w-sm">
                  {[
                    { value: 'male', label: '男', symbol: '♂', symbolClass: 'text-wb-info font-bold' },
                    { value: 'female', label: '女', symbol: '♀', symbolClass: 'text-wb-danger font-bold' },
                    { value: 'secret', label: '保密', symbol: '', symbolClass: '' },
                  ].map((g) => (
                    <button
                      key={g.value}
                      type="button"
                      onClick={() => setGender(g.value as any)}
                      className={`wb-pressable flex items-center justify-center gap-1.5 py-2 px-3 rounded-2xl text-xs font-medium border transition-all ${
                        gender === g.value
                          ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary shadow-xs'
                          : 'bg-wb-bg-subtle/80 text-wb-text-secondary border-wb-border-subtle hover:border-wb-border-strong hover:text-wb-text-primary'
                      }`}
                    >
                      {g.symbol && (
                        <span className={`text-sm leading-none ${gender === g.value ? 'text-inherit' : g.symbolClass}`}>
                          {g.symbol}
                        </span>
                      )}
                      <span>{g.label}</span>
                    </button>
                  ))}
                </div>
              </div>

              {/* 技术栈标签 */}
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="block text-xs font-medium text-wb-text-secondary">
                    技术栈 (用逗号分隔，如 Python, React, Docker)
                  </label>
                  <span className="text-2xs text-wb-text-muted">
                    展示在个人名片上
                  </span>
                </div>
                <input
                  type="text"
                  value={techStack}
                  onChange={(e) => setTechStack(e.target.value)}
                  placeholder="如: Rust, Go, TypeScript, PyTorch, Linux"
                  maxLength={100}
                  className="w-full h-10 px-3.5 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors font-mono"
                />
                {/* 常用技术快捷添加药丸 */}
                <div className="flex items-center gap-1.5 flex-wrap pt-2">
                  <span className="text-2xs text-wb-text-muted">快捷点选:</span>
                  {['Python', 'TypeScript', 'React', 'Vue', 'Go', 'Rust', 'Docker', 'K8s', 'Linux', 'Node.js', 'PyTorch'].map((tag) => {
                    const currentTags = techStack.split(/[,，]/).map((t) => t.trim()).filter(Boolean);
                    const isSelected = currentTags.some((t) => t.toLowerCase() === tag.toLowerCase());
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => {
                          if (isSelected) {
                            setTechStack(currentTags.filter((t) => t.toLowerCase() !== tag.toLowerCase()).join(', '));
                          } else {
                            setTechStack([...currentTags, tag].join(', '));
                          }
                        }}
                        className={`wb-pressable text-3xs px-2 py-0.5 rounded-capsule border transition-colors ${
                          isSelected
                            ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary font-bold'
                            : 'bg-wb-bg-subtle/70 text-wb-text-muted border-wb-border-subtle hover:border-wb-border-strong hover:text-wb-text-primary'
                        }`}
                      >
                        {isSelected ? '✓ ' : '+ '}{tag}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 社交与外部链接: GitHub & 独立博客 */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div>
                  <label className="block text-xs font-medium text-wb-text-secondary mb-1">
                    GitHub 账号或主页链接
                  </label>
                  <div className="relative">
                    <GithubIcon className="w-3.5 h-3.5 absolute left-3 top-3 text-wb-text-muted pointer-events-none" />
                    <input
                      type="text"
                      value={githubUrl}
                      onChange={(e) => setGithubUrl(e.target.value)}
                      placeholder="用户名 或 https://github.com/..."
                      maxLength={100}
                      className="w-full h-10 pl-9 pr-3.5 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary font-mono transition-colors"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-medium text-wb-text-secondary mb-1">
                    个人博客 / 独立站点
                  </label>
                  <div className="relative">
                    <Globe className="w-3.5 h-3.5 absolute left-3 top-3 text-wb-text-muted pointer-events-none" />
                    <input
                      type="text"
                      value={blogUrl}
                      onChange={(e) => setBlogUrl(e.target.value)}
                      placeholder="https://yourblog.dev"
                      maxLength={100}
                      className="w-full h-10 pl-9 pr-3.5 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary font-mono transition-colors"
                    />
                  </div>
                </div>
              </div>

              <div className="space-y-3 pt-1">
                <label className="block text-xs font-semibold text-wb-text-primary">
                  个性头像配置
                </label>

                {/* 当前选中头像实时预览与本地图片上传按键 */}
                <div className="flex flex-col sm:flex-row sm:items-center gap-4 p-4 rounded-2xl bg-wb-bg-subtle/70 border border-wb-border-subtle">
                  <div className="flex items-center gap-3">
                    {effectiveAvatar && (effectiveAvatar.startsWith('http') || effectiveAvatar.startsWith('/')) ? (
                      <img loading="lazy" decoding="async"
                        src={effectiveAvatar}
                        alt="Preview"
                        onError={(e) => {
                          // 老头像文件缺失时不要显示破图，退回首字母色块
                          const el = e.currentTarget;
                          el.style.display = 'none';
                          const fallback = el.nextElementSibling as HTMLElement | null;
                          if (fallback) fallback.style.display = 'flex';
                        }}
                        className="w-14 h-14 rounded-capsule object-cover border border-wb-border-strong shadow-md bg-wb-bg-surface"
                      />
                    ) : null}
                    <div
                      className="w-14 h-14 rounded-capsule bg-wb-text-primary text-wb-bg-page items-center justify-center font-mono font-bold text-xl shadow-md select-none"
                      style={{ display: effectiveAvatar && (effectiveAvatar.startsWith('http') || effectiveAvatar.startsWith('/')) ? 'none' : 'flex' }}
                    >
                      {effectiveAvatar && effectiveAvatar.length <= 2 ? effectiveAvatar : user.username.slice(0, 1).toUpperCase()}
                    </div>
                    <div>
                      <div className="text-xs font-semibold text-wb-text-primary">
                        当前生效头像
                      </div>
                      <div className="text-2xs text-wb-text-muted font-mono">
                        {effectiveAvatar.startsWith('http') || effectiveAvatar.startsWith('/')
                          ? uploadedAvatarUrl && !avatarUrl.trim()
                            ? '已上传头像 (直链已隐藏)'
                            : '自定义图片'
                          : effectiveAvatar
                          ? `符号: ${effectiveAvatar}`
                          : '默认矢量字母徽章'}
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 sm:ml-auto">
                    <label className="wb-pressable cursor-pointer inline-flex items-center gap-1.5 px-3.5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 shadow-sm transition-opacity select-none">
                      <Upload className="w-3.5 h-3.5" />
                      <span>{uploadingAvatar ? '上传中...' : '上传本地图片'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        disabled={uploadingAvatar}
                        onChange={handleAvatarFileChange}
                        className="hidden"
                      />
                    </label>
                    {effectiveAvatar && (
                      <button
                        type="button"
                        onClick={handleResetAvatar}
                        disabled={resettingAvatar}
                        className="wb-pressable px-3 py-2 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-50"
                      >
                        {resettingAvatar ? '重置中...' : '重置默认'}
                      </button>
                    )}
                  </div>
                </div>

                <div className="space-y-1.5">
                  <span className="block text-2xs text-wb-text-muted">
                    或选择极简黑白钛金属徽章预设:
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {PRESET_AVATARS.map((av) => (
                      <button
                        key={av.id}
                        type="button"
                        onClick={() => setAvatarUrl(av.symbol)}
                        className={`wb-pressable flex items-center gap-1.5 px-3 py-1.5 rounded-capsule border text-xs transition-colors select-none ${
                          avatarUrl === av.symbol
                            ? 'border-wb-text-primary bg-wb-bg-subtle font-semibold'
                            : 'border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong text-wb-text-secondary'
                        }`}
                      >
                        <span className={`w-4 h-4 rounded-capsule ${av.bg} ${av.text} flex items-center justify-center font-mono text-3xs`}>
                          {av.symbol}
                        </span>
                        <span>{av.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingProfile}
                  className="wb-pressable inline-flex items-center gap-2 h-10 px-5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm transition-opacity"
                >
                  <Save className="w-3.5 h-3.5" />
                  <span>{savingProfile ? '保存中...' : '保存资料'}</span>
                </button>
              </div>
            </form>
          </motion.div>
        )}

        {/* 3. 密码与安全 */}
        {activeSubTab === 'security' && (
          <motion.div
            key="security"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="p-5 md:p-7 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-6"
          >
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-wb-text-primary" />
              <h3 className="font-semibold text-sm text-wb-text-primary">
                修改账户安全密码
              </h3>
            </div>

            {passwordMsg && (
              <div
                className={`p-3 rounded-2xl text-xs flex items-center gap-2 ${
                  passwordMsg.type === 'success'
                    ? 'bg-wb-bg-subtle border border-wb-border-strong text-wb-text-primary'
                    : 'bg-wb-danger/10 border border-wb-danger/20 text-wb-danger'
                }`}
              >
                <Check className="w-3.5 h-3.5" />
                <span>{passwordMsg.text}</span>
              </div>
            )}

            <form onSubmit={handleChangePassword} className="space-y-4 max-w-md">
              <div>
                <label className="block text-xs font-medium text-wb-text-secondary mb-1">
                  当前原密码
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                  <input
                    type="password"
                    required
                    value={oldPassword}
                    onChange={(e) => setOldPassword(e.target.value)}
                    placeholder="请输入当前生效的密码"
                    className="w-full pl-10 pr-4 h-10 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-medium text-wb-text-secondary mb-1">
                  新密码
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                  <input
                    type="password"
                    required
                    minLength={8}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="至少 8 位，需含字母和数字"
                    className="w-full pl-10 pr-4 h-10 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                  />
                </div>
                {/* 规则实时打勾，提交前就知道还差哪一项 */}
                <PasswordHint value={newPassword} username={user?.username || ''} />
              </div>

              <div>
                <label className="block text-xs font-medium text-wb-text-secondary mb-1">
                  确认新密码
                </label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-wb-text-muted" />
                  <input
                    type="password"
                    required
                    minLength={6}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="请再次输入新密码"
                    className="w-full pl-10 pr-4 h-10 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                  />
                </div>
              </div>

              <div className="pt-2">
                <button
                  type="submit"
                  disabled={savingPassword}
                  className="wb-pressable inline-flex items-center gap-2 h-10 px-5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm transition-opacity"
                >
                  <Lock className="w-3.5 h-3.5" />
                  <span>{savingPassword ? '提交中...' : '确认更新密码'}</span>
                </button>
              </div>
            </form>

            {/* 危险区：自助注销（管理员账号后端会拒绝） */}
            <div className="mt-8 pt-5 border-t border-wb-border-subtle max-w-md">
              <h4 className="text-xs font-bold text-wb-text-primary mb-1">危险区</h4>
              <p className="text-2xs text-wb-text-muted leading-relaxed mb-3">
                注销后账号立即对其他人隐藏、内容全部下架、所有设备强制登出；
                <span className="text-wb-text-primary font-medium">10 天内</span>可联系超级管理员恢复，逾期将
                <span className="text-wb-danger font-medium">彻底清除且不可找回</span>。
                {isOAuthAccount && ' 你当前是第三方登录账号（GitHub / Gitee），注销时输入用户名确认即可。'}
              </p>
              <button
                type="button"
                onClick={() => { setDeactivateInput(''); setDeactivateError(''); setDeactivateModalOpen(true); }}
                className="inline-flex items-center gap-2 h-9 px-4 rounded-capsule border border-wb-danger/40 text-wb-danger dark:text-wb-danger text-xs font-semibold hover:bg-wb-danger/10 transition-colors"
              >
                注销我的账号
              </button>
            </div>

            {/* 注销确认弹窗（应用内风格，Portal 挂载到 body 避免父级 transform 使 fixed 失效） */}
            {deactivateModalOpen && createPortal(
              <div
                className="fixed inset-0 z-[99999] flex items-center justify-center p-4 bg-black/70 backdrop-blur-md animate-fade-in"
                onClick={(e) => { if (e.target === e.currentTarget && !deactivating) setDeactivateModalOpen(false); }}
              >
                <div className="relative w-full max-w-sm bg-wb-bg-elevated border border-wb-border-subtle rounded-3xl p-6 shadow-2xl space-y-4">
                  <div className="flex items-start gap-3.5">
                    <div className="p-2.5 rounded-2xl bg-wb-danger/10 text-wb-danger border border-wb-danger/20 flex-shrink-0">
                      <AlertTriangle className="w-5 h-5" />
                    </div>
                    <div className="space-y-1 pr-6">
                      <h3 className="text-base font-semibold text-wb-text-primary tracking-tight">注销账号（不可逆）</h3>
                      <p className="text-xs text-wb-text-secondary leading-relaxed">
                        注销后：账号立即对其他人隐藏，你发布的文章与评论同时下架，所有设备立即登出。
                        10 天内可联系超级管理员恢复全部数据，逾期将彻底清除且无法找回。
                      </p>
                    </div>
                  </div>

                  <div>
                    <label className="block text-xs font-medium text-wb-text-secondary mb-1.5">
                      {isOAuthAccount ? (
                        <>请输入你的用户名 <span className="text-wb-text-primary font-mono font-semibold">{user?.username}</span> 以确认：</>
                      ) : (
                        '请输入你的登录密码以确认：'
                      )}
                    </label>
                    <input
                      type={isOAuthAccount ? 'text' : 'password'}
                      autoFocus
                      value={deactivateInput}
                      onChange={(e) => { setDeactivateInput(e.target.value); setDeactivateError(''); }}
                      onKeyDown={(e) => { if (e.key === 'Enter' && !deactivating) handleDeactivateAccount(); }}
                      placeholder={isOAuthAccount ? user?.username : '登录密码'}
                      className="w-full px-4 h-10 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary transition-colors"
                    />
                    {deactivateError && (
                      <p className="text-2xs text-wb-danger mt-1.5">{deactivateError}</p>
                    )}
                  </div>

                  <div className="flex items-center justify-end gap-2.5 pt-1">
                    <button
                      type="button"
                      onClick={() => setDeactivateModalOpen(false)}
                      disabled={deactivating}
                      className="wb-pressable px-4 py-2 text-xs font-medium rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-colors disabled:opacity-50"
                    >
                      取消
                    </button>
                    <button
                      type="button"
                      onClick={handleDeactivateAccount}
                      disabled={deactivating || !deactivateInput.trim()}
                      className="wb-pressable px-4 py-2 text-xs font-semibold rounded-capsule bg-wb-danger hover:bg-wb-danger text-white transition-all shadow-sm disabled:opacity-50"
                    >
                      {deactivating ? '注销中...' : '确认注销'}
                    </button>
                  </div>
                </div>
              </div>,
              document.body
            )}
          </motion.div>
        )}

        {/* 4. 我的发布与草稿箱 */}
        {activeSubTab === 'my_posts' && (
          <motion.div
            key="my_posts"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-3.5"
          >
            {/* 我的发布 / 草稿箱 二级分类切换 */}
            <div className="flex items-center justify-between pb-1 flex-wrap gap-2">
              <SegmentedControl
                id="profile-posts-filter"
                activeKey={postsFilter}
                onChange={(k) => setPostsFilter(k as 'published' | 'draft')}
                items={[
                  {
                    key: 'published',
                    label: `已发布 (${myPosts.length})`,
                  },
                  {
                    key: 'draft',
                    label: (
                      <>
                        <Archive className="w-3.5 h-3.5" />
                        <span>草稿箱</span>
                        {myDrafts.length > 0 && (
                          <span className="px-1.5 py-0.2 rounded-full text-3xs bg-wb-warn/15 text-wb-warn dark:text-wb-warn font-bold">
                            {myDrafts.length}
                          </span>
                        )}
                      </>
                    ),
                  },
                ]}
              />

              {onGoWrite && (
                <button
                  type="button"
                  onClick={onGoWrite}
                  className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 transition-opacity"
                >
                  <PenTool className="w-3 h-3" />
                  <span>写新帖</span>
                </button>
              )}
            </div>

            <AnimatePresence mode="wait">
              {postsFilter === 'published' ? (
                <motion.div
                  key="published-tab"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.16 }}
                  className="space-y-3.5"
                >
                  {/* 已发布列表 */}
                  {loadingPosts ? (
                    <div className="p-8 text-center text-xs text-wb-text-muted">
                      正在加载发表文章...
                    </div>
                  ) : myPosts.length > 0 ? (
                    myPosts.map((p) => (
                      <article
                        key={p.id}
                        onClick={() => onSelectPost && onSelectPost(p.id)}
                        className="wb-pressable cursor-pointer p-4 md:p-5 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-card hover:border-wb-border-strong transition-all flex items-center justify-between gap-4 group"
                      >
                        <div className="space-y-1.5 flex-1 min-w-0">
                          <div className="flex items-center gap-2 text-2xs text-wb-text-muted flex-wrap">
                            <span>{new Date(p.created_at).toLocaleDateString()}</span>
                            {p.category_name && <span>· {p.category_name}</span>}
                            {p.is_pinned && (
                              <span className="px-2 py-0.5 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold text-3xs">
                                置顶
                              </span>
                            )}
                          </div>
                          <h4 className="font-semibold text-sm text-wb-text-primary group-hover:text-wb-info transition-colors line-clamp-1">
                            {p.title}
                          </h4>
                          <div className="flex items-center gap-4 text-xs text-wb-text-secondary font-mono">
                            <span className="flex items-center gap-1">
                              <Eye className="w-3.5 h-3.5" /> {p.view_count}
                            </span>
                            <span className="flex items-center gap-1">
                              <Heart className="w-3.5 h-3.5" /> {p.like_count}
                            </span>
                            <span className="flex items-center gap-1">
                              <MessageSquare className="w-3.5 h-3.5" /> {p.comment_count}
                            </span>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => handleWithdrawMyPost(e, p.id)}
                            title="下架文章并转存入草稿箱，可随时编辑重新上架"
                            className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-warn hover:border-wb-warn/30 transition-colors"
                          >
                            <Archive className="w-3 h-3" />
                            <span className="hidden sm:inline">下架存草稿</span>
                          </button>
                          <ChevronRight className="w-4 h-4 text-wb-text-muted group-hover:translate-x-0.5 transition-transform" />
                        </div>
                      </article>
                    ))
                  ) : (
                    <div className="p-10 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3">
                      <FileText className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
                      <p className="text-xs text-wb-text-secondary">你尚未在社区发布过任何讨论或文章</p>
                      {onGoWrite && (
                        <button
                          type="button"
                          onClick={onGoWrite}
                          className="wb-pressable inline-flex items-center gap-1.5 h-8 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold"
                        >
                          <PenTool className="w-3.5 h-3.5" />
                          <span>立即写第一篇帖</span>
                        </button>
                      )}
                    </div>
                  )}
                </motion.div>
              ) : (
                <motion.div
                  key="draft-tab"
                  initial={{ opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.16 }}
                  className="space-y-3.5"
                >
                  {/* 草稿箱列表 */}
                  {loadingDrafts ? (
                    <div className="p-8 text-center text-xs text-wb-text-muted">
                      正在加载草稿箱...
                    </div>
                  ) : myDrafts.length > 0 ? (
                    myDrafts.map((d) => (
                      <div
                        key={d.id}
                        className="p-4 md:p-5 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-card hover:border-wb-border-strong transition-all space-y-3"
                      >
                        <div className="flex items-center justify-between gap-2 flex-wrap">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="px-2 py-0.5 rounded-md bg-wb-warn/10 text-wb-warn dark:text-wb-warn text-2xs font-semibold border border-wb-warn/20">
                              {d.char_count > 0 ? '已下架转存草稿' : '草稿'}
                            </span>
                            {d.category_name && (
                              <span className="px-2 py-0.5 rounded-md bg-wb-bg-subtle text-2xs text-wb-text-secondary border border-wb-border-subtle">
                                {d.category_name}
                              </span>
                            )}
                            <span className="text-2xs text-wb-text-muted font-mono">
                              更新于 {new Date(d.updated_at || d.created_at).toLocaleDateString()} · {d.char_count || 0} 字符
                            </span>
                          </div>
                        </div>

                        <div>
                          <h4 className="font-semibold text-sm text-wb-text-primary line-clamp-1">
                            {d.title || '（未命名草稿）'}
                          </h4>
                          {d.content_md && (
                            <p className="text-xs text-wb-text-muted line-clamp-2 mt-1 leading-relaxed">
                              {d.content_md.slice(0, 150)}
                            </p>
                          )}
                        </div>

                        <div className="flex items-center justify-end gap-2 pt-2 border-t border-wb-border-subtle flex-wrap">
                          <button
                            type="button"
                            onClick={() => onEditDraft ? onEditDraft(d.id) : onGoWrite?.()}
                            className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle text-xs text-wb-text-primary hover:bg-wb-accent-subtle hover:text-wb-accent border border-wb-border-subtle transition-colors"
                          >
                            <Edit3 className="w-3.5 h-3.5" />
                            <span>编辑修改</span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => handleRepublishDraft(e, d.id)}
                            className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 transition-opacity"
                          >
                            <Upload className="w-3.5 h-3.5" />
                            <span>重新上架</span>
                          </button>

                          <button
                            type="button"
                            onClick={(e) => handleDeleteDraft(e, d.id)}
                            className="wb-pressable inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-capsule bg-wb-bg-subtle text-xs text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 border border-wb-border-subtle transition-colors"
                            title="彻底永久删除此草稿"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                            <span>彻底删除</span>
                          </button>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="p-10 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3">
                      <Archive className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
                      <p className="text-xs text-wb-text-secondary">草稿箱空空如也</p>
                      <p className="text-2xs text-wb-text-muted max-w-sm mx-auto">
                        您下架的文章或暂存的灵感草稿都会保存在这里，可随时进行编辑修改并重新上架发布。
                      </p>
                      {onGoWrite && (
                        <button
                          type="button"
                          onClick={onGoWrite}
                          className="wb-pressable inline-flex items-center gap-1.5 h-8 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold"
                        >
                          <PenTool className="w-3.5 h-3.5" />
                          <span>新建写作</span>
                        </button>
                      )}
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}

        <CollectionFolderManager open={folderManagerOpen} onClose={() => setFolderManagerOpen(false)} />

        {/* 5. 我的收藏 */}
        {activeSubTab === 'my_favorites' && (
          <motion.div
            key="my_favorites"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-3.5"
          >
            {myFavorites.length > 0 && (
              <div className="flex items-center gap-2">
                <div className="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-1 flex-1" role="tablist" aria-label="收藏夹分组">
                {['全部', ...favGroups].map((g) => (
                  <button
                    key={g}
                    type="button"
                    role="tab"
                    aria-selected={favGroup === g}
                    onClick={() => setFavGroup(g)}
                    className={`px-2.5 py-1.5 min-h-[36px] rounded-capsule border text-2xs font-medium whitespace-nowrap transition-colors ${
                      favGroup === g
                        ? 'bg-wb-text-primary text-wb-bg-page border-transparent'
                        : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
                    }`}
                  >
                    {g}
                  </button>
                ))}
                </div>
                <button
                  type="button"
                  onClick={() => setFolderManagerOpen(true)}
                  className="shrink-0 px-2.5 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary"
                >
                  管理
                </button>
              </div>
            )}

            {loadingFavorites ? (
              <div className="p-8 text-center text-xs text-wb-text-muted">
                正在加载收藏列表...
              </div>
            ) : shownFavorites.length > 0 ? (
              shownFavorites.map((p) => (
                <article
                  key={p.id}
                  onClick={() => onSelectPost && onSelectPost(p.id)}
                  className="wb-pressable cursor-pointer p-4 md:p-5 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-card hover:border-wb-border-strong transition-all flex items-center justify-between gap-4 group"
                >
                  <div className="space-y-1.5 flex-1">
                    <div className="flex items-center gap-2 text-2xs text-wb-text-muted">
                      <span className="font-semibold text-wb-text-primary">
                        {p.author_username}
                      </span>
                      <span>·</span>
                      <span>{new Date(p.created_at).toLocaleDateString()}</span>
                      {p.category_name && <span>· {p.category_name}</span>}
                      <span className="px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-primary font-semibold text-3xs">
                        已收藏
                      </span>
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setEditingGroup(p.id); setGroupInput((p as any).group_name || '默认收藏'); }}
                        aria-label="设置收藏分组"
                        className="px-2 py-0.5 rounded-capsule bg-wb-info/10 border border-wb-info/20 text-wb-info font-semibold text-3xs hover:bg-wb-info/20"
                      >
                        {(p as any).group_name || '默认收藏'}
                      </button>
                    </div>
                    <h4 className="font-semibold text-sm text-wb-text-primary group-hover:underline line-clamp-1">
                      {p.title}
                    </h4>
                    {editingGroup === p.id && (
                      <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                        <input
                          value={groupInput}
                          onChange={(e) => setGroupInput(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter') void saveGroup(p.id); }}
                          aria-label="分组名称"
                          placeholder="分组名称"
                          className="min-w-0 flex-1 px-2 py-1.5 rounded-lg bg-wb-bg-surface border border-wb-border-subtle text-2xs outline-none"
                        />
                        <button type="button" onClick={() => void saveGroup(p.id)} className="px-2 py-1.5 rounded-lg bg-wb-text-primary text-wb-bg-page text-2xs font-semibold">保存</button>
                        <button type="button" onClick={() => setEditingGroup(null)} className="px-2 py-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-2xs">取消</button>
                      </div>
                    )}
                    <div className="flex items-center gap-4 text-xs text-wb-text-secondary font-mono">
                      <span className="flex items-center gap-1">
                        <Eye className="w-3.5 h-3.5" /> {p.view_count}
                      </span>
                      <span className="flex items-center gap-1">
                        <Heart className="w-3.5 h-3.5" /> {p.like_count}
                      </span>
                      <span className="flex items-center gap-1">
                        <MessageSquare className="w-3.5 h-3.5" /> {p.comment_count}
                      </span>
                    </div>
                  </div>
                  <ChevronRight className="w-4 h-4 text-wb-text-muted transition-transform group-hover:translate-x-0.5" />
                </article>
              ))
            ) : (
              <div className="p-10 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3">
                <Bookmark className="w-8 h-8 text-wb-text-muted mx-auto stroke-1" />
                <p className="text-xs text-wb-text-secondary">你尚未收藏任何讨论或文章</p>
                <p className="text-2xs text-wb-text-muted">
                  在发现列表或文章详情页点击收藏按钮，即可在此快速查阅
                </p>
              </div>
            )}
          </motion.div>
        )}

        {/* 6. 隐私与黑名单设置 */}
        {activeSubTab === 'my_reports' && (
          <motion.div
            key="my_reports"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
          >
            <MyReports />
          </motion.div>
        )}

        {activeSubTab === 'privacy' && (
          <motion.div
            key="privacy"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.18 }}
            className="space-y-6"
          >
            {/* 社区浏览偏好卡片 (仿照 linux.sb/profile) */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-wb-border-subtle">
                <SlidersHorizontal className="w-4 h-4 text-wb-text-primary" />
                <h3 className="font-semibold text-sm text-wb-text-primary">
                  社区浏览偏好设置
                </h3>
              </div>

              {/* 默认门户界面：账号级持久化，换设备 / 重新登录仍生效 */}
              <div className="py-2 flex items-center justify-between gap-4">
                <div className="space-y-0.5 min-w-0">
                  <span className="text-xs font-semibold text-wb-text-primary block">默认界面</span>
                  <p className="text-2xs text-wb-text-muted leading-relaxed">
                    经典版（悬浮胶囊）或专业版（三栏工作台）。选择保存在你的账号中，换设备也会跟随；
                    顶栏的切换按钮同样会更新这里。
                  </p>
                </div>
                <div className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle shrink-0">
                  {([['经典版', 'classic'], ['专业版', 'pro']] as const).map(([label, mode]) => (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => {
                        if (portalMode === mode) return;
                        changePortalMode(mode);
                        toast.success(mode === 'pro' ? '已设为专业版门户' : '已设为经典版');
                      }}
                      className={`px-2.5 py-1 rounded-capsule text-2xs font-semibold transition-colors ${
                        portalMode === mode ? 'bg-wb-text-primary text-wb-bg-page' : 'text-wb-text-secondary hover:text-wb-text-primary'}`}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <div className="h-px bg-wb-border-subtle" />

              <div className="py-2 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="text-xs font-semibold text-wb-text-primary block">
                    首页无限滚动 (Infinite Scroll)
                  </span>
                  <p className="text-2xs text-wb-text-muted leading-relaxed">
                    开启后首页隐藏分页并向下滚动自动加载更多；关闭后恢复普通传统分页器导航。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => handleToggleInfiniteScroll(!infiniteScroll)}
                  className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    infiniteScroll ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                  }`}
                >
                  <span
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                      infiniteScroll ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>

              <div className="h-px bg-wb-border-subtle" />

              {/* 自定义系统字体 */}
              <div className="py-2 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="text-xs font-semibold text-wb-text-primary block">
                    自定义本地系统字体 (Custom Font)
                  </span>
                  <p className="text-2xs text-wb-text-muted leading-relaxed">
                    调用您电脑中已安装的字体（如微软雅黑、霞鹜文楷、Fira Code、苹方等），即时渲染全站页面。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsFontModalOpen(true)}
                  className="wb-pressable px-3.5 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-primary hover:border-wb-border-strong text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0"
                >
                  <Type className="w-3.5 h-3.5 text-wb-brand" />
                  <span>字体设置</span>
                </button>
              </div>

              <div className="h-px bg-wb-border-subtle" />

              {/* 全站配色主题 */}
              <div className="py-2 flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <span className="text-xs font-semibold text-wb-text-primary block">
                    外观与个性化 (Appearance)
                  </span>
                  <p className="text-2xs text-wb-text-muted leading-relaxed">
                    当前配色「{paletteName}」。配色方案、强调色、界面字号、密度、动效强度、背景质感与代码块主题均可调整，设置仅保存在本设备。
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsPaletteModalOpen(true)}
                  className="wb-pressable px-3.5 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-primary hover:border-wb-border-strong text-xs font-semibold transition-colors flex items-center gap-1.5 shrink-0"
                >
                  <Palette className="w-3.5 h-3.5 text-wb-brand" />
                  <span>外观设置</span>
                </button>
              </div>
            </div>

            {/* 社交隐私开关组 */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
              <div className="flex items-center gap-2 pb-2 border-b border-wb-border-subtle">
                <Shield className="w-4 h-4 text-wb-text-primary" />
                <h3 className="font-semibold text-sm text-wb-text-primary">
                  社交公开度与隐私可见性
                </h3>
              </div>

              <div className="divide-y divide-wb-border-subtle">
                {/* 隐藏在线状态 */}
                <div className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-wb-text-primary block">
                      隐藏我的在线状态 (Hide Online Status)
                    </span>
                    <p className="text-2xs text-wb-text-muted">
                      开启后，头像旁的在线绿点不再对其他人显示（对方看到的是离线，不会知道您设置了隐藏）
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={savingPrivacy}
                    onClick={() => handleUpdatePrivacySetting('hide_online_status', !hideOnlineStatus)}
                    className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      hideOnlineStatus ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                        hideOnlineStatus ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* 隐藏 IP 属地 */}
                <div className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-wb-text-primary block">
                      隐藏我的 IP 属地 (Hide Location)
                    </span>
                    <p className="text-2xs text-wb-text-muted">
                      开启后，您的个人主页不再对外展示所在地区，仅您本人可见
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={savingPrivacy}
                    onClick={() => handleUpdatePrivacySetting('hide_ip_location', !hideIpLocation)}
                    className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      hideIpLocation ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                        hideIpLocation ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* 隐藏关注列表 */}
                <div className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-wb-text-primary block">
                      隐藏我的关注名单 (Hide Following)
                    </span>
                    <p className="text-2xs text-wb-text-muted">
                      开启后，除您本人和超级管理员外，其他极客访问您主页时将无法查看您的关注用户名单
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={savingPrivacy}
                    onClick={() => handleUpdatePrivacySetting('hide_following', !hideFollowing)}
                    className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      hideFollowing ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                        hideFollowing ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* 隐藏粉丝列表 */}
                <div className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-wb-text-primary block">
                      隐藏我的粉丝名单 (Hide Followers)
                    </span>
                    <p className="text-2xs text-wb-text-muted">
                      开启后，他人无法查阅有哪些极客正在关注您，保护您的社交圈不被刺探
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={savingPrivacy}
                    onClick={() => handleUpdatePrivacySetting('hide_followers', !hideFollowers)}
                    className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      hideFollowers ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                        hideFollowers ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>

                {/* 隐藏我的收藏 */}
                <div className="py-3 flex items-center justify-between gap-4">
                  <div className="space-y-0.5">
                    <span className="text-xs font-semibold text-wb-text-primary block">
                      隐藏我的文章收藏夹 (Hide Favorites)
                    </span>
                    <p className="text-2xs text-wb-text-muted">
                      开启后，您的收藏夹内容将仅对自己可见，主页对外隐藏收藏 Tab
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={savingPrivacy}
                    onClick={() => handleUpdatePrivacySetting('hide_favorites', !hideFavorites)}
                    className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                      hideFavorites ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                    }`}
                  >
                    <span
                      className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                        hideFavorites ? 'translate-x-5' : 'translate-x-0'
                      }`}
                    />
                  </button>
                </div>
              </div>
            </div>

            {/* 统一的「新页面打开文章」偏好：随账号持久化，默认关闭 */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card">
              <div className="flex items-center justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <ExternalLink className="w-4 h-4 text-wb-text-primary shrink-0" />
                    <h3 className="font-semibold text-sm text-wb-text-primary">新页面打开文章</h3>
                  </div>
                  <p className="text-xs text-wb-text-muted">
                    开启后点击列表里的文章会在新标签页打开；关闭则在本页展开。设置会跟随账号同步。
                  </p>
                </div>
                <button
                  type="button"
                  disabled={savingPrivacy}
                  onClick={() => handleUpdatePrivacySetting('open_post_in_new_tab', !openPostInNewTab)}
                  className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${openPostInNewTab ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'}`}
                >
                  <span aria-hidden="true" className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${openPostInNewTab ? 'translate-x-5' : 'translate-x-0'}`} />
                </button>
              </div>
            </div>

            {/* 免打扰开关卡片 */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
              <div className="flex items-center justify-between">
                <div className="space-y-1">
                  <div className="flex items-center gap-2">
                    <BellOff className="w-4 h-4 text-wb-text-primary" />
                    <h3 className="font-semibold text-sm text-wb-text-primary">
                      全站免打扰保护模式 (Do Not Disturb)
                    </h3>
                  </div>
                  <p className="text-xs text-wb-text-muted">
                    开启后，仅接收您已关注极客的私信，陌生人私信将被系统自动静默拦截，且不向您推送提醒
                  </p>
                </div>

                <button
                  type="button"
                  disabled={savingDnd}
                  onClick={handleToggleDnd}
                  className={`wb-pressable relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                    dndEnabled ? 'bg-wb-text-primary' : 'bg-wb-bg-subtle border border-wb-border-subtle'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-wb-bg-page shadow ring-0 transition duration-200 ease-in-out ${
                      dndEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            </div>

            {/* 黑名单管理卡片 */}
            <div className="p-5 md:p-6 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
              <div className="flex items-center justify-between pb-2 border-b border-wb-border-subtle">
                <div className="flex items-center gap-2">
                  <ShieldAlert className="w-4 h-4 text-wb-text-primary" />
                  <h3 className="font-semibold text-sm text-wb-text-primary">
                    已拉黑用户名单 ({blockedUsers.length})
                  </h3>
                </div>
                <span className="text-xs text-wb-text-muted font-mono">
                  共 {blockedUsers.length} 人
                </span>
              </div>

              {loadingBlocks ? (
                <div className="p-8 text-center text-xs text-wb-text-muted">
                  正在加载黑名单列表...
                </div>
              ) : blockedUsers.length > 0 ? (
                <div className="space-y-3">
                  {blockedUsers.map((b) => (
                    <div
                      key={b.id}
                      className="p-4 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle flex items-center justify-between gap-4"
                    >
                      <div className="flex items-center gap-3">
                        <UserAvatar
                          username={b.username}
                          avatarUrl={b.avatar_url}
                          size={40}
                          className="border border-wb-border-subtle flex-shrink-0"
                        />
                        <div>
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-xs text-wb-text-primary">
                              {b.nickname || b.username}
                            </span>
                            <span className="text-2xs text-wb-text-muted font-mono">
                              @{b.username}
                            </span>
                          </div>
                          <span className="text-3xs text-wb-text-muted font-mono">
                            拉黑于 {new Date(b.blocked_at).toLocaleDateString()}
                          </span>
                        </div>
                      </div>

                      <button
                        type="button"
                        onClick={() => handleUnblockUser(b.username)}
                        className="wb-pressable h-8 px-3.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle hover:border-wb-border-strong text-wb-text-primary text-xs font-medium transition-colors"
                      >
                        解除拉黑
                      </button>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="p-8 rounded-2xl bg-wb-bg-subtle/30 border border-dashed border-wb-border-subtle text-center space-y-2">
                  <ShieldOff className="w-7 h-7 text-wb-text-muted mx-auto stroke-1" />
                  <p className="text-xs text-wb-text-secondary">当前黑名单为空</p>
                  <p className="text-2xs text-wb-text-muted">
                    在极客个人主页可对其执行拉黑操作，自动拦截骚扰私信并屏蔽动态
                  </p>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* 关注与粉丝名单弹窗 (本人与查看他人公用) */}
      <FollowListModal
        isOpen={followModalOpen}
        onClose={() => setFollowModalOpen(false)}
        targetUsername={followModalUser}
        currentUser={user}
        initialTab={followModalTab}
        onRequireAuth={onRequireAuth}
        onSelectUser={(uname) => {
          setFollowModalOpen(false);
          if (onSelectUser) onSelectUser(uname);
        }}
      />

      {/* 个性化自定义系统字体弹窗 */}
      <FontSettingsModal
        isOpen={isFontModalOpen}
        onClose={() => setIsFontModalOpen(false)}
      />

      {/* 个性化外观设置弹窗（配色 / 字号 / 密度 / 动效 / 质感 / 代码块） */}
      <AppearanceSettingsModal
        isOpen={isPaletteModalOpen}
        onClose={() => setIsPaletteModalOpen(false)}
      />

      <AvatarPreview
        src={avatarPreview?.src ?? null}
        name={avatarPreview?.name}
        onClose={() => setAvatarPreview(null)}
      />

      <AvatarCropper
        file={cropFile}
        onCancel={() => setCropFile(null)}
        onConfirm={handleAvatarCropped}
      />
    </div>
  );
};

