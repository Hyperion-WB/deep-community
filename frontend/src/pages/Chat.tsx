import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo } from 'react';
import { motion } from 'framer-motion';
import { AvatarPreview } from '../components/AvatarPreview';
import { Send, Search, RotateCcw, MessageSquare, Smile, ImagePlus, Loader2, Maximize2, Minimize2, MoreVertical, Trash2, Ban, User, X, ShieldAlert, ArrowLeft, Pin, BellOff, Bell, Users, Plus, Sparkles, UserPlus, UserMinus, LogOut, Crown, Shield, Globe, Lock, ShieldCheck, Megaphone, Edit3, AtSign, Reply, Check, Clock, FileText, CheckCircle2, Layers, ArrowUp, ArrowDown, History, BellRing, Wrench, Dices, ListOrdered, Feather, CalendarCheck, Timer, Medal, BarChart3, Terminal, PanelLeftClose, PanelLeftOpen, Utensils } from 'lucide-react';
import { apiClient, refreshAccessToken, UPLOAD_TIMEOUT } from '../api/client';
import { GroupBadge, GROUP_BADGE_NAMES } from '../components/GroupBadge';
import { DiceCube } from '../components/minigames/DiceCube';
import { SafeImage } from '../components/SafeImage';
import { GroupActivitiesModal, FortuneOverlay, reportGroupExp, type FortuneResult } from '../components/GroupActivities';
import { LunchWheel } from '../components/LunchWheel';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { useImageDrop, DROP_HINT_CLASS } from '../hooks/useImageDrop';
import type {
  UserProfile,
  ConversationItem,
  ChatMessage,
  GroupRoomItem,
  GroupChatMessage,
  GroupMemberItem,
  GroupQuotaInfo,
  GroupJoinRequestItem,
  GroupAnnouncementItem,
} from '../types';
import { UserAvatar } from '../components/UserAvatar';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmModal';
import { EmojiStickerPanel } from '../components/EmojiStickerPanel';
import { formatChatTime } from '../utils/format';
import { precompressImage, validateUploadFile } from '../utils/imageCompress';
import { ImageLightbox } from '../components/ImageLightbox';
import { MessageActions } from '../components/MessageActions';
import { pushMutedToCloud } from '../utils/muted';
import { createPortal } from 'react-dom';
import { usePortalMode } from '../utils/portalMode';
import { StealthWorkspaceCamouflage, type StealthTheme } from '../components/StealthWorkspaceCamouflage';
import { ProChatControls } from '../components/ProChatControls';

interface Props {
  user: UserProfile | null;
  onRequireAuth: () => void;
  initialPeer?: { id?: string; username: string } | null;
  onClearInitialPeer?: () => void;
  initialGroupId?: string | null;
  onClearInitialGroupId?: () => void;
  /** 桌面通知点击后按会话 id 直接打开私聊 */
  initialConvId?: string | null;
  onClearInitialConvId?: () => void;
  onSelectUser?: (username: string) => void;
  onUnreadChange?: (totalUnread: number) => void;
  /** 聊天页当前是否可见（常驻挂载后，切回来时需要重新贴到最新消息） */
  isActive?: boolean;
}

// 与后端 get_group_messages 默认分页保持一致
const GROUP_PAGE_SIZE = 50;
const CHAT_DRAFTS_KEY = 'wb:chatDrafts:v1';

type GroupHistoryCursor = { token?: string; legacySeq?: number };
type ConversationRequest = { id: string; controller: AbortController };

function mergeMessages<T extends { id: string; created_at: string; seq_id?: number | null; is_recalled?: boolean }>(
  current: T[], incoming: T[], optimisticId?: string,
): T[] {
  const byId = new Map(current.filter((message) => message.id !== optimisticId).map((message) => [message.id, message]));
  for (const message of incoming) {
    const existing = byId.get(message.id);
    if (!existing?.is_recalled || message.is_recalled) byId.set(message.id, { ...existing, ...message });
  }
  return [...byId.values()].sort((left, right) => {
    const timestamp = Date.parse(left.created_at) - Date.parse(right.created_at);
    const subMilliseconds = (value: string) => (value.match(/\.(\d+)/)?.[1] ?? '').padEnd(6, '0').slice(3, 6);
    return timestamp || subMilliseconds(left.created_at).localeCompare(subMilliseconds(right.created_at))
      || (left.seq_id ?? -1) - (right.seq_id ?? -1) || left.id.localeCompare(right.id);
  });
}
// 模块级常量：避免每条消息渲染时重复构造正则
const IMG_IN_TEXT_RE_G = /(?:https?:\/\/[^\s/]+)?\/uploads\/[\w/.\-]+\.(?:webp|gif|png|jpe?g)(?:\?\S*)?/gi;

// 整条消息内容就是一张本站图片 → 渲染成表情图片
const STICKER_URL_RE = /^\/uploads\/[\w/.-]+\.(webp|gif|png|jpe?g)$/i;

// 会话列表预览：把图片/表情地址折叠成占位词。
// 直接展示 /uploads/stickers/xxx.webp 既难看，也把存储路径暴露给了所有会话列表观察者。
const ABS_UPLOAD_RE = /\/uploads\/[\w/.\-]+\.(webp|gif|png|jpe?g)(\?\S*)?$/i;

/** 结构化群消息（骰子 / 机器人接龙等）在会话列表里不能露出原始 JSON。
 *  preview 可能带 "昵称: " 前缀，也可能被后端截断，因此要容忍两种形态。 */
const previewStructured = (raw: string): string | null => {
  const at = raw.indexOf('{');
  if (at < 0) return null;
  const prefix = raw.slice(0, at).trim();
  const tail = raw.slice(at).trim();
  let obj: any = null;
  try { obj = JSON.parse(tail); } catch {
    // 后端可能截断到 50 字：用正则兜底提取「谁接了什么」/ 点数 / 文本
    const head0 = prefix ? prefix + ' ' : '';
    const um = tail.match(/"user"\s*:\s*"([^"]{1,20})"/);
    const wm = tail.match(/"user_word"\s*:\s*"([^"]{1,10})"/);
    if (um && wm) return `${head0}🀄 ${um[1]} 接「${wm[1]}」`;
    const pm = tail.match(/"points"\s*:\s*(\d+)/);
    if (pm) return `${head0}🎲 ${pm[1]}`;
    const tm = tail.match(/"text"\s*:\s*"([^"]{1,40})/);
    if (tm) return `${head0}${tm[1]}`;
    return '[群互动消息]';
  }
  if (!obj || typeof obj !== 'object') return null;
  const head = prefix ? prefix + ' ' : '';
  // 接龙播报优先给「谁 + 接了什么词」，比截断的幽默文案更清楚
  if (obj.user && obj.user_word) {
    const mark = obj.kind === 'wrong' ? '✕' : '✓';
    return `${head}${mark} ${obj.user} 接「${obj.user_word}」`;
  }
  if (typeof obj.points === 'number') return `${head}🎲 ${obj.points}`;
  if (obj.text) return `${head}${String(obj.text).slice(0, 30)}`;
  if (obj.word) return `${head}🀄 ${obj.word}`;
  return null;
};

const formatPreview = (text?: string | null): string => {
  const raw = (text || '').trim();
  if (!raw) return '';
  const structured = previewStructured(raw);
  if (structured) return structured;
  const label = (part: string) =>
    /\/uploads\/stickers\//i.test(part) ? '[表情]' : '[图片]';
  // 整条就是一张图/一个表情 → 直接显示占位词
  if (STICKER_URL_RE.test(raw) || ABS_UPLOAD_RE.test(raw)) return label(raw);
  // 历史数据里可能被截断成半截 /uploads/... 路径：只要包含存储路径就折叠，
  // 绝不把文件路径显示到会话列表上
  return raw
    .split(/\s+/)
    .map((part) =>
      part.includes('/uploads/') || STICKER_URL_RE.test(part) || ABS_UPLOAD_RE.test(part)
        ? label(part)
        : part
    )
    .join(' ')
    .slice(0, 50);
};

// 输入框随内容自动增高（最多 5 行 ≈ 120px），超出后内部滚动
const COMPOSER_MAX_HEIGHT = 120;
const autoGrowTextarea = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, COMPOSER_MAX_HEIGHT)}px`;
};

export const Chat: React.FC<Props> = ({
  user,
  onRequireAuth,
  initialPeer,
  onClearInitialPeer,
  initialGroupId,
  onClearInitialGroupId,
  initialConvId,
  onClearInitialConvId,
  onSelectUser,
  onUnreadChange,
  isActive = true,
}) => {
  const toast = useToast();
  const confirmModal = useConfirm();

  // 区分「私聊」与「群聊」
  const [chatTab, setChatTab] = useState<'direct' | 'group'>(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem('geek_chat_active_tab');
      if (saved === 'direct' || saved === 'group') return saved;
    }
    return 'direct';
  });

  // ---------- 私聊状态 ----------
  const [conversations, setConversations] = useState<ConversationItem[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      return localStorage.getItem('geek_chat_active_conv_id');
    }
    return null;
  });
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isTyping, setIsTyping] = useState(false);

  // 本地置顶会话列表
  // 群聊置顶与免打扰：和私聊一样只在本地保存（个人偏好，不必上云）
  const [pinnedGroupIds, setPinnedGroupIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('geek_chat_pinned_groups') || '[]');
    } catch {
      return [];
    }
  });
  const [mutedGroupIds, setMutedGroupIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('geek_chat_muted_groups') || '[]');
    } catch {
      return [];
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem('geek_chat_pinned_groups', JSON.stringify(pinnedGroupIds));
    } catch {}
  }, [pinnedGroupIds]);

  useEffect(() => {
    try {
      localStorage.setItem('geek_chat_muted_groups', JSON.stringify(mutedGroupIds));
      void pushMutedToCloud();
    } catch {}
  }, [mutedGroupIds]);

  // 私聊免打扰：与会话一一对应，存在本地（和群聊静音同一套思路）
  const [mutedConvIds, setMutedConvIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('geek_chat_muted_convs') || '[]');
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('geek_chat_muted_convs', JSON.stringify(mutedConvIds));
      void pushMutedToCloud();
    } catch {}
  }, [mutedConvIds]);

  const [pinnedConvIds, setPinnedConvIds] = useState<string[]>(() => {
    try {
      const s = localStorage.getItem(`geek_pinned_convs_${user?.id || 'guest'}`);
      return s ? JSON.parse(s) : [];
    } catch {
      return [];
    }
  });

  // 私聊会话右键菜单状态
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    conv: ConversationItem | null;
  }>({ visible: false, x: 0, y: 0, conv: null });

  // 发起新私聊弹窗状态
  const [isNewChatModalOpen, setIsNewChatModalOpen] = useState(false);
  // 弹窗无障碍：Esc 关闭、焦点陷阱、背景滚动锁定
  const newChatDialogRef = useDialogA11y(isNewChatModalOpen, () => setIsNewChatModalOpen(false));
  const [newChatTargetUsername, setNewChatTargetUsername] = useState('');
  const [isStartingChat, setIsStartingChat] = useState(false);

  // ---------- 群聊状态 ----------
  const [groups, setGroups] = useState<GroupRoomItem[]>([]);
  const [activeGroupId, setActiveGroupId] = useState<string | null>(() => {
    if (typeof window !== 'undefined') {
      const isDesktop = window.innerWidth >= 768;
      return isDesktop ? localStorage.getItem('geek_chat_active_group_id') : null;
    }
    return null;
  });
  const [groupMessages, setGroupMessages] = useState<GroupChatMessage[]>([]);
  const [isGroupModalOpen, setIsGroupModalOpen] = useState(false);
  const [newGroupName, setNewGroupName] = useState('');
  const [newGroupDesc, setNewGroupDesc] = useState('');
  const [newGroupIsPublic, setNewGroupIsPublic] = useState(false);
  const [groupQuota, setGroupQuota] = useState<GroupQuotaInfo | null>(null);
  const [groupFilter, setGroupFilter] = useState<'all' | 'public' | 'private'>('all');
  const [isCreatingGroup, setIsCreatingGroup] = useState(false);

  // 群成员管理状态
  const [isMembersModalOpen, setIsMembersModalOpen] = useState(false);
  const [membersModalTab, setMembersModalTab] = useState<'members' | 'requests'>('members');
  // 专业版门户：宽屏控制台 + 终端日志伪装 + 右侧折叠群成员看板
  const [portalMode] = usePortalMode();
  const isPro = portalMode === 'pro';

  // 专业版专属：全屏沉浸工作台 + 六大工作软件摸鱼伪装。
  // 这些状态只在 isPro 时被读取，经典版既不渲染相关 UI 也不注册快捷键。
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [stealthTheme, setStealthTheme] = useState<StealthTheme>('normal');
  useEffect(() => {
    if (!isPro) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F11') {
        e.preventDefault();
        setIsFullscreen((v) => !v);
      } else if (e.key === 'Escape') {
        // 伪装层自己也监听 Esc，这里重复设 normal 是幂等的
        if (stealthTheme !== 'normal') setStealthTheme('normal');
        else if (isFullscreen) setIsFullscreen(false);
      } else if (e.altKey && e.key >= '1' && e.key <= '6') {
        // 从聊天工作台直接一键进入对应伪装皮肤（伪装层内切换由组件自己处理）
        const map: Record<string, StealthTheme> = {
          '1': 'vscode', '2': 'idea', '3': 'feishu',
          '4': 'excel', '5': 'word', '6': 'ppt',
        };
        const theme = map[e.key];
        if (theme) { e.preventDefault(); setStealthTheme(theme); }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isPro, isFullscreen, stealthTheme]);
  const [stealthMode, setStealthMode] = useState(() => {
    try { return localStorage.getItem('geek_chat_stealth_mode') === 'true'; } catch { return false; }
  });
  // 群成员看板已下线（与群管理重复），清理历史偏好键
  try { localStorage.removeItem('geek_chat_group_panel'); } catch { /* 忽略 */ }

  // 专业版专属：折叠左侧会话列表，把空间让给聊天区
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  const stealth = isPro && stealthMode;
  const toggleStealthMode = () => setStealthMode((v) => {
    try { localStorage.setItem('geek_chat_stealth_mode', String(!v)); } catch { /* 忽略 */ }
    return !v;
  });
  const [groupMembers, setGroupMembers] = useState<GroupMemberItem[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [inviteUsername, setInviteUsername] = useState('');
  const [isInviting, setIsInviting] = useState(false);
  // 工具箱 / 禁言 / 铭牌 / 群等级榜
  const [showToolbox, setShowToolbox] = useState(false);
  const [showLunchWheel, setShowLunchWheel] = useState(false);
  const [lunchTick, setLunchTick] = useState(0);
  const [lunchBanner, setLunchBanner] = useState(false);
  const toolboxRef = useRef<HTMLDivElement | null>(null);
  const [memberAction, setMemberAction] = useState<{ type: 'mute' | 'badge'; member: any } | null>(null);
  const [muteMinutes, setMuteMinutes] = useState(30);
  const [muteReason, setMuteReason] = useState('');
  // 铭牌 v2：等级牌只由等级决定；特殊名牌可一人多个、管理员可授予/收回
  const [badgeList, setBadgeList] = useState<any[]>([]);
  const [badgeLevel, setBadgeLevel] = useState(1);
  const [badgeWearing, setBadgeWearing] = useState<string>('');
  const [newBadgeName, setNewBadgeName] = useState('');
  const [badgeBusy, setBadgeBusy] = useState(false);
  type GroupLevelProgress = { level: number; total: number; in_level: number; need: number };
  type GroupLevelBoard = {
    items: { user_id: string; rank: number; nickname: string; group_level: number; group_exp: number; badge_name: string; badge_id: number; progress: GroupLevelProgress }[];
    my_progress: GroupLevelProgress | null;
  };
  const [levelBoard, setLevelBoard] = useState<GroupLevelBoard | null>(null);
  const [levelBoardError, setLevelBoardError] = useState(false);
  // 群经验变化后（玩游戏/发言升级）让已打开的等级榜重新拉一次
  const [levelBoardTick, setLevelBoardTick] = useState(0);
  const [actionBusy, setActionBusy] = useState(false);
  const [showLevelBoard, setShowLevelBoard] = useState(false);
  type CheckinSlot = { name: string; start: string; end: string };
  const [checkinCfg, setCheckinCfg] = useState<{ text: string; times_per_day: number; exp: number; daily_exp_cap: number; slots: CheckinSlot[] }>(
    { text: 'hhh', times_per_day: 3, exp: 10, daily_exp_cap: 10, slots: [] },
  );
  const [checkinDraft, setCheckinDraft] = useState<{ text: string; times_per_day: number; exp: number; daily_exp_cap: number; slots: CheckinSlot[] }>(
    { text: 'hhh', times_per_day: 3, exp: 10, daily_exp_cap: 10, slots: [] },
  );
  const [showCheckinConfig, setShowCheckinConfig] = useState(false);
  // 成语接龙 / 每日求签 / 群投票
  const [activityKind, setActivityKind] = useState<'chain' | 'poll' | 'feihua' | null>(null);
  // 接龙进度信号：别人答题时后端会推 chain_update，面板据此立刻刷新读音
  const [chainTick, setChainTick] = useState(0);
  // 飞花令进度信号：feihua_update 推送后让面板重拉诗句流与榜单
  const [feihuaTick, setFeihuaTick] = useState(0);
  const [fortune, setFortune] = useState<FortuneResult | null>(null);
  const [fortuneBusy, setFortuneBusy] = useState(false);
  // 成员管理搜索（本地过滤）+ 邀请入群联想（/users/search，用户名与唯一 ID 都能搜）
  const [memberQuery, setMemberQuery] = useState('');
  const [inviteCandidates, setInviteCandidates] = useState<any[]>([]);
  const inviteSearchSeq = useRef(0);

  // 群聊入群申请审核状态
  const [joinRequests, setJoinRequests] = useState<GroupJoinRequestItem[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [handlingRequestId, setHandlingRequestId] = useState<string | null>(null);

  // 申请入群弹窗状态 (普通用户)
  const [isApplyModalOpen, setIsApplyModalOpen] = useState(false);
  const [applyReason, setApplyReason] = useState('');
  const [isSubmittingApply, setIsSubmittingApply] = useState(false);

  // 群资料与公告编辑状态 (群主/管理员)
  const [isEditGroupModalOpen, setIsEditGroupModalOpen] = useState(false);
  const membersDialogRef = useDialogA11y(isMembersModalOpen, () => setIsMembersModalOpen(false));
  const editGroupDialogRef = useDialogA11y(isEditGroupModalOpen, () => setIsEditGroupModalOpen(false));
  const [editGroupName, setEditGroupName] = useState('');
  const [editGroupDesc, setEditGroupDesc] = useState('');
  const [editGroupAvatar, setEditGroupAvatar] = useState('');
  const [groupAvatarUploading, setGroupAvatarUploading] = useState(false);
  const [editGroupAnnouncement, setEditGroupAnnouncement] = useState('');
  const [isSavingGroup, setIsSavingGroup] = useState(false);
  const [isAnnouncementExpanded, setIsAnnouncementExpanded] = useState(false);

  // 群公告历史：置顶只看“未确认已读”的最新一条，历史抽屉里保留全部
  const [groupAnnouncements, setGroupAnnouncements] = useState<GroupAnnouncementItem[]>([]);
  const [announcementsLoading, setAnnouncementsLoading] = useState(false);
  const [announcementHistoryOpen, setAnnouncementHistoryOpen] = useState(false);
  const [announcementDraft, setAnnouncementDraft] = useState('');
  const [announcementPublishing, setAnnouncementPublishing] = useState(false);
  const [confirmingAnnouncementId, setConfirmingAnnouncementId] = useState<string | null>(null);
  const announcementDialogRef = useDialogA11y(announcementHistoryOpen, () => setAnnouncementHistoryOpen(false));
  const [mentionAllQuota, setMentionAllQuota] = useState<{ limit: number; used: number; remaining: number; can_use: boolean } | null>(null);

  // @ 艾特提及自动补全状态
  const [showMentionPopover, setShowMentionPopover] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);

  // ---------- 公共输入与交互 ----------
  // 草稿按会话隔离：私聊用 c:<会话id>，群聊用 g:<群id>。
  // 之前是单一字符串，在 A 群敲了一半切到 B 群，文字会跟着跑到 B 群输入框里。
  // 聊天草稿按会话持久化：刷新后不再丢失
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      const raw = localStorage.getItem(CHAT_DRAFTS_KEY);
      return raw ? (JSON.parse(raw) as Record<string, string>) : {};
    } catch {
      return {};
    }
  });
  const [lightboxImg, setLightboxImg] = useState<string | null>(null);

  // 当前会话的所有图片（按消息顺序）：大图查看器据此左右切换与定位回原消息
  const chatImages = useMemo(() => {
    const list: { url: string; msgId: string }[] = [];
    const source: { id: string; content: string; is_recalled?: boolean }[] =
      chatTab === 'group' ? (groupMessages as any) : (messages as any);
    for (const m of source) {
      if (m.is_recalled) continue;
      const urls = (m.content || '').match(IMG_IN_TEXT_RE_G) || [];
      for (const u of urls) list.push({ url: u, msgId: m.id });
    }
    return list;
  }, [chatTab, groupMessages, messages]);

  const lightboxIndex = lightboxImg
    ? Math.max(0, chatImages.findIndex((x) => x.url === lightboxImg))
    : 0;
  // 点头像看大图（群头像在会话头部，个人头像在成员/资料卡片）
  const [avatarPreview, setAvatarPreview] = useState<{ src: string; name: string } | null>(null);

  // 会话内消息搜索
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchResults, setSearchResults] = useState<any[]>([]);
  // @我 的消息
  const [mentionsOpen, setMentionsOpen] = useState(false);
  const [mentionsLoading, setMentionsLoading] = useState(false);
  const [mentionList, setMentionList] = useState<any[]>([]);

  const runSearch = async () => {
    const q = searchQuery.trim();
    const request = chatTab === 'group' ? groupRequestRef.current : directRequestRef.current;
    if (!q || !request) return;
    const { signal } = request.controller;
    const scope = chatTab === 'group' ? 'groups' : 'conversations';
    setSearchLoading(true);
    try {
      const res = await apiClient.get(`/chat/${scope}/${request.id}/messages/search`, { signal, params: { q, limit: 30 } });
      if (!signal.aborted) setSearchResults(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (!signal.aborted) {
        setSearchResults([]);
        toast.error('搜索失败，请稍后重试');
      }
    } finally {
      if (!signal.aborted) setSearchLoading(false);
    }
  };

  const openMentions = async () => {
    setMentionsOpen(true);
    if (mentionList.length) return;
    setMentionsLoading(true);
    try {
      const res = await apiClient.get('/chat/mentions', { params: { limit: 30 } });
      setMentionList(Array.isArray(res.data) ? res.data : []);
    } catch {
      setMentionList([]);
    } finally {
      setMentionsLoading(false);
    }
  };

  // 跳到某条消息：同群直接滚动高亮，其他群先切过去
  const jumpToSearchResult = (roomId: string, msgId: string) => {
    setSearchOpen(false);
    setMentionsOpen(false);
    if (roomId && roomId !== activeGroupId) {
      setChatTab('group');
      setActiveGroupId(roomId);
    }
    window.setTimeout(() => {
      const el = document.querySelector(`[data-msg-id="${msgId}"]`);
      if (el) {
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        setActiveMsgId(msgId);
      } else {
        toast.info('这条消息较早，可能还没加载，请向上翻找');
      }
    }, 700);
  };
  const [showEmojiPicker, setShowEmojiPicker] = useState(false);
  type ComposerState = {
    composerExpanded?: boolean;
    replyTarget?: { id: string; sender: string; snippet: string } | null;
    pendingImageUrl?: string | null;
    pendingImageUploading?: boolean;
    uploadPercent?: number;
    isSending?: boolean;
  };
  const [composerStates, setComposerStates] = useState<Record<string, ComposerState>>({});
  const draftKey = chatTab === 'group' ? `g:${activeGroupId ?? ''}` : `c:${activeConvId ?? ''}`;
  const { composerExpanded = false, replyTarget = null, pendingImageUrl = null,
    pendingImageUploading = false, uploadPercent = 0, isSending = false } = composerStates[draftKey] ?? {};
  const updateComposer = (update: Partial<ComposerState>) => {
    setComposerStates((prev) => ({ ...prev, [draftKey]: { ...prev[draftKey], ...update } }));
  };
  const setComposerExpanded = (composerExpanded: boolean) => updateComposer({ composerExpanded });
  const setReplyTarget = (replyTarget: ComposerState['replyTarget']) => updateComposer({ replyTarget });
  const setPendingImageUrl = (pendingImageUrl: string | null) => updateComposer({ pendingImageUrl });
  const setIsSending = (isSending: boolean) => updateComposer({ isSending });
  const currentDraftKeyRef = useRef(draftKey);
  useLayoutEffect(() => { currentDraftKeyRef.current = draftKey; }, [draftKey]);
  const inputText = drafts[draftKey] ?? '';
  // 草稿写入 localStorage（300ms 防抖，避免逐字符写盘）
  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        if (Object.keys(drafts).length) {
          localStorage.setItem(CHAT_DRAFTS_KEY, JSON.stringify(drafts));
        } else {
          localStorage.removeItem(CHAT_DRAFTS_KEY);
        }
      } catch {}
    }, 300);
    return () => window.clearTimeout(timer);
  }, [drafts]);
  const setDraftText = useCallback((key: string, value: string | ((prev: string) => string)) => {
    setDrafts((prev) => {
      const current = prev[key] ?? '';
      const next = typeof value === 'function' ? value(current) : value;
      if (next === current) return prev;
      if (next) return { ...prev, [key]: next };
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  }, []);
  const setInputText = useCallback((value: string | ((prev: string) => string)) => {
    setDraftText(draftKey, value);
  }, [draftKey, setDraftText]);
  const [showActionMenu, setShowActionMenu] = useState(false);
  const [isWsConnected, setIsWsConnected] = useState(false);

  const groupsRef = useRef(groups);
  useEffect(() => { groupsRef.current = groups; }, [groups]);
  const groupPageRef = useRef(0);
  const unreadAtEntryRef = useRef(0);
  const [unreadAtEntry, setUnreadAtEntry] = useState(0);
  const [showBackToBottom, setShowBackToBottom] = useState(false);
  // 与 showBackToBottom 同步的 ref：滚动回调里需要判断「刚离开底部 / 刚回到底部」这一瞬间
  const showBackToBottomRef = useRef(false);
  // 从开始爬楼那一刻起新增的消息条数（显示在「回到最新消息」按钮上的小角标）
  const [newMessagesWhileAway, setNewMessagesWhileAway] = useState(0);
  const [jumpingToUnread, setJumpingToUnread] = useState(false);
  const [hasMoreGroupHistory, setHasMoreGroupHistory] = useState(false);
  const [loadingGroupHistory, setLoadingGroupHistory] = useState(false);
  const groupCursorRef = useRef<GroupHistoryCursor | null>(null);
  const hasMoreGroupHistoryRef = useRef(false);
  const groupRequestRef = useRef<ConversationRequest | null>(null);
  const directRequestRef = useRef<ConversationRequest | null>(null);
  const groupLoadLockRef = useRef<ConversationRequest | null>(null);
  const directLoadLockRef = useRef<ConversationRequest | null>(null);
  const directHistoryRevisionRef = useRef(0);
  const recalledMessagesRef = useRef(new Set<string>());
  // 撤回前的原文：QQ 风格「重新编辑」需要把原文回填到输入框。
  // 撤回事件只带消息 id，所以在本地替换成「已撤回」之前先把内容记下来。
  const recalledOriginalsRef = useRef(new Map<string, string>());
  const rememberRecalledContent = useCallback((msgId: string, content?: string | null) => {
    const text = (content || '').trim();
    if (!text || text === '[该消息已撤回]') return;
    recalledOriginalsRef.current.set(msgId, text);
  }, []);

  const pendingSendsRef = useRef(new Map<string, { draftKey: string; restoreDraft: () => void }>());

  const activeConvIdRef = useRef<string | null>(null);
  const activeGroupIdRef = useRef<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = useRef<any>(null);
  const reconnectAttemptsRef = useRef<number>(0);
  // 最后一次收到 pong 的时间：用于检测"半开连接"（NAT 超时后界面仍显示已连接）
  const lastPongRef = useRef<number>(Date.now());
  const isDestroyedRef = useRef<boolean>(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  // 只有用户停留在底部附近时才自动滚动，向上翻历史时不再被新消息/输入中提示强行拽回底部
  const isAtBottomRef = useRef(true);
  // 移动端软键盘弹出时 visualViewport 会变矮，用它同步收缩聊天容器，避免输入区被遮挡
  const [vvHeight, setVvHeight] = useState<number | null>(null);
  const typingTimerRef = useRef<any>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const actionMenuRef = useRef<HTMLDivElement>(null);
  // 表情面板锚点：贴着点开的那个表情按钮弹出
  const emojiAnchorRef = useRef<HTMLElement | null>(null);
  const mentionPopoverRef = useRef<HTMLDivElement>(null);
  const groupScrollRef = useRef<HTMLDivElement>(null);
  const convScrollRef = useRef<HTMLDivElement>(null);
  // 首次加载/切会话时需要"无动画直接贴到底部"：标记后由 useLayoutEffect 在绘制前完成
  // 贴底时间窗：进入会话/切会话/自己发消息后的一小段时间内，
  // 每次渲染都贴底。用时间窗而不是布尔标记，是因为消息是分几次渲染进来的
  // （空列表 → 50 条 → 头像图片加载），布尔标记会在第一次渲染就被消费掉，
  // 等数据真正填满时已经不再贴底，表现就是"进群后停在半空中"。
  const stickUntilRef = useRef(0);
  // 向上加载历史时的位置快照：加载完成后据此把阅读位置挪回原处
  const historyRestoreRef = useRef<{ top: number; height: number } | null>(null);
  // 程序化滚动（贴底/位置还原）会触发 onScroll，此时不能当成"用户滑到顶部"，
  // 否则刚进群就会误触发一次历史加载，列表被拉长后又停在中间
  const programmaticScrollAtRef = useRef(0);
  // 上一次的 scrollTop：内容变高时浏览器也会派发 scroll 事件，
  // 但此时 scrollTop 并没有变化，不能据此判定"用户爬楼了"
  const lastScrollTopRef = useRef(0);
  const [loadingMessages, setLoadingMessages] = useState(false);
  const typingSentAtRef = useRef<number>(0);
  const resyncRef = useRef<() => void>(() => {});
  // 回前台补数据的节流时间戳（focus/visibility/online 会连续触发，避免重复整页刷新）
  const lastVisibleResyncRef = useRef(0);
  // WS 回调里拉取群公告：connectWebSocket 依赖为空，用 ref 取最新实现
  const fetchGroupAnnouncementsRef = useRef<((roomId: string) => void) | null>(null);
  const fetchGroupMembersRef = useRef<((roomId: string) => void) | null>(null);
  const subscribedRoomRef = useRef<string | null>(null);
  const unreadReadyRef = useRef(false);

  useEffect(() => {
    activeConvIdRef.current = activeConvId;
    if (activeConvId) {
      localStorage.setItem('geek_chat_active_conv_id', activeConvId);
    } else {
      localStorage.removeItem('geek_chat_active_conv_id');
    }
  }, [activeConvId]);

  useEffect(() => {
    activeGroupIdRef.current = activeGroupId;
    if (activeGroupId) {
      localStorage.setItem('geek_chat_active_group_id', activeGroupId);
    } else {
      localStorage.removeItem('geek_chat_active_group_id');
    }
  }, [activeGroupId]);

  // 父组件传入的都是内联回调，每次渲染引用都会变化。
  // 若直接作为 WebSocket useEffect 的依赖，会导致每次未读变化/Toast 变化都断开重连，
  // 期间的消息会被丢弃，因此统一用 ref 持有最新引用。
  const onUnreadChangeRef = useRef(onUnreadChange);
  const onRequireAuthRef = useRef(onRequireAuth);
  const onClearInitialPeerRef = useRef(onClearInitialPeer);
  const onClearInitialGroupIdRef = useRef(onClearInitialGroupId);
  const toastRef = useRef(toast);
  const userIdRef = useRef(user?.id);

  useEffect(() => {
    onUnreadChangeRef.current = onUnreadChange;
    onRequireAuthRef.current = onRequireAuth;
    onClearInitialPeerRef.current = onClearInitialPeer;
    onClearInitialGroupIdRef.current = onClearInitialGroupId;
    toastRef.current = toast;
    userIdRef.current = user?.id;
  });

  // 从通知中心或外部跳转指定群聊
  useEffect(() => {
    if (initialGroupId) {
      setChatTab('group');
      setActiveGroupId(initialGroupId);
      onClearInitialGroupIdRef.current?.();
    }
  }, [initialGroupId]);

  // 桌面通知点击后按会话 id 打开私聊
  useEffect(() => {
    if (initialConvId) {
      setChatTab('direct');
      setActiveConvId(initialConvId);
      onClearInitialConvId?.();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialConvId]);

  // 点击外部收起弹出层与右键菜单
  useEffect(() => {
    const onEsc = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowActionMenu(false);
        setShowMentionPopover(false);
      }
    };
    document.addEventListener('keydown', onEsc);

    const handleClickOutside = (event: MouseEvent) => {
      if (actionMenuRef.current && !actionMenuRef.current.contains(event.target as Node)) {
        setShowActionMenu(false);
      }
      if (mentionPopoverRef.current && !mentionPopoverRef.current.contains(event.target as Node)) {
        setShowMentionPopover(false);
      }
      // 用 ref.contains 判断，不再无条件关闭：否则菜单内嵌 portal 子组件或
      // 事件委托变化时，菜单会在菜单项 onClick 执行前被卸载
      setContextMenu((prev) => {
        if (!prev.visible) return prev;
        if (contextMenuRef.current?.contains(event.target as Node)) return prev;
        return { ...prev, visible: false };
      });
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, []);

  // 置顶 / 取消置顶会话
  const togglePinConversation = (convId: string) => {
    setPinnedConvIds((prev) => {
      const isPinned = prev.includes(convId);
      const next = isPinned ? prev.filter((id) => id !== convId) : [convId, ...prev];
      localStorage.setItem(`geek_pinned_convs_${user?.id || 'guest'}`, JSON.stringify(next));
      toast.info(isPinned ? '已取消置顶' : '会话已置顶到顶部');
      return next;
    });
    setContextMenu((prev) => ({ ...prev, visible: false }));
  };


  // 群成员索引：消息列表里原本每条消息都 find 两次，改成 O(1) 查表
  const memberByUsername = useMemo(
    () => new Map(groupMembers.map((m) => [m.username, m])),
    [groupMembers]
  );

  // @ 高亮白名单：只有真正在群里的成员才会被渲染成 @ 标签。
  // 此前只要是「@ + 任意字符」都会染色，随便打一句 "@测试一下" 也显示成提人，很误导。
  const groupMemberNameSet = useMemo(() => {
    const names = new Set<string>();
    groupMembers.forEach((m) => {
      if (m.username) names.add(m.username.toLowerCase());
      if (m.nickname) names.add(m.nickname.toLowerCase());
    });
    return names;
  }, [groupMembers]);
  // @ 高亮要显示「可修改的昵称」，而不是唯一用户名
  const groupMemberNickMap = useMemo(() => {
    const map: Record<string, string> = {};
    groupMembers.forEach((m) => {
      if (m.username) map[m.username.toLowerCase()] = m.nickname || m.username;
      if (m.nickname) map[m.nickname.toLowerCase()] = m.nickname;
    });
    return map;
  }, [groupMembers]);
  // 昵称 → 唯一用户名：跳主页、判断「是不是我」时必须用 username
  const groupMemberNickToUsername = useMemo(() => {
    const map: Record<string, string> = {};
    groupMembers.forEach((m) => {
      if (!m.username) return;
      map[m.username.toLowerCase()] = m.username;
      if (m.nickname) map[m.nickname.toLowerCase()] = m.username;
    });
    return map;
  }, [groupMembers]);
  // 群聊列表：置顶的排最前，其余按最近消息时间倒序
  const sortedGroups = useMemo(() => {
    const pinned = new Set(pinnedGroupIds);
    return [...groups].sort((a, b) => {
      const ap = pinned.has(a.id) ? 1 : 0;
      const bp = pinned.has(b.id) ? 1 : 0;
      if (ap !== bp) return bp - ap;
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return bt - at;
    });
  }, [groups, pinnedGroupIds]);

  // 排序后的会话列表 (置顶排在最前)：输入框每次按键都会重渲染，必须 memo
  const sortedConversations = useMemo(() => {
    const pinnedSet = new Set(pinnedConvIds);
    return [...conversations].sort((a, b) => {
      const aPinned = pinnedSet.has(a.id);
      const bPinned = pinnedSet.has(b.id);
      if (aPinned && !bPinned) return -1;
      if (!aPinned && bPinned) return 1;
      // 未读会话优先，其次按最后消息时间
      const aUnread = (a as any).unread_count || 0;
      const bUnread = (b as any).unread_count || 0;
      if (aUnread > 0 && bUnread === 0) return -1;
      if (bUnread > 0 && aUnread === 0) return 1;
      return new Date(b.last_message_at).getTime() - new Date(a.last_message_at).getTime();
    });
  }, [conversations, pinnedConvIds]);

  // 建立 WebSocket 连接与事件监听
  const connectWebSocket = useCallback(() => {
    if (isDestroyedRef.current) return;
    const token = localStorage.getItem('access_token');
    if (!token) return;

    // 重复连接保护：已有连接处于 OPEN/CONNECTING 时直接复用，
    // 避免旧连接 onclose 晚触发导致的重复建连（消息双份、未读重复自增）
    if (wsRef.current && (wsRef.current.readyState === WebSocket.OPEN || wsRef.current.readyState === WebSocket.CONNECTING)) {
      return;
    }

    try {
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      // 令牌通过 Sec-WebSocket-Protocol 子协议传递，不再拼进 URL：
      // query 会被 nginx access_log 完整记录，等于把访问令牌写进日志与浏览器历史
      const wsUrl = `${protocol}//${window.location.host}/api/chat/ws`;
      const ws = new WebSocket(wsUrl, ['access_token', token]);
      // 先登记再挂事件：onopen/onclose 里都能用 wsRef.current === ws 判断「是否仍是当前连接」，
      // 迟到的旧连接事件一律忽略，避免把新连接的在线状态误判为断开。
      wsRef.current = ws;

      ws.onopen = () => {
        if (wsRef.current !== ws) return;
        // 只有「重连」才需要补偿同步。
        // 首次连接时页面初始化刚拉过一轮数据，这里再全量拉一次会让每次进入聊天页
        // 都变成双倍请求 + 双倍 setState + 双倍滚动，弱机直接卡顿。
        const isReconnect = reconnectAttemptsRef.current > 0;
        setIsWsConnected(true);
        reconnectAttemptsRef.current = 0;
        // 连上后清掉可能还挂着的重连计时器，避免重复建连
        if (reconnectTimeoutRef.current) {
          clearTimeout(reconnectTimeoutRef.current);
          reconnectTimeoutRef.current = null;
        }
        // 关键：每条新连接都重置探活基准并立刻探一次。
        // 以前 lastPong 沿用的是上一条连接（甚至页面加载时）的时间戳，
        // 重连后第一轮心跳就会判定「超时」并再次断开，形成每 25 秒一次的降级死循环。
        lastPongRef.current = Date.now();
        try {
          ws.send(JSON.stringify({ type: 'ping' }));
        } catch {}
        const roomId = groupRequestRef.current?.id;
        subscribedRoomRef.current = null;
        if (roomId) {
          try {
            ws.send(JSON.stringify({ type: 'join_group', room_id: roomId }));
            subscribedRoomRef.current = roomId;
          } catch {}
        }
        if (isReconnect) {
          try {
            resyncRef.current?.();
          } catch {}
        }
      };

      ws.onmessage = (event) => {
        if (wsRef.current !== ws) return;
        try {
          const data = JSON.parse(event.data);

          if (data.type === 'pong') {
            lastPongRef.current = Date.now();
            return;
          }

          // 1. 私聊消息
          if (data.type === 'new_msg' || data.type === 'new_message') {
            const isCurrentConv = data.conversation_id != null && data.conversation_id === directRequestRef.current?.id;
            const newMsg: ChatMessage = data.message || {
              id: data.msg_id,
              conversation_id: data.conversation_id,
              sender_id: data.sender_id,
              msg_type: 'text',
              content: data.content,
              seq_id: data.seq_id,
              is_read: false,
              is_recalled: false,
              created_at: data.created_at,
              reply_to_id: data.reply_to_id || null,
              reply_sender: data.reply_sender || '',
              reply_snippet: data.reply_snippet || '',
            };
            if (isCurrentConv) {
              setMessages((prev) => mergeMessages(prev, [newMsg]));
              // 正在爬楼时收到别人的新消息：给「回到最新消息」按钮加计数角标
              if (!isAtBottomRef.current && newMsg.sender_id !== userIdRef.current) {
                setNewMessagesWhileAway((n) => n + 1);
              }
              // 活跃会话即时沉淀已读至服务端，避免刷新后仍亮红点
              apiClient.post(`/chat/conversations/${data.conversation_id}/read`).catch(() => {});
            }
            setConversations((prev) =>
              prev.map((c) => {
                if (c.id === data.conversation_id) {
                  return {
                    ...c,
                    last_message_preview: data.content || (data.message && data.message.content),
                    last_message_at: data.created_at || (data.message && data.message.created_at),
                    unread_count: isCurrentConv ? 0 : (c.unread_count || 0) + 1,
                  };
                }
                return c;
              })
            );
          }
          // 2. 群聊消息广播
          else if (data.type === 'group_msg') {
            const isCurrentGroup = data.room_id != null && data.room_id === groupRequestRef.current?.id;
            if (data.client_msg_id) pendingSendsRef.current.delete(data.client_msg_id);
            if (isCurrentGroup) {
              const newGMsg: GroupChatMessage = {
                id: data.msg_id,
                room_id: data.room_id,
                sender_id: data.sender_id,
                sender_username: data.sender_username,
                sender_nickname: data.sender_nickname,
                sender_avatar: data.sender_avatar,
                sender_level: data.sender_level || 1,
                content: data.is_recalled ? '[该消息已撤回]' : data.content,
                msg_type: data.msg_type || 'text',
                seq_id: data.seq_id,
                is_recalled: Boolean(data.is_recalled),
                is_mention_all: Boolean(data.is_mention_all),
                created_at: data.created_at,
                // 引用信息必须一起带回来，否则 WS 广播覆盖乐观消息后，
                // 气泡上的引用块会消失，只有刷新重新拉列表才出现
                reply_to_id: data.reply_to_id || null,
                reply_sender: data.reply_sender || '',
                reply_snippet: data.reply_snippet || '',
              };
              setGroupMessages((prev) => mergeMessages(prev, [newGMsg], data.client_msg_id));
              // 服务端随消息下发发送者的最新群等级：即时刷新铭牌，不必等重新拉成员列表
              if (typeof data.sender_group_level === 'number' && data.sender_group_level > 0) {
                setGroupMembers((prev) =>
                  prev.map((m) =>
                    m.user_id === data.sender_id
                      ? {
                          ...m,
                          group_level: data.sender_group_level,
                          group_exp: Number(data.sender_group_exp) || m.group_exp,
                        }
                      : m
                  )
                );
              }
              if (data.sender_level_up && data.sender_id === userIdRef.current) {
                toastRef.current?.success?.(`群等级提升到 Lv.${data.sender_group_level}`);
              }
              // 正在爬楼时收到别人的新消息：给「回到最新消息」按钮加计数角标
              if (!isAtBottomRef.current && data.sender_id !== userIdRef.current && !data.is_recalled) {
                setNewMessagesWhileAway((n) => n + 1);
              }
              // 正在查看该群时立即上报已读
              apiClient.post(`/chat/groups/${data.room_id}/read`).catch(() => {});
            }
            setGroups((prev) =>
              prev.map((g) => {
                if (g.id !== data.room_id) return g;
                // 群活动卡片（接龙/投票/求签/飞花令）不进会话预览、不加未读，避免刷屏
                const isActivityMsg = ['chain', 'poll', 'fortune', 'feihua'].includes(
                  String(data.msg_type || 'text')
                );
                if (isActivityMsg) {
                  return { ...g, unread_count: isCurrentGroup ? 0 : g.unread_count || 0 };
                }
                return {
                  ...g,
                  last_message_preview: data.is_recalled
                    ? '[该消息已撤回]'
                    : `${data.sender_nickname || data.sender_username}: ${data.content}`,
                  last_message_at: data.created_at,
                  unread_count: isCurrentGroup ? 0 : (g.unread_count || 0) + 1,
                };
              })
            );
          } else if (data.type === 'chain_update') {
            // 别人接了龙 / 开局 / 结算：通知打开着的接龙面板重新拉状态，
            // 避免「他接了、我这边还显示旧读音」。
            if (data.room_id === activeGroupIdRef.current) {
              setChainTick((n) => n + 1);
            }
          } else if (data.type === 'feihua_update') {
            // 飞花令：别人答对 / 开局 / 结算时刷新面板的诗句流与实时榜
            if (data.room_id === activeGroupIdRef.current) {
              setFeihuaTick((n) => n + 1);
            }
          } else if (data.type === 'lunch_update') {
            // 群友加菜/删菜/改冻结时间：让打开着的转盘面板重新拉状态
            if (data.room_id === activeGroupIdRef.current) {
              setLunchTick((n) => n + 1);
            }
          } else if (data.type === 'feihua_self') {
            // 群内直接发诗句的判定结果：只回给发送者，不在群里发卡片
            if (data.room_id === activeGroupIdRef.current) {
              if (data.ok) {
                toast.success(data.info ? `✓ ${data.verse} —— ${data.info}` : `✓ 答对「${data.verse}」`);
              } else {
                toast.error(data.reason || '这句不算');
              }
            }
          } else if (data.type === 'group_recall') {
            if (data.message_id) recalledMessagesRef.current.add(data.message_id);
            if (data.room_id === groupRequestRef.current?.id) {
              setGroupMessages((prev) => {
                rememberRecalledContent(data.message_id, prev.find((m) => m.id === data.message_id)?.content);
                return prev.map((m) =>
                  m.id === data.message_id ? { ...m, is_recalled: true, content: '[该消息已撤回]' } : m
                );
              });
            }
            if (data.room_id) {
              setGroups((prev) =>
                prev.map((g) =>
                  g.id === data.room_id
                    ? {
                        ...g,
                        last_message_preview: '[该消息已撤回]',
                      }
                    : g
                )
              );
            }
          }
          // 3. 群已解散 / 本人被移出 / 本人已退出：立即从列表移除并退出会话
          else if (data.type === 'group_closed' || data.type === 'group_kicked' || data.type === 'group_left') {
            const rid = data.room_id;
            setGroups((prev) => prev.filter((g) => g.id !== rid));
            if (activeGroupIdRef.current === rid) {
              setActiveGroupId(null);
              setGroupMessages([]);
              setGroupMembers([]);
            }
            if (data.type === 'group_closed') {
              toastRef.current?.warning(`群聊「${data.room_name || ''}」已被解散`);
            } else if (data.type === 'group_kicked') {
              toastRef.current?.warning(`您已被移出群聊「${data.room_name || ''}」`);
            }
          }
          // 3.5 群公告发布 / 删除：当前正在看这个群就刷新置顶与历史
          else if (data.type === 'group_announcement' || data.type === 'group_announcement_deleted') {
            if (data.room_id && data.room_id === activeGroupIdRef.current) {
              void fetchGroupAnnouncementsRef.current?.(data.room_id);
            }
            if (data.type === 'group_announcement' && data.sender && data.sender_id !== userIdRef.current) {
              toastRef.current?.info(`${data.sender} 发布了新的群公告`);
            }
          }
          // 4. 群成员/角色/群资料发生变化：刷新群列表与成员名单
          else if (data.type === 'group_members_changed' || data.type === 'group_joined') {
            apiClient
              .get('/chat/groups')
              .then((res) => {
                if (Array.isArray(res.data)) setGroups(res.data);
              })
              .catch(() => {});
            if (data.room_id) void fetchGroupMembersRef.current?.(data.room_id);
          } else if (data.type === 'ack') {
            if (data.client_msg_id) pendingSendsRef.current.delete(data.client_msg_id);
            setMessages((prev) => {
              const optimistic = prev.find((message) => message.id === data.client_msg_id);
              if (!optimistic) return prev;
              if (prev.some((message) => message.id === data.msg_id)) return mergeMessages(prev, [], optimistic.id);
              return mergeMessages(prev, [{
                ...optimistic, id: data.msg_id, seq_id: data.seq_id, created_at: data.created_at || optimistic.created_at,
              }], optimistic.id);
            });
          } else if (data.type === 'typing') {
            if (data.conversation_id === directRequestRef.current?.id) {
              setIsTyping(true);
              if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
              typingTimerRef.current = setTimeout(() => setIsTyping(false), 3000);
            }
          } else if (data.type === 'recall') {
            if (data.message_id) recalledMessagesRef.current.add(data.message_id);
            setMessages((prev) => {
              rememberRecalledContent(data.message_id, prev.find((m) => m.id === data.message_id)?.content);
              return prev.map((m) =>
                m.id === data.message_id ? { ...m, is_recalled: true, content: '[该消息已撤回]' } : m
              );
            });
            if (data.conversation_id) {
              setConversations((prev) =>
                prev.map((c) => (c.id === data.conversation_id ? { ...c, last_message_preview: '[该消息已撤回]' } : c))
              );
            }
          } else if (data.type === 'error') {
            const clientMsgId = data.client_msg_id;
            const pendingSend = pendingSendsRef.current.get(clientMsgId);
            if (pendingSend) {
              pendingSendsRef.current.delete(clientMsgId);
              pendingSend.restoreDraft();
              if (pendingSend.draftKey !== currentDraftKeyRef.current) return;
              const removePending = <T extends ChatMessage | GroupChatMessage,>(prev: T[]) =>
                prev.filter((message) => message.id !== clientMsgId);
              if (pendingSend.draftKey.startsWith('g:')) setGroupMessages(removePending);
              else setMessages(removePending);
            }
            toastRef.current?.error(data.detail || '发送消息遇到问题');
          }
        } catch {}
      };

      ws.onclose = async (ev) => {
        // 已被更新连接替换掉的旧 socket：它的 onclose 迟到不能把新连接标记为断开
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setIsWsConnected(false);
        // 4003 账号被拒：不重连；4001 令牌失效：刷新成功后立即重连
        if (ev.code === 4003) return;
        if (ev.code === 4001) {
          try {
            await refreshAccessToken();
          } catch {
            // 续签失败（refresh 凭证过期 / 并发续签）不永久放弃：
            // 低频重试，等用户重新登录或令牌恢复可用时自动回到 WS，无需整页刷新
            if (!isDestroyedRef.current && !reconnectTimeoutRef.current) {
              reconnectTimeoutRef.current = setTimeout(() => {
                reconnectTimeoutRef.current = null;
                connectWebSocket();
              }, 10000);
            }
            return;
          }
        }
        if (isDestroyedRef.current) return;

        const MAX_ATTEMPTS = 8;
        if (reconnectAttemptsRef.current >= MAX_ATTEMPTS) {
          // 聊天页常驻挂载，切 tab 不会重挂；达到上限后要能自愈。
          // 低频兜底：网络恢复 / 后端重启后自动清零重试，不必整页刷新
          if (!reconnectTimeoutRef.current) {
            reconnectTimeoutRef.current = setTimeout(() => {
              reconnectTimeoutRef.current = null;
              reconnectAttemptsRef.current = 0;
              if (!isDestroyedRef.current) connectWebSocket();
            }, 60000);
          }
          return;
        }
        const base = Math.min(1000 * Math.pow(1.5, reconnectAttemptsRef.current), 30000);
        const delay = Math.round(base * (0.7 + Math.random() * 0.6)); // ±30% 抖动
        reconnectAttemptsRef.current += 1;
        reconnectTimeoutRef.current = setTimeout(connectWebSocket, delay);
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        // 只负责触发关闭，在线状态统一由 onclose 翻转：
        // error + close 各改一次会让状态灯 / 未读提示闪两下
        try {
          ws.close();
        } catch {}
      };

    } catch {
      setIsWsConnected(false);
    }
    // 依赖为空：内部一律通过 ref 读取最新回调，避免父组件重渲染导致反复重连
  }, []);

  // 获取群聊列表
  const fetchGroups = useCallback(() => {
    apiClient
      .get('/chat/groups')
      .then((res) => {
        if (Array.isArray(res.data)) {
          setGroups(res.data);
          const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 768;
          const savedGroupId = typeof window !== 'undefined' ? localStorage.getItem('geek_chat_active_group_id') : null;
          if (isDesktop && savedGroupId && res.data.some((g: any) => g.id === savedGroupId)) {
            setActiveGroupId(savedGroupId);
          } else if (isDesktop && res.data.length > 0 && !activeGroupIdRef.current) {
            setActiveGroupId(res.data[0].id);
          }
        }
      })
      .catch(() => {});
  }, []);

  // 获取群公告历史（附带本人已读状态：未读的最新一条才置顶）
  const fetchGroupAnnouncements = useCallback(async (roomId: string) => {
    const request = groupRequestRef.current;
    if (request?.id !== roomId) return;
    const { signal } = request.controller;
    setAnnouncementsLoading(true);
    try {
      const res = await apiClient.get(`/chat/groups/${roomId}/announcements`, { signal });
      if (!signal.aborted) setGroupAnnouncements(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (!signal.aborted) setGroupAnnouncements([]);
    } finally {
      if (!signal.aborted) setAnnouncementsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchGroupAnnouncementsRef.current = fetchGroupAnnouncements;
  }, [fetchGroupAnnouncements]);

  // 确认已读：该公告不再置顶，自动归入历史
  const confirmAnnouncementRead = async (announcementId: string) => {
    const request = groupRequestRef.current;
    if (!request) return;
    const { signal } = request.controller;
    setConfirmingAnnouncementId(announcementId);
    try {
      await apiClient.post(`/chat/groups/${request.id}/announcements/${announcementId}/read`);
      if (signal.aborted) return;
      setGroupAnnouncements((prev) =>
        prev.map((a) => (a.id === announcementId ? { ...a, is_read: true } : a))
      );
      setIsAnnouncementExpanded(false);
    } catch (err: any) {
      if (!signal.aborted) toast.error(err?.response?.data?.detail || '确认失败，请稍后重试');
    } finally {
      if (!signal.aborted) setConfirmingAnnouncementId(null);
    }
  };

  // 发布新公告（群主 / 管理员）
  const publishAnnouncement = async () => {
    const request = groupRequestRef.current;
    const content = announcementDraft.trim();
    if (!request || !content || announcementPublishing) return;
    const { signal } = request.controller;
    setAnnouncementPublishing(true);
    try {
      const { data: created } = await apiClient.post<GroupAnnouncementItem>(`/chat/groups/${request.id}/announcements`, { content });
      void fetchGroups();
      if (signal.aborted) return;
      setAnnouncementDraft('');
      setGroupAnnouncements((prev) => [created, ...prev.filter((a) => a.id !== created.id)]);
      toast.success('群公告已发布');
    } catch (err: any) {
      if (!signal.aborted) toast.error(err?.response?.data?.detail || '发布失败，请稍后重试');
    } finally {
      if (!signal.aborted) setAnnouncementPublishing(false);
    }
  };

  // 删除历史公告（软删除，仅群主 / 管理员）
  const deleteAnnouncement = async (item: GroupAnnouncementItem) => {
    const ok = await confirmModal({
      title: '删除群公告',
      description: '删除后该公告会从公告历史中移除，群成员将不再看到它。确定删除？',
      confirmText: '删除',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/chat/groups/${item.room_id}/announcements/${item.id}`);
      setGroupAnnouncements((prev) => prev.filter((a) => a.id !== item.id));
      fetchGroups();
      toast.success('公告已删除');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '删除失败，请稍后重试');
    }
  };

  // 获取用户群聊配额与权限信息
  const fetchGroupQuota = useCallback(async () => {
    try {
      const res = await apiClient.get('/chat/groups/quota');
      setGroupQuota(res.data);
      if (res.data.can_create_public && res.data.public_created_count < res.data.public_max_limit) {
        setNewGroupIsPublic(true);
      } else {
        setNewGroupIsPublic(false);
      }
    } catch {
      // ignore
    }
  }, []);

  // 获取群成员列表
  const fetchGroupMembers = useCallback(async (roomId: string) => {
    const request = groupRequestRef.current;
    if (request?.id !== roomId) return;
    const { signal } = request.controller;
    setLoadingMembers(true);
    try {
      const res = await apiClient.get(`/chat/groups/${roomId}/members`, { signal });
      if (!signal.aborted && Array.isArray(res.data)) setGroupMembers(res.data);
    } catch {
      // 保留已有成员列表，等待下次刷新。
    } finally {
      if (!signal.aborted) setLoadingMembers(false);
    }
  }, []);

  useEffect(() => { fetchGroupMembersRef.current = fetchGroupMembers; }, [fetchGroupMembers]);

  const fetchGroupJoinRequests = useCallback(async (roomId: string) => {
    const request = groupRequestRef.current;
    if (request?.id !== roomId) return;
    const { signal } = request.controller;
    setLoadingRequests(true);
    try {
      const res = await apiClient.get(`/chat/groups/${roomId}/requests`, { signal });
      if (!signal.aborted) setJoinRequests(Array.isArray(res.data) ? res.data : []);
    } catch {
      if (!signal.aborted) setJoinRequests([]);
    } finally {
      if (!signal.aborted) setLoadingRequests(false);
    }
  }, []);

  const applyRecalls = useCallback(<T extends ChatMessage | GroupChatMessage,>(list: T[]): T[] => (
    list.map((message) => recalledMessagesRef.current.has(message.id)
      ? { ...message, is_recalled: true, content: '[该消息已撤回]' }
      : message)
  ), []);

  const loadConversationMessages = useCallback(async (convId: string, initial = false) => {
    const request = directRequestRef.current;
    if (request?.id !== convId || directLoadLockRef.current === request) return;
    const { signal } = request.controller;
    const revision = directHistoryRevisionRef.current;
    directLoadLockRef.current = request;
    if (initial) setLoadingMessages(true);
    try {
      const { data } = await apiClient.get<ChatMessage[]>(`/chat/${convId}/messages`, { signal });
      if (!signal.aborted && revision === directHistoryRevisionRef.current && Array.isArray(data)) {
        setMessages((prev) => mergeMessages(prev, applyRecalls(data)));
      }
    } catch {
      // 实时消息仍可用，重连或回到前台时再同步。
    } finally {
      if (directLoadLockRef.current === request) directLoadLockRef.current = null;
      if (initial && !signal.aborted) setLoadingMessages(false);
    }
  }, [applyRecalls]);

  const loadGroupMessages = useCallback(async (roomId: string, mode: 'latest' | 'older' = 'latest', restoreScroll = false) => {
    const request = groupRequestRef.current;
    if (request?.id !== roomId || groupLoadLockRef.current === request) return false;
    const previousPage = groupPageRef.current;
    if (mode === 'older' && (!previousPage || !hasMoreGroupHistoryRef.current)) return false;
    const page = mode === 'older' ? previousPage + 1 : 1;
    const cursor = mode === 'older' ? groupCursorRef.current : null;
    const { signal } = request.controller;
    groupLoadLockRef.current = request;
    const initial = !previousPage;
    if (initial) setLoadingMessages(true);
    try {
      const res = await apiClient.get<GroupChatMessage[]>(`/chat/groups/${roomId}/messages`, {
        signal,
        params: {
          page, size: GROUP_PAGE_SIZE,
          ...(cursor?.token ? { before_cursor: cursor.token } : cursor?.legacySeq ? { before_seq_id: cursor.legacySeq } : {}),
        },
      });
      if (signal.aborted) return false;
      const list = Array.isArray(res.data) ? res.data : [];
      if (initial || mode === 'older') {
        const hasMore = res.headers['x-has-more'] === '1'
          || (res.headers['x-has-more'] === undefined && list.length >= GROUP_PAGE_SIZE);
        const token = res.headers['x-next-history-cursor'];
        const legacySeq = Number(res.headers['x-next-cursor']);
        groupCursorRef.current = typeof token === 'string' && token
          ? { token } : legacySeq > 0 ? { legacySeq } : null;
        groupPageRef.current = page;
        hasMoreGroupHistoryRef.current = hasMore;
        setHasMoreGroupHistory(hasMore);
      }
      if (restoreScroll && groupScrollRef.current) {
        const { scrollTop, scrollHeight } = groupScrollRef.current;
        historyRestoreRef.current = { top: scrollTop, height: scrollHeight };
      }
      setGroupMessages((prev) => mergeMessages(prev, applyRecalls(list)));
      return true;
    } catch {
      return false;
    } finally {
      if (groupLoadLockRef.current === request) groupLoadLockRef.current = null;
      if (initial && !signal.aborted) setLoadingMessages(false);
    }
  }, [applyRecalls]);

  useEffect(() => {
    if (!user) {
      onRequireAuthRef.current?.();
      return;
    }

    isDestroyedRef.current = false;

    // 若从用户主页点击“发私信”传入了目标用户，自动创建或定位该会话
    if (initialPeer) {
      setChatTab('direct');
      const resolveTargetId = async () => {
        if (initialPeer.id) return initialPeer.id;
        const uRes = await apiClient.get(`/users/profile/${initialPeer.username}`);
        return uRes.data.id;
      };

      resolveTargetId()
        .then((targetId) => apiClient.post('/chat/conversations', null, { params: { target_user_id: targetId } }))
        .then((res) => {
          const convId = res.data.conversation_id;
          apiClient.get('/chat/conversations').then((cRes) => {
            setConversations(cRes.data);
            setActiveConvId(convId);
          });
        })
        .catch((err) => {
          toastRef.current?.error(err.response?.data?.detail || '无法建立私聊会话');
        })
        .finally(() => {
          onClearInitialPeerRef.current?.();
        });
    } else {
      // 获取正常会话列表
      apiClient
        .get('/chat/conversations')
        .then((res) => {
          setConversations(res.data);
          const isDesktop = typeof window !== 'undefined' && window.innerWidth >= 768;
          const savedConvId = typeof window !== 'undefined' ? localStorage.getItem('geek_chat_active_conv_id') : null;
          if (savedConvId && res.data.some((c: any) => c.id === savedConvId)) {
            setActiveConvId(savedConvId);
          } else if (isDesktop && res.data.length > 0 && !activeConvId) {
            setActiveConvId(res.data[0].id);
          }
        })
        .catch(() => {});
    }

    fetchGroups();

    // WS 常连：切到后台不再主动断开，避免每次切 tab 都重新握手。
    // 回到前台 / 网络恢复 / 窗口重新聚焦时立即补连（有重复连接保护，是幂等的）。
    const ensureConnected = () => {
      if (isDestroyedRef.current) return;
      reconnectAttemptsRef.current = 0;
      connectWebSocket();
    };
    // 后台期间 WS 可能已经半开（NAT 超时、系统挂起），此时 socket 仍是 OPEN，
    // 只靠重连不会补数据。回到前台时主动补一次同步，避免看到旧会话内容。
    const refreshIfStale = () => {
      if (isDestroyedRef.current) return;
      const now = Date.now();
      if (now - lastVisibleResyncRef.current < 20000) return;
      lastVisibleResyncRef.current = now;
      try {
        resyncRef.current?.();
      } catch {}
    };
    const onWake = () => {
      ensureConnected();
      refreshIfStale();
    };
    const onVisibility = () => {
      if (!document.hidden) onWake();
    };
    document.addEventListener('visibilitychange', onVisibility);
    window.addEventListener('online', onWake);
    window.addEventListener('focus', onWake);

    connectWebSocket();

    // 心跳保活 (每 25 秒)：先发 ping 再判超时。
    // 旧逻辑先判「80 秒没有 pong」并直接 return，于是重连出来的新连接一轮 ping 都没发就被关掉，
    // lastPong 永远停留在旧时间戳 → 每 25 秒断开重连一次，状态灯持续闪烁、消息退化为 HTTP。
    const pingInterval = setInterval(() => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {}
      // 约 3 个心跳周期（90 秒）彻底没有响应才认定半开，单次丢包不再触发重连
      if (Date.now() - lastPongRef.current > 90000) {
        try {
          ws.close();
        } catch {}
      }
    }, 25000);

    return () => {
      isDestroyedRef.current = true;
      document.removeEventListener('visibilitychange', onVisibility);
      window.removeEventListener('online', onWake);
      window.removeEventListener('focus', onWake);
      clearInterval(pingInterval);
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
      // 卸载时清掉输入中提示等零散定时器，避免在已卸载组件上 setState
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
      if (historyRestoreRef.current) clearTimeout(historyRestoreRef.current as any);
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        try {
          ws.close();
        } catch {}
      }
    };
    // 回调统一走 ref，避免父组件重渲染导致 WebSocket 反复重建
  }, [user, initialPeer, connectWebSocket, fetchGroups]);

  // ---------- 连接状态灯 ----------
  // 常驻小圆点：绿=WS 实时通道，黄=降级走 HTTP，灰=离线。
  // 圆点始终渲染，只是颜色变化，不会出现「出现又消失」的闪烁。
  const [isOnline, setIsOnline] = useState<boolean>(
    () => (typeof navigator === 'undefined' ? true : navigator.onLine)
  );
  const [connStatus, setConnStatus] = useState<'ws' | 'http' | 'offline'>('http');

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, []);

  const rawConnStatus: 'ws' | 'http' | 'offline' = !isOnline
    ? 'offline'
    : isWsConnected
    ? 'ws'
    : 'http';

  useEffect(() => {
    // 绿灯/灰灯即时生效；黄灯要持续 2 秒才落地。
    // 弱网下 WS 每秒重连一次的抖动落在 2 秒窗口内时，圆点保持原色不变。
    if (rawConnStatus !== 'http') {
      setConnStatus(rawConnStatus);
      return;
    }
    const timer = setTimeout(() => setConnStatus('http'), 2000);
    return () => clearTimeout(timer);
  }, [rawConnStatus]);

  const visibleConvId = chatTab === 'direct' ? activeConvId : null;
  const visibleGroupId = chatTab === 'group' ? activeGroupId : null;
  useLayoutEffect(() => {
    setShowActionMenu(false);
    setShowEmojiPicker(false);
    setShowMentionPopover(false);
    setSearchOpen(false);
    setSearchLoading(false);
    setSearchResults([]);
    setSearchQuery('');
    setLightboxImg(null);
    setIsTyping(false);
    if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    historyRestoreRef.current = null;
    lastScrollTopRef.current = 0;
    isAtBottomRef.current = true;
    stickUntilRef.current = Date.now() + 3000;
    showBackToBottomRef.current = false;
    setShowBackToBottom(false);
    setNewMessagesWhileAway(0);
    setLoadingMessages(false);
  }, [visibleConvId, visibleGroupId, user?.id]);

  useLayoutEffect(() => {
    setMessages([]);
    if (!visibleConvId || !user?.id) return;
    const request = { id: visibleConvId, controller: new AbortController() };
    directRequestRef.current = request;
    setConversations((prev) => prev.map((c) => (c.id === visibleConvId ? { ...c, unread_count: 0 } : c)));
    void loadConversationMessages(visibleConvId, true);
    return () => {
      directRequestRef.current = null;
      request.controller.abort();
    };
  }, [visibleConvId, user?.id, loadConversationMessages]);

  useLayoutEffect(() => {
    setGroupMessages([]);
    setGroupMembers([]);
    setGroupAnnouncements([]);
    setJoinRequests([]);
    setLoadingMembers(false);
    setLoadingRequests(false);
    setAnnouncementsLoading(false);
    setIsAnnouncementExpanded(false);
    setAnnouncementHistoryOpen(false);
    setAnnouncementDraft('');
    setConfirmingAnnouncementId(null);
    setAnnouncementPublishing(false);
    setIsMembersModalOpen(false);
    setShowLevelBoard(false);
    setLevelBoard(null);
    setLevelBoardError(false);
    setMemberAction(null);
    setBadgeList([]);
    setShowCheckinConfig(false);
    setActivityKind(null);
    setLoadingGroupHistory(false);
    setJumpingToUnread(false);
    groupPageRef.current = 0;
    groupCursorRef.current = null;
    hasMoreGroupHistoryRef.current = false;
    setHasMoreGroupHistory(false);
    if (!visibleGroupId || !user?.id) return;
    const request = { id: visibleGroupId, controller: new AbortController() };
    groupRequestRef.current = request;
    void loadGroupMessages(visibleGroupId);
    void fetchGroupMembers(visibleGroupId);
    void fetchGroupAnnouncements(visibleGroupId);

    const entryUnread = groupsRef.current.find((g) => g.id === visibleGroupId)?.unread_count || 0;
    unreadAtEntryRef.current = entryUnread;
    setUnreadAtEntry(entryUnread);
    setGroups((prev) => prev.map((g) => (g.id === visibleGroupId ? { ...g, unread_count: 0 } : g)));
    apiClient.post(`/chat/groups/${visibleGroupId}/read`, null, { signal: request.controller.signal }).catch(() => {});
    return () => {
      groupRequestRef.current = null;
      request.controller.abort();
    };
  }, [visibleGroupId, user?.id, fetchGroupMembers, fetchGroupAnnouncements, loadGroupMessages]);

  // 进入/切换群聊时订阅房间推送；离开群聊 Tab 时退订，避免持续接收无用帧
  useEffect(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (subscribedRoomRef.current && subscribedRoomRef.current !== visibleGroupId) {
      ws.send(JSON.stringify({ type: 'leave_group', room_id: subscribedRoomRef.current }));
    }
    if (visibleGroupId) ws.send(JSON.stringify({ type: 'join_group', room_id: visibleGroupId }));
    subscribedRoomRef.current = visibleGroupId;
  }, [chatTab, activeGroupId, isWsConnected]);

  // 全局未读 = 私聊未读 + 群聊未读（导航栏红点的唯一数据源，避免两处口径不一致）
  useEffect(() => {
    if (!unreadReadyRef.current) {
      if (conversations.length === 0 && groups.length === 0) return;
      unreadReadyRef.current = true;
    }
    const privateTotal = conversations.reduce((sum, c) => sum + (c.unread_count || 0), 0);
    const groupTotal = groups.reduce((sum, g) => sum + (g.unread_count || 0), 0);
    onUnreadChangeRef.current?.(privateTotal + groupTotal);
  }, [conversations, groups]);

  // 点「↑ N 条未读」：自动向后翻页加载历史（无需手动点加载），
  // 加载够 N 条对应的页数后滚到上次退出时看到的那条消息
  const jumpToUnread = async () => {
    const request = groupRequestRef.current;
    const target = unreadAtEntryRef.current;
    if (!request || target <= 0 || jumpingToUnread || groupLoadLockRef.current === request) return;
    const { signal } = request.controller;
    setJumpingToUnread(true);
    stickUntilRef.current = 0;
    historyRestoreRef.current = null;

    const pagesNeeded = Math.min(9, Math.ceil((target + 1) / GROUP_PAGE_SIZE));
    while (!signal.aborted && groupPageRef.current < pagesNeeded) {
      if (!await loadGroupMessages(request.id, 'older')) break;
    }

    await new Promise((r) => window.setTimeout(r, 320));
    if (signal.aborted) return;
    const container = groupScrollRef.current;
    const nodes = container?.querySelectorAll<HTMLElement>('[data-msg-id]');
    if (container && nodes && nodes.length) {
      const idx = Math.max(0, nodes.length - target - 1);
      const node = nodes[idx];
      container.scrollTop = Math.max(0, node.offsetTop - container.offsetTop - 24);
      programmaticScrollAtRef.current = Date.now();
      isAtBottomRef.current = false;
      showBackToBottomRef.current = true;
      setShowBackToBottom(true);
    }
    setJumpingToUnread(false);
    unreadAtEntryRef.current = 0;
    setUnreadAtEntry(0);
  };

  // 爬完楼一键回到最新消息；若翻过历史页则重新拉最新一页
  const scrollToLatest = () => {
    const el = groupScrollRef.current;
    if (!el) return;
    // 已翻过的历史页保留在列表里，不再整体重拉 page=1（否则回到底部后历史全丢）
    isAtBottomRef.current = true;
    stickUntilRef.current = Date.now() + 3000;
    window.requestAnimationFrame(() => {
      const cur = groupScrollRef.current;
      if (cur) cur.scrollTop = cur.scrollHeight;
    });
    showBackToBottomRef.current = false;
    setShowBackToBottom(false);
    setNewMessagesWhileAway(0);
    // 保留 unreadAtEntry：回到底部后用户仍可再跳回未读位置
  };

  // 断线重连后的补偿同步（WS 不会重放断线期间的消息）
  useEffect(() => {
    resyncRef.current = () => {
      fetchGroups();
      if (visibleGroupId) void loadGroupMessages(visibleGroupId);
      if (visibleConvId) void loadConversationMessages(visibleConvId);
      apiClient
        .get('/chat/conversations')
        .then((res) => {
          if (!Array.isArray(res.data)) return;
          setConversations(res.data);
        })
        .catch(() => {});
    };
  });

  // 向上加载更早的群聊历史
  const loadMoreGroupHistory = async () => {
    const request = groupRequestRef.current;
    if (!request || loadingGroupHistory || !hasMoreGroupHistoryRef.current || groupLoadLockRef.current === request || jumpingToUnread) return;
    setLoadingGroupHistory(true);
    stickUntilRef.current = 0;
    await loadGroupMessages(request.id, 'older', true);
    if (!request.controller.signal.aborted) setLoadingGroupHistory(false);
  };

  // 用户滚动时记录是否仍贴在底部（80px 容差），作为是否自动滚动的依据
  // 点击引用块跳转到被引用的那条消息，并短暂高亮
  const [highlightMsgId, setHighlightMsgId] = useState<string | null>(null);
  const jumpToMessage = (msgId?: string | null) => {
    if (!msgId) return;
    const el = pickVisibleScrollEl();
    const target = el?.querySelector(`[data-msg-id="${msgId}"]`) as HTMLElement | null;
    if (!target) {
      toast.info('这条消息在更早的记录里，继续向上加载就能看到');
      return;
    }
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightMsgId(msgId);
    window.setTimeout(() => setHighlightMsgId((cur) => (cur === msgId ? null : cur)), 1800);
  };

  // 窄屏（手机）判断：用于缩短占位文案、精简头部信息
  // 手机端：点一下某条消息才显示它的操作按钮（回复/撤回/收藏），
  // 避免每条消息右侧都挂着一个箭头，视觉很吵
  const [activeMsgId, setActiveMsgId] = useState<string | null>(null);

  const [isNarrow, setIsNarrow] = useState<boolean>(
    () => typeof window !== 'undefined' && window.innerWidth < 768
  );
  useEffect(() => {
    const onResize = () => setIsNarrow(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // 取当前真正可见的消息容器：刷新恢复时 chatTab 与 DOM 可能短暂不同步，
  // 只看 ref 会贴错容器（贴到隐藏的那个），用户就会停在顶部
  const pickVisibleScrollEl = () => {
    const g = groupScrollRef.current;
    const c = convScrollRef.current;
    if (g && g.offsetParent !== null) return g;
    if (c && c.offsetParent !== null) return c;
    return chatTab === 'group' ? g : c;
  };

  const scrollRafRef = useRef<number | null>(null);
  const handleMsgScroll = (e: React.UIEvent<HTMLDivElement>) => {
    const el = e.currentTarget;
    // 滚动事件用 rAF 合并：高频滚动时一帧只做一次 layout 读取，
    // 避免每次 scroll 都强制同步布局造成掉帧
    if (scrollRafRef.current !== null) return;
    scrollRafRef.current = window.requestAnimationFrame(() => {
      scrollRafRef.current = null;
      runMsgScroll(el);
    });
  };

  const runMsgScroll = (el: HTMLDivElement) => {
    const top = el.scrollTop;
    const prevTop = lastScrollTopRef.current;
    lastScrollTopRef.current = top;

    // 关键：只有滚动位置真的变了才更新"是否在底部"。
    // 消息追加 / 图片加载会撑高列表并触发 scroll 事件，但 scrollTop 不变，
    // 以前会被误判成"用户爬楼"，于是刷新后停在顶部再也不贴底。
    if (Math.abs(top - prevTop) > 2) {
      isAtBottomRef.current = el.scrollHeight - top - el.clientHeight < 80;
      if (!isAtBottomRef.current) stickUntilRef.current = 0;
    }
    // 爬楼时显示「回到底部」（群聊 / 私聊共用）
    const away = el.scrollHeight - top - el.clientHeight > 200;
    if (showBackToBottomRef.current !== away) {
      showBackToBottomRef.current = away;
      setShowBackToBottom(away);
      // 开始爬楼 / 回到底部：新增消息角标都从 0 重新计
      setNewMessagesWhileAway(0);
    }

    // 「↑ N 条未读」是一次性的历史跳转入口，不随滚动消失。
    // 只在「点了它 / 手动关闭 / 切换会话」时才收起；滚动只负责右下角的回到底部箭头。
    // 滚到接近顶部时自动拉更早的历史（微信/QQ 的做法），不用再点按钮。
    // loadingGroupHistory 本身就防重入，一次触底只会发一个请求。
    // 历史消息改为「手动加载更多」：上滑不再自动翻页，
    // 避免加载时列表跳动，以及未读提示条与自动加载互相打断。
  };

  // 首次加载 / 切会话 / 切回聊天页：在浏览器绘制之前把滚动条设到底部。
  // 用 scrollTop 而不是 scrollIntoView，既能避免"从顶部滚到底"的动画，
  // 也不会把整页一起滚动。
  useLayoutEffect(() => {
    if (!isActive) return;
    const el = pickVisibleScrollEl();
    if (!el) return;

    // 1) 向上加载历史：把用户原本看到的那条消息挪回屏幕原位置。
    //    在绘制前完成，不会出现"闪一下再跳"。
    if (historyRestoreRef.current) {
      const snap = historyRestoreRef.current;
      historyRestoreRef.current = null;
      el.scrollTop = snap.top + (el.scrollHeight - snap.height);
      programmaticScrollAtRef.current = Date.now();
      return;
    }

    // 2) 贴底条件：仍在「刚进入会话」的时间窗内，或者用户本来就贴着底部。
    //    后者很关键 —— 刷新后头像、表情图片是陆续加载的，列表高度会持续变高；
    //    只在时间窗内贴底的话，图片晚一点加载完就会停在中间。
    const inEntryWindow = Date.now() < stickUntilRef.current;
    if (!inEntryWindow && !isAtBottomRef.current) return;
    // 用户已经自己滑走了：立刻终止贴底，别再把他拽回来
    if (!isAtBottomRef.current && !inEntryWindow) return;

    el.scrollTop = el.scrollHeight;
    programmaticScrollAtRef.current = Date.now();
  }, [isActive, chatTab, messages, groupMessages]);

  // 常驻高度观察：内容变高（图片加载、消息追加）时，
  // 只要用户还贴着底部就继续贴底；一旦爬楼立即停手。
  useEffect(() => {
    if (!isActive) return;
    const el = pickVisibleScrollEl();
    if (!el) return;
    const inner = el.firstElementChild as HTMLElement | null;
    const ro = new ResizeObserver(() => {
      if (!isAtBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
      programmaticScrollAtRef.current = Date.now();
    });
    try {
      ro.observe(inner || el);
    } catch {}
    return () => ro.disconnect();
  }, [isActive, chatTab, activeConvId, activeGroupId]);

  // 切群 / 从别的页面切回聊天：直接停在最新消息（即使期间没有新消息）
  useLayoutEffect(() => {
    if (!isActive) return;
    const el = pickVisibleScrollEl();
    if (!el) return;
    isAtBottomRef.current = true;
    stickUntilRef.current = Date.now() + 3000;
    el.scrollTop = el.scrollHeight;
    lastScrollTopRef.current = el.scrollTop;
    programmaticScrollAtRef.current = Date.now();
  }, [isActive, chatTab, activeConvId, activeGroupId]);

  // 新消息到达时：仅在用户本来就贴着底部的情况下平滑跟随
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = chatTab === 'group' ? groupScrollRef.current : convScrollRef.current;
    el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    // isTyping 不再触发：对方正在输入时不应打断正在阅读历史的用户
  }, [messages, groupMessages, chatTab]);

  // 软键盘适配：仅当可视高度明显小于窗口高度（即键盘弹起）时才收缩容器
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const apply = () => setVvHeight(vv.height);
    apply();
    vv.addEventListener('resize', apply);
    vv.addEventListener('scroll', apply);
    return () => {
      vv.removeEventListener('resize', apply);
      vv.removeEventListener('scroll', apply);
    };
  }, []);

  // @ 艾特过滤成员列表
  const filteredMentionMembers = React.useMemo(() => {
    if (mentionQuery === null) return groupMembers;
    const q = mentionQuery.toLowerCase();
    return groupMembers.filter((m) => {
      const matchUser = m.username.toLowerCase().includes(q);
      const matchNick = m.nickname ? m.nickname.toLowerCase().includes(q) : false;
      return matchUser || matchNick;
    });
  }, [groupMembers, mentionQuery]);

  // 群主 / 管理员才可以用 @全体成员（服务端同样会二次校验）
  const activeGroupRole = activeGroupId
    ? groups.find((g) => g.id === activeGroupId)?.my_role
    : null;
  const canMentionAll = Boolean(
    activeGroupRole === 'owner' ||
      activeGroupRole === 'admin' ||
      ['super_admin', 'admin'].includes(user?.role || '')
  );
  const MENTION_ALL_ID = '__mention_all__';

  // 候选列表顺序：AI 机器人（大肥鱼）→ 全体成员 → 其余成员。
  // 键盘上下选择也走同一份列表，索引与视觉顺序一致。
  type MentionCandidate = GroupMemberItem & { is_all?: boolean };
  const mentionCandidates = React.useMemo<MentionCandidate[]>(() => {
    const members: MentionCandidate[] = filteredMentionMembers.map((m) => ({ ...m }));
    // AI 机器人永远置顶，连「全体成员」都排在它后面
    const bots = members.filter((m) => m.is_bot);
    const humans = members.filter((m) => !m.is_bot);
    const list: MentionCandidate[] = [...bots];

    if (canMentionAll) {
      const q = (mentionQuery || '').toLowerCase();
      const matched =
        !q ||
        '全体成员'.includes(q) ||
        '所有人'.toLowerCase().includes(q) ||
        'all'.includes(q);
      if (matched) {
        list.push({
          user_id: MENTION_ALL_ID,
          username: MENTION_ALL_ID,
          nickname: '全体成员',
          avatar_url: '',
          level: 0,
          role: 'member',
          joined_at: '',
          is_all: true,
        });
      }
    }

    list.push(...humans);
    return list;
  }, [filteredMentionMembers, canMentionAll, mentionQuery]);

  // 打开 @ 面板时查一次 @全体成员 今日剩余额度
  useEffect(() => {
    if (!showMentionPopover || !canMentionAll || !activeGroupId) return;
    apiClient
      .get(`/chat/groups/${activeGroupId}/mention-all-quota`)
      .then((res) => setMentionAllQuota(res.data))
      .catch(() => setMentionAllQuota(null));
  }, [showMentionPopover, canMentionAll, activeGroupId]);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const val = e.target.value;
    setInputText(val);
    autoGrowTextarea(e.currentTarget);

    if (chatTab === 'group') {
      const cursor = e.target.selectionStart || val.length;
      const textBeforeCursor = val.slice(0, cursor);
      const match = /@([a-zA-Z0-9_\u4e00-\u9fa5]*)$/.exec(textBeforeCursor);
      if (match) {
        setMentionQuery(match[1]);
        setShowMentionPopover(true);
        setMentionIndex(0);
        if (groupMembers.length === 0 && activeGroupId) {
          fetchGroupMembers(activeGroupId);
        }
      } else {
        setShowMentionPopover(false);
        setMentionQuery(null);
      }
    } else {
      setShowMentionPopover(false);
      const activeConv = conversations.find((c) => c.id === activeConvId);
      // 输入中状态节流：每 2 秒最多发送一次，避免每个按键都产生一帧
      const now = Date.now();
      if (
        wsRef.current &&
        wsRef.current.readyState === WebSocket.OPEN &&
        activeConv &&
        now - typingSentAtRef.current > 2000
      ) {
        typingSentAtRef.current = now;
        wsRef.current.send(
          JSON.stringify({
            type: 'typing',
            conversation_id: activeConvId,
            receiver_id: activeConv.peer_user_id,
          })
        );
      }
    }
  };

  const handleSelectMention = (member: GroupMemberItem) => {
    const cursor = inputRef.current?.selectionStart || inputText.length;
    const textBeforeCursor = inputText.slice(0, cursor);
    const textAfterCursor = inputText.slice(cursor);
    const mentionName = (member as any).is_all ? '全体成员' : member.nickname || member.username;
    const newBefore = textBeforeCursor.replace(/@([a-zA-Z0-9_.\-\u4e00-\u9fa5]*)$/, `@${mentionName} `);
    setInputText(newBefore + textAfterCursor);
    setShowMentionPopover(false);
    setMentionQuery(null);
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        const nextPos = newBefore.length;
        inputRef.current.setSelectionRange(nextPos, nextPos);
      }
    }, 10);
  };

  // 切换会话后草稿内容变化，重新按内容撑开输入框高度
  useEffect(() => {
    autoGrowTextarea(inputRef.current);
  }, [draftKey, chatTab]);

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (showMentionPopover && mentionCandidates.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setMentionIndex((prev) => (prev + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setMentionIndex((prev) => (prev - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = mentionCandidates[mentionIndex] || mentionCandidates[0];
        if (selected) {
          handleSelectMention(selected);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowMentionPopover(false);
        return;
      }
    }

    // textarea 不会像 input 那样回车提交表单，这里显式触发；
    // Shift+Enter 保留换行，输入法组合中（中文拼音未上屏）不拦截
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      (e.currentTarget.form as HTMLFormElement | null)?.requestSubmit();
    }
  };

  // 键盘上下选择 @ 成员时，把选中项滚进可视区
  const mentionItemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  useEffect(() => {
    if (!showMentionPopover) return;
    mentionItemRefs.current[mentionIndex]?.scrollIntoView({ block: 'nearest' });
  }, [mentionIndex, showMentionPopover]);

  const handleQuickMention = (targetUsername: string) => {
    if (chatTab !== 'group') return;
    // 优先插入可修改的昵称：username 里可能带 - 或很长，直接 @ 用户名显示很难看
    const display = (memberByUsername.get(targetUsername)?.nickname || '').trim() || targetUsername;
    setInputText((prev) => {
      const trimmed = prev.trim();
      return trimmed ? `${trimmed} @${display} ` : `@${display} `;
    });
    inputRef.current?.focus();
  };

  // 渲染带有 @高亮 的消息内容
  const renderMessageContent = (
    content: string,
    currentUsername?: string,
    validUsernames?: Set<string> | null,
    nickMap?: Record<string, string>,
    nickToUsername?: Record<string, string> | null
  ) => {
    // 自定义表情：整条消息内容就是一张本站上传图片的地址，直接渲染成图片
    const trimmed = (content || '').trim();
    if (STICKER_URL_RE.test(trimmed)) {
      return (
        <div className="relative inline-block group/sticker">
          <SafeImage
            src={trimmed}
            compatiblePreview
            loading="eager"
            alt="表情"
            onClick={(e) => {
              e.stopPropagation();
              setLightboxImg(trimmed);
            }}
            className="w-[140px] h-[140px] max-w-[140px] max-h-[140px] object-contain bg-wb-bg-subtle/60 rounded-lg cursor-zoom-in"
          />
          {/* 收藏别人的表情：群里/私聊里看到喜欢的直接收进自己的表情面板 */}
          <button
            type="button"
            title="收藏到我的表情"
            onClick={async (e) => {
              e.stopPropagation();
              try {
                await apiClient.post('/stickers/collect', { url: trimmed });
                toast.success('已收藏到「我的表情」');
              } catch (err: any) {
                toast.error(err?.response?.data?.detail || '收藏失败（可能已达 60 个上限）');
              }
            }}
            className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-wb-text-primary text-wb-bg-page flex items-center justify-center shadow opacity-0 group-hover/sticker:opacity-100 max-sm:opacity-80 transition-opacity"
          >
            <Plus className="w-3 h-3" />
          </button>
        </div>
      );
    }

    // 粘贴图片后补了文字一起发：从任意文本里提取图片地址渲染成缩略图，
    // 不依赖换行符（空格分隔、历史数据里的字面 \n 都能识别）
    const IMG_IN_TEXT_RE = IMG_IN_TEXT_RE_G;
    const urls = trimmed.match(IMG_IN_TEXT_RE) || [];
    const textPart = trimmed.replace(IMG_IN_TEXT_RE, '').replace(/\\n/g, ' ').trim();
    if (urls.length > 0 && textPart.length > 0) {
      return (
        <div className="space-y-1">
          <p className="whitespace-pre-wrap break-words">{textPart}</p>
          {urls.map((u, i) => (
            <SafeImage
              key={i}
              src={u}
              alt="图片"
              onClick={(e) => { e.stopPropagation(); setLightboxImg(u); }}
              className="w-[160px] h-[120px] object-contain rounded-lg cursor-zoom-in"
            />
          ))}
        </div>
      );
    }

    // 用户名允许 - 和 .（如 dalian-tongzhi-instrumen），正则漏掉会让 @ 只匹配到前半段
    const mentionRegex = /@([a-zA-Z0-9_.\-\u4e00-\u9fa5]+)/g;
    const parts: React.ReactNode[] = [];
    let lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = mentionRegex.exec(content)) !== null) {
      if (match.index > lastIndex) {
        parts.push(content.substring(lastIndex, match.index));
      }
      const targetName = match[1];
      // @全体成员：不是真实用户名，单独用醒目样式渲染
      if (targetName === '全体成员') {
        parts.push(
          <span
            key={match.index}
            className="inline-flex items-center px-1.5 py-0.5 rounded-md text-2xs font-bold mx-0.5 bg-wb-danger/15 text-wb-danger border border-wb-danger/30"
          >
            @全体成员
          </span>
        );
        lastIndex = match.index + match[0].length;
        continue;
      }
      // 白名单存在时，没匹配到真实成员就原样输出，不做 @ 染色
      if (validUsernames && !validUsernames.has(targetName.toLowerCase())) {
        parts.push(match[0]);
        lastIndex = match.index + match[0].length;
        continue;
      }
      const realUsername = nickToUsername?.[targetName.toLowerCase()] || targetName;
      const isMe = currentUsername && realUsername.toLowerCase() === currentUsername.toLowerCase();

      parts.push(
        <span
          key={match.index}
          onClick={(e) => {
            e.stopPropagation();
            onSelectUser?.(realUsername);
          }}
          className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-2xs font-semibold cursor-pointer mx-0.5 transition-colors ${
            isMe
              ? 'bg-wb-warn/25 text-wb-warn dark:text-wb-warn border border-wb-warn/40 ring-1 ring-wb-warn/20 shadow-xs'
              : 'bg-wb-info/15 text-wb-info dark:text-wb-info border border-wb-info/20 hover:bg-wb-info/25'
          }`}
          title={`查看 @${targetName} 的个人主页`}
        >
          @{nickMap?.[targetName.toLowerCase()] || targetName}
          {isMe && <span className="ml-0.5 text-3xs opacity-80">(你)</span>}
        </span>
      );
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex < content.length) {
      parts.push(content.substring(lastIndex));
    }

    return parts.length > 0 ? parts : content;
  };

  const uploadLocksRef = useRef(new Set<string>());
  // 选择、粘贴和拖放共用待发送附件，上传结果始终归入开始上传时的会话。
  const uploadPendingImage = async (file: File) => {
    if (!(chatTab === 'group' ? activeGroupId : activeConvId) || !file?.type.startsWith('image/') || uploadLocksRef.current.has(draftKey)) return;
    const invalid = validateUploadFile(file);
    if (invalid) {
      toast.error(invalid);
      return;
    }
    uploadLocksRef.current.add(draftKey);
    updateComposer({ pendingImageUploading: true, uploadPercent: 0 });
    try {
      const compressed = await precompressImage(file, 1280, 0.78);
      const fd = new FormData();
      fd.append('file', compressed);
      const res = await apiClient.post('/posts/upload-image', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
        timeout: UPLOAD_TIMEOUT,
        onUploadProgress: (e) => {
          if (e.total) updateComposer({ uploadPercent: Math.min(99, Math.round((e.loaded / e.total) * 100)) });
        },
      });
      if (res.data?.url) setPendingImageUrl(res.data.url);
    } catch (err: any) {
      if (currentDraftKeyRef.current === draftKey) toast.error(err?.response?.data?.detail || '图片上传失败');
    } finally {
      uploadLocksRef.current.delete(draftKey);
      updateComposer({ pendingImageUploading: false, uploadPercent: 0 });
    }
  };

  // 拖拽图片上传（私聊 / 群聊两个输入区共用一套视觉反馈，与 Ctrl+V 互不冲突）
  const imageDrop = useImageDrop((file) => { void uploadPendingImage(file); });

  // 双通道消息发送 (私聊 & 群聊统一处理)
  // overrideContent：发送自定义表情时直接传图片地址，不经过输入框，也不污染草稿
  const handleSendMessage = async (e?: React.FormEvent, overrideContent?: string) => {
    e?.preventDefault();
    const request = chatTab === 'group' ? groupRequestRef.current : directRequestRef.current;
    if (!request || currentDraftKeyRef.current !== draftKey || isSending || (!overrideContent && pendingImageUploading)) return;
    const { signal } = request.controller;
    const attachment = overrideContent ? null : pendingImageUrl;
    const text = (overrideContent ?? inputText).trim();
    const content = attachment ? [text, attachment].filter(Boolean).join('\n') : text;
    if (!content) return;
    if (attachment) setPendingImageUrl(null);
    const trackWebSocketSend = (clientMsgId: string) => {
      const pending = pendingSendsRef.current;
      pending.set(clientMsgId, { draftKey, restoreDraft });
      window.setTimeout(() => { pending.delete(clientMsgId); }, 60_000);
    };
    const restoreDraft = () => {
      if (overrideContent) return;
      setInputText((prev) => prev || text);
      if (attachment) {
        setComposerStates((prev) => prev[draftKey]?.pendingImageUrl ? prev : {
          ...prev, [draftKey]: { ...prev[draftKey], pendingImageUrl: attachment },
        });
      }
    };

    if (chatTab === 'group') {
      if (!activeGroupId) return;
      const clientMsgId = `gc_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;

      // 发送表情图片时不动输入框里的草稿
      if (!overrideContent) setInputText('');
      setShowEmojiPicker(false);
      setIsSending(true);
      setReplyTarget(null);

      // 乐观 UI 预先插入，让群聊发送即时呈现，杜绝延迟感知
      const optimisticMsg: GroupChatMessage = {
        id: clientMsgId,
        room_id: activeGroupId,
        sender_id: user?.id || '',
        sender_username: user?.username || '',
        sender_nickname: user?.nickname || user?.username || '',
        sender_avatar: user?.avatar_url || '',
        sender_level: user?.level || 1,
        content,
        msg_type: 'text',
        seq_id: 0,
        is_recalled: false,
        created_at: new Date().toISOString(),
        reply_to_id: replyTarget?.id || null,
        reply_sender: replyTarget?.sender || '',
        reply_snippet: replyTarget?.snippet || '',
      };
      setGroupMessages((prev) => [...prev, optimisticMsg]);
      setGroups((prev) =>
        prev.map((g) =>
          g.id === activeGroupId
            ? {
                ...g,
                last_message_preview: `${user?.nickname || user?.username}: ${content}`,
                last_message_at: new Date().toISOString(),
              }
            : g
        )
      );
      // 主动发消息时无条件回到底部（只滚动消息容器，不动整页）
      isAtBottomRef.current = true;
      window.requestAnimationFrame(() => {
        const el = groupScrollRef.current;
        el?.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
      });

      // 1. 群聊 WebSocket 优先
      if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
        try {
          wsRef.current.send(
            JSON.stringify({
              type: 'group_msg',
              room_id: activeGroupId,
              content,
              client_msg_id: clientMsgId,
              reply_to_message_id: replyTarget?.id || undefined,
            })
          );
          trackWebSocketSend(clientMsgId);
          setIsSending(false);
          return;
        } catch {}
      }

      // 2. 群聊 HTTP 降级
      try {
        const res = await apiClient.post(`/chat/groups/${activeGroupId}/messages`, {
          content,
          client_msg_id: clientMsgId,
          reply_to_message_id: replyTarget?.id || undefined,
        });
        if (currentDraftKeyRef.current === draftKey) {
          setGroupMessages((prev) => mergeMessages(prev, applyRecalls([res.data]), clientMsgId));
        }
      } catch (err: any) {
        if (!signal.aborted) {
          setGroupMessages((prev) => prev.filter((m) => m.id !== clientMsgId));
          toast.error(err.response?.data?.detail || '群消息发送失败');
        }
        restoreDraft();
      } finally {
        setIsSending(false);
      }
      return;
    }

    // ---------- 私聊发送 ----------
    if (!activeConvId) return;

    const clientMsgId = `c_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    if (!overrideContent) setInputText('');
    setReplyTarget(null);
    setShowEmojiPicker(false);
    setIsSending(true);

    // 乐观 UI
    const optimisticMsg: ChatMessage = {
      id: clientMsgId,
      conversation_id: activeConvId,
      sender_id: user?.id || '',
      msg_type: 'text',
      content,
      seq_id: 0,
      is_read: false,
      is_recalled: false,
      created_at: new Date().toISOString(),
    };
    // 主动发消息时无条件回到底部
    isAtBottomRef.current = true;
    setMessages((prev) => [...prev, optimisticMsg]);
    setConversations((prev) =>
      prev.map((c) =>
        c.id === activeConvId
          ? { ...c, last_message_preview: content, last_message_at: new Date().toISOString() }
          : c
      )
    );

    // WebSocket 优先
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      try {
        wsRef.current.send(
          JSON.stringify({
            type: 'msg',
            conversation_id: activeConvId,
            content,
            client_msg_id: clientMsgId,
            reply_to_message_id: replyTarget?.id || undefined,
          })
        );
        trackWebSocketSend(clientMsgId);
        setIsSending(false);
        return;
      } catch {}
    }

    // HTTP 降级通道
    try {
      const res = await apiClient.post(`/chat/${activeConvId}/messages`, {
        content,
        reply_to_message_id: replyTarget?.id || undefined,
      });
      if (currentDraftKeyRef.current === draftKey) {
        setMessages((prev) => mergeMessages(prev, applyRecalls([res.data]), clientMsgId));
      }
    } catch (err: any) {
      if (!signal.aborted) {
        setMessages((prev) => prev.filter((m) => m.id !== clientMsgId));
        toast.error(err.response?.data?.detail || '消息发送失败，请稍后重试');
      }
      restoreDraft();
    } finally {
      setIsSending(false);
    }
  };

  // 插入表情
  const handleInsertEmoji = (emoji: string) => {
    setInputText((prev) => prev + emoji);
    if (inputRef.current) {
      inputRef.current.focus();
    }
  };

  // 撤回私聊消息
  const handleRecall = async (msgId: string) => {
    // 先记下原文，撤回后气泡只剩「已撤回」，重新编辑要靠这份快照
    rememberRecalledContent(msgId, messages.find((m) => m.id === msgId)?.content);
    try {
      await apiClient.post(`/chat/messages/${msgId}/recall`);
      recalledMessagesRef.current.add(msgId);
      setMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, is_recalled: true, content: '[该消息已撤回]' } : m))
      );
      if (activeConvId) {
        setConversations((prev) =>
          prev.map((c) => (c.id === activeConvId ? { ...c, last_message_preview: '[该消息已撤回]' } : c))
        );
      }
      toast.info('已撤回一条消息');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '无法撤回此消息');
    }
  };

  // 撤回群聊消息 (发送者2分钟内或群主/管理员)
  const handleRecallGroupMessage = async (msgId: string) => {
    if (!activeGroupId) return;
    rememberRecalledContent(msgId, groupMessages.find((m) => m.id === msgId)?.content);
    try {
      await apiClient.post(`/chat/groups/${activeGroupId}/messages/${msgId}/recall`);
      recalledMessagesRef.current.add(msgId);
      setGroupMessages((prev) =>
        prev.map((m) => (m.id === msgId ? { ...m, is_recalled: true, content: '[该消息已撤回]' } : m))
      );
      setGroups((prev) =>
        prev.map((g) => (g.id === activeGroupId ? { ...g, last_message_preview: '[该消息已撤回]' } : g))
      );
      toast.info('群消息已撤回');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '无法撤回此群消息');
    }
  };

  // 撤回消息「重新编辑」：把撤回前的原文回填输入框，用户改完再发
  const handleReeditRecalled = async (msgId: string, scope: 'direct' | 'group') => {
    let content = recalledOriginalsRef.current.get(msgId) || '';
    if (!content) {
      try {
        // 刷新/换设备后本地快照丢失，向服务端取回自己撤回的原文
        const res = scope === 'group' && activeGroupId
          ? await apiClient.get(`/chat/groups/${activeGroupId}/messages/${msgId}/original`)
          : await apiClient.get(`/chat/messages/${msgId}/original`);
        content = String(res.data?.content || '');
      } catch (err: any) {
        toast.error(err?.response?.data?.detail || '原文已不可用，无法重新编辑');
        return;
      }
    }
    if (!content.trim()) {
      toast.error('原文已不可用，无法重新编辑');
      return;
    }
    recalledOriginalsRef.current.set(msgId, content);
    setInputText(content);
    setReplyTarget(null);
    setShowEmojiPicker(false);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (!el) return;
      el.focus();
      try {
        el.setSelectionRange(content.length, content.length);
      } catch {}
    });
    toast.info('已回填原始内容，编辑后可重新发送');
  };

  // 拉黑 / 解除拉黑用户
  const handleToggleBlock = async (targetUsername: string, currentBlocked: boolean) => {
    try {
      if (currentBlocked) {
        await apiClient.delete(`/users/${targetUsername}/block`);
        setConversations((prev) =>
          prev.map((c) => (c.peer_username === targetUsername ? { ...c, is_blocked: false } : c))
        );
        toast.info(`已解除对 @${targetUsername} 的拉黑`);
      } else {
        const ok = await confirmModal({
          title: '拉黑用户',
          description: `确定要拉黑用户 @${targetUsername} 吗？拉黑后对方将无法向您发送私信，且您也将无法向对方发送消息。`,
          confirmText: '确认拉黑',
          danger: true,
        });
        if (!ok) return;
        await apiClient.post(`/users/${targetUsername}/block`);
        setConversations((prev) =>
          prev.map((c) => (c.peer_username === targetUsername ? { ...c, is_blocked: true } : c))
        );
        toast.warning(`已拉黑用户 @${targetUsername}`);
      }
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '操作失败');
    }
  };

  // 清空会话聊天记录
  const handleClearMessages = async (convId: string) => {
    const ok = await confirmModal({
      title: '清空聊天记录',
      description: '确定要清空该会话的所有聊天记录吗？此操作不可撤销。',
      confirmText: '清空记录',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/chat/conversations/${convId}/messages`);
      if (directRequestRef.current?.id === convId) {
        directHistoryRevisionRef.current += 1;
        setMessages([]);
      }
      setConversations((prev) =>
        prev.map((c) => (c.id === convId ? { ...c, last_message_preview: '' } : c))
      );
      toast.info('已清空聊天记录');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '清空聊天记录失败');
    }
  };

  // 删除私聊会话
  const handleDeleteConversation = async (convId: string) => {
    const ok = await confirmModal({
      title: '删除私聊会话',
      description: '确定要删除此私聊会话吗？会话记录和历史消息都将被移除。',
      confirmText: '删除会话',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/chat/conversations/${convId}`);
      setConversations((prev) => {
        const nextList = prev.filter((c) => c.id !== convId);
        if (activeConvId === convId) {
          setActiveConvId(nextList.length > 0 ? nextList[0].id : null);
        }
        return nextList;
      });
      // 同步移除置顶状态
      setPinnedConvIds((prev) => prev.filter((id) => id !== convId));
      toast.info('已删除私聊会话');
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '删除会话失败');
    }
  };

  // 发起新私聊对话
  const handleStartNewChat = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const target = newChatTargetUsername.trim().replace(/^@/, '');
    if (!target) {
      toast.warning('请输入目标用户名');
      return;
    }
    if (user && target.toLowerCase() === user.username.toLowerCase()) {
      toast.warning('不可与自己发起私聊');
      return;
    }

    try {
      setIsStartingChat(true);
      const uRes = await apiClient.get(`/users/profile/${target}`);
      const targetUser = uRes.data;
      if (!targetUser || !targetUser.id) {
        toast.error('未找到该极客用户，请核对用户名');
        return;
      }

      const convRes = await apiClient.post(`/chat/conversations?target_user_id=${targetUser.id}`);
      const convData = convRes.data;
      // 后端返回字段为 conversation_id，此前误用 id 导致新建私聊后无法进入会话
      const newConvId: string | undefined = convData?.conversation_id || convData?.id;

      if (!newConvId) {
        toast.error('发起私聊失败，请稍后重试');
        return;
      }

      setConversations((prev) => {
        const exists = prev.find((c) => c.id === newConvId);
        if (exists) return prev;
        const newConvItem: ConversationItem = {
          id: newConvId,
          peer_user_id: targetUser.id,
          peer_username: targetUser.username,
          peer_nickname: targetUser.nickname,
          peer_avatar: targetUser.avatar_url,
          last_message_preview: convData.last_message_preview || '',
          last_message_at: convData.last_message_at || new Date().toISOString(),
          unread_count: 0,
          is_blocked: false,
          is_blocked_by_peer: false,
        };
        return [newConvItem, ...prev];
      });

      setActiveConvId(newConvId);
      localStorage.setItem('geek_chat_active_conv_id', newConvId);
      setChatTab('direct');
      localStorage.setItem('geek_chat_active_tab', 'direct');
      setIsNewChatModalOpen(false);
      setNewChatTargetUsername('');
      toast.success(`已开启与 @${targetUser.nickname || targetUser.username} 的私聊`);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '发起私聊失败，请确认用户名是否正确');
    } finally {
      setIsStartingChat(false);
    }
  };

  // 创建新群聊频道
  const handleCreateGroup = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newGroupName.trim()) {
      toast.warning('请输入群聊名称');
      return;
    }
    setIsCreatingGroup(true);
    try {
      const res = await apiClient.post('/chat/groups', {
        name: newGroupName.trim(),
        description: newGroupDesc.trim(),
        is_public: newGroupIsPublic,
      });
      setGroups((prev) => [res.data, ...prev.filter((g) => g.id !== res.data.id)]);
      setActiveGroupId(res.data.id);
      localStorage.setItem('geek_chat_active_group_id', res.data.id);
      setChatTab('group');
      localStorage.setItem('geek_chat_active_tab', 'group');
      setGroupFilter('all');
      setIsGroupModalOpen(false);
      setNewGroupName('');
      setNewGroupDesc('');
      toast.success(`${newGroupIsPublic ? '公共频道' : '私密好友群'}「${res.data.name}」已成功创建！`);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '创建群聊失败');
    } finally {
      setIsCreatingGroup(false);
    }
  };

  // 打开群成员与管理面板
  const handleOpenMembersModal = () => {
    if (!activeGroupId) return;
    setMembersModalTab('members');
    setIsMembersModalOpen(true);
    fetchGroupMembers(activeGroupId);
    const isOwnerOrAdmin =
      activeGroup?.my_role === 'owner' ||
      activeGroup?.my_role === 'admin' ||
      ['super_admin', 'admin'].includes(user?.role || '');
    if (isOwnerOrAdmin) {
      fetchGroupJoinRequests(activeGroupId);
    }
  };

  // 邀请用户入群
  const handleInviteUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGroupId || !inviteUsername.trim() || isInviting) return;
    setIsInviting(true);
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/invite`, {
        username: inviteUsername.trim(),
      });
      toast.success(res.data?.message || '成功邀请成员');
      setInviteUsername('');
      fetchGroupMembers(activeGroupId);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '邀请失败');
    } finally {
      setIsInviting(false);
    }
  };

  // 审批通过入群申请 (群主/管理员)
  const handleApproveRequest = async (requestId: string) => {
    if (!activeGroupId) return;
    setHandlingRequestId(requestId);
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/requests/${requestId}/approve`);
      toast.success(res.data?.message || '已同意入群申请');
      setJoinRequests((prev) => prev.filter((r) => r.id !== requestId));
      fetchGroupMembers(activeGroupId);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '审批失败');
    } finally {
      setHandlingRequestId(null);
    }
  };

  // 拒绝入群申请 (群主/管理员)
  const handleRejectRequest = async (requestId: string) => {
    if (!activeGroupId) return;
    setHandlingRequestId(requestId);
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/requests/${requestId}/reject`);
      toast.info(res.data?.message || '已拒绝入群申请');
      setJoinRequests((prev) => prev.filter((r) => r.id !== requestId));
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '操作失败');
    } finally {
      setHandlingRequestId(null);
    }
  };

  // 普通用户提交入群申请
  const handleSubmitApply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGroupId || isSubmittingApply) return;
    setIsSubmittingApply(true);
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/apply`, {
        reason: applyReason.trim(),
      });
      toast.success(res.data?.message || '入群申请已提交，请等待管理员审核');
      setIsApplyModalOpen(false);
      setApplyReason('');
      setGroups((prev) =>
        prev.map((g) => (g.id === activeGroupId ? { ...g, has_pending_apply: true } : g))
      );
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '提交申请失败');
    } finally {
      setIsSubmittingApply(false);
    }
  };

  // 打开编辑群资料与群公告弹窗
  const handleOpenEditGroupModal = () => {
    if (!activeGroup) return;
    setEditGroupName(activeGroup.name);
    setEditGroupDesc(activeGroup.description || '');
    setEditGroupAnnouncement(activeGroup.announcement || '');
    setEditGroupAvatar((activeGroup as any).avatar_url || '');
    setIsEditGroupModalOpen(true);
  };

  // 保存群资料与群公告
  const handleSaveGroupInfo = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!activeGroupId || !editGroupName.trim() || isSavingGroup) return;
    setIsSavingGroup(true);
    try {
      const isOwnerNow = (myGroupRole || activeGroup?.my_role) === 'owner';
      const res = await apiClient.put(`/chat/groups/${activeGroupId}`, {
        name: editGroupName.trim(),
        description: editGroupDesc.trim(),
        announcement: editGroupAnnouncement.trim(),
        // 群头像只由群主提交，其它角色后端也会拒绝
        ...(isOwnerNow ? { avatar_url: editGroupAvatar } : {}),
      });
      const updated: GroupRoomItem = res.data;
      setGroups((prev) => prev.map((g) => (g.id === activeGroupId ? { ...g, ...updated } : g)));
      toast.success('群资料与群公告已成功更新');
      setIsEditGroupModalOpen(false);
      fetchGroups();
      // 公告内容有改动时会落一条新的历史公告，这里同步刷新置顶与历史列表
      fetchGroupAnnouncements(activeGroupId);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '更新群信息失败');
    } finally {
      setIsSavingGroup(false);
    }
  };

  // 移出群成员 (踢人)
  const handleKickMember = async (targetUserId: string, targetUsername: string) => {
    if (!activeGroupId) return;
    const ok = await confirmModal({
      title: '移出群成员',
      description: `确定将成员 @${targetUsername} 移出本群聊吗？`,
      confirmText: '移出成员',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/kick`, {
        user_id: targetUserId,
      });
      toast.success(res.data?.message || '已移出该成员');
      fetchGroupMembers(activeGroupId);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '移出成员失败');
    }
  };

  // 群主转让：把群主身份交给指定成员，原群主降为管理员
  const handleTransferOwner = async (targetUserId: string, targetUsername: string) => {
    if (!activeGroupId) return;
    const ok = await confirmModal({
      title: '转让群主',
      description: `确定把群主转让给 @${targetUsername} 吗？转让后您将成为该群的管理员。`,
      confirmText: '确认转让',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/transfer-owner`, {
        target_user_id: targetUserId,
      });
      toast.success(res.data?.message || '群主已转让');
      fetchGroupMembers(activeGroupId);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '转让失败');
    }
  };

  // 群头像：后端在未设置时会返回 dicebear 兜底图，
  // 这里只把「真正上传过」的地址当头像，其余仍显示地球/锁图标。
  const groupAvatarUrl = (g?: { avatar_url?: string } | null) => {
    const url = (g?.avatar_url || '').trim();
    if (!url || url.includes('dicebear.com')) return '';
    return url;
  };

  // 群内管理员名额：1 位群主 + 最多 5 位管理员
  const GROUP_ADMIN_LIMIT = 10;
  const groupAdminCount = groupMembers.filter((m) => m.role === 'admin').length;

  useLayoutEffect(() => {
    setCheckinCfg({ text: 'hhh', times_per_day: 3, exp: 10, daily_exp_cap: 10, slots: [] });
    const request = groupRequestRef.current;
    if (!request) return;
    const { signal } = request.controller;
    apiClient.get(`/chat/groups/${request.id}/checkin-status`, { signal })
      .then(({ data }) => {
        if (signal.aborted) return;
        setCheckinCfg({
          text: data?.text || 'hhh',
          times_per_day: data?.times_per_day || 3,
          exp: data?.exp || 10,
          daily_exp_cap: data?.daily_exp_cap || 10,
          slots: Array.isArray(data?.slots) ? data.slots : [],
        });
      })
      .catch(() => {});
  }, [visibleGroupId, user?.id]);

  /** 工具箱：@提及 / 接龙 / 骰子 / 打卡，风格与现有输入工具行一致 */
  const triggerMention = () => {
    setInputText((prev) => `${prev}@`);
    setMentionQuery('');
    setShowMentionPopover(true);
    setMentionIndex(0);
    setShowToolbox(false);
    inputRef.current?.focus();
  };

  const drawFortune = async () => {
    if (!activeGroupId || fortuneBusy) return;
    setShowToolbox(false);
    setFortuneBusy(true);
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/fortune`);
      setFortune(res.data);
      reportGroupExp(toast, res.data);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '求签失败');
    } finally {
      setFortuneBusy(false);
    }
  };

  // 11:00 午餐提醒：每个群每天只弹一次，3 秒自动收起
  useEffect(() => {
    if (!activeGroupId || chatTab !== 'group') return;
    const check = () => {
      const now = new Date();
      const minutes = now.getHours() * 60 + now.getMinutes();
      if (minutes < 11 * 60 || minutes >= 11 * 60 + 5) return;
      const key = `meal-reminder:${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}:${activeGroupId}`;
      try {
        if (localStorage.getItem(key)) return;
        localStorage.setItem(key, '1');
      } catch { /* 隐私模式忽略 */ }
      setLunchBanner(true);
      window.setTimeout(() => setLunchBanner(false), 3000);
    };
    check();
    const timer = window.setInterval(check, 30000);
    return () => window.clearInterval(timer);
  }, [activeGroupId, chatTab]);

  const toolboxActions = [
    { key: 'mention', label: '@ 提及成员', hint: '选择群友', icon: AtSign, run: triggerMention },
    { key: 'chain', label: '成语接龙', hint: '机器人自动裁判 · 答对 +5 群经验', icon: ListOrdered, run: () => {
      setShowToolbox(false); setActivityKind('chain');
    } },
    { key: 'feihua', label: '飞花令', hint: '令字抢答 · 答对 +5 群经验', icon: Feather, run: () => {
      setShowToolbox(false); setActivityKind('feihua');
    } },
    { key: 'dice', label: '掷骰子', hint: '掷一次按发言计 2 群经验', icon: Dices, run: () => {
      setShowToolbox(false);
      if (!activeGroupId) return;
      void apiClient.post(`/chat/groups/${activeGroupId}/dice`)
        .then((res) => reportGroupExp(toast, res.data))
        .catch((err: any) => toast.error(err?.response?.data?.detail || '掷骰子失败'));
    } },
    { key: 'lunch', label: '今天吃什么', hint: '午餐转盘 · 群共享菜盘', icon: Utensils, run: () => {
      setShowToolbox(false); setShowLunchWheel(true);
    } },
    { key: 'fortune', label: '每日求签', hint: '每天 2 次 · 每次 +2 群经验', icon: Sparkles, run: () => { void drawFortune(); } },
    { key: 'poll', label: '群投票', hint: '实时结果 · 首次投票 +2 群经验', icon: BarChart3, run: () => {
      setShowToolbox(false); setActivityKind('poll');
    } },
    { key: 'checkin', label: '发签到语', hint: `发送「${checkinCfg.text}」得经验`, icon: CalendarCheck, run: () => {
      setShowToolbox(false);
      void handleSendMessage(undefined, checkinCfg.text);
    } },
    { key: 'checkinCfg', label: '签到设置', hint: '仅管理员可改', icon: Timer, run: () => {
      setShowToolbox(false);
      setCheckinDraft({ ...checkinCfg });
      setShowCheckinConfig(true);
    } },
  ];

  const handleMemberAction = async () => {
    if (!memberAction || !activeGroupId) return;
    setActionBusy(true);
    try {
      const uid = memberAction.member.user_id;
      if (memberAction.type === 'mute') {
        await apiClient.post(`/chat/groups/${activeGroupId}/members/${uid}/mute`, {
          duration_minutes: muteMinutes, reason: muteReason.trim() || undefined,
        });
        toast.success(`已禁言 ${memberAction.member.nickname || memberAction.member.username} ${muteMinutes} 分钟`);
      }
      setMemberAction(null);
      void fetchGroupMembers(activeGroupId);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '操作失败');
    } finally {
      setActionBusy(false);
    }
  };

  const loadSpecialBadges = async (uid: string) => {
    const request = groupRequestRef.current;
    if (!request || request.id !== activeGroupId) return;
    const { signal } = request.controller;
    try {
      const res = await apiClient.get(`/chat/groups/${request.id}/members/${uid}/special-badges`, { signal });
      if (signal.aborted) return;
      setBadgeList(res.data?.items || []);
      setBadgeWearing(res.data?.wearing || '');
      setBadgeLevel(res.data?.group_level || 1);
    } catch (err: any) {
      if (signal.aborted) return;
      toast.error(err?.response?.data?.detail || '读取名牌失败');
      setBadgeList([]);
    }
  };

  const openBadgeDialog = (member: any) => {
    setNewBadgeName('');
    setBadgeList([]);
    setBadgeWearing('');
    setMemberAction({ type: 'badge', member });
    void loadSpecialBadges(member.user_id);
  };

  const handleGrantBadge = async () => {
    if (!activeGroupId || !memberAction) return;
    const name = newBadgeName.trim();
    if (!name) { toast.warning('请输入名牌名称'); return; }
    setBadgeBusy(true);
    try {
      await apiClient.post(`/chat/groups/${activeGroupId}/members/${memberAction.member.user_id}/special-badges`, { name });
      setNewBadgeName('');
      toast.success('已授予特殊名牌');
      await loadSpecialBadges(memberAction.member.user_id);
      void fetchGroupMembers(activeGroupId);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '授予失败');
    } finally {
      setBadgeBusy(false);
    }
  };

  const handleRevokeBadge = async (badgeId: string, name: string) => {
    if (!activeGroupId || !memberAction) return;
    setBadgeBusy(true);
    try {
      await apiClient.delete(`/chat/groups/${activeGroupId}/special-badges/${badgeId}`);
      toast.success(`已收回「${name}」`);
      await loadSpecialBadges(memberAction.member.user_id);
      void fetchGroupMembers(activeGroupId);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '收回失败');
    } finally {
      setBadgeBusy(false);
    }
  };

  const handleWearBadge = async (specialId: string | null) => {
    if (!activeGroupId || !memberAction) return;
    setBadgeBusy(true);
    try {
      await apiClient.put(`/chat/groups/${activeGroupId}/me/badge`, { special_id: specialId });
      toast.success(specialId ? '已佩戴该名牌' : '已切回等级铭牌');
      await loadSpecialBadges(memberAction.member.user_id);
      void fetchGroupMembers(activeGroupId);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '切换失败');
    } finally {
      setBadgeBusy(false);
    }
  };

  const handleUnmute = async (member: any) => {
    if (!activeGroupId) return;
    try {
      await apiClient.post(`/chat/groups/${activeGroupId}/members/${member.user_id}/unmute`);
      toast.success('已解除禁言');
      void fetchGroupMembers(activeGroupId);
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '操作失败');
    }
  };

  useEffect(() => {
    setLevelBoard(null);
    setLevelBoardError(false);
    const groupRequest = groupRequestRef.current;
    if (!showLevelBoard || !groupRequest || groupRequest.id !== visibleGroupId) return;

    const request = new AbortController();
    const isCurrent = () => !request.signal.aborted && groupRequestRef.current === groupRequest;
    apiClient.get<GroupLevelBoard>(`/chat/groups/${groupRequest.id}/levels`, { signal: request.signal })
      .then(({ data }) => { if (isCurrent()) setLevelBoard(data); })
      .catch(() => { if (isCurrent()) setLevelBoardError(true); });
    return () => request.abort();
  }, [showLevelBoard, visibleGroupId, levelBoardTick]);

  // 群经验变化（发言/接龙/飞花令/骰子/求签/投票）：同步自己的铭牌等级，
  // 等级榜开着的话顺手刷新，避免「升了级但界面还是旧等级」
  useEffect(() => {
    const onExpChanged = (event: Event) => {
      const detail = (event as CustomEvent).detail || {};
      const me = user?.id;
      const level = Number(detail.group_level) || 0;
      if (me && level > 0) {
        setGroupMembers((prev) =>
          prev.map((m) => (m.user_id === me ? { ...m, group_level: level } : m))
        );
      }
      if (showLevelBoard) setLevelBoardTick((n) => n + 1);
    };
    window.addEventListener('geek:group-exp-changed', onExpChanged);
    return () => window.removeEventListener('geek:group-exp-changed', onExpChanged);
  }, [user?.id, showLevelBoard]);

  const myLevelProgress = levelBoard?.my_progress;
  const myLevelStatus = myLevelProgress && (myLevelProgress.need > 0
    ? `距 Lv.${myLevelProgress.level + 1} 还差 ${myLevelProgress.need - myLevelProgress.in_level} EXP`
    : '已满级');

  const handleToggleMemberRole = async (targetUserId: string, targetUsername: string, newRole: 'admin' | 'member') => {
    if (!activeGroupId) return;
    if (newRole === 'admin' && groupAdminCount >= GROUP_ADMIN_LIMIT) {
      toast.error(`每个群最多 ${GROUP_ADMIN_LIMIT} 位管理员，请先撤销一位`);
      return;
    }
    const roleText = newRole === 'admin' ? '设为管理员' : '撤销管理员';
    const ok = await confirmModal({
      title: '修改成员角色',
      description: `确定将 @${targetUsername} ${roleText}吗？（当前管理员 ${groupAdminCount}/${GROUP_ADMIN_LIMIT}）`,
      confirmText: '确定修改',
      danger: newRole !== 'admin',
    });
    if (!ok) return;
    try {
      const res = await apiClient.post(`/chat/groups/${activeGroupId}/members/${targetUserId}/role`, {
        role: newRole,
      });
      toast.success(res.data?.message || '成员角色已成功更新');
      fetchGroupMembers(activeGroupId);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '修改成员角色失败');
    }
  };

  // 申请/加入群聊入口
  const handleJoinGroup = async (roomId: string) => {
    // 若为超级管理员可直接入群，普通用户唤起申请弹窗
    const isSiteAdmin = ['super_admin', 'admin'].includes(user?.role || '');
    if (!isSiteAdmin) {
      setIsApplyModalOpen(true);
      return;
    }
    try {
      const res = await apiClient.post(`/chat/groups/${roomId}/join`);
      toast.success(res.data?.message || '已加入群聊');
      fetchGroups();
      if (isMembersModalOpen) fetchGroupMembers(roomId);
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '加入群聊失败');
    }
  };

  // 退出群聊
  const handleLeaveGroup = async (roomId: string) => {
    const ok = await confirmModal({
      title: '退出群聊',
      description: '确定要退出该群聊吗？',
      confirmText: '退出群聊',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiClient.post(`/chat/groups/${roomId}/leave`);
      toast.success(res.data?.message || '已退出群聊');
      setIsMembersModalOpen(false);
      setActiveGroupId(null);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '退出群聊失败');
    }
  };

  // 解散群聊
  const handleDeleteGroup = async (roomId: string) => {
    const ok = await confirmModal({
      title: '解散群聊',
      description: '确定要解散此群聊吗？此操作将永久移除所有群成员和历史聊天记录，不可恢复！',
      confirmText: '解散群聊',
      danger: true,
    });
    if (!ok) return;
    try {
      const res = await apiClient.delete(`/chat/groups/${roomId}`);
      toast.success(res.data?.message || '群聊已解散');
      setIsMembersModalOpen(false);
      setActiveGroupId(null);
      fetchGroups();
    } catch (err: any) {
      toast.error(err.response?.data?.detail || '解散群聊失败');
    }
  };

  // 唤起右键上下文菜单
  const handleContextMenu = (e: React.MouseEvent, conv: ConversationItem) => {
    e.preventDefault();
    e.stopPropagation();
    const menuWidth = 160;
    const menuHeight = 140;
    const x = Math.min(e.clientX, window.innerWidth - menuWidth - 12);
    const y = Math.min(e.clientY, window.innerHeight - menuHeight - 12);
    setContextMenu({ visible: true, x, y, conv });
  };

  const activeConv = conversations.find((c) => c.id === activeConvId);
  const activeGroup = groups.find((g) => g.id === activeGroupId);

  // 手机端：进入某个具体会话时通知顶栏隐藏底部 Dock（那里要留给输入栏），
  // 回到会话列表时恢复。Chat 为常驻挂载，事件在切换 tab 时也会持续有效。
  const inConversation = Boolean(
    (chatTab === 'direct' && activeConv) || (chatTab === 'group' && activeGroup)
  );
  useEffect(() => {
    window.dispatchEvent(new CustomEvent('geek:chat-conversation-open', { detail: inConversation }));
    return () => {
      window.dispatchEvent(new CustomEvent('geek:chat-conversation-open', { detail: false }));
    };
  }, [inConversation]);

  // 手机端底部点「私聊」应回到「私聊 + 群聊」列表，而不是停留在上次打开的会话
  useEffect(() => {
    const handler = () => {
      setActiveConvId(null);
      setActiveGroupId(null);
      setShowToolbox(false);
      setShowEmojiPicker(false);
      setShowMentionPopover(false);
    };
    window.addEventListener('geek:chat-show-list', handler);
    return () => window.removeEventListener('geek:chat-show-list', handler);
  }, []);
  // 当前用户在群里的角色（消息操作权限判断），避免每条消息重复 find
  const myGroupRole = useMemo(
    () => groupMembers.find((m) => m.user_id === user?.id)?.role || activeGroup?.my_role,
    [groupMembers, user?.id, activeGroup]
  );

  return (
    <div className={isPro
      ? (isFullscreen
          ? 'fixed inset-0 z-[120] w-screen h-screen max-w-none bg-wb-bg-surface p-0 flex flex-col overflow-hidden'
          : 'w-full max-w-[1780px] mx-auto px-0 sm:px-2 md:px-4 py-0 sm:py-2 md:py-3')
      : 'max-w-5xl mx-auto px-4 py-6'}>
      {/* 专业版专属工具行：横跨聊天卡片顶部，折叠左侧列表后依然可用，不压任何标题栏 */}
      {isPro && !isFullscreen && (
        <div className="hidden md:flex items-center gap-1.5 px-1 pb-2 shrink-0">
          <span className="text-3xs text-wb-text-muted font-mono shrink-0 mr-0.5">PRO</span>
          <button
            type="button"
            onClick={() => setSidebarCollapsed((v) => !v)}
            title={sidebarCollapsed ? '展开左侧会话列表' : '收起左侧会话列表'}
            aria-label={sidebarCollapsed ? '展开左侧会话列表' : '收起左侧会话列表'}
            className={`inline-flex items-center justify-center w-7 h-7 rounded-md border transition-all shrink-0 ${
              sidebarCollapsed
                ? 'bg-wb-brand/10 text-wb-brand border-wb-brand/30'
                : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
            }`}
          >
            {sidebarCollapsed
              ? <PanelLeftOpen className="w-3.5 h-3.5" />
              : <PanelLeftClose className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={toggleStealthMode}
            title={stealth ? '切回普通气泡视图' : '伪装成终端代码日志（摸鱼模式）'}
            className={`inline-flex items-center gap-1 h-7 px-2 rounded-md text-3xs font-semibold border transition-all shrink-0 ${
              stealth
                ? 'bg-zinc-900 text-emerald-400 border-zinc-700 shadow-inner'
                : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
            }`}
          >
            <Terminal className="w-3.5 h-3.5" /> {stealth ? '气泡视图' : '摸鱼终端'}
          </button>
          <div className="flex-1" />
          <ProChatControls
            compact
            isFullscreen={isFullscreen}
            onToggleFullscreen={() => setIsFullscreen((v) => !v)}
            stealthTheme={stealthTheme}
            onThemeChange={setStealthTheme}
          />
        </div>
      )}
      <div
        className={isPro
          ? (isFullscreen
              ? 'flex-1 rounded-none border-0 overflow-hidden flex flex-col md:flex-row relative w-full h-full bg-wb-bg-surface'
              : 'h-[calc(100dvh-104px)] md:h-[calc(100dvh-115px)] rounded-none md:rounded-2xl bg-wb-bg-surface border-0 md:border border-wb-border-subtle shadow-none md:shadow-xs overflow-hidden flex flex-col md:flex-row relative w-full')
          : 'h-[calc(100dvh-190px)] md:h-[calc(100dvh-120px)] rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card overflow-hidden flex flex-col md:flex-row relative'}
        style={
          // 仅在软键盘把可视区压矮时收缩（留出容器顶部与页面边距），桌面端保持原布局
          vvHeight !== null && vvHeight < window.innerHeight - 120 && window.innerWidth < 768
            ? { height: `${Math.max(280, vvHeight - 100)}px` }
            : undefined
        }
      >
        {/* 专业版：摸鱼终端 / 群成员看板开关（不占布局，absolute 悬浮） */}
        {/* 左侧会话/群聊列表抽屉 (移动端若打开了聊天则隐藏列表，仅在目标会话真实存在时隐藏，防止白屏) */}
        <aside
          className={`w-full md:w-80 border-r border-wb-border-subtle flex-col bg-wb-bg-subtle/30 ${
            isPro && sidebarCollapsed
              ? 'hidden'
              : (chatTab === 'direct' && activeConv) || (chatTab === 'group' && activeGroup)
                ? 'hidden md:flex'
                : 'flex'
          }`}
        >
          {/* 顶栏：私聊 / 群聊 双 Tab 切换器 */}
          <div className="p-3 border-b border-wb-border-subtle flex items-center justify-between gap-2">
            <div className="relative flex items-center gap-1 bg-wb-bg-surface p-1 rounded-2xl border border-wb-border-subtle flex-1">
              <button
                type="button"
                onClick={() => {
                  setChatTab('direct');
                  localStorage.setItem('geek_chat_active_tab', 'direct');
                }}
                className={`relative z-10 flex-1 py-1.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors duration-200 select-none ${
                  chatTab === 'direct'
                    ? 'text-wb-bg-page'
                    : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                {chatTab === 'direct' && (
                  <motion.div
                    layoutId="chat-tab-pill"
                    transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                    className="absolute inset-0 bg-wb-text-primary rounded-xl shadow-sm -z-10"
                  />
                )}
                <MessageSquare className="w-3.5 h-3.5" />
                <span>私聊</span>
                {conversations.some((c) => (c.unread_count || 0) > 0) && (
                  <span className="w-2 h-2 rounded-full bg-wb-danger animate-pulse" />
                )}
              </button>
              <button
                type="button"
                onClick={() => {
                  setChatTab('group');
                  localStorage.setItem('geek_chat_active_tab', 'group');
                }}
                className={`relative z-10 flex-1 py-1.5 px-3 rounded-xl text-xs font-semibold flex items-center justify-center gap-1.5 transition-colors duration-200 select-none ${
                  chatTab === 'group'
                    ? 'text-wb-bg-page'
                    : 'text-wb-text-muted hover:text-wb-text-primary'
                }`}
              >
                {chatTab === 'group' && (
                  <motion.div
                    layoutId="chat-tab-pill"
                    transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                    className="absolute inset-0 bg-wb-text-primary rounded-xl shadow-sm -z-10"
                  />
                )}
                <Users className="w-3.5 h-3.5" />
                <span>群聊</span>
                {(() => {
                  const total = groups.reduce((n, g) => n + (g.unread_count || 0), 0);
                  return total > 0 ? (
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-wb-danger text-white text-3xs font-bold flex items-center justify-center">
                      {total > 99 ? '99+' : total}
                    </span>
                  ) : null;
                })()}
              </button>
            </div>

            {/* 顶栏常驻操作按钮：私聊下为发起新私信，群聊下为新建群聊，容器宽度恒定，彻底杜绝切换跳动 */}
            <button
              type="button"
              onClick={() => {
                if (chatTab === 'group') {
                  fetchGroupQuota();
                  setIsGroupModalOpen(true);
                } else {
                  setIsNewChatModalOpen(true);
                }
              }}
              className="w-9 h-9 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-all flex items-center justify-center shrink-0"
              title={chatTab === 'group' ? '新建群聊频道' : '发起新私聊'}
            >
              <Plus className="w-4 h-4" />
            </button>

            {/* 连接状态灯：常驻显示，只变颜色不闪烁 */}
            <span
              role="status"
              aria-live="polite"
              aria-label={
                connStatus === 'ws'
                  ? '实时连接正常'
                  : connStatus === 'http'
                  ? '已降级为 HTTP 通道'
                  : '连接已断开'
              }
              title={
                connStatus === 'ws'
                  ? 'WebSocket 实时连接正常'
                  : connStatus === 'http'
                  ? '实时通道不可用，已切换为 HTTP 降级通道'
                  : '网络已断开，消息将在恢复后同步'
              }
              className="w-5 h-9 flex items-center justify-center shrink-0"
            >
              <span
                className={`w-2 h-2 rounded-full transition-colors duration-300 ${
                  connStatus === 'ws'
                    ? 'bg-wb-success'
                    : connStatus === 'http'
                    ? 'bg-wb-warn'
                    : 'bg-wb-text-muted'
                }`}
              />
            </span>
          </div>

          {/* 会话 / 群聊列表主体 */}
          <div className="flex-1 overflow-y-auto divide-y divide-wb-border-subtle/50">
            {chatTab === 'direct' ? (
              sortedConversations.length === 0 ? (
                <div className="p-8 text-center text-xs text-wb-text-muted space-y-2">
                  <MessageSquare className="w-6 h-6 mx-auto opacity-30" />
                  <p>暂无私聊会话</p>
                  <p className="text-2xs opacity-75">可在社区用户主页点击“发私信”开启对话</p>
                </div>
              ) : (
                sortedConversations.map((conv) => {
                  const isPinned = pinnedConvIds.includes(conv.id);
                  return (
                    <div
                      key={conv.id}
                      onClick={() => setActiveConvId(conv.id)}
                      onContextMenu={(e) => handleContextMenu(e, conv)}
                      className={`p-3.5 flex items-center gap-3 cursor-pointer transition-colors group/item relative ${
                        activeConvId === conv.id
                          ? 'bg-wb-bg-subtle font-medium'
                          : isPinned
                          ? 'bg-wb-warn/5 hover:bg-wb-warn/10'
                          : 'hover:bg-wb-bg-subtle/50'
                      }`}
                    >
                      <div className="relative">
                        <UserAvatar
                          username={conv.peer_username}
                          avatarUrl={conv.peer_avatar}
                          size="sm"
                        />
                        {isPinned && (
                          <div
                            className="absolute -top-1 -left-1 w-3.5 h-3.5 bg-wb-warn text-white rounded-full flex items-center justify-center shadow-xs"
                            title="已置顶会话"
                          >
                            <Pin className="w-2 h-2 fill-current" />
                          </div>
                        )}
                      </div>

                      <div className="flex-1 min-w-0 pr-6">
                        <div className="flex items-center justify-between">
                          <span className="text-xs font-semibold text-wb-text-primary truncate flex items-center gap-1.5">
                            {conv.peer_nickname || conv.peer_username}
                            {mutedConvIds.includes(conv.id) && (
                              <BellOff className="w-3 h-3 text-wb-text-muted shrink-0" aria-label="已静音" />
                            )}
                            {isPinned && (
                              <span className="text-3xs px-1 py-0.2 rounded bg-wb-warn/10 text-wb-warn font-mono">
                                置顶
                              </span>
                            )}
                          </span>
                          <div className="flex items-center gap-1.5 flex-shrink-0 ml-1">
                            {conv.is_blocked && (
                              <span className="text-3xs text-wb-danger bg-wb-danger/10 px-1 rounded">
                                已拉黑
                              </span>
                            )}
                            {conv.unread_count && conv.unread_count > 0 && activeConvId !== conv.id ? (
                              <span className="px-1.5 py-0.2 rounded-full text-3xs font-bold bg-wb-danger text-white min-w-[17px] text-center leading-tight animate-pulse">
                                {conv.unread_count > 99 ? '99+' : conv.unread_count}
                              </span>
                            ) : null}
                          </div>
                        </div>
                        <p className="text-2xs text-wb-text-muted truncate mt-0.5">
                          {formatPreview(conv.last_message_preview) || '暂无新消息'}
                        </p>
                      </div>

                      {/* 静音切换：只影响是否提示，不影响消息进入列表 */}
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setMutedConvIds((prev) =>
                            prev.includes(conv.id)
                              ? prev.filter((x) => x !== conv.id)
                              : [...prev, conv.id]
                          );
                          toast.info(
                            mutedConvIds.includes(conv.id)
                              ? '已取消该会话的免打扰'
                              : '已开启免打扰，消息仍会进入列表但不再提醒'
                          );
                        }}
                        title={mutedConvIds.includes(conv.id) ? '取消免打扰' : '开启免打扰'}
                        className={`opacity-0 group-hover/item:opacity-100 absolute right-9 top-1/2 -translate-y-1/2 p-1.5 rounded-lg transition-all ${
                          mutedConvIds.includes(conv.id)
                            ? 'text-wb-text-secondary'
                            : 'text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                        }`}
                      >
                        {mutedConvIds.includes(conv.id) ? (
                          <BellOff className="w-3.5 h-3.5" />
                        ) : (
                          <Bell className="w-3.5 h-3.5" />
                        )}
                      </button>

                      {/* 悬浮操作菜单按钮 */}
                      <button
                        type="button"
                        onClick={(e) => handleContextMenu(e, conv)}
                        title="右键或点击查看更多会话操作"
                        className="opacity-0 group-hover/item:opacity-100 p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-all absolute right-2 top-1/2 -translate-y-1/2"
                      >
                        <MoreVertical className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  );
                })
              )
            ) : (
              // 群聊频道列表
              <div className="flex flex-col h-full">
                {/* 分类过滤器：全部 / 🌐 公共 / 🔒 私密 */}
                <div className="relative p-1.5 border-b border-wb-border-subtle/60 flex items-center gap-1 bg-wb-bg-surface/50 shrink-0">
                  <button
                    type="button"
                    onClick={() => setGroupFilter('all')}
                    className={`relative z-10 flex-1 py-1 px-2 rounded-xl text-2xs font-medium transition-colors flex items-center justify-center gap-1 shrink-0 ${
                      groupFilter === 'all'
                        ? 'text-wb-text-primary font-semibold'
                        : 'text-wb-text-muted hover:text-wb-text-primary'
                    }`}
                  >
                    {groupFilter === 'all' && (
                      <motion.div
                        layoutId="chat-group-filter-pill"
                        transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                        className="absolute inset-0 bg-wb-bg-subtle rounded-xl shadow-xs -z-10"
                      />
                    )}
                    <Layers className="w-3 h-3 text-wb-text-muted" />
                    <span>全部 ({groups.length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupFilter('public')}
                    className={`relative z-10 flex-1 py-1 px-2 rounded-xl text-2xs font-medium transition-colors flex items-center justify-center gap-1 shrink-0 ${
                      groupFilter === 'public'
                        ? 'text-wb-text-primary font-semibold'
                        : 'text-wb-text-muted hover:text-wb-text-primary'
                    }`}
                  >
                    {groupFilter === 'public' && (
                      <motion.div
                        layoutId="chat-group-filter-pill"
                        transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                        className="absolute inset-0 bg-wb-bg-subtle rounded-xl shadow-xs -z-10"
                      />
                    )}
                    <Globe className="w-3 h-3 text-wb-brand" />
                    <span>公共 ({groups.filter((g) => g.is_public).length})</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setGroupFilter('private')}
                    className={`relative z-10 flex-1 py-1 px-2 rounded-xl text-2xs font-medium transition-colors flex items-center justify-center gap-1 shrink-0 ${
                      groupFilter === 'private'
                        ? 'text-wb-text-primary font-semibold'
                        : 'text-wb-text-muted hover:text-wb-text-primary'
                    }`}
                  >
                    {groupFilter === 'private' && (
                      <motion.div
                        layoutId="chat-group-filter-pill"
                        transition={{ type: 'spring', stiffness: 480, damping: 36 }}
                        className="absolute inset-0 bg-wb-bg-subtle rounded-xl shadow-xs -z-10"
                      />
                    )}
                    <Lock className="w-3 h-3 text-wb-warn" />
                    <span>私密 ({groups.filter((g) => !g.is_public).length})</span>
                  </button>
                </div>

                <div className="flex-1 overflow-y-auto divide-y divide-wb-border-subtle/50">
                  {sortedGroups.filter((g) => {
                    if (groupFilter === 'public') return g.is_public;
                    if (groupFilter === 'private') return !g.is_public;
                    return true;
                  }).length === 0 ? (
                    <div className="p-8 text-center text-xs text-wb-text-muted space-y-3">
                      {groupFilter === 'private' ? (
                        <Lock className="w-6 h-6 mx-auto opacity-30 text-wb-warn" />
                      ) : (
                        <Users className="w-6 h-6 mx-auto opacity-30" />
                      )}
                      <p>
                        {groupFilter === 'public'
                          ? '暂无公共群聊频道'
                          : groupFilter === 'private'
                          ? '您尚未加入任何私密好友群'
                          : '暂无群聊频道'}
                      </p>
                      <p className="text-2xs opacity-75">
                        {groupFilter === 'private'
                          ? '可创建好友私密群，或等待朋友邀请'
                          : "点击下方按钮或右上角 '+' 创建群聊"}
                      </p>
                      <button
                        type="button"
                        onClick={() => {
                          fetchGroupQuota();
                          setIsGroupModalOpen(true);
                        }}
                        className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold mx-auto hover:opacity-90 transition-opacity"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>创建群聊</span>
                      </button>
                    </div>
                  ) : (
                    sortedGroups
                      .filter((g) => {
                        if (groupFilter === 'public') return g.is_public;
                        if (groupFilter === 'private') return !g.is_public;
                        return true;
                      })
                      .map((group) => (
                        <div
                          key={group.id}
                          onClick={() => setActiveGroupId(group.id)}
                          className={`p-3.5 flex items-center gap-3 cursor-pointer transition-colors group/item relative ${
                            activeGroupId === group.id ? 'bg-wb-bg-subtle font-medium' : 'hover:bg-wb-bg-subtle/50'
                          }`}
                        >
                          <SafeImage
                            compatiblePreview src={groupAvatarUrl(group) || undefined}
                            alt={group.name}
                            className="w-9 h-9 rounded-2xl object-cover border border-wb-border-subtle flex-shrink-0"
                            fallback={
                              <div className="w-9 h-9 rounded-2xl bg-gradient-to-br from-wb-info/10 to-purple-500/20 border border-wb-border-subtle flex items-center justify-center text-wb-text-primary flex-shrink-0 relative">
                                {group.is_public ? <Globe className="w-4 h-4 text-wb-brand" /> : <Lock className="w-4 h-4 text-wb-warn" />}
                              </div>
                            }
                          />
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center justify-between gap-1">
                              <div className="flex items-center gap-1.5 min-w-0">
                                <span className="text-xs font-semibold text-wb-text-primary truncate">
                                  {group.name}
                                </span>
                                {pinnedGroupIds.includes(group.id) && (
                                  <Pin className="w-2.5 h-2.5 text-wb-warn shrink-0" />
                                )}
                                {mutedGroupIds.includes(group.id) && (
                                  <BellOff className="w-2.5 h-2.5 text-wb-text-muted shrink-0" />
                                )}
                                {group.is_public ? (
                                  <span className="text-3xs px-1 py-0.2 rounded bg-wb-info/10 text-wb-info font-mono shrink-0">
                                    公共
                                  </span>
                                ) : (
                                  <span className="text-3xs px-1 py-0.2 rounded bg-wb-warn/10 text-wb-warn font-mono shrink-0">
                                    私密
                                  </span>
                                )}
                              </div>
                              <div className="flex items-center gap-1 shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setPinnedGroupIds((prev) =>
                                      prev.includes(group.id)
                                        ? prev.filter((id) => id !== group.id)
                                        : [...prev, group.id]
                                    );
                                  }}
                                  className={`p-1 rounded-md transition-all ${
                                    pinnedGroupIds.includes(group.id)
                                      ? 'opacity-100 text-wb-warn'
                                      : 'opacity-0 group-hover/item:opacity-100 text-wb-text-muted hover:text-wb-warn'
                                  }`}
                                  title={pinnedGroupIds.includes(group.id) ? '取消置顶' : '置顶该群'}
                                >
                                  <Pin className="w-3 h-3" />
                                </button>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMutedGroupIds((prev) =>
                                      prev.includes(group.id)
                                        ? prev.filter((id) => id !== group.id)
                                        : [...prev, group.id]
                                    );
                                  }}
                                  className={`p-1 rounded-md transition-all ${
                                    mutedGroupIds.includes(group.id)
                                      ? 'opacity-100 text-wb-text-secondary'
                                      : 'opacity-0 group-hover/item:opacity-100 text-wb-text-muted hover:text-wb-text-secondary'
                                  }`}
                                  title={mutedGroupIds.includes(group.id) ? '关闭免打扰' : '消息免打扰'}
                                >
                                  <BellOff className="w-3 h-3" />
                                </button>
                                {!group.is_member && group.is_public && (
                                  <span className="text-3xs text-wb-text-muted bg-wb-bg-subtle px-1 py-0.2 rounded border border-wb-border-subtle">
                                    未加入
                                  </span>
                                )}
                                {activeGroupId !== group.id && (group.unread_count || 0) > 0 && (
                                  mutedGroupIds.includes(group.id) ? (
                                    <span
                                      className="w-2 h-2 rounded-full bg-wb-text-muted/50 shrink-0"
                                      title="免打扰：有新消息但不提醒"
                                    />
                                  ) : (
                                    <span className="px-1.5 py-0.2 rounded-full text-3xs font-bold bg-wb-danger text-white min-w-[17px] text-center leading-tight animate-pulse">
                                      {(group.unread_count || 0) > 99 ? '99+' : group.unread_count}
                                    </span>
                                  )
                                )}
                                <span className="text-3xs text-wb-text-muted bg-wb-bg-surface px-1.5 py-0.5 rounded-md border border-wb-border-subtle font-mono">
                                  {group.member_count}人
                                </span>
                              </div>
                            </div>
                            <p className="text-2xs text-wb-text-muted truncate mt-0.5">
                              {formatPreview(group.last_message_preview) || group.description || (group.is_public ? '公共频道探讨交流' : '私密好友圈')}
                            </p>
                          </div>
                        </div>
                      ))
                  )}
                </div>
              </div>
            )}
          </div>
        </aside>

        {/* 右侧聊天窗口 (移动端未选择会话时隐藏) */}
        <main
          className={`relative flex-1 flex-col bg-wb-bg-surface overflow-hidden ${
            (chatTab === 'direct' && !activeConv) || (chatTab === 'group' && !activeGroup)
              ? 'hidden md:flex'
              : 'flex'
          }`}
        >
          {chatTab === 'direct' ? (
            // ==================== 私聊聊天窗口 ====================
            activeConv ? (
              <>
                {/* 私聊顶部标题栏 */}
                <div className="px-4 md:px-5 py-3 border-b border-wb-border-subtle flex items-center justify-between bg-wb-bg-surface/80 backdrop-blur-sm relative z-20">
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveConvId(null)}
                      className="md:hidden p-1.5 -ml-1 text-wb-text-secondary hover:text-wb-text-primary rounded-xl hover:bg-wb-bg-subtle transition-colors"
                      title="返回会话列表"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>

                    <div
                      className="flex items-center gap-3 cursor-pointer group"
                      onClick={() => onSelectUser?.(activeConv.peer_username)}
                      title={`查看 ${activeConv.peer_nickname || activeConv.peer_username} 的主页`}
                    >
                      <UserAvatar
                        username={activeConv.peer_username}
                        avatarUrl={activeConv.peer_avatar}
                        size="sm"
                      />
                      <div>
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-sm text-wb-text-primary group-hover:text-wb-brand transition-colors">
                            {activeConv.peer_nickname || activeConv.peer_username}
                          </h3>
                          <span className="text-2xs text-wb-text-muted font-normal">
                            @{activeConv.peer_username}
                          </span>
                          {pinnedConvIds.includes(activeConv.id) && (
                            <span className="px-1.5 py-0.2 rounded text-3xs bg-wb-warn/10 text-wb-warn font-mono">
                              已置顶
                            </span>
                          )}
                          {activeConv.is_blocked && (
                            <span className="px-1.5 py-0.5 rounded text-3xs bg-wb-danger/10 text-wb-danger font-medium">
                              已拉黑
                            </span>
                          )}
                          {activeConv.is_blocked_by_peer && (
                            <span className="px-1.5 py-0.5 rounded text-3xs bg-wb-warn/10 text-wb-warn font-medium">
                              对方拒收
                            </span>
                          )}
                        </div>
                        {isTyping ? (
                          <span className="text-3xs text-wb-brand animate-pulse block">
                            对方正在输入中...
                          </span>
                        ) : (
                          <span className="text-3xs text-wb-text-muted group-hover:underline">
                            点击查看个人主页
                          </span>
                        )}
                      </div>
                    </div>
                  </div>

                  {/* 会话管理下拉菜单 */}
                  <div className="relative" ref={actionMenuRef}>
                    <button
                      type="button"
                      onClick={() => setShowActionMenu(!showActionMenu)}
                      className="p-2 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                      title="会话管理设置"
                    >
                      <MoreVertical className="w-4 h-4" />
                    </button>

                    {showActionMenu && (
                      <div className="absolute right-0 top-full mt-1 w-44 bg-wb-bg-surface border border-wb-border-subtle shadow-xl rounded-2xl p-1.5 z-[110] text-xs">
                        <button
                          type="button"
                          onClick={() => {
                            setShowActionMenu(false);
                            togglePinConversation(activeConv.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                        >
                          <Pin className="w-3.5 h-3.5 text-wb-text-muted" />
                          <span>{pinnedConvIds.includes(activeConv.id) ? '取消置顶' : '置顶聊天'}</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowActionMenu(false);
                            onSelectUser?.(activeConv.peer_username);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                        >
                          <User className="w-3.5 h-3.5 text-wb-text-muted" />
                          <span>访问个人主页</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowActionMenu(false);
                            handleClearMessages(activeConv.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                        >
                          <RotateCcw className="w-3.5 h-3.5 text-wb-text-muted" />
                          <span>清空聊天记录</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            setShowActionMenu(false);
                            handleToggleBlock(activeConv.peer_username, !!activeConv.is_blocked);
                          }}
                          className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl transition-colors text-left ${
                            activeConv.is_blocked
                              ? 'text-wb-brand hover:bg-wb-brand/10'
                              : 'text-wb-warn hover:bg-wb-warn/10'
                          }`}
                        >
                          <Ban className="w-3.5 h-3.5" />
                          <span>{activeConv.is_blocked ? '解除拉黑' : '拉黑该用户'}</span>
                        </button>
                        <div className="h-px bg-wb-border-subtle my-1" />
                        <button
                          type="button"
                          onClick={() => {
                            setShowActionMenu(false);
                            handleDeleteConversation(activeConv.id);
                          }}
                          className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-wb-danger hover:bg-wb-danger/10 transition-colors text-left"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除此会话</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* 私聊消息滚动视窗 */}
                <div
                  ref={convScrollRef}
                  data-stealth={stealth ? 'true' : undefined}
                  className={stealth
                    ? 'wb-msg-viewport wb-msg-list flex-1 overflow-y-auto p-3 space-y-1 bg-zinc-50/70 dark:bg-zinc-950/60 font-mono text-xs'
                    : 'wb-msg-viewport wb-msg-list flex-1 overflow-y-auto p-4 md:p-6 space-y-4'}
                  onScroll={handleMsgScroll}
                >
                  {messages.length === 0 ? (
                    // 加载中不显示"暂无消息记录"，否则先空状态再出列表会有明显闪动
                    loadingMessages ? (
                      <div className="py-20 text-center text-2xs text-wb-text-muted">正在加载消息…</div>
                    ) : (
                      <div className="py-20 text-center text-xs text-wb-text-muted space-y-2">
                        <Sparkles className="w-6 h-6 mx-auto opacity-40 text-wb-warn" />
                        <p>暂无消息记录</p>
                        <p className="text-2xs opacity-75">发送一条问候，开启交流吧！</p>
                      </div>
                    )
                  ) : (
                    messages.map((msg) => {
                      const isMe = msg.sender_id === user?.id;
                      if (msg.is_recalled) {
                        return (
                          <div key={msg.id} className="flex justify-center my-2 select-none">
                            <div className="inline-flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-wb-bg-subtle/80 border border-wb-border-subtle/50 text-2xs text-wb-text-muted">
                                {isMe ? '你撤回了一条消息' : '对方撤回了一条消息'}
                              </span>
                              {/* 与 QQ 一致：自己撤回的消息可以一键回填原文再编辑 */}
                              {isMe && (
                                <button
                                  type="button"
                                  onClick={() => void handleReeditRecalled(msg.id, 'direct')}
                                  title="把撤回前的原文填回输入框"
                                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold text-wb-info bg-wb-info/10 border border-wb-info/25 hover:bg-wb-info/20 transition-colors"
                                >
                                  <Edit3 className="w-3 h-3" />
                                  重新编辑
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      }
                      return (
                        <div
                          key={msg.id}
                          data-msg-id={msg.id}
                          data-stealth-row={stealth ? 'true' : undefined}
                          onClick={() => setActiveMsgId((prev) => (prev === msg.id ? null : msg.id))}
                          className={`flex gap-2.5 items-end group rounded-2xl transition-colors ${
                            isMe ? 'flex-row-reverse' : 'flex-row'
                          } ${highlightMsgId === msg.id ? 'bg-wb-warn/15 ring-2 ring-wb-warn/40' : ''}`}
                        >
                          <UserAvatar
                            username={isMe ? (user?.username || '') : activeConv.peer_username}
                            avatarUrl={isMe ? (user?.avatar_url || '') : activeConv.peer_avatar}
                            size="sm"
                          />

                          <div className={`max-w-[78%] md:max-w-[65%] flex flex-col space-y-1 ${isMe ? 'items-end' : 'items-start'}`}>
                            {/* 头部行与群聊一致：昵称 + 时间 */}
                            <div className={`flex items-center gap-1.5 text-3xs text-wb-text-muted flex-wrap ${isMe ? 'flex-row-reverse justify-start' : 'justify-start'}`}>
                              <span
                                className="font-semibold text-wb-text-secondary cursor-pointer hover:underline"
                                onClick={() => !isMe && onSelectUser?.(activeConv.peer_username)}
                              >
                                {isMe
                                  ? (user?.nickname || user?.username || '')
                                  : (activeConv.peer_nickname || activeConv.peer_username || '')}
                              </span>
                              <span>{formatChatTime(msg.created_at)}</span>
                            </div>
                            <div
                              className={`w-fit max-w-full text-xs md:text-sm leading-relaxed break-words relative ${
                                STICKER_URL_RE.test((msg.content || '').trim())
                                  ? 'bg-transparent p-0 shadow-none'
                                  : `rounded-2xl px-3.5 py-2.5 shadow-sm ${
                                      isMe
                                        ? 'bg-wb-text-primary text-wb-bg-page rounded-tr-xs self-end'
                                        : 'bg-wb-bg-subtle text-wb-text-primary rounded-tl-xs border border-wb-border-subtle self-start'
                                    }`
                              }`}
                            >
                              {/* 引用块：私聊同样展示"回复的是哪句话" */}
                              {(msg as any).reply_snippet && (
                                <div
                                  onClick={() => jumpToMessage((msg as any).reply_to_id)}
                                  title="点击跳到原消息"
                                  className="mb-1.5 max-w-full px-2 py-1 rounded-lg bg-black/10 border-l-2 border-current/40 overflow-hidden cursor-pointer hover:bg-black/20 transition-colors"
                                >
                                  <div className="text-3xs font-semibold opacity-80 truncate">
                                    {(msg as any).reply_sender}
                                  </div>
                                  <div className="text-3xs opacity-80 truncate">{formatPreview((msg as any).reply_snippet)}</div>
                                </div>
                              )}
                              {renderMessageContent(msg.content, user?.username)}
                            </div>
                            {/* 已读状态已下线：is_read 仅作为未读计数的内部水位，不再对外展示 */}

                          </div>
                            <MessageActions
                              isMe={isMe}
                              active={activeMsgId === msg.id}
                              compensateHeader
                              canRecall={isMe && (Date.now() - new Date(msg.created_at).getTime() < 120000 || user?.role === 'admin' || user?.role === 'super_admin')}
                              onRecall={() => handleRecall(msg.id)}
                              onReply={() => setReplyTarget({
                                id: msg.id,
                                sender: isMe
                                  ? (user?.nickname || user?.username || '')
                                  : (activeConv?.peer_nickname || activeConv?.peer_username || ''),
                                snippet: STICKER_URL_RE.test((msg.content || '').trim())
                                  ? '[图片]'
                                  : formatPreview(msg.content || '').slice(0, 60),
                              })}
                            />
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* 私聊底部输入框 */}
                {activeConv.is_blocked ? (
                  <div className="p-4 bg-wb-danger/5 border-t border-wb-danger/20 text-center text-xs text-wb-danger flex items-center justify-center gap-2">
                    <ShieldAlert className="w-4 h-4" />
                    <span>您已拉黑此用户，如需继续沟通请先解除拉黑</span>
                  </div>
                ) : activeConv.is_blocked_by_peer ? (
                  <div className="p-4 bg-wb-warn/5 border-t border-wb-warn/20 text-center text-xs text-wb-warn flex items-center justify-center gap-2">
                    <ShieldAlert className="w-4 h-4" />
                    <span>对方已开启隐私保护或将您列入黑名单，拒收此私聊</span>
                  </div>
                ) : (
                  <form
                    onSubmit={handleSendMessage}
                    {...imageDrop.handlers}
                    className="p-3 md:p-4 border-t border-wb-border-subtle bg-wb-bg-surface flex flex-col gap-1.5 relative"
                  >
                    {imageDrop.dragging && (
                      <div className={DROP_HINT_CLASS}>
                        <ImagePlus className="w-4 h-4" /> 松开即可上传图片（与粘贴上传一致）
                      </div>
                    )}
                    {/* 引用条：单独占一行，位于输入框上方，不再挤占输入框宽度 */}
                    {replyTarget && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-wb-bg-subtle border-l-2 border-wb-info text-2xs">
                        <Reply className="w-3 h-3 text-wb-info shrink-0" />
                        <span className="font-semibold text-wb-info shrink-0 max-w-[10rem] truncate">
                          回复 {replyTarget.sender}
                        </span>
                        <span className="text-wb-text-muted truncate flex-1">{formatPreview(replyTarget.snippet)}</span>
                        <button
                          type="button"
                          onClick={() => setReplyTarget(null)}
                          className="p-0.5 rounded-full text-wb-text-muted hover:text-wb-danger shrink-0"
                          title="取消引用"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 md:gap-2 w-full">
                    {/* 表情选择器浮层 */}
                    <EmojiStickerPanel
                      isOpen={showEmojiPicker}
                      anchor={emojiAnchorRef.current}
                      onClose={() => setShowEmojiPicker(false)}
                      onSelectEmoji={(emoji) => handleInsertEmoji(emoji)}
                      onSelectSticker={(url) => {
                        setShowEmojiPicker(false);
                        handleSendMessage(undefined, url);
                      }}
                    />

                    <label
                      title="发送图片（也可以直接粘贴）"
                      className={`p-1.5 md:p-2 rounded-capsule cursor-pointer transition-colors ${
                        pendingImageUploading
                          ? 'text-wb-text-muted opacity-50 pointer-events-none'
                          : 'text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                      }`}
                    >
                      {pendingImageUploading ? (
                        <span className="flex items-center gap-0.5">
                          <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin" />
                          {uploadPercent > 0 && (
                            <span className="text-3xs font-mono leading-none">{uploadPercent}%</span>
                          )}
                        </span>
                      ) : (
                        <ImagePlus className="w-4 h-4 md:w-5 md:h-5" />
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) uploadPendingImage(file);
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      onClick={(e) => {
                        emojiAnchorRef.current = e.currentTarget as HTMLElement;
                        setShowEmojiPicker(!showEmojiPicker);
                      }}
                      className={`p-2 rounded-capsule transition-colors ${
                        showEmojiPicker
                          ? 'bg-wb-bg-subtle text-wb-text-primary'
                          : 'text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                      }`}
                      title="选择表情"
                    >
                      <Smile className="w-4 h-4 md:w-5 md:h-5" />
                    </button>

                    <div className="relative flex-1 min-w-0">
                      {pendingImageUrl && (
                        <div className="absolute bottom-full left-0 right-0 mb-2 z-20 flex items-center gap-2 p-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle shadow-lg">
                          <img src={pendingImageUrl} alt="待发送图片" className="w-10 h-10 object-cover rounded-lg shrink-0" />
                          <span className="text-3xs text-wb-text-muted flex-1 leading-relaxed">
                            图片已就绪，可继续输入文字一起发送
                          </span>
                          <button type="button" onClick={() => setPendingImageUrl(null)} aria-label="移除待发送图片" className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-bg-subtle">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                      <textarea
                        ref={inputRef}
                        rows={1}
                        value={inputText}
                        onChange={handleInputChange}
                        onKeyDown={handleInputKeyDown}
                        onPaste={(e) => {
                          const file = Array.from(e.clipboardData.files).find((f) =>
                            f.type.startsWith('image/')
                          );
                          if (!file) return;
                          e.preventDefault();
                          uploadPendingImage(file);
                        }}
                        placeholder={stealth ? '> 输入控制台日志... (Enter 发送)' : (isNarrow ? '发消息…' : '发一条私信... (Enter 发送，Shift+Enter 换行，可直接粘贴图片)')}
                        className="w-full px-4 py-2 pr-11 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary placeholder:text-wb-text-muted resize-none leading-relaxed max-h-[120px] overflow-y-auto no-scrollbar"
                      />
                      {/* 展开编辑：固定在输入框右上角，多行时也不会被文字压住 */}
                      <button
                        type="button"
                        onClick={() => setComposerExpanded(true)}
                        className="absolute right-1.5 top-1.5 p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-surface/90 transition-colors"
                        title="展开编辑（长文本时看得更清楚）"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={(!inputText.trim() && !pendingImageUrl) || pendingImageUploading || isSending}
                      className="wb-pressable p-2.5 rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-40 flex items-center justify-center shrink-0"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                    </div>
                  </form>
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-wb-text-muted text-xs p-8">
                <MessageSquare className="w-8 h-8 mb-2 opacity-40" />
                <span>选择左侧联系人开启即时对话</span>
              </div>
            )
          ) : (
            // ==================== 群聊聊天窗口 ====================
            activeGroup ? (
              <>
                {/* 群聊顶部标题栏 */}
                <div className="px-3 md:px-5 py-2.5 md:py-3 border-b border-wb-border-subtle flex items-center justify-between gap-2 bg-wb-bg-surface/80 backdrop-blur-sm relative z-20">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <button
                      type="button"
                      onClick={() => setActiveGroupId(null)}
                      className="md:hidden p-1.5 -ml-1 text-wb-text-secondary hover:text-wb-text-primary rounded-xl hover:bg-wb-bg-subtle transition-colors shrink-0"
                      title="返回群聊列表"
                    >
                      <ArrowLeft className="w-4 h-4" />
                    </button>

                    {groupAvatarUrl(activeGroup) ? (
                      <button
                        type="button"
                        onClick={() =>
                          setAvatarPreview({ src: groupAvatarUrl(activeGroup), name: activeGroup.name })
                        }
                        className="cursor-zoom-in shrink-0"
                        title="点击查看群头像"
                      >
                        <SafeImage
                          compatiblePreview src={groupAvatarUrl(activeGroup) || undefined}
                          alt={activeGroup.name}
                          className="w-8 h-8 md:w-9 md:h-9 rounded-2xl object-cover border border-wb-border-subtle"
                          fallback={
                            <div className="w-8 h-8 md:w-9 md:h-9 rounded-2xl bg-gradient-to-br from-wb-info/10 to-purple-500/20 border border-wb-border-subtle flex items-center justify-center">
                              {activeGroup.is_public ? <Globe className="w-4 h-4 text-wb-brand" /> : <Lock className="w-4 h-4 text-wb-warn" />}
                            </div>
                          }
                        />
                      </button>
                    ) : (
                      <div className="w-8 h-8 md:w-9 md:h-9 rounded-2xl bg-gradient-to-br from-wb-info/10 to-purple-500/20 border border-wb-border-subtle flex items-center justify-center shrink-0">
                        {activeGroup.is_public ? (
                          <Globe className="w-4 h-4 text-wb-brand" />
                        ) : (
                          <Lock className="w-4 h-4 text-wb-warn" />
                        )}
                      </div>
                    )}

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <h3 className="font-semibold text-sm text-wb-text-primary truncate">
                          {activeGroup.name}
                        </h3>
                        {activeGroup.is_public ? (
                          <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded-full bg-wb-info/10 text-wb-info font-medium shrink-0">
                            <Globe className="w-2.5 h-2.5" />
                            <span className="hidden sm:inline">公共频道</span>
                            <span className="sm:hidden">公共</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-3xs px-1.5 py-0.5 rounded-full bg-wb-warn/10 text-wb-warn font-medium shrink-0">
                            <Lock className="w-2.5 h-2.5" />
                            <span className="hidden sm:inline">私密好友群</span>
                            <span className="sm:hidden">私密</span>
                          </span>
                        )}

                        {/* 群主 / 管理员修改群资料与公告快捷按钮 */}
                        {(activeGroup.my_role === 'owner' ||
                          activeGroup.my_role === 'admin' ||
                          ['super_admin', 'admin'].includes(user?.role || '')) && (
                          <button
                            type="button"
                            onClick={handleOpenEditGroupModal}
                            className="inline-flex items-center gap-1 text-3xs text-wb-brand font-medium hover:underline px-1.5 py-0.5 rounded hover:bg-wb-brand/10 transition-colors shrink-0"
                            title="修改群名称、描述与群公告"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span className="hidden sm:inline">编辑群信息</span>
                          </button>
                        )}
                      </div>
                      <div className="flex items-center gap-1.5 text-2xs text-wb-text-muted mt-0.5">
                        <span className="shrink-0 font-mono">
                          {activeGroup.member_count} 成员
                        </span>
                        <span className="text-wb-border-strong shrink-0">•</span>
                        {/* 手机上只留成员数，描述留到桌面端展示，避免头部占三行 */}
                        <p className="truncate hidden sm:block">
                          {activeGroup.description || (activeGroup.is_public ? '社区公共技术探讨频道' : '好友私密交流群')}
                        </p>
                      </div>
                    </div>
                  </div>

                  {/* 右侧：申请加入 / 审批中状态 / 群成员管理按钮 */}
                  <div className="flex items-center gap-1.5 shrink-0">
                    {!activeGroup.is_member && (
                      activeGroup.has_pending_apply ? (
                        <div
                          className="inline-flex items-center gap-1 px-2 md:px-3 py-1 md:py-1.5 rounded-capsule bg-wb-warn/10 border border-wb-warn/30 text-wb-warn dark:text-wb-warn text-xs font-semibold select-none cursor-default shrink-0"
                          title="已提交入群申请，请等待管理员审核"
                        >
                          <Clock className="w-3.5 h-3.5" />
                          <span className="hidden sm:inline">申请审批中</span>
                          <span className="sm:hidden">审批中</span>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleJoinGroup(activeGroup.id)}
                          className="inline-flex items-center gap-1 px-2.5 md:px-3 py-1 md:py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 transition-opacity shrink-0"
                        >
                          <UserPlus className="w-3.5 h-3.5" />
                          <span>加入</span>
                        </button>
                      )
                    )}

                    <button
                      type="button"
                      onClick={() => setAnnouncementHistoryOpen(true)}
                      className="relative p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                      title="群公告历史"
                    >
                      <Megaphone className="w-4 h-4" />
                      {groupAnnouncements.some((a) => !a.is_read) && (
                        <span className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-wb-danger" />
                      )}
                    </button>
                    <button
                      type="button"
                      onClick={() => setSearchOpen(true)}
                      className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                      title="搜索本会话消息"
                    >
                      <Search className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={openMentions}
                      className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors"
                      title="查看 @我 的消息"
                    >
                      <AtSign className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      onClick={handleOpenMembersModal}
                      className="inline-flex items-center gap-1 px-2 md:px-3 py-1 md:py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-primary hover:border-wb-border-strong hover:bg-wb-bg-surface transition-colors shrink-0"
                      title="群成员与管理"
                    >
                      <Users className="w-3.5 h-3.5 text-wb-brand" />
                      <span className="hidden sm:inline">群成员</span>
                      <span className="px-1.5 py-0.2 rounded-full bg-wb-bg-surface text-3xs font-mono border border-wb-border-subtle">
                        {activeGroup.member_count}
                      </span>
                    </button>
                  </div>
                </div>

                {/* 顶部置顶群公告：只展示本人尚未确认已读的最新一条；读完自动沉入公告历史 */}
                {(() => {
                  const canManageAnnouncement =
                    activeGroup.my_role === 'owner' ||
                    activeGroup.my_role === 'admin' ||
                    ['super_admin', 'admin'].includes(user?.role || '');
                  const pinnedAnnouncement = groupAnnouncements.find((a) => !a.is_read) || null;
                  if (!pinnedAnnouncement) {
                    if (!canManageAnnouncement) return null;
                    return (
                      <div className="px-4 py-1.5 bg-wb-bg-subtle/40 border-b border-wb-border-subtle flex items-center justify-between text-2xs text-wb-text-muted shrink-0">
                        <span className="flex items-center gap-1.5">
                          <Megaphone className="w-3.5 h-3.5 text-wb-text-muted" />
                          {groupAnnouncements.length > 0 ? '群公告已全部读完，可在历史中回看' : '当前尚未设置群公告'}
                        </span>
                        <div className="flex items-center gap-2">
                          {groupAnnouncements.length > 0 && (
                            <button
                              type="button"
                              onClick={() => setAnnouncementHistoryOpen(true)}
                              className="text-wb-text-secondary font-medium hover:underline inline-flex items-center gap-1"
                            >
                              <History className="w-3 h-3" />
                              <span>公告历史</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={handleOpenEditGroupModal}
                            className="text-wb-brand font-medium hover:underline inline-flex items-center gap-1"
                          >
                            <Plus className="w-3 h-3" />
                            <span>发布群公告</span>
                          </button>
                        </div>
                      </div>
                    );
                  }
                  return (
                    <div className="px-4 py-2.5 bg-gradient-to-r from-wb-warn/10 via-wb-info/5 to-transparent border-b border-wb-border-subtle flex items-start justify-between gap-3 text-xs shrink-0 animate-in fade-in duration-150">
                      <div className="flex items-start gap-2.5 min-w-0 flex-1">
                        <Megaphone className="w-4 h-4 text-wb-warn shrink-0 mt-0.5 animate-pulse" />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-2xs text-wb-warn dark:text-wb-warn tracking-wide">群公告</span>
                            <span className="text-3xs text-wb-text-muted font-mono">
                              {formatChatTime(pinnedAnnouncement.created_at)}
                            </span>
                            {(pinnedAnnouncement.created_by_nickname || pinnedAnnouncement.created_by_username) && (
                              <span className="text-3xs text-wb-text-muted truncate">
                                {pinnedAnnouncement.created_by_nickname || pinnedAnnouncement.created_by_username}
                              </span>
                            )}
                          </div>
                          <p
                            className={`text-wb-text-secondary text-xs mt-0.5 whitespace-pre-wrap leading-relaxed ${
                              isAnnouncementExpanded ? '' : 'line-clamp-2'
                            }`}
                          >
                            {pinnedAnnouncement.content}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 shrink-0 self-start mt-0.5">
                        {pinnedAnnouncement.content.length > 50 && (
                          <button
                            type="button"
                            onClick={() => setIsAnnouncementExpanded(!isAnnouncementExpanded)}
                            className="text-2xs text-wb-text-muted hover:text-wb-text-primary px-1.5 py-0.5 rounded transition-colors"
                          >
                            {isAnnouncementExpanded ? '收起' : '展开'}
                          </button>
                        )}
                        <button
                          type="button"
                          disabled={confirmingAnnouncementId === pinnedAnnouncement.id}
                          onClick={() => confirmAnnouncementRead(pinnedAnnouncement.id)}
                          className="text-2xs text-wb-success font-semibold hover:underline px-1.5 py-0.5 rounded hover:bg-wb-success/10 transition-colors inline-flex items-center gap-1 disabled:opacity-60"
                          title="确认已读后，该公告不再置顶"
                        >
                          {confirmingAnnouncementId === pinnedAnnouncement.id ? (
                            <Loader2 className="w-3 h-3 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-3 h-3" />
                          )}
                          <span>我已读</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setAnnouncementHistoryOpen(true)}
                          className="text-2xs text-wb-text-muted hover:text-wb-text-primary px-1.5 py-0.5 rounded hover:bg-wb-bg-subtle transition-colors inline-flex items-center gap-1"
                        >
                          <History className="w-3 h-3" />
                          <span>历史</span>
                        </button>
                        {canManageAnnouncement && (
                          <button
                            type="button"
                            onClick={handleOpenEditGroupModal}
                            className="text-2xs text-wb-brand font-medium hover:underline px-1.5 py-0.5 rounded hover:bg-wb-brand/10 transition-colors inline-flex items-center gap-1"
                          >
                            <Edit3 className="w-3 h-3" />
                            <span>编辑</span>
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* 群聊消息滚动视窗 */}
                <div
                  ref={groupScrollRef}
                  data-stealth={stealth ? 'true' : undefined}
                  className={stealth
                    ? 'wb-msg-viewport flex-1 overflow-y-auto p-3 space-y-1 bg-zinc-50/70 dark:bg-zinc-950/60 font-mono text-xs'
                    : 'wb-msg-viewport flex-1 overflow-y-auto p-4 md:p-6 space-y-4'}
                  onScroll={handleMsgScroll}
                >
                  {unreadAtEntry > 0 && (
                    <div className="sticky top-0 z-20 flex justify-center items-center gap-1 pointer-events-none -mt-1 mb-1">
                      <button
                        type="button"
                        onClick={jumpToUnread}
                        disabled={jumpingToUnread}
                        className="pointer-events-auto inline-flex items-center gap-1.5 px-3 py-1.5 min-h-[36px] rounded-capsule bg-wb-info text-white text-2xs font-semibold shadow-lg hover:brightness-110 disabled:opacity-60"
                      >
                        <ArrowUp className="w-3.5 h-3.5" />
                        {jumpingToUnread ? '正在加载未读消息…' : `${unreadAtEntry} 条未读 · 回到上次位置`}
                      </button>
                      <button
                        type="button"
                        aria-label="关闭未读提示"
                        title="不再提示"
                        onClick={() => {
                          unreadAtEntryRef.current = 0;
                          setUnreadAtEntry(0);
                        }}
                        className="pointer-events-auto w-7 h-7 rounded-full bg-wb-bg-surface/90 border border-wb-border-subtle text-wb-text-muted hover:text-wb-text-primary flex items-center justify-center shadow"
                      >
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                  {hasMoreGroupHistory && groupMessages.length > 0 && (
                    <div className="flex justify-center">
                      <button
                        type="button"
                        onClick={loadMoreGroupHistory}
                        disabled={loadingGroupHistory}
                        className="px-3 py-1.5 rounded-full text-2xs font-medium text-wb-text-secondary bg-wb-bg-subtle border border-wb-border-subtle hover:text-wb-text-primary hover:border-wb-border-strong transition-colors disabled:opacity-50"
                      >
                        {loadingGroupHistory ? '正在加载...' : '加载更早的消息'}
                      </button>
                    </div>
                  )}
                  {groupMessages.length === 0 ? (
                    loadingMessages ? (
                      <div className="py-20 text-center text-2xs text-wb-text-muted">正在加载消息…</div>
                    ) : (
                      <div className="py-20 text-center text-xs text-wb-text-muted space-y-2">
                        <Users className="w-6 h-6 mx-auto opacity-40 text-wb-brand" />
                        <p>群聊刚刚建立，欢迎发送第一条消息！</p>
                      </div>
                    )
                  ) : (
                    groupMessages.map((msg) => {
                      const isMe = msg.sender_id === user?.id;
                      if (msg.is_recalled) {
                        return (
                          <div key={msg.id} className="flex justify-center my-2 select-none">
                            <div className="inline-flex items-center gap-1.5">
                              <span className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-wb-bg-subtle/80 border border-wb-border-subtle/50 text-2xs text-wb-text-muted">
                                {isMe
                                  ? '你撤回了一条消息'
                                  : `${msg.sender_nickname || msg.sender_username} 撤回了一条消息`}
                              </span>
                              {isMe && (
                                <button
                                  type="button"
                                  onClick={() => void handleReeditRecalled(msg.id, 'group')}
                                  title="把撤回前的原文填回输入框"
                                  className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-2xs font-semibold text-wb-info bg-wb-info/10 border border-wb-info/25 hover:bg-wb-info/20 transition-colors"
                                >
                                  <Edit3 className="w-3 h-3" />
                                  重新编辑
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      }
                      const senderMember = memberByUsername.get(msg.sender_username);
                      const isOwner = senderMember?.role === 'owner';
                      const isAdmin = senderMember?.role === 'admin';
                      const myRole = myGroupRole || activeGroup.my_role;
                      const isGroupAdmin = myRole === 'owner' || myRole === 'admin' || user?.role === 'super_admin' || user?.role === 'admin';
                      const within2Min = Date.now() - new Date(msg.created_at).getTime() < 120000;
                      const canRecallGroup = isGroupAdmin || (isMe && within2Min);

                      return (
                        <div
                          key={msg.id}
                          data-msg-id={msg.id}
                          data-stealth-row={stealth ? 'true' : undefined}
                          onClick={() => setActiveMsgId((prev) => (prev === msg.id ? null : msg.id))}
                          className={`flex gap-2.5 items-start group rounded-2xl transition-colors ${
                            isMe ? 'flex-row-reverse' : 'flex-row'
                          } ${highlightMsgId === msg.id ? 'bg-wb-warn/15 ring-2 ring-wb-warn/40' : ''}`}
                        >
                          <div
                            className="cursor-pointer shrink-0"
                            onClick={() => onSelectUser?.(msg.sender_username)}
                            title={`查看 @${msg.sender_username} 的个人主页`}
                          >
                            <UserAvatar
                              username={msg.sender_username}
                              avatarUrl={msg.sender_avatar}
                              size="sm"
                            />
                          </div>

                          <div className={`max-w-[78%] md:max-w-[65%] flex flex-col space-y-1 ${isMe ? 'items-end' : 'items-start'}`}>
                            {/* 发送人昵称、角色徽章、等级与快捷 @ 提及 */}
                            <div className={`flex items-center gap-1.5 text-3xs text-wb-text-muted flex-wrap ${isMe ? 'flex-row-reverse justify-start' : 'justify-start'}`}>
                              <span
                                className="font-semibold text-wb-text-secondary cursor-pointer hover:underline"
                                onClick={() => onSelectUser?.(msg.sender_username)}
                              >
                                {msg.sender_nickname || msg.sender_username}
                              </span>

                              {/* 群主 / 管理员角标 */}
                              {isOwner ? (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full text-3xs font-bold bg-wb-warn/15 text-wb-warn border border-wb-warn/25">
                                  <Crown className="w-2.5 h-2.5 fill-current" />
                                  <span>群主</span>
                                </span>
                              ) : isAdmin ? (
                                <span className="inline-flex items-center gap-0.5 px-1.5 py-0.2 rounded-full text-3xs font-semibold bg-wb-info/15 text-wb-info border border-wb-info/25">
                                  <Shield className="w-2.5 h-2.5" />
                                  <span>管理员</span>
                                </span>
                              ) : null}

                              <GroupBadge
                                level={senderMember?.group_level || 1}
                                name={senderMember?.badge_name}
                                badgeId={senderMember?.group_level || 1}
                                showLevel={senderMember?.badge_kind !== 'special'}
                              />
                              <span>
                                {formatChatTime(msg.created_at)}
                              </span>

                              {/* 快捷 @ 提及按钮 */}
                              {!isMe && (
                                <button
                                  type="button"
                                  onClick={() => handleQuickMention(msg.sender_username)}
                                  className={`opacity-0 group-hover:opacity-100 hover:text-wb-brand transition-opacity ml-0.5 ${activeMsgId === msg.id ? 'max-sm:opacity-100' : 'max-sm:opacity-0'}`}
                                  title={`@提及 ${msg.sender_nickname || msg.sender_username}`}
                                >
                                  <AtSign className="w-3 h-3" />
                                </button>
                              )}

                              {/* 群消息撤回按钮 */}
                              {canRecallGroup && (
                                <button
                                  type="button"
                                  onClick={() => handleRecallGroupMessage(msg.id)}
                                  className={`opacity-0 group-hover:opacity-100 hover:text-wb-danger transition-opacity ml-1 ${activeMsgId === msg.id ? 'max-sm:opacity-100' : 'max-sm:opacity-0'}`}
                                  title="撤回该群消息"
                                >
                                  撤回
                                </button>
                              )}
                            </div>

                            {/* 消息气泡：使用 w-fit max-w-full，短文本紧贴文字绝不被顶栏过长信息撑开 */}
                            <div
                              className={`w-fit max-w-full text-xs md:text-sm leading-relaxed break-words relative ${
                                STICKER_URL_RE.test((msg.content || '').trim())
                                  ? // 表情包：裸图，不加气泡，不加内边距
                                    'bg-transparent p-0 shadow-none self-start'
                                  : `rounded-2xl px-3.5 py-2.5 shadow-sm ${
                                      isMe
                                        ? 'bg-wb-text-primary text-wb-bg-page rounded-tr-xs self-end'
                                        : 'bg-wb-bg-subtle text-wb-text-primary rounded-tl-xs border border-wb-border-subtle self-start'
                                    }`
                              }`}
                            >
                              {/* 引用块：只占两行高度，能看清"回复的是谁、说了什么" */}
                              {msg.reply_snippet && (
                                <div
                                  onClick={() => jumpToMessage(msg.reply_to_id)}
                                  title="点击跳到原消息"
                                  className="mb-1.5 max-w-full px-2 py-1 rounded-lg bg-black/10 border-l-2 border-current/40 overflow-hidden cursor-pointer hover:bg-black/20 transition-colors"
                                >
                                  <div className="text-3xs font-semibold opacity-80 truncate">
                                    {msg.reply_sender}
                                  </div>
                                  <div className="text-3xs opacity-80 truncate">{formatPreview(msg.reply_snippet)}</div>
                                </div>
                              )}
                              {msg.msg_type === 'dice' ? (
                                <div className="inline-flex p-1.5 rounded-2xl">
                                  <DiceCube
                                    value={(() => { try { return JSON.parse(msg.content).points; } catch { return 1; } })()}
                                    animate={Boolean(msg.created_at && Date.now() - new Date(msg.created_at).getTime() < 120000)}
                                  />
                                </div>
                              ) : (msg.msg_type === 'chain' || msg.msg_type === 'poll' || msg.msg_type === 'fortune' || msg.msg_type === 'feihua') ? (
                                (() => {
                                  let d: any = {};
                                  try { d = JSON.parse(msg.content) || {}; } catch { d = {}; }
                                  const isChainEnd = msg.msg_type === 'chain' && d.kind === 'end';
                                  const isFeihua = msg.msg_type === 'feihua';
                                  const isFeihuaEnd = isFeihua && d.kind === 'end';
                                  const isGood = isChainEnd || (isFeihua && d.kind === 'accept');
                                  const title = isChainEnd ? '接龙战报'
                                    : isFeihuaEnd ? '飞花令战报'
                                    : isFeihua
                                      ? (d.kind === 'start' ? '飞花令 · 开局' : d.kind === 'accept' ? '飞花令 · 答对' : '飞花令 · 提示')
                                      : '群互动 · 接龙裁判';
                                  return (
                                    <div className={`inline-flex items-start gap-2 px-3 py-2 rounded-2xl max-w-full border ${
                                      isFeihua
                                        ? (isGood ? 'bg-wb-success/10 border-wb-success/30' : 'bg-wb-info/10 border-wb-info/30')
                                        : (isChainEnd ? 'bg-wb-success/10 border-wb-success/30' : 'bg-wb-info/10 border-wb-info/30')
                                    }`}>
                                      <span className="text-base leading-none">
                                        {isFeihua ? (isFeihuaEnd ? '🏁' : '🏮') : (isChainEnd ? '🏁' : '🤖')}
                                      </span>
                                      <div className="min-w-0">
                                        <div className="text-2xs font-bold text-wb-text-primary">{title}</div>
                                        {d.user && d.user_word ? (
                                          <div className={`mt-0.5 mb-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-capsule text-3xs font-semibold ${d.kind === 'wrong' ? 'bg-wb-danger/15 text-wb-danger' : 'bg-wb-success/15 text-wb-success'}`}>
                                            {d.kind === 'wrong' ? '✕' : '✓'} {d.user} 接「{d.user_word}」
                                          </div>
                                        ) : null}
                                        <div className="text-2xs text-wb-text-secondary leading-relaxed break-words whitespace-pre-line">
                                          {d.text || ''}
                                        </div>
                                        {msg.msg_type === 'chain' && (
                                          <button
                                            type="button"
                                            onClick={() => { setShowToolbox(false); setActivityKind('chain'); }}
                                            className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule bg-wb-brand text-white text-3xs font-bold hover:brightness-110 transition-all"
                                            title="直接打开接龙面板，输入成语接龙"
                                          >
                                            接
                                          </button>
                                        )}
                                        {isFeihua && !isFeihuaEnd && (
                                          <button
                                            type="button"
                                            onClick={() => { setShowToolbox(false); setActivityKind('feihua'); }}
                                            className="mt-1 inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule bg-wb-brand text-white text-3xs font-bold hover:brightness-110 transition-all"
                                            title="打开飞花令面板，输入含令字的诗句"
                                          >
                                            对诗
                                          </button>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })()
                              ) : msg.msg_type === 'checkin' ? (
                                <div className="wb-checkin-card inline-flex items-center gap-2 px-3 py-2 rounded-2xl">
                                  <span className="text-lg leading-none">✅</span>
                                  <div>
                                    <div className="text-xs font-bold">每日签到 · {msg.content}</div>
                                    <div className="text-3xs font-mono wb-checkin-sub">群等级经验已到账</div>
                                  </div>
                                </div>
                              ) : renderMessageContent(msg.content, user?.username, groupMemberNameSet, groupMemberNickMap, groupMemberNickToUsername)}
                            </div>
                          </div>
                          <MessageActions
                            isMe={isMe}
                            active={activeMsgId === msg.id}
                            compensateHeader
                            onReply={() => {
                              setReplyTarget({
                                id: msg.id,
                                sender: msg.sender_nickname || msg.sender_username,
                                snippet: STICKER_URL_RE.test((msg.content || '').trim())
                                  ? '[图片]'
                                  : formatPreview(msg.content || '').slice(0, 60),
                              });
                              handleQuickMention(msg.sender_username);
                            }}
                          />
                        </div>
                      );
                    })
                  )}
                  <div ref={messagesEndRef} />
                </div>

                {/* 群聊底部输入栏或未加入提示 */}
                {!activeGroup.is_member ? (
                  <div className="p-4 border-t border-wb-border-subtle bg-wb-bg-surface/90 flex flex-col sm:flex-row items-center justify-between gap-3 text-center sm:text-left">
                    <div className="flex items-center gap-2 text-xs text-wb-text-secondary">
                      {activeGroup.has_pending_apply ? (
                        <>
                          <Clock className="w-4 h-4 text-wb-warn shrink-0 animate-pulse" />
                          <span>您的入群申请已提交，群主或管理员正在审核中，请耐心等待。</span>
                        </>
                      ) : activeGroup.is_public ? (
                        <>
                          <Globe className="w-4 h-4 text-wb-brand shrink-0" />
                          <span>公共群聊实行申请准入制，提交申请并经管理员同意后即可加入发言。</span>
                        </>
                      ) : (
                        <>
                          <Lock className="w-4 h-4 text-wb-warn shrink-0" />
                          <span>私密群聊实行申请与邀请制，提交申请并经审核同意后方可参与讨论。</span>
                        </>
                      )}
                    </div>
                    {activeGroup.has_pending_apply ? (
                      <button
                        type="button"
                        disabled
                        className="px-5 py-2 rounded-xl bg-wb-warn/10 border border-wb-warn/30 text-wb-warn dark:text-wb-warn text-xs font-semibold shrink-0 inline-flex items-center gap-1.5 cursor-not-allowed"
                      >
                        <Clock className="w-3.5 h-3.5" />
                        <span>申请审批中</span>
                      </button>
                    ) : (
                      <button
                        type="button"
                        onClick={() => handleJoinGroup(activeGroup.id)}
                        className="px-5 py-2 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 transition-opacity shrink-0 inline-flex items-center gap-1.5 shadow-sm"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>申请加入群聊</span>
                      </button>
                    )}
                  </div>
                ) : (
                  <form
                    onSubmit={handleSendMessage}
                    {...imageDrop.handlers}
                    className="p-3 md:p-4 border-t border-wb-border-subtle bg-wb-bg-surface flex flex-col gap-1.5 relative"
                  >
                    {imageDrop.dragging && (
                      <div className={DROP_HINT_CLASS}>
                        <ImagePlus className="w-4 h-4" /> 松开即可上传图片（与粘贴上传一致）
                      </div>
                    )}
                    {/* 引用条：单独占一行，位于输入框上方，不再挤占输入框宽度 */}
                    {replyTarget && (
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-wb-bg-subtle border-l-2 border-wb-info text-2xs">
                        <Reply className="w-3 h-3 text-wb-info shrink-0" />
                        <span className="font-semibold text-wb-info shrink-0 max-w-[10rem] truncate">
                          回复 {replyTarget.sender}
                        </span>
                        <span className="text-wb-text-muted truncate flex-1">{formatPreview(replyTarget.snippet)}</span>
                        <button
                          type="button"
                          onClick={() => setReplyTarget(null)}
                          className="p-0.5 rounded-full text-wb-text-muted hover:text-wb-danger shrink-0"
                          title="取消引用"
                        >
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    )}

                    <div className="flex items-center gap-1.5 md:gap-2 w-full">
                  {showToolbox && (
                    <div
                      ref={toolboxRef}
                      className="absolute bottom-full left-4 mb-2 w-60 max-w-[calc(100vw-2rem)] rounded-2xl frost-panel border border-wb-border-subtle shadow-2xl p-1.5 z-50 space-y-0.5"
                    >
                      <p className="px-2 py-1 text-3xs font-semibold text-wb-text-muted">群互动工具箱</p>
                      {toolboxActions.map((act) => (
                        <button
                          key={act.key}
                          type="button"
                          onClick={act.run}
                          className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-2xs text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                        >
                          <act.icon className="w-3.5 h-3.5 text-wb-brand shrink-0" />
                          <span className="font-semibold">{act.label}</span>
                          <span className="ml-auto text-3xs text-wb-text-muted">{act.hint}</span>
                        </button>
                      ))}
                    </div>
                  )}

                    {/* @ 艾特提及自动补全浮层 */}
                    {showMentionPopover && mentionCandidates.length > 0 && (
                      <div
                        ref={mentionPopoverRef}
                        className="absolute bottom-full left-4 mb-2 w-64 md:w-72 bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-2xl p-1.5 z-50 text-xs animate-in fade-in zoom-in-95 duration-100 max-h-56 overflow-y-auto"
                      >
                        <div className="px-2.5 py-1 text-3xs font-semibold text-wb-text-muted border-b border-wb-border-subtle flex items-center justify-between">
                          <span className="flex items-center gap-1">
                            <AtSign className="w-3 h-3 text-wb-brand" />
                            提及群成员
                          </span>
                          <span className="font-mono">
                            {canMentionAll && mentionAllQuota
                              ? `@全体剩余 ${mentionAllQuota.remaining}/${mentionAllQuota.limit}`
                              : `${mentionCandidates.length} 人`}
                          </span>
                        </div>
                        <div className="pt-1 space-y-0.5">
                          {mentionCandidates.map((m, idx) => {
                            const isSelected = idx === mentionIndex;
                            if (m.is_all) {
                              return (
                                <button
                                  key={m.user_id}
                                  ref={(el) => {
                                    mentionItemRefs.current[idx] = el;
                                  }}
                                  type="button"
                                  disabled={mentionAllQuota?.remaining === 0}
                                  onClick={() => handleSelectMention(m)}
                                  className={`w-full flex items-center justify-between p-2 rounded-xl transition-colors text-left disabled:opacity-50 ${
                                    isSelected
                                      ? 'bg-wb-danger/10 text-wb-danger font-semibold'
                                      : 'hover:bg-wb-bg-subtle text-wb-text-primary'
                                  }`}
                                >
                                  <div className="flex items-center gap-2 min-w-0">
                                    <span className="w-6 h-6 rounded-full bg-wb-danger/10 text-wb-danger flex items-center justify-center shrink-0">
                                      <BellRing className="w-3.5 h-3.5" />
                                    </span>
                                    <div className="min-w-0">
                                      <div className="text-xs truncate">全体成员</div>
                                      <div className="text-3xs text-wb-text-muted font-mono truncate">
                                        @全体成员 · 通知群内所有人
                                      </div>
                                    </div>
                                  </div>
                                  <span className="shrink-0 ml-1 text-3xs font-semibold text-wb-danger/80">
                                    {mentionAllQuota ? `${mentionAllQuota.remaining}/10` : '10 次/天'}
                                  </span>
                                </button>
                              );
                            }
                            return (
                              <button
                                key={m.user_id}
                                ref={(el) => {
                                  mentionItemRefs.current[idx] = el;
                                }}
                                type="button"
                                onClick={() => handleSelectMention(m)}
                                className={`w-full flex items-center justify-between p-2 rounded-xl transition-colors text-left ${
                                  isSelected
                                    ? 'bg-wb-brand/10 text-wb-brand font-semibold'
                                    : 'hover:bg-wb-bg-subtle text-wb-text-primary'
                                }`}
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <UserAvatar username={m.username} avatarUrl={m.avatar_url} size="xs" />
                                  <div className="min-w-0">
                                    <div className="text-xs truncate">
                                      {m.nickname || m.username}
                                    </div>
                                    <div className="text-3xs text-wb-text-muted font-mono truncate">
                                      @{m.username}
                                    </div>
                                  </div>
                                </div>
                                <div className="shrink-0 ml-1">
                                  {m.role === 'owner' ? (
                                    <span className="text-3xs px-1 py-0.2 rounded bg-wb-warn/15 text-wb-warn font-bold">
                                      群主
                                    </span>
                                  ) : m.role === 'admin' ? (
                                    <span className="text-3xs px-1 py-0.2 rounded bg-wb-info/15 text-wb-info font-medium">
                                      管理员
                                    </span>
                                  ) : null}
                                </div>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {/* 表情选择器浮层 */}
                    <EmojiStickerPanel
                      isOpen={showEmojiPicker}
                      anchor={emojiAnchorRef.current}
                      onClose={() => setShowEmojiPicker(false)}
                      onSelectEmoji={(emoji) => handleInsertEmoji(emoji)}
                      onSelectSticker={(url) => {
                        setShowEmojiPicker(false);
                        handleSendMessage(undefined, url);
                      }}
                    />

                    {/* 快捷表情按钮 */}
                    <label
                      title="发送图片（也可以直接粘贴）"
                      className={`p-1.5 md:p-2 rounded-capsule cursor-pointer transition-colors ${
                        pendingImageUploading
                          ? 'text-wb-text-muted opacity-50 pointer-events-none'
                          : 'text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                      }`}
                    >
                      {pendingImageUploading ? (
                        <span className="flex items-center gap-0.5">
                          <Loader2 className="w-4 h-4 md:w-5 md:h-5 animate-spin" />
                          {uploadPercent > 0 && (
                            <span className="text-3xs font-mono leading-none">{uploadPercent}%</span>
                          )}
                        </span>
                      ) : (
                        <ImagePlus className="w-4 h-4 md:w-5 md:h-5" />
                      )}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (file) uploadPendingImage(file);
                        }}
                      />
                    </label>

                    <button
                      type="button"
                      onClick={(e) => {
                        emojiAnchorRef.current = e.currentTarget as HTMLElement;
                        setShowEmojiPicker(!showEmojiPicker);
                      }}
                      className={`p-2 rounded-capsule transition-colors ${
                        showEmojiPicker
                          ? 'bg-wb-bg-subtle text-wb-text-primary'
                          : 'text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                      }`}
                      title="选择表情"
                    >
                      <Smile className="w-4 h-4 md:w-5 md:h-5" />
                    </button>

                    {/* 群互动工具箱（替代原 @ 按钮） */}
                    <button
                      type="button"
                      onClick={() => setShowToolbox((v) => !v)}
                      className="flex p-1.5 md:p-2 rounded-capsule text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors shrink-0"
                      title="工具箱"
                      aria-label="工具箱"
                      aria-expanded={showToolbox}
                    >
                      <Wrench className="w-4 h-4 md:w-5 md:h-5" />
                    </button>

                    {/* 引用条：告诉用户即将回复哪一条，可随时取消 */}
                    <div className="relative flex-1 min-w-0">
                      {pendingImageUrl && (
                        <div className="absolute bottom-full left-0 right-0 mb-2 z-20 flex items-center gap-2 p-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle shadow-lg">
                          <img src={pendingImageUrl} alt="待发送图片" className="w-10 h-10 object-cover rounded-lg shrink-0" />
                          <span className="text-3xs text-wb-text-muted flex-1 leading-relaxed">
                            图片已就绪，可继续输入文字一起发送
                          </span>
                          <button type="button" onClick={() => setPendingImageUrl(null)} aria-label="移除待发送图片" className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger hover:bg-wb-bg-subtle">
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                      <textarea
                        ref={inputRef}
                        rows={1}
                        value={inputText}
                        onChange={handleInputChange}
                        onKeyDown={handleInputKeyDown}
                        onPaste={(e) => {
                          const file = Array.from(e.clipboardData.files).find((f) =>
                            f.type.startsWith('image/')
                          );
                          if (!file) return;
                          e.preventDefault();
                          uploadPendingImage(file);
                        }}
                        placeholder={stealth ? '> 输入控制台日志... (Enter 发送)' : (isNarrow ? '发消息…' : `在 #${activeGroup.name} 中发言，输入 @ 提及群友，可粘贴图片...`)}
                        className="w-full px-4 py-2 pr-11 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary placeholder:text-wb-text-muted resize-none leading-relaxed max-h-[120px] overflow-y-auto no-scrollbar"
                      />
                      {/* 展开编辑：固定在输入框右上角，多行时也不会被文字压住 */}
                      <button
                        type="button"
                        onClick={() => setComposerExpanded(true)}
                        className="absolute right-1.5 top-1.5 p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-surface/90 transition-colors"
                        title="展开编辑（长文本时看得更清楚）"
                      >
                        <Maximize2 className="w-3.5 h-3.5" />
                      </button>
                    </div>

                    <button
                      type="submit"
                      disabled={(!inputText.trim() && !pendingImageUrl) || pendingImageUploading || isSending}
                      className="wb-pressable p-2.5 rounded-capsule bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-40 flex items-center justify-center shrink-0"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                    </div>
                  </form>
                )}
              </>
            ) : (
              <div className="flex-1 flex flex-col items-center justify-center text-wb-text-muted text-xs p-8 gap-2">
                <Users className="w-8 h-8 opacity-40" />
                <span>选择左侧群聊频道加入探讨</span>
                <button
                  type="button"
                  onClick={() => {
                    setActiveGroupId(null);
                    localStorage.removeItem('geek_chat_active_group_id');
                  }}
                  className="md:hidden mt-2 px-3 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-primary text-xs hover:border-wb-border-strong transition-colors"
                >
                  返回群聊列表
                </button>
              </div>
            )
          )}
      {/* QQ 式回到最新：贴在聊天窗口内侧；爬楼期间新到的消息以角标计数 */}
      {showBackToBottom && (activeGroup || activeConv) && (
        <button
          type="button"
          onClick={scrollToLatest}
          aria-label={
            newMessagesWhileAway > 0
              ? `回到最新消息（${newMessagesWhileAway} 条新消息）`
              : '回到最新消息'
          }
          title={
            newMessagesWhileAway > 0
              ? `${newMessagesWhileAway} 条新消息`
              : '回到最新消息'
          }
          className="absolute bottom-24 right-4 z-30 w-10 h-10 rounded-full bg-wb-bg-surface border border-wb-border-subtle shadow-lg flex items-center justify-center text-wb-text-primary hover:bg-wb-bg-subtle active:scale-95 transition-transform"
        >
          <ArrowDown className="w-4 h-4" />
          {newMessagesWhileAway > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[18px] h-[18px] px-1 rounded-full bg-wb-danger text-white text-3xs font-bold flex items-center justify-center ring-2 ring-wb-bg-surface">
              {newMessagesWhileAway > 99 ? '99+' : newMessagesWhileAway}
            </span>
          )}
        </button>
      )}
        </main>
      </div>



      {/* ==================== 快捷右键上下文操作菜单 (Context Menu) ==================== */}
      {/* 右键菜单 portal 到 body：原来挂在 Chat 组件树里会被父容器 transform/overflow 裁剪，
          坐标也被算到左上角，表现为「点了三个功能都没反应」 */}
      {contextMenu.visible && contextMenu.conv && createPortal(
        <div
          ref={contextMenuRef}
          style={{ top: `${contextMenu.y}px`, left: `${contextMenu.x}px`, zIndex: 150 }}
          className="fixed w-44 bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-2xl p-1.5 text-xs animate-in fade-in zoom-in-95 duration-100"
          onClick={(e) => e.stopPropagation()}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="px-3 py-1.5 text-3xs text-wb-text-muted font-mono border-b border-wb-border-subtle mb-1 truncate">
            @{contextMenu.conv.peer_username}
          </div>

          <button
            type="button"
            onClick={() => {
              const cid = contextMenu.conv!.id;
              setContextMenu((prev) => ({ ...prev, visible: false }));
              togglePinConversation(cid);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
          >
            <Pin className="w-3.5 h-3.5 text-wb-warn" />
            <span>
              {pinnedConvIds.includes(contextMenu.conv.id) ? '取消置顶会话' : '置顶此会话'}
            </span>
          </button>

          <button
            type="button"
            onClick={() => {
              const peer = contextMenu.conv!;
              setContextMenu((prev) => ({ ...prev, visible: false }));
              handleToggleBlock(peer.peer_username, !!peer.is_blocked);
            }}
            className={`w-full flex items-center gap-2 px-3 py-2 rounded-xl transition-colors text-left ${
              contextMenu.conv.is_blocked
                ? 'text-wb-brand hover:bg-wb-brand/10'
                : 'text-wb-warn hover:bg-wb-warn/10'
            }`}
          >
            <Ban className="w-3.5 h-3.5" />
            <span>{contextMenu.conv.is_blocked ? '解除拉黑' : '拉黑该用户'}</span>
          </button>

          <div className="h-px bg-wb-border-subtle my-1" />

          <button
            type="button"
            onClick={() => {
              const cid = contextMenu.conv!.id;
              setContextMenu((prev) => ({ ...prev, visible: false }));
              handleDeleteConversation(cid);
            }}
            className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-wb-danger hover:bg-wb-danger/10 transition-colors text-left"
          >
            <Trash2 className="w-3.5 h-3.5" />
            <span>删除此会话</span>
          </button>
        </div>,
        document.body
      )}

      {/* ==================== 发起新私聊模态弹窗 ==================== */}
      {isNewChatModalOpen && (
        <div
          ref={newChatDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="发起私聊对话"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-3xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-5 h-5 text-wb-brand" />
                <h3 className="font-bold text-base text-wb-text-primary">发起私聊对话</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsNewChatModalOpen(false)}
                className="p-1 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleStartNewChat} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                  对方用户名 <span className="text-wb-danger">*</span>
                </label>
                <input
                  type="text"
                  value={newChatTargetUsername}
                  onChange={(e) => setNewChatTargetUsername(e.target.value)}
                  placeholder="输入目标极客用户名，如：Hyperion"
                  autoFocus
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
                />
                <p className="text-2xs text-wb-text-muted mt-1.5">
                  输入对方用户名即可快速建立双人实时私信会话。
                </p>
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsNewChatModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-wb-text-muted hover:bg-wb-bg-subtle transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!newChatTargetUsername.trim() || isStartingChat}
                  className="px-4 py-2 rounded-xl text-xs font-semibold bg-wb-text-primary text-wb-bg-page hover:opacity-90 transition-opacity disabled:opacity-50"
                >
                  {isStartingChat ? '正在查找...' : '开始私聊'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== 新建群聊频道模态弹窗 ==================== */}
      {isGroupModalOpen && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="操作对话框"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-3xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2">
                <Users className="w-5 h-5 text-wb-brand" />
                <h3 className="font-bold text-base text-wb-text-primary">创建新群聊频道</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsGroupModalOpen(false)}
                className="p-1 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleCreateGroup} className="space-y-4">
              {/* 群聊类型选择器 */}
              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-2">
                  群聊类型与权限
                </label>
                <div className="grid grid-cols-2 gap-2.5">
                  {/* 公共频道选项 */}
                  <div
                    onClick={() => {
                      if (!groupQuota?.can_create_public) {
                        toast.warning('公共频道为社区公开资源，仅限板块版主及以上管理人员创建');
                        return;
                      }
                      if (groupQuota.public_created_count >= groupQuota.public_max_limit) {
                        toast.warning(`已达到版主公共群聊配额上限 (${groupQuota.public_max_limit} 个)`);
                        return;
                      }
                      setNewGroupIsPublic(true);
                    }}
                    className={`p-3 rounded-2xl border transition-all cursor-pointer relative ${
                      newGroupIsPublic
                        ? 'bg-wb-brand/5 border-wb-brand shadow-sm'
                        : 'bg-wb-bg-subtle/50 border-wb-border-subtle hover:border-wb-border-strong opacity-80'
                    } ${!groupQuota?.can_create_public ? 'opacity-50 cursor-not-allowed' : ''}`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Globe className={`w-4 h-4 ${newGroupIsPublic ? 'text-wb-brand' : 'text-wb-text-muted'}`} />
                        <span className="text-xs font-bold text-wb-text-primary">公共频道</span>
                      </div>
                      <span className="text-3xs px-1.5 py-0.2 rounded-full bg-wb-info/10 text-wb-info font-mono">
                        版主专属
                      </span>
                    </div>
                    <p className="text-2xs text-wb-text-muted leading-tight">
                      全站公开索引，任意极客均可发现与参与探讨。
                    </p>
                    {groupQuota && (
                      <div className="mt-2 text-3xs font-mono text-wb-text-muted">
                        {groupQuota.can_create_public
                          ? `已建配额: ${groupQuota.public_created_count} / ${groupQuota.public_max_limit}`
                          : '需版主或站长权限'}
                      </div>
                    )}
                  </div>

                  {/* 私密好友群选项 */}
                  <div
                    onClick={() => {
                      if (groupQuota && groupQuota.private_created_count >= groupQuota.private_max_limit) {
                        toast.warning(`私密好友群已达上限 (${groupQuota.private_max_limit} 个)`);
                        return;
                      }
                      setNewGroupIsPublic(false);
                    }}
                    className={`p-3 rounded-2xl border transition-all cursor-pointer relative ${
                      !newGroupIsPublic
                        ? 'bg-wb-warn/5 border-wb-warn shadow-sm'
                        : 'bg-wb-bg-subtle/50 border-wb-border-subtle hover:border-wb-border-strong opacity-80'
                    }`}
                  >
                    <div className="flex items-center justify-between mb-1.5">
                      <div className="flex items-center gap-1.5">
                        <Lock className={`w-4 h-4 ${!newGroupIsPublic ? 'text-wb-warn' : 'text-wb-text-muted'}`} />
                        <span className="text-xs font-bold text-wb-text-primary">私密好友群</span>
                      </div>
                      <span className="text-3xs px-1.5 py-0.2 rounded-full bg-wb-warn/10 text-wb-warn font-mono">
                        好友/小组
                      </span>
                    </div>
                    <p className="text-2xs text-wb-text-muted leading-tight">
                      仅群成员可见，全网不公开，受邀好友可进群。
                    </p>
                    {groupQuota && (
                      <div className="mt-2 text-3xs font-mono text-wb-text-muted">
                        已建配额: {groupQuota.private_created_count} / {groupQuota.private_max_limit}
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                  群聊名称 <span className="text-wb-danger">*</span>
                </label>
                <input
                  type="text"
                  value={newGroupName}
                  onChange={(e) => setNewGroupName(e.target.value)}
                  placeholder={newGroupIsPublic ? '如：Rust 异步并发实践探讨' : '如：极客朋友小圈子 / 敏捷小队'}
                  maxLength={50}
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                  群聊简介或讨论主题
                </label>
                <textarea
                  value={newGroupDesc}
                  onChange={(e) => setNewGroupDesc(e.target.value)}
                  placeholder="简要描述该群聊关注的技术方向或交流规范..."
                  rows={2}
                  maxLength={200}
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsGroupModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-wb-text-muted hover:bg-wb-bg-subtle transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!newGroupName.trim() || isCreatingGroup}
                  className="px-5 py-2 rounded-xl text-xs font-semibold bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {isCreatingGroup ? '创建中...' : '确认创建'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== 群成员管理与申请审批模态弹窗 ==================== */}
      {/* 禁言 / 铭牌设置弹窗 */}
      {memberAction && (() => {
        const dialogRole = myGroupRole || activeGroup?.my_role || '';
        const isDialogManager = memberAction.type === 'badge' && (
          dialogRole === 'owner' || dialogRole === 'admin' ||
          ['super_admin', 'admin'].includes(user?.role || '')
        );
        const isSelfDialog = String(memberAction.member?.user_id || '') === String(user?.id || '');
        return createPortal(
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
             onClick={() => setMemberAction(null)}>
          <div className="w-full max-w-md rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-4"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-wb-text-primary">
                {memberAction.type === 'mute' ? '禁言成员' : '铭牌管理'}
              </h3>
              <button type="button" onClick={() => setMemberAction(null)} className="p-1 rounded-lg text-wb-text-muted hover:bg-wb-bg-subtle">
                <X className="w-4 h-4" />
              </button>
            </div>
            <p className="text-2xs text-wb-text-muted">
              目标：{memberAction.member.nickname || memberAction.member.username}
            </p>
            {memberAction.type === 'mute' ? (
              <div className="space-y-3">
                <label className="block text-2xs font-semibold text-wb-text-secondary">禁言时长（分钟）</label>
                <div className="flex gap-1.5 flex-wrap">
                  {[10, 30, 60, 360, 1440, 10080].map((m) => (
                    <button key={m} type="button" onClick={() => setMuteMinutes(m)}
                      className={`h-8 px-2.5 rounded-capsule text-2xs font-semibold transition-colors ${muteMinutes === m ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'}`}>
                      {m < 60 ? `${m}分` : m < 1440 ? `${m / 60}时` : `${m / 1440}天`}
                    </button>
                  ))}
                </div>
                <input value={muteReason} onChange={(e) => setMuteReason(e.target.value)}
                  placeholder="禁言原因（选填）" maxLength={200}
                  className="w-full h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none" />
              </div>
            ) : (
              <div className="space-y-3">
                {/* 等级铭牌：只读，任何人不可授予 */}
                <div className="p-2.5 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-2xs font-semibold text-wb-text-primary">等级铭牌</span>
                    <GroupBadge
                      level={badgeLevel}
                      name={GROUP_BADGE_NAMES[badgeLevel - 1]}
                      badgeId={badgeLevel}
                    />
                  </div>
                  <p className="text-3xs text-wb-text-muted leading-relaxed">
                    由群等级自动决定，只能通过群内活跃升级获得；站长、群主与管理员均无权授予或更改。
                  </p>
                </div>

                {/* 特殊名牌列表 */}
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between">
                    <span className="text-2xs font-semibold text-wb-text-primary">特殊名牌</span>
                    <span className="text-3xs text-wb-text-muted">
                      {isDialogManager ? '可授予 / 收回' : '选择要佩戴的名牌'}
                    </span>
                  </div>
                  <div className="max-h-40 overflow-y-auto space-y-1">
                    {badgeList.length === 0 && (
                      <p className="py-3 text-center text-3xs text-wb-text-muted">
                        {isDialogManager ? '还没有特殊名牌，可在下方输入名称授予' : '暂未获得特殊名牌'}
                      </p>
                    )}
                    {badgeList.map((b) => {
                      const worn = badgeWearing === b.name;
                      return (
                        <div key={b.id}
                          className={`flex items-center gap-1.5 px-2 py-1.5 rounded-xl border transition-colors ${worn ? 'bg-wb-brand/10 border-wb-brand/30' : 'bg-wb-bg-subtle/40 border-transparent hover:bg-wb-bg-subtle'}`}>
                          <GroupBadge level={badgeLevel} name={b.name} badgeId={badgeLevel} showLevel={false} />
                          {worn && <span className="text-3xs text-wb-brand font-semibold">佩戴中</span>}
                          <div className="ml-auto flex items-center gap-1">
                            {!worn && isSelfDialog && (
                              <button type="button" disabled={badgeBusy} onClick={() => void handleWearBadge(b.id)}
                                className="h-6 px-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-3xs font-semibold disabled:opacity-40">
                                佩戴
                              </button>
                            )}
                            {isDialogManager && (
                              <button type="button" disabled={badgeBusy} onClick={() => void handleRevokeBadge(b.id, b.name)}
                                className="h-6 px-2 rounded-capsule bg-wb-danger/10 text-wb-danger text-3xs font-semibold disabled:opacity-40">
                                收回
                              </button>
                            )}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {isSelfDialog && (
                    <button type="button" disabled={badgeBusy} onClick={() => void handleWearBadge(null)}
                      className="w-full h-8 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-3xs font-semibold text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-40">
                      使用等级铭牌
                    </button>
                  )}
                </div>

                {/* 授予（仅群主/管理员） */}
                {isDialogManager && (
                  <div className="flex gap-1.5">
                    <input
                      value={newBadgeName}
                      onChange={(e) => setNewBadgeName(e.target.value.slice(0, 32))}
                      placeholder="输入名牌名称，如 夜宵搭子"
                      maxLength={32}
                      className="flex-1 h-8 px-2.5 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none"
                    />
                    <button type="button" disabled={badgeBusy} onClick={() => void handleGrantBadge()}
                      className="h-8 px-3 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold disabled:opacity-40">
                      授予
                    </button>
                  </div>
                )}
              </div>
            )}
            {memberAction.type === 'mute' && (
              <div className="flex justify-end gap-2 pt-1">
                <button type="button" onClick={() => setMemberAction(null)}
                  className="h-9 px-4 rounded-capsule bg-wb-bg-subtle text-2xs font-semibold text-wb-text-secondary">取消</button>
                <button type="button" disabled={actionBusy} onClick={() => void handleMemberAction()}
                  className="h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold disabled:opacity-40">
                  {actionBusy ? '处理中…' : '确认禁言'}
                </button>
              </div>
            )}
          </div>
        </div>, document.body
        );
      })()}

      {/* 群等级榜：只展示群等级，不展示网站等级 */}
      {showLevelBoard && createPortal(
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
             onClick={() => setShowLevelBoard(false)}>
          <div className="w-full max-w-sm rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-3"
               onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-wb-text-primary">群等级榜</h3>
              <button type="button" onClick={() => setShowLevelBoard(false)} className="p-1 rounded-lg text-wb-text-muted hover:bg-wb-bg-subtle">
                <X className="w-4 h-4" />
              </button>
            </div>
            {myLevelProgress && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl bg-wb-bg-subtle px-2.5 py-2 text-2xs">
                <span className="font-semibold text-wb-text-primary">我的等级 Lv.{myLevelProgress.level}</span>
                <span className="text-wb-text-muted">{myLevelProgress.total} EXP</span>
                <span className="flex items-center gap-2 text-wb-text-muted">
                  {myLevelStatus}
                  {myLevelProgress.need > 0 && <progress className="h-[3px] w-10 accent-current text-wb-brand" aria-label="我的升级进度" max={myLevelProgress.need} value={myLevelProgress.in_level} />}
                </span>
              </div>
            )}
            <div className="max-h-80 overflow-y-auto">
              {!levelBoard && <p role="status" className="py-4 text-center text-2xs text-wb-text-muted">{levelBoardError ? '等级榜加载失败，请关闭后重试' : '正在加载等级榜…'}</p>}
              {levelBoard?.items.length === 0 && <p className="py-4 text-center text-2xs text-wb-text-muted">暂无等级数据</p>}
              {levelBoard?.items.map((r) => (
                <div key={r.user_id} className="flex items-center gap-1.5 rounded-lg px-1.5 py-1 hover:bg-wb-bg-subtle">
                  <span className={`w-4 shrink-0 text-center font-mono text-2xs font-bold ${r.rank <= 3 ? 'text-wb-brand' : 'text-wb-text-muted'}`}>{r.rank}</span>
                  <span className="min-w-0 flex-1 truncate text-2xs text-wb-text-primary" title={r.nickname}>{r.nickname}</span>
                  <div className="hidden shrink-0 sm:block"><GroupBadge level={r.group_level} name={r.badge_name} badgeId={r.badge_id} showLevel={false} /></div>
                  <span className="shrink-0 text-3xs text-wb-text-muted">Lv.{r.group_level}</span>
                  <span className="shrink-0 text-3xs text-wb-text-muted">{r.group_exp} EXP</span>
                  {r.progress?.need > 0 ? (
                    <progress className="h-[3px] w-8 shrink-0 accent-current text-wb-brand" aria-label={`${r.nickname} 的升级进度`} title={`距下一级还差 ${r.progress.need - r.progress.in_level} EXP`} max={r.progress.need} value={r.progress.in_level} />
                  ) : <span className="w-8 shrink-0 text-right text-3xs text-wb-text-muted">满级</span>}
                </div>
              ))}
            </div>
          </div>
        </div>, document.body
      )}

      {activityKind && activeGroupId && (
        <GroupActivitiesModal
          roomId={activeGroupId}
          kind={activityKind}
          refreshKey={activityKind === 'feihua' ? feihuaTick : chainTick}
          canManage={Boolean(myGroupRole === 'owner' || myGroupRole === 'admin' || (activeGroup && (activeGroup as any).my_role === 'owner') || ['super_admin', 'admin'].includes(user?.role || ''))}
          toast={toast}
          onClose={() => setActivityKind(null)}
          onShareToGroup={(text) => { void handleSendMessage(undefined, text); }}
        />
      )}
      {showLunchWheel && activeGroupId && (
        <LunchWheel
          groupId={activeGroupId}
          groupName={activeGroup?.name}
          onClose={() => setShowLunchWheel(false)}
          refreshKey={lunchTick}
          onTestReminder={() => {
            setLunchBanner(true);
            window.setTimeout(() => setLunchBanner(false), 3000);
          }}
        />
      )}

      {lunchBanner && (
        <button
          type="button"
          onClick={() => { setLunchBanner(false); setShowLunchWheel(true); }}
          className="fixed left-1/2 top-16 z-[140] -translate-x-1/2 px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold shadow-2xl animate-[lunch-bounce_.6s_ease-out]"
        >
          🍚 午餐时间到，今天吃什么？
        </button>
      )}

      <FortuneOverlay data={fortune} onClose={() => setFortune(null)} />

      {showCheckinConfig && createPortal(
        <div className="fixed inset-0 z-[150] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4"
             onClick={() => setShowCheckinConfig(false)}>
          <div className="w-full max-w-sm rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-4"
               onClick={(e) => e.stopPropagation()}>
            <h3 className="text-sm font-bold text-wb-text-primary">群签到设置</h3>
            <p className="text-3xs text-wb-text-muted">成员在群里发送签到语即可获得群等级经验，按北京时间每日限次。</p>
            <label className="block text-2xs font-semibold text-wb-text-secondary">签到语</label>
            <input value={checkinDraft.text} onChange={(e) => setCheckinDraft({ ...checkinDraft, text: e.target.value.slice(0, 32) })}
              placeholder="例如 hhh" maxLength={32}
              className="w-full h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs focus:outline-none" />
            <div className="flex items-center justify-between">
              <label className="block text-2xs font-semibold text-wb-text-secondary">打卡时间段</label>
              <button type="button"
                onClick={() => setCheckinDraft({
                  ...checkinDraft,
                  slots: checkinDraft.slots.length >= 5
                    ? checkinDraft.slots
                    : [...checkinDraft.slots, { name: '', start: '09:00', end: '12:00' }],
                })}
                className="text-3xs text-wb-brand hover:underline disabled:opacity-40"
                disabled={checkinDraft.slots.length >= 5}
              >
                + 添加时段
              </button>
            </div>
            <div className="space-y-1.5">
              {checkinDraft.slots.length === 0 && (
                <p className="text-3xs text-wb-text-muted">未配置时段 → 全天任意时间都能打卡</p>
              )}
              {checkinDraft.slots.map((slot, i) => (
                <div key={i} className="flex items-center gap-1.5">
                  <input
                    value={slot.name}
                    onChange={(e) => {
                      const next = [...checkinDraft.slots];
                      next[i] = { ...next[i], name: e.target.value.slice(0, 8) };
                      setCheckinDraft({ ...checkinDraft, slots: next });
                    }}
                    placeholder="早上"
                    className="w-16 h-8 px-2 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-3xs focus:outline-none"
                  />
                  <input type="time" value={slot.start}
                    onChange={(e) => {
                      const next = [...checkinDraft.slots];
                      next[i] = { ...next[i], start: e.target.value };
                      setCheckinDraft({ ...checkinDraft, slots: next });
                    }}
                    className="flex-1 h-8 px-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-3xs focus:outline-none" />
                  <span className="text-3xs text-wb-text-muted">至</span>
                  <input type="time" value={slot.end}
                    onChange={(e) => {
                      const next = [...checkinDraft.slots];
                      next[i] = { ...next[i], end: e.target.value };
                      setCheckinDraft({ ...checkinDraft, slots: next });
                    }}
                    className="flex-1 h-8 px-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-3xs focus:outline-none" />
                  <button type="button"
                    onClick={() => setCheckinDraft({ ...checkinDraft, slots: checkinDraft.slots.filter((_, idx) => idx !== i) })}
                    className="w-7 h-8 rounded-lg text-wb-text-muted hover:text-wb-danger shrink-0"
                    title="删除该时段"
                  >
                    <X className="w-3.5 h-3.5 mx-auto" />
                  </button>
                </div>
              ))}
            </div>
            <div className="p-2.5 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle space-y-0.5">
              <p className="text-3xs text-wb-text-secondary">每天最多打卡 <b>3 次</b>，每个时间段每天限 1 次。</p>
              <p className="text-3xs text-wb-text-secondary">每次固定 <b>10 经验</b>，每日打卡经验上限 <b>10 分</b>（后续打卡只记次数、不再加分）。</p>
            </div>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowCheckinConfig(false)}
                className="h-9 px-4 rounded-capsule bg-wb-bg-subtle text-2xs font-semibold">取消</button>
              <button type="button" onClick={async () => {
                if (!activeGroupId || !checkinDraft.text.trim()) return;
                try {
                  const res = await apiClient.put(`/chat/groups/${activeGroupId}/checkin-config`, {
                    text: checkinDraft.text.trim(),
                    slots: checkinDraft.slots.filter((sl) => sl.name.trim() && sl.start && sl.end),
                  });
                  setCheckinCfg({
                    text: res.data?.text || checkinDraft.text.trim(),
                    times_per_day: res.data?.times_per_day || 3,
                    exp: res.data?.exp || 10,
                    daily_exp_cap: res.data?.daily_exp_cap || 10,
                    slots: Array.isArray(res.data?.slots) ? res.data.slots : [],
                  });
                  setShowCheckinConfig(false);
                  toast.success('签到设置已保存');
                } catch (err: any) {
                  toast.error(err?.response?.data?.detail || '仅群主/管理员可设置');
                }
              }} className="h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold">保存</button>
            </div>
          </div>
        </div>, document.body
      )}

      {isMembersModalOpen && activeGroup && (
        <div
          ref={membersDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="群成员管理"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-lg bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-3xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            {/* 顶栏 */}
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2.5">
                <div className="w-8 h-8 rounded-xl bg-gradient-to-br from-wb-info/10 to-purple-500/20 border border-wb-border-subtle flex items-center justify-center shrink-0">
                  {activeGroup.is_public ? (
                    <Globe className="w-4 h-4 text-wb-brand" />
                  ) : (
                    <Lock className="w-4 h-4 text-wb-warn" />
                  )}
                </div>
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-bold text-base text-wb-text-primary">
                      {activeGroup.name}
                    </h3>
                    {activeGroup.is_public ? (
                      <span className="text-3xs px-1.5 py-0.2 rounded-full bg-wb-info/10 text-wb-info font-medium">
                        公共频道
                      </span>
                    ) : (
                      <span className="text-3xs px-1.5 py-0.2 rounded-full bg-wb-warn/10 text-wb-warn font-medium">
                        私密好友群
                      </span>
                    )}
                  </div>
                  <p className="text-2xs text-wb-text-muted flex items-center gap-1.5 flex-wrap">
                    当前共有 {groupMembers.length} 位极客成员
                    <button
                      type="button"
                      onClick={() => setShowLevelBoard(true)}
                      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-capsule bg-wb-brand/10 text-wb-brand font-semibold hover:bg-wb-brand/20 transition-colors"
                    >
                      <Medal className="w-3 h-3" /> 群等级榜
                    </button>
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsMembersModalOpen(false)}
                className="p-1 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {/* 标签页切换：仅群主与管理员展示审批 Tab */}
            {(activeGroup.my_role === 'owner' ||
              activeGroup.my_role === 'admin' ||
              ['super_admin', 'admin'].includes(user?.role || '')) && (
              <div className="flex items-center gap-2 bg-wb-bg-subtle/50 p-1 rounded-xl border border-wb-border-subtle text-xs">
                <button
                  type="button"
                  onClick={() => setMembersModalTab('members')}
                  className={`flex-1 py-1.5 px-3 rounded-lg font-semibold transition-all ${
                    membersModalTab === 'members'
                      ? 'bg-wb-bg-surface text-wb-text-primary shadow-xs'
                      : 'text-wb-text-muted hover:text-wb-text-primary'
                  }`}
                >
                  群成员 ({groupMembers.length})
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setMembersModalTab('requests');
                    if (activeGroupId) fetchGroupJoinRequests(activeGroupId);
                  }}
                  className={`flex-1 py-1.5 px-3 rounded-lg font-semibold transition-all flex items-center justify-center gap-1.5 ${
                    membersModalTab === 'requests'
                      ? 'bg-wb-bg-surface text-wb-text-primary shadow-xs'
                      : 'text-wb-text-muted hover:text-wb-text-primary'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  <span>入群申请</span>
                  {joinRequests.length > 0 && (
                    <span className="px-1.5 py-0.2 rounded-full text-3xs bg-wb-danger text-white font-mono">
                      {joinRequests.length}
                    </span>
                  )}
                </button>
              </div>
            )}

            {membersModalTab === 'members' ? (
              <>
                {/* 邀请新成员输入框：私密群仅群主/管理员可拉人，普通成员无此权限 */}
                {(activeGroup.is_public ||
                  activeGroup.my_role === 'owner' ||
                  activeGroup.my_role === 'admin' ||
                  ['super_admin', 'admin'].includes(user?.role || '')) ? (
                  <form onSubmit={handleInviteUser} className="space-y-1.5">
                    <label className="block text-xs font-semibold text-wb-text-secondary">
                      邀请极客加入群聊
                    </label>
                    <div className="flex items-center gap-2">
                      <input
                        type="text"
                        value={inviteUsername}
                        onChange={(e) => {
                          const v = e.target.value;
                          setInviteUsername(v);
                          const seq = ++inviteSearchSeq.current;
                          if (!v.trim()) { setInviteCandidates([]); return; }
                          window.setTimeout(() => {
                            if (inviteSearchSeq.current !== seq) return;
                            apiClient.get('/users/search', { params: { q: v.trim(), limit: 8 } })
                              .then((res) => {
                                if (inviteSearchSeq.current === seq) {
                                  setInviteCandidates(Array.isArray(res.data) ? res.data : []);
                                }
                              })
                              .catch(() => { if (inviteSearchSeq.current === seq) setInviteCandidates([]); });
                          }, 250);
                        }}
                        placeholder="输入昵称或唯一 ID，输入即搜"
                        className="flex-1 px-3.5 py-2 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
                      />
                      <button
                        type="submit"
                        disabled={!inviteUsername.trim() || isInviting}
                        className="wb-pressable px-4 py-2 rounded-xl text-xs font-semibold bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-40 transition-opacity inline-flex items-center gap-1.5 shrink-0"
                      >
                        <UserPlus className="w-3.5 h-3.5" />
                        <span>{isInviting ? '邀请中...' : '邀请入群'}</span>
                      </button>
                    </div>
                    {inviteCandidates.length > 0 && (
                      <div className="rounded-xl border border-wb-border-subtle bg-wb-bg-surface max-h-40 overflow-y-auto">
                        {inviteCandidates.map((c: any) => (
                          <button
                            key={c.id || c.username}
                            type="button"
                            onClick={() => {
                              setInviteUsername(c.username || '');
                              setInviteCandidates([]);
                            }}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 text-2xs hover:bg-wb-bg-subtle text-left"
                          >
                            <span className="font-semibold text-wb-text-primary truncate">{c.nickname || c.username}</span>
                            <span className="text-wb-text-muted font-mono truncate ml-auto">@{c.username}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </form>
                ) : (
                  <div className="px-3 py-2 rounded-xl bg-wb-bg-subtle/50 border border-wb-border-subtle text-2xs text-wb-text-muted">
                    私密好友群仅群主或群管理员可直接邀请成员，您可以分享群聊给好友，由对方提交入群申请。
                  </div>
                )}

                {/* 成员列表 */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between text-xs font-semibold text-wb-text-secondary">
                    <span>群成员名单</span>
                    <span className="font-mono text-wb-text-muted">
                      {memberQuery.trim()
                        ? `${groupMembers.filter((m) => (m.nickname || '').toLowerCase().includes(memberQuery.trim().toLowerCase()) || (m.username || '').toLowerCase().includes(memberQuery.trim().toLowerCase())).length} / ${groupMembers.length} 人`
                        : `${groupMembers.length} 人`}
                    </span>
                  </div>

                  {/* 管理成员时可按昵称或唯一 ID 快速定位，不用翻长列表 */}
                  <div className="relative">
                    <Search className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-wb-text-muted pointer-events-none" />
                    <input
                      type="text"
                      value={memberQuery}
                      onChange={(e) => setMemberQuery(e.target.value)}
                      placeholder="搜索成员：昵称或唯一 ID"
                      className="w-full h-8 pl-8 pr-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs text-wb-text-primary focus:outline-none focus:border-wb-border-strong"
                    />
                  </div>

                  <div className="max-h-64 overflow-y-auto divide-y divide-wb-border-subtle/50 rounded-2xl bg-wb-bg-subtle/30 border border-wb-border-subtle p-1">
                    {loadingMembers ? (
                      <div className="py-8 text-center text-xs text-wb-text-muted font-mono">
                        成员名单加载中...
                      </div>
                    ) : groupMembers.length === 0 ? (
                      <div className="py-8 text-center text-xs text-wb-text-muted">
                        暂无成员记录
                      </div>
                    ) : memberQuery.trim() && !groupMembers.some((m) =>
                        (m.nickname || '').toLowerCase().includes(memberQuery.trim().toLowerCase())
                        || (m.username || '').toLowerCase().includes(memberQuery.trim().toLowerCase())) ? (
                      <div className="py-8 text-center text-xs text-wb-text-muted">
                        没有匹配「{memberQuery.trim()}」的成员
                      </div>
                    ) : (
                      groupMembers
                        .filter((m) => {
                          const q = memberQuery.trim().toLowerCase();
                          if (!q) return true;
                          return (m.nickname || '').toLowerCase().includes(q)
                            || (m.username || '').toLowerCase().includes(q);
                        })
                        .map((member) => {
                        const isSelf = member.user_id === user?.id;
                        const myRole = myGroupRole || activeGroup.my_role;
                        const isSiteAdmin = ['super_admin', 'admin'].includes(user?.role || '');
                        const canManageRole = !isSelf && member.role !== 'owner' && (myRole === 'owner' || isSiteAdmin);
                        const canKick =
                          !isSelf &&
                          member.role !== 'owner' &&
                          (myRole === 'owner' || isSiteAdmin || (myRole === 'admin' && member.role === 'member'));

                        return (
                          <div
                            key={member.user_id}
                            className="p-2.5 flex items-center justify-between gap-3 hover:bg-wb-bg-subtle/60 rounded-xl transition-colors"
                          >
                            <div
                              className="flex items-center gap-2.5 min-w-0 cursor-pointer"
                              onClick={() => {
                                setIsMembersModalOpen(false);
                                onSelectUser?.(member.username);
                              }}
                            >
                              <UserAvatar
                                username={member.username}
                                avatarUrl={member.avatar_url}
                                size="sm"
                              />
                              <div className="min-w-0">
                                <div className="flex items-center gap-1.5">
                                  <span className="text-xs font-semibold text-wb-text-primary truncate hover:underline">
                                    {member.nickname || member.username}
                                  </span>
                                  <GroupBadge
                                    level={member.group_level || 1}
                                    name={member.badge_name}
                                    badgeId={member.group_level || 1}
                                    showLevel={member.badge_kind !== 'special'}
                                  />
                                  {member.muted_until && (
                                    <span className="text-3xs text-wb-danger font-semibold">已禁言</span>
                                  )}
                                </div>
                                <span className="text-3xs text-wb-text-muted font-mono block truncate">
                                  @{member.username}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-2 shrink-0">
                              {/* 快捷 @ 提及该成员 */}
                              {!isSelf && (
                                <button
                                  type="button"
                                  onClick={() => {
                                    handleQuickMention(member.username);
                                    setIsMembersModalOpen(false);
                                  }}
                                  className="p-1 text-wb-text-muted hover:text-wb-brand rounded-lg hover:bg-wb-brand/10 transition-colors"
                                  title={`@提及 ${member.nickname || member.username}`}
                                >
                                  <AtSign className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* 角色标识 */}
                              {member.role === 'owner' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-bold bg-wb-warn/10 text-wb-warn border border-wb-warn/20">
                                  <Crown className="w-3 h-3 fill-current" />
                                  <span>群主</span>
                                </span>
                              ) : member.role === 'admin' ? (
                                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-3xs font-medium bg-wb-info/10 text-wb-info border border-wb-info/20">
                                  <Shield className="w-3 h-3" />
                                  <span>管理员</span>
                                </span>
                              ) : (
                                <span className="px-1.5 py-0.5 rounded-md text-3xs text-wb-text-muted bg-wb-bg-surface border border-wb-border-subtle">
                                  成员
                                </span>
                              )}

                              {/* 群主设为/撤销管理员操作 */}
                              {canManageRole && (
                                member.role === 'admin' ? (
                                  <button
                                    type="button"
                                    onClick={() => handleToggleMemberRole(member.user_id, member.username, 'member')}
                                    className="p-1 text-wb-info hover:text-wb-info rounded-lg hover:bg-wb-info/10 transition-colors"
                                    title="撤销该成员的管理员身份"
                                  >
                                    <ShieldCheck className="w-3.5 h-3.5" />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleToggleMemberRole(member.user_id, member.username, 'admin')}
                                    disabled={groupAdminCount >= GROUP_ADMIN_LIMIT}
                                    className="p-1 text-wb-text-muted hover:text-wb-info rounded-lg hover:bg-wb-info/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                    title={
                                      groupAdminCount >= GROUP_ADMIN_LIMIT
                                        ? `管理员名额已满（${groupAdminCount}/${GROUP_ADMIN_LIMIT}）`
                                        : `将该成员设为群管理员（当前 ${groupAdminCount}/${GROUP_ADMIN_LIMIT}）`
                                    }
                                  >
                                    <Shield className="w-3.5 h-3.5" />
                                  </button>
                                )
                              )}

                              {/* 本人：打开我的名牌（选择等级牌或已授予的特殊名牌） */}
                              {isSelf && (
                                <button
                                  type="button"
                                  onClick={() => openBadgeDialog(member)}
                                  className="p-1 text-wb-text-muted hover:text-wb-brand hover:bg-wb-brand/10 rounded-lg transition-colors"
                                  title="我的铭牌"
                                >
                                  <Medal className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* 禁言 / 解禁：仅群主与管理员 */}
                              {(myRole === 'owner' || myRole === 'admin' || isSiteAdmin) && !isSelf && member.role !== 'owner' && (
                                member.muted_until ? (
                                  <button
                                    type="button"
                                    onClick={() => void handleUnmute(member)}
                                    className="p-1 text-wb-success hover:bg-wb-success/10 rounded-lg transition-colors"
                                    title="解除禁言"
                                  >
                                    <BellRing className="w-3.5 h-3.5" />
                                  </button>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => {
                                      setMuteMinutes(30); setMuteReason('');
                                      setMemberAction({ type: 'mute', member });
                                    }}
                                    className="p-1 text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 rounded-lg transition-colors"
                                    title="禁言该成员（可设时长）"
                                  >
                                    <Timer className="w-3.5 h-3.5" />
                                  </button>
                                )
                              )}

                              {/* 铭牌设置：仅群主与管理员 */}
                              {(myRole === 'owner' || myRole === 'admin' || isSiteAdmin) && !isSelf && (
                                <button
                                  type="button"
                                  onClick={() => openBadgeDialog(member)}
                                  className="p-1 text-wb-text-muted hover:text-wb-brand hover:bg-wb-brand/10 rounded-lg transition-colors"
                                  title="铭牌管理（授予/收回特殊名牌）"
                                >
                                  <Medal className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* 群主转让：仅群主/站长可见，目标不能是自己或现任群主 */}
                              {(myRole === 'owner' || isSiteAdmin) && !isSelf && member.role !== 'owner' && (
                                <button
                                  type="button"
                                  onClick={() => handleTransferOwner(member.user_id, member.username)}
                                  className="p-1 text-wb-text-muted hover:text-wb-warn rounded-lg hover:bg-wb-warn/10 transition-colors"
                                  title={`把群主转让给 ${member.nickname || member.username}`}
                                >
                                  <Crown className="w-3.5 h-3.5" />
                                </button>
                              )}

                              {/* 踢人按钮 */}
                              {canKick && (
                                <button
                                  type="button"
                                  onClick={() => handleKickMember(member.user_id, member.username)}
                                  className="p-1 text-wb-text-muted hover:text-wb-danger rounded-lg hover:bg-wb-danger/10 transition-colors"
                                  title="将该成员移出群聊"
                                >
                                  <UserMinus className="w-3.5 h-3.5" />
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>
                </div>
              </>
            ) : (
              /* 入群申请审核视图 */
              <div className="space-y-3">
                <div className="flex items-center justify-between text-xs font-semibold text-wb-text-secondary">
                  <span>待审批入群申请</span>
                  <span className="font-mono text-wb-text-muted">{joinRequests.length} 人申请</span>
                </div>

                <div className="max-h-72 overflow-y-auto divide-y divide-wb-border-subtle/50 rounded-2xl bg-wb-bg-subtle/30 border border-wb-border-subtle p-1">
                  {loadingRequests ? (
                    <div className="py-10 text-center text-xs text-wb-text-muted font-mono">
                      加载申请列表中...
                    </div>
                  ) : joinRequests.length === 0 ? (
                    <div className="py-10 text-center text-xs text-wb-text-muted space-y-1">
                      <CheckCircle2 className="w-6 h-6 mx-auto text-wb-success opacity-60" />
                      <p>当前暂无待处理的入群申请</p>
                      <p className="text-2xs opacity-70">有新用户申请入群时将在此展示与提示</p>
                    </div>
                  ) : (
                    joinRequests.map((req) => (
                      <div
                        key={req.id}
                        className="p-3 space-y-2 hover:bg-wb-bg-subtle/50 rounded-xl transition-colors"
                      >
                        <div className="flex items-center justify-between gap-3">
                          <div
                            className="flex items-center gap-2.5 min-w-0 cursor-pointer"
                            onClick={() => {
                              setIsMembersModalOpen(false);
                              onSelectUser?.(req.username);
                            }}
                          >
                            <UserAvatar
                              username={req.username}
                              avatarUrl={req.avatar_url}
                              size="sm"
                            />
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="text-xs font-semibold text-wb-text-primary truncate hover:underline">
                                  {req.nickname || req.username}
                                </span>
                                <span className="text-3xs text-wb-text-muted font-mono">
                                  Lv.{req.level}
                                </span>
                              </div>
                              <span className="text-3xs text-wb-text-muted font-mono">
                                @{req.username} · {formatChatTime(req.created_at)}
                              </span>
                            </div>
                          </div>

                          {/* 审批操作按钮 */}
                          <div className="flex items-center gap-1.5 shrink-0">
                            <button
                              type="button"
                              disabled={handlingRequestId === req.id}
                              onClick={() => handleRejectRequest(req.id)}
                              className="px-2.5 py-1 rounded-lg border border-wb-border-subtle text-xs text-wb-text-muted hover:text-wb-danger hover:bg-wb-danger/10 transition-colors disabled:opacity-50"
                            >
                              拒绝
                            </button>
                            <button
                              type="button"
                              disabled={handlingRequestId === req.id}
                              onClick={() => handleApproveRequest(req.id)}
                              className="px-3 py-1 rounded-lg bg-wb-success text-white text-xs font-semibold hover:bg-wb-success transition-colors disabled:opacity-50 inline-flex items-center gap-1 shadow-xs"
                            >
                              <Check className="w-3 h-3" />
                              <span>同意入群</span>
                            </button>
                          </div>
                        </div>

                        {/* 申请理由 */}
                        {req.reason && (
                          <div className="text-2xs bg-wb-bg-surface border border-wb-border-subtle/80 rounded-xl p-2 text-wb-text-secondary leading-relaxed">
                            <span className="font-semibold text-wb-text-muted">申请附言：</span>
                            {req.reason}
                          </div>
                        )}
                      </div>
                    ))
                  )}
                </div>
              </div>
            )}

            {/* 底栏危险区操作：退出 / 解散群聊 */}
            <div className="pt-3 border-t border-wb-border-subtle flex items-center justify-between gap-3">
              <span className="text-2xs text-wb-text-muted font-mono">
                {activeGroup.my_role === 'owner' ? '当前角色：👑 群主' : activeGroup.my_role === 'admin' ? '当前角色：🛡️ 管理员' : activeGroup.is_member ? '当前角色：成员' : '尚未加入群聊'}
              </span>

              <div className="flex items-center gap-2">
                {activeGroup.is_member && activeGroup.my_role !== 'owner' && (
                  <button
                    type="button"
                    onClick={() => handleLeaveGroup(activeGroup.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-wb-border-subtle text-xs text-wb-danger hover:bg-wb-danger/10 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" />
                    <span>退出群聊</span>
                  </button>
                )}

                {(activeGroup.my_role === 'owner' || ['super_admin', 'admin'].includes(user?.role || '')) && (
                  <button
                    type="button"
                    onClick={() => handleDeleteGroup(activeGroup.id)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl border border-wb-danger/20 bg-wb-danger/10 text-xs font-semibold text-wb-danger hover:bg-wb-danger/20 transition-colors"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                    <span>解散群聊</span>
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ==================== 群公告历史抽屉 ==================== */}
      {announcementHistoryOpen && activeGroup && (
        <div
          ref={announcementDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="群公告历史"
          className="fixed inset-0 z-[120] flex items-center justify-center p-3 md:p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
          onClick={() => setAnnouncementHistoryOpen(false)}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-lg bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-3xl flex flex-col max-h-[86vh] overflow-hidden"
          >
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-wb-border-subtle shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Megaphone className="w-4 h-4 text-wb-warn shrink-0" />
                <h3 className="font-bold text-sm text-wb-text-primary truncate">群公告历史</h3>
                <span className="text-3xs text-wb-text-muted font-mono shrink-0">
                  {groupAnnouncements.length} 条
                </span>
              </div>
              <button
                type="button"
                onClick={() => setAnnouncementHistoryOpen(false)}
                className="p-1.5 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
                title="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-3">
              {announcementsLoading && groupAnnouncements.length === 0 ? (
                <div className="py-12 flex items-center justify-center gap-2 text-xs text-wb-text-muted">
                  <Loader2 className="w-4 h-4 animate-spin" />
                  正在加载群公告…
                </div>
              ) : groupAnnouncements.length === 0 ? (
                <div className="py-12 text-center space-y-2 text-xs text-wb-text-muted">
                  <Megaphone className="w-7 h-7 mx-auto opacity-40" />
                  <p>暂无群公告</p>
                </div>
              ) : (
                groupAnnouncements.map((item) => {
                  const canManage =
                    activeGroup.my_role === 'owner' ||
                    activeGroup.my_role === 'admin' ||
                    ['super_admin', 'admin'].includes(user?.role || '');
                  return (
                    <div
                      key={item.id}
                      className={`rounded-2xl border p-3 space-y-2 ${
                        item.is_read
                          ? 'bg-wb-bg-subtle/40 border-wb-border-subtle'
                          : 'bg-wb-warn/5 border-wb-warn/30'
                      }`}
                    >
                      <div className="flex items-center gap-2 text-3xs text-wb-text-muted">
                        <span className="font-semibold text-wb-text-secondary truncate">
                          {item.created_by_nickname || item.created_by_username || '群主 / 管理员'}
                        </span>
                        <span className="font-mono shrink-0">{formatChatTime(item.created_at)}</span>
                        <span
                          className={`ml-auto shrink-0 px-1.5 py-0.5 rounded-full font-semibold ${
                            item.is_read
                              ? 'bg-wb-bg-subtle text-wb-text-muted'
                              : 'bg-wb-warn/15 text-wb-warn'
                          }`}
                        >
                          {item.is_read ? '已读' : '未读'}
                        </span>
                      </div>
                      <p className="text-xs text-wb-text-secondary whitespace-pre-wrap leading-relaxed break-words">
                        {item.content}
                      </p>
                      <div className="flex items-center gap-3 pt-0.5">
                        {!item.is_read && (
                          <button
                            type="button"
                            disabled={confirmingAnnouncementId === item.id}
                            onClick={() => confirmAnnouncementRead(item.id)}
                            className="text-2xs text-wb-success font-semibold hover:underline inline-flex items-center gap-1 disabled:opacity-60"
                          >
                            <CheckCircle2 className="w-3 h-3" />
                            确认已读
                          </button>
                        )}
                        {canManage && (
                          <button
                            type="button"
                            onClick={() => deleteAnnouncement(item)}
                            className="text-2xs text-wb-danger font-medium hover:underline inline-flex items-center gap-1 ml-auto"
                          >
                            <Trash2 className="w-3 h-3" />
                            删除
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {(activeGroup.my_role === 'owner' ||
              activeGroup.my_role === 'admin' ||
              ['super_admin', 'admin'].includes(user?.role || '')) && (
              <div className="border-t border-wb-border-subtle p-3 space-y-2 shrink-0 bg-wb-bg-subtle/20">
                <textarea
                  value={announcementDraft}
                  onChange={(e) => setAnnouncementDraft(e.target.value)}
                  rows={2}
                  maxLength={2000}
                  placeholder="发布新的群公告（会置顶给所有成员，成员确认已读后自动归档）"
                  className="w-full resize-none rounded-xl border border-wb-border-subtle bg-wb-bg-surface px-3 py-2 text-xs text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:border-wb-border-strong"
                />
                <div className="flex items-center justify-between">
                  <span className="text-3xs text-wb-text-muted font-mono">
                    {announcementDraft.length}/2000
                  </span>
                  <button
                    type="button"
                    disabled={!announcementDraft.trim() || announcementPublishing}
                    onClick={publishAnnouncement}
                    className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
                  >
                    {announcementPublishing ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Plus className="w-3.5 h-3.5" />
                    )}
                    <span>发布公告</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ==================== 编辑群聊资料与公告模态弹窗 ==================== */}
      {isEditGroupModalOpen && activeGroup && (
        <div
          ref={editGroupDialogRef}
          role="dialog"
          aria-modal="true"
          aria-label="编辑群信息与公告"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-3xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2">
                <Edit3 className="w-5 h-5 text-wb-brand" />
                <h3 className="font-bold text-base text-wb-text-primary">编辑群信息与公告</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsEditGroupModalOpen(false)}
                className="p-1 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSaveGroupInfo} className="space-y-4">
              {/* 群头像：只有群主可以设置 */}
              {(myGroupRole || activeGroup?.my_role) === 'owner' && (
                <div>
                  <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                    群头像
                    <span className="ml-1.5 text-3xs font-normal text-wb-text-muted">仅群主可设置</span>
                  </label>
                  <div className="flex items-center gap-3">
                    <div className="w-14 h-14 rounded-2xl overflow-hidden border border-wb-border-subtle bg-wb-bg-subtle flex items-center justify-center shrink-0">
                      {editGroupAvatar ? (
                        <SafeImage compatiblePreview src={editGroupAvatar} alt="群头像" className="w-full h-full object-cover" />
                      ) : (
                        <Users className="w-6 h-6 text-wb-text-muted" />
                      )}
                    </div>
                    <label
                      className={`px-3 py-1.5 rounded-capsule text-2xs font-semibold cursor-pointer border border-wb-border-subtle bg-wb-bg-subtle hover:border-wb-border-strong transition-colors ${
                        groupAvatarUploading ? 'opacity-50 pointer-events-none' : ''
                      }`}
                    >
                      {groupAvatarUploading ? '上传中…' : '更换头像'}
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          setGroupAvatarUploading(true);
                          try {
                            const fd = new FormData();
                            fd.append('file', file);
                            const res = await apiClient.post('/posts/upload-image', fd, {
                              headers: { 'Content-Type': 'multipart/form-data' },
                            });
                            if (res.data?.url) setEditGroupAvatar(res.data.url);
                          } catch (err: any) {
                            toast.error(err?.response?.data?.detail || '头像上传失败');
                          } finally {
                            setGroupAvatarUploading(false);
                          }
                        }}
                      />
                    </label>
                    {editGroupAvatar && (
                      <button
                        type="button"
                        onClick={() => setEditGroupAvatar('')}
                        className="px-2 py-1.5 rounded-capsule text-2xs text-wb-text-muted hover:text-wb-danger"
                      >
                        移除
                      </button>
                    )}
                  </div>
                </div>
              )}

              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                  群聊名称 <span className="text-wb-danger">*</span>
                </label>
                <input
                  type="text"
                  value={editGroupName}
                  onChange={(e) => setEditGroupName(e.target.value)}
                  maxLength={50}
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                  群简介
                </label>
                <textarea
                  value={editGroupDesc}
                  onChange={(e) => setEditGroupDesc(e.target.value)}
                  rows={2}
                  maxLength={200}
                  placeholder="简述本群聊的主题与讨论方向..."
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary resize-none"
                />
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <label className="text-xs font-semibold text-wb-text-primary flex items-center gap-1">
                    <Megaphone className="w-3.5 h-3.5 text-wb-warn" />
                    <span>群公告 (发布后置顶，成员确认已读后归档到历史)</span>
                  </label>
                  <span className="text-3xs text-wb-text-muted font-mono">{editGroupAnnouncement.length}/2000</span>
                </div>
                <textarea
                  value={editGroupAnnouncement}
                  onChange={(e) => setEditGroupAnnouncement(e.target.value)}
                  rows={4}
                  maxLength={2000}
                  placeholder="发布最新的群公告、社群公约、活动安排等..."
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsEditGroupModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-wb-text-muted hover:bg-wb-bg-subtle transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={!editGroupName.trim() || isSavingGroup}
                  className="px-5 py-2 rounded-xl text-xs font-semibold bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {isSavingGroup ? '保存中...' : '保存修改'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ==================== 申请加入群聊模态弹窗 ==================== */}
      {isApplyModalOpen && activeGroup && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="操作对话框"
          className="fixed inset-0 z-[120] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-150"
        >
          <div className="w-full max-w-md bg-wb-bg-surface border border-wb-border-subtle shadow-2xl rounded-3xl p-5 md:p-6 space-y-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
              <div className="flex items-center gap-2">
                <UserPlus className="w-5 h-5 text-wb-brand" />
                <h3 className="font-bold text-base text-wb-text-primary">申请加入群聊</h3>
              </div>
              <button
                type="button"
                onClick={() => setIsApplyModalOpen(false)}
                className="p-1 rounded-xl text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <form onSubmit={handleSubmitApply} className="space-y-4">
              <div className="p-3 bg-wb-bg-subtle/50 rounded-2xl border border-wb-border-subtle space-y-1">
                <div className="text-xs font-bold text-wb-text-primary flex items-center gap-1.5">
                  <span>群聊：</span>
                  <span>{activeGroup.name}</span>
                </div>
                <div className="text-2xs text-wb-text-muted">
                  提交申请后，群主及群管理员将对您的申请进行审核，审核通过后您将自动进入群聊并收到系统通知。
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-wb-text-primary mb-1.5">
                  申请说明 / 自我介绍（选填）
                </label>
                <textarea
                  value={applyReason}
                  onChange={(e) => setApplyReason(e.target.value)}
                  rows={3}
                  maxLength={200}
                  placeholder="如：关注前端技术与Rust架构，希望能与各位大佬共同交流探讨..."
                  className="w-full px-3.5 py-2.5 text-xs md:text-sm bg-wb-bg-subtle border border-wb-border-subtle rounded-2xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary resize-none"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setIsApplyModalOpen(false)}
                  className="px-4 py-2 rounded-xl text-xs font-medium text-wb-text-muted hover:bg-wb-bg-subtle transition-colors"
                >
                  取消
                </button>
                <button
                  type="submit"
                  disabled={isSubmittingApply}
                  className="px-5 py-2 rounded-xl text-xs font-semibold bg-wb-text-primary text-wb-bg-page hover:opacity-90 disabled:opacity-40 transition-opacity"
                >
                  {isSubmittingApply ? '提交中...' : '提交入群申请'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* 灯箱大图 */}
      {/* 展开编辑：长文本时在主输入框里只能看到一两行，这里给一个大编辑区 */}
      {composerExpanded && (
        <div className="fixed inset-0 z-[140] bg-black/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="w-full max-w-2xl rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-3 border-b border-wb-border-subtle">
              <h3 className="text-sm font-semibold text-wb-text-primary truncate">
                {chatTab === 'group' ? `发送到 #${activeGroup?.name || '群聊'}` : '编辑消息'}
              </h3>
              <button
                type="button"
                onClick={() => setComposerExpanded(false)}
                className="p-1.5 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
                title="收起"
              >
                <Minimize2 className="w-4 h-4" />
              </button>
            </div>

            <textarea
              autoFocus
              value={inputText}
              onChange={handleInputChange}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  setComposerExpanded(false);
                  handleSendMessage();
                }
              }}
              placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
              className="w-full h-64 p-5 bg-transparent resize-none focus:outline-none text-sm text-wb-text-primary placeholder:text-wb-text-muted leading-relaxed"
            />

            <div className="px-5 py-3 border-t border-wb-border-subtle flex items-center justify-between">
              <span className="text-2xs text-wb-text-muted">{inputText.length} 字</span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setComposerExpanded(false)}
                  className="px-4 py-2 rounded-capsule text-xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle"
                >
                  收起
                </button>
                <button
                  type="button"
                  disabled={(!inputText.trim() && !pendingImageUrl) || pendingImageUploading || isSending}
                  onClick={() => {
                    setComposerExpanded(false);
                    handleSendMessage();
                  }}
                  className="wb-pressable px-4 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
                >
                  发送
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      <ImageLightbox
        src={lightboxImg}
        onClose={() => setLightboxImg(null)}
        index={lightboxIndex}
        total={chatImages.length}
        onPrev={chatImages.length > 1 ? () => {
          const i = (lightboxIndex - 1 + chatImages.length) % chatImages.length;
          setLightboxImg(chatImages[i].url);
        } : undefined}
        onNext={chatImages.length > 1 ? () => {
          const i = (lightboxIndex + 1) % chatImages.length;
          setLightboxImg(chatImages[i].url);
        } : undefined}
        onLocate={chatImages[lightboxIndex] ? () => {
          const target = chatImages[lightboxIndex];
          setLightboxImg(null);
          jumpToMessage(target.msgId);
        } : undefined}
      />

      {/* 会话内消息搜索 */}
      {searchOpen && (
        <div
          className="fixed inset-0 z-[130] flex items-start justify-center pt-20 sm:pt-28 px-4 bg-black/55 backdrop-blur-xs"
          onClick={() => setSearchOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-3xl bg-wb-bg-elevated border border-wb-border-subtle shadow-2xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-2">
              <Search className="w-4 h-4 text-wb-text-muted shrink-0" />
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') runSearch();
                  if (e.key === 'Escape') setSearchOpen(false);
                }}
                placeholder={chatTab === 'group' ? '搜索本群消息…' : '搜索本会话消息…'}
                className="flex-1 h-9 px-3 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary"
              />
              <button
                type="button"
                onClick={runSearch}
                disabled={searchLoading}
                className="h-9 px-3 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-semibold disabled:opacity-50"
              >
                {searchLoading ? '搜索中' : '搜索'}
              </button>
            </div>

            <div className="max-h-[52vh] overflow-y-auto thin-scrollbar space-y-1">
              {!searchResults.length && !searchLoading && searchQuery && (
                <p className="py-6 text-center text-2xs text-wb-text-muted">没有找到包含该关键词的消息</p>
              )}
              {searchResults.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => jumpToSearchResult(r.room_id || '', r.id)}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-wb-bg-subtle transition-colors space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-3xs text-wb-text-muted">
                    <span className="font-semibold text-wb-text-secondary truncate">
                      {r.sender_nickname || r.sender_username}
                    </span>
                    <span className="font-mono shrink-0">{formatChatTime(r.created_at)}</span>
                  </div>
                  <p className="text-2xs text-wb-text-primary line-clamp-2 break-all">{r.content}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* @我 的消息 */}
      {mentionsOpen && (
        <div
          className="fixed inset-0 z-[130] flex items-start justify-center pt-20 sm:pt-28 px-4 bg-black/55 backdrop-blur-xs"
          onClick={() => setMentionsOpen(false)}
        >
          <div
            className="w-full max-w-lg rounded-3xl bg-wb-bg-elevated border border-wb-border-subtle shadow-2xl p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold text-wb-text-primary flex items-center gap-1.5">
                <AtSign className="w-4 h-4 text-wb-brand" />
                @我 的消息
              </h3>
              <button
                type="button"
                onClick={() => setMentionsOpen(false)}
                className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle"
                title="关闭"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="max-h-[60vh] overflow-y-auto thin-scrollbar space-y-1">
              {mentionsLoading && <p className="py-6 text-center text-2xs text-wb-text-muted">加载中…</p>}
              {!mentionsLoading && !mentionList.length && (
                <p className="py-6 text-center text-2xs text-wb-text-muted">最近 30 天还没有人 @ 你</p>
              )}
              {mentionList.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  onClick={() => jumpToSearchResult(r.room_id, r.id)}
                  className="w-full text-left p-2.5 rounded-xl hover:bg-wb-bg-subtle transition-colors space-y-1"
                >
                  <div className="flex items-center justify-between gap-2 text-3xs text-wb-text-muted">
                    <span className="truncate">
                      <span className="font-semibold text-wb-text-secondary">{r.room_name}</span>
                      <span className="mx-1">·</span>
                      {r.sender_nickname || r.sender_username}
                    </span>
                    <span className="font-mono shrink-0">{formatChatTime(r.created_at)}</span>
                  </div>
                  <p className="text-2xs text-wb-text-primary line-clamp-2 break-all">{r.content}</p>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      <AvatarPreview
        src={avatarPreview?.src ?? null}
        name={avatarPreview?.name}
        onClose={() => setAvatarPreview(null)}
      />

      {/* 专业版专属：六大工作软件摸鱼伪装层。数据全部取自当前聊天界面，
          发送走现有 handleSendMessage，切换会话走现有 state，经典版不渲染。 */}
      {isPro && stealthTheme !== 'normal' && (
        <StealthWorkspaceCamouflage
          theme={stealthTheme}
          onThemeChange={setStealthTheme}
          activeTitle={
            chatTab === 'group'
              ? activeGroup?.name || '技术研讨群'
              : activeConv?.peer_nickname || activeConv?.peer_username || '私聊会话'
          }
          conversations={
            chatTab === 'group'
              ? groups.map((g) => ({
                  id: g.id, name: g.name, isGroup: true,
                  unreadCount: g.unread_count, lastMessage: g.last_message_preview,
                }))
              : conversations.map((c) => ({
                  id: c.id, name: c.peer_nickname || c.peer_username || '未知',
                  isGroup: false, unreadCount: c.unread_count,
                  lastMessage: c.last_message_preview,
                }))
          }
          groups={groups.filter((group) => group.is_member).map((group) => ({ id: group.id, name: group.name, unreadCount: group.unread_count }))}
          activeConvId={chatTab === 'group' ? activeGroupId || '' : activeConvId || ''}
          onSelectConversation={(id, isGroup) => {
            if (chatTab === (isGroup ? 'group' : 'direct') && id === (isGroup ? activeGroupId : activeConvId)) return;
            setChatTab(isGroup ? 'group' : 'direct');
            if (isGroup) setActiveGroupId(id);
            else setActiveConvId(id);
          }}
          onOpenGroupAction={(action) => {
            if (action === 'levels') setShowLevelBoard(true);
            if (action === 'members') setIsMembersModalOpen(true);
            if (action === 'checkinCfg') toolboxActions.find((item) => item.key === action)?.run();
          }}
          activityRefreshKey={{ chain: chainTick, feihua: feihuaTick }}
          mentionMembers={groupMembers}
          messages={
            chatTab === 'group'
              ? groupMessages.map((gm) => ({
                  id: gm.id,
                  senderName: gm.sender_nickname || gm.sender_username,
                  content: gm.content,
                  timeStr: formatChatTime(gm.created_at),
                  isMe: gm.sender_id === user?.id,
                  msgType: gm.msg_type,
                  recalled: gm.is_recalled,
                  reply: gm.reply_snippet ? { id: gm.reply_to_id, sender: gm.reply_sender || '', snippet: gm.reply_snippet } : undefined,
                }))
              : messages.map((m) => ({
                  id: m.id,
                  senderName: m.sender_id === user?.id
                    ? user?.nickname || user?.username || '我'
                    : activeConv?.peer_nickname || activeConv?.peer_username || '对方',
                  content: m.content,
                  timeStr: formatChatTime(m.created_at),
                  isMe: m.sender_id === user?.id,
                  msgType: 'text',
                  recalled: m.is_recalled,
                  reply: m.reply_snippet ? { id: m.reply_to_id, sender: m.reply_sender || '', snippet: m.reply_snippet } : undefined,
                }))
          }
          inputText={inputText}
          onInputChange={setInputText}
          onSendMessage={() => { void handleSendMessage(); }}
          onSendSticker={(url) => { void handleSendMessage(undefined, url); }}
          pendingImageUrl={pendingImageUrl}
          isUploadingImage={pendingImageUploading}
          uploadPercent={uploadPercent}
          onRemoveImage={() => setPendingImageUrl(null)}
          isSending={isSending}
          onUploadImage={uploadPendingImage}
          onToolAction={(key) => { toolboxActions.find((a) => a.key === key)?.run(); }}
          onReply={(m) => setReplyTarget({ id: m.id, sender: m.senderName, snippet: (m.content || '').slice(0, 40) })}
          onCancelReply={() => setReplyTarget(null)}
          replyTo={replyTarget ? { sender: replyTarget.sender, snippet: replyTarget.snippet } : null}
          onRecall={(id) => {
            if (chatTab === 'group') void handleRecallGroupMessage(id);
            else void handleRecall(id);
          }}
          onLoadMoreHistory={chatTab === 'group' ? loadMoreGroupHistory : undefined}
          hasMoreHistory={chatTab === 'group' ? hasMoreGroupHistory : false}
          loadingHistory={chatTab === 'group' ? loadingGroupHistory : false}
          groupRoomId={chatTab === 'group' ? activeGroupId || '' : ''}
          canManageGroup={myGroupRole === 'owner' || myGroupRole === 'admin'}
          groupToast={toast}
          onShareToGroup={(text) => { void handleSendMessage(undefined, text); }}
          onDrawFortune={async () => {
            if (!activeGroupId) return null;
            try {
              const res = await apiClient.post(`/chat/groups/${activeGroupId}/fortune`);
              return res.data;
            } catch (err: any) {
              toast.error(err?.response?.data?.detail || '求签失败');
              return null;
            }
          }}
          onClose={() => setStealthTheme('normal')}
        />
      )}
    </div>
  );
};
