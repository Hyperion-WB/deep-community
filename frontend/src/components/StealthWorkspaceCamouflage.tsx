import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import {
  Code2,
  FileSpreadsheet,
  FileText,
  Presentation,
  Building2,
  Calendar,
  X,
  Play,
  Search,
  Folder,
  File,
  ChevronDown,
  GitBranch,
  Settings,
  ImagePlus,
  Smile,
  Wrench,
  Loader2,
  ArrowUp,
  Reply,
  AtSign,
  Undo2,
} from 'lucide-react';
import { GroupActivitiesModal, FortuneOverlay } from './GroupActivities';
import { EMOJI_CATEGORIES } from './EmojiPicker';
import { SafeImage } from './SafeImage';
import { apiClient } from '../api/client';

export type StealthTheme = 'normal' | 'vscode' | 'idea' | 'feishu' | 'excel' | 'word' | 'ppt';

const MEDIA_TOKEN_RE = /!\[[^\]\n]*\]\(((?:https?:\/\/|\/(?!\/))[^\s)\\]+)\)|((?:https?:\/\/[^\s/<>"'()[\]\\]+)?\/uploads\/[\w/%.\-]+(?:[?#][^\s<>"'()[\]\\，。！？]+)?)/gi;
const UPLOAD_IMAGE_RE = /\.(?:avif|gif|jpe?g|png|webp)$/i;
const SHOW_IMAGES_KEY = 'geek_chat_skin_show_images';
const isSticker = (url: string) => /\/uploads\/stickers\//i.test(url);
const mediaLabel = (url: string) => isSticker(url) ? '[表情包]' : '[图片]';
const camouflageMedia = (content: string) => content.replace(MEDIA_TOKEN_RE, (_token, markdownUrl, uploadUrl) =>
  mediaLabel(markdownUrl || uploadUrl),
);

const StealthImage = ({ url, eager }: { url: string; eager?: boolean }) => {
  const sticker = isSticker(url);
  return <SafeImage src={url} alt={sticker ? '表情包' : '图片'} loading={eager ? 'eager' : undefined}
    className={`block max-w-full rounded object-contain object-left ${sticker ? 'h-24 w-24' : 'h-36 w-56'}`}
    fallback={<span>{mediaLabel(url)}加载失败</span>} />;
};

const StealthImagePreview = ({ url }: { url: string }) => {
  const previewRef = useRef<HTMLSpanElement>(null);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [activated, setActivated] = useState<boolean | null>(null);
  const expanded = activated ?? (hovered || focused);

  useLayoutEffect(() => {
    if (expanded) previewRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [expanded]);

  return (
    <span ref={previewRef} className="inline-flex max-w-full flex-col items-start align-top"
      onPointerEnter={(event) => { if (event.pointerType === 'mouse') setHovered(true); }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        setHovered(false);
        if (!focused) setActivated(null);
      }}>
      <button type="button" aria-expanded={expanded}
        className="cursor-pointer rounded text-inherit focus-visible:outline focus-visible:outline-1"
        onFocus={(event) => setFocused(event.currentTarget.matches(':focus-visible'))}
        onBlur={() => { setFocused(false); setActivated(null); }}
        onClick={(event) => { event.stopPropagation(); setActivated(!expanded); }}>
        {mediaLabel(url)}
      </button>
      {expanded && <StealthImage url={url} eager />}
    </span>
  );
};

/** 结构化消息（骰子/签到/接龙/投票/求签）在伪装层里转成人话，不再暴露 JSON */
const KIND_LABEL: Record<string, string> = {
  dice: '🎲 掷了骰子',
  checkin: '✅ 每日签到',
  chain: '🀄 成语接龙',
  feihua: '🏮 飞花令',
  poll: '📊 群投票',
  fortune: '🔮 每日求签',
};
const summarizeStructured = (content: string): string | null => {
  const t = (content || '').trim();
  if (!t.startsWith('{')) return null;
  try {
    const o = JSON.parse(t);
    if (typeof o?.text === 'string' && o.text.trim()) return o.text;
    if (typeof o?.points === 'number') return `🎲 掷出 ${o.points} 点`;
    if (typeof o?.word === 'string' && o.word) return `🀄 ${o.user ? `${o.user} ` : ''}接「${o.word}」`;
    if (typeof o?.kind === 'string') return KIND_LABEL[o.kind] || '📎 结构化消息';
    return '📎 结构化消息';
  } catch {
    return null;
  }
};

interface StealthStickerItem {
  id: string;
  url: string;
  name?: string;
}

export interface StealthMessageItem {
  id: string;
  senderName: string;
  content: string;
  timeStr: string;
  isMe: boolean;
  /** 原始消息类型（text / dice / checkin / chain / poll / fortune …） */
  msgType?: string;
  recalled?: boolean;
  reply?: { id?: string | null; sender: string; snippet: string };
}

export interface StealthConversationItem {
  id: string;
  name: string;
  lastMessage?: string;
  unreadCount?: number;
  isGroup?: boolean;
}

interface Props {
  theme: StealthTheme;
  onThemeChange: (theme: StealthTheme) => void;
  activeTitle: string;
  conversations: StealthConversationItem[];
  activeConvId?: string;
  onSelectConversation?: (id: string, isGroup: boolean) => void;
  messages: StealthMessageItem[];
  inputText: string;
  onInputChange: (value: string | ((previous: string) => string)) => void;
  onSendMessage: () => void;
  onSendSticker: (url: string) => void;
  pendingImageUrl: string | null;
  isUploadingImage: boolean;
  uploadPercent: number;
  onRemoveImage: () => void;
  isSending: boolean;
  onClose: () => void;
  /** 使用当前会话的图片暂存上传链路 */
  onUploadImage?: (file: File) => void | Promise<void>;
  /** 群工具：dice / checkin 直接发送；chain / fortune / poll 走嵌入式面板 */
  onToolAction?: (key: string) => void;
  /** 消息操作：引用回复 / 撤回 / @ 提及 */
  onReply?: (msg: StealthMessageItem) => void;
  onCancelReply?: () => void;
  replyTo?: { sender: string; snippet: string } | null;
  onRecall?: (msgId: string) => void;
  groups: StealthConversationItem[];
  onOpenGroupAction?: (action: 'levels' | 'members' | 'checkinCfg') => void;
  activityRefreshKey?: { chain: number; feihua: number };
  mentionMembers?: { user_id: string; username: string; nickname?: string }[];
  /** 上滑加载更早的聊天历史（群聊） */
  onLoadMoreHistory?: () => void;
  hasMoreHistory?: boolean;
  loadingHistory?: boolean;
  /** 嵌入式活动面板所需 */
  groupRoomId?: string;
  canManageGroup?: boolean;
  groupToast?: any;
  onDrawFortune?: () => Promise<any>;
  /** 把投票结果发送到群聊 */
  onShareToGroup?: (text: string) => void;
}

export const StealthWorkspaceCamouflage: React.FC<Props> = ({
  theme,
  onThemeChange,
  activeTitle,
  conversations,
  activeConvId,
  onSelectConversation,
  messages,
  inputText,
  onInputChange: setInputText,
  onSendMessage,
  onSendSticker,
  pendingImageUrl,
  isUploadingImage,
  uploadPercent,
  onRemoveImage,
  isSending,
  onClose,
  onUploadImage,
  onToolAction,
  onReply,
  onCancelReply,
  replyTo,
  onRecall,
  groups,
  onOpenGroupAction,
  activityRefreshKey,
  mentionMembers = [],
  groupRoomId,
  canManageGroup,
  groupToast,
  onDrawFortune,
  onShareToGroup,
  onLoadMoreHistory,
  hasMoreHistory,
  loadingHistory,
}) => {
  const canSend = Boolean(activeConvId && (inputText.trim() || pendingImageUrl) && !isUploadingImage && !isSending);
  const [showImages, setShowImages] = useState(() => {
    try { return localStorage.getItem(SHOW_IMAGES_KEY) === 'true'; } catch { return false; }
  });
  useEffect(() => {
    try { localStorage.setItem(SHOW_IMAGES_KEY, String(showImages)); } catch { /* ignore */ }
  }, [showImages]);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const switcherHovered = useRef(false);
  const [showEmoji, setShowEmoji] = useState(false);
  const [emojiTab, setEmojiTab] = useState<'emoji' | 'sticker'>('emoji');
  const [stickers, setStickers] = useState<StealthStickerItem[]>([]);
  const [stickersLoading, setStickersLoading] = useState(false);
  const [showTools, setShowTools] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);
  // 点击消息弹出操作菜单（回复 / @ / 撤回）
  const [opsFor, setOpsFor] = useState<{ msg: StealthMessageItem; x: number; y: number } | null>(null);
  // 群活动面板嵌入伪装层，保证不退出伪装
  const [activePanel, setActivePanel] = useState<'chain' | 'poll' | 'fortune' | 'feihua' | null>(null);
  const [fortuneData, setFortuneData] = useState<any>(null);

  // 伪装层内 Ctrl+V 粘贴图片：与真实聊天共用同一条上传链路
  useEffect(() => {
    const onPaste = (e: ClipboardEvent) => {
      const files = Array.from(e.clipboardData?.files || []).filter((f) => f.type.startsWith('image/'));
      if (!files.length || !onUploadImage) return;
      e.preventDefault();
      void onUploadImage(files[0]);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [onUploadImage]);

  // 点击空白关闭消息操作菜单
  useEffect(() => {
    if (!opsFor) return;
    const close = () => setOpsFor(null);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [opsFor]);

  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottomRef = useRef(true);
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [highlightedMessage, setHighlightedMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!highlightedMessage) return;
    const timer = window.setTimeout(() => setHighlightedMessage(null), 1800);
    return () => window.clearTimeout(timer);
  }, [highlightedMessage]);

  const jumpToReply = (id: string) => {
    const row = scrollRef.current?.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(id)}"]`);
    if (!row) {
      groupToast?.info('这条消息在更早的记录里，可通过「历史」继续加载');
      return;
    }
    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    setHighlightedMessage(id);
  };
  const historyAnchorRef = useRef<{ id: string; offset: number } | null>(null);
  const firstMessageId = messages[0]?.id;
  const lastMessageId = messages[messages.length - 1]?.id;

  useLayoutEffect(() => {
    historyAnchorRef.current = null;
    atBottomRef.current = true;
    setAwayFromBottom(false);
    setHighlightedMessage(null);
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [theme, activeConvId]);

  useEffect(() => {
    setOpsFor(null);
    setShowEmoji(false);
    setShowTools(false);
    setActivePanel(null);
  }, [activeConvId]);

  const loadEarlier = () => {
    if (!onLoadMoreHistory || loadingHistory || !hasMoreHistory) return;
    const el = scrollRef.current;
    const first = el?.querySelector<HTMLElement>('[data-message-id]');
    if (el && first?.dataset.messageId) {
      historyAnchorRef.current = { id: first.dataset.messageId, offset: first.getBoundingClientRect().top };
    }
    void onLoadMoreHistory();
  };

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || loadingHistory) return;
    const anchor = historyAnchorRef.current;
    historyAnchorRef.current = null;
    if (anchor) {
      const row = Array.from(el.querySelectorAll<HTMLElement>('[data-message-id]'))
        .find((node) => node.dataset.messageId === anchor.id);
      if (row) el.scrollTop += row.getBoundingClientRect().top - anchor.offset;
    } else if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [firstMessageId, lastMessageId, loadingHistory, showImages]);

  const trackScroll = (event: React.UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    const distance = el.scrollHeight - el.clientHeight - el.scrollTop;
    atBottomRef.current = distance < 80;
    setAwayFromBottom(distance > 200);
  };

  // 「我的表情」：与主聊天共用同一份收藏/上传表情
  useEffect(() => {
    if (!showEmoji || emojiTab !== 'sticker') return;
    let alive = true;
    setStickersLoading(true);
    apiClient.get('/stickers/mine')
      .then((r) => {
        if (!alive) return;
        const data = r.data;
        const list = Array.isArray(data) ? data : (data?.items || []);
        setStickers(Array.isArray(list) ? list : []);
      })
      .catch(() => { if (alive) setStickers([]); })
      .finally(() => { if (alive) setStickersLoading(false); });
    return () => { alive = false; };
  }, [showEmoji, emojiTab]);

  // 监听键盘快捷键 (Alt+1~6 切换皮肤，Esc 退出)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      if (e.altKey) {
        if (e.key === '1') onThemeChange('vscode');
        if (e.key === '2') onThemeChange('idea');
        if (e.key === '3') onThemeChange('feishu');
        if (e.key === '4') onThemeChange('excel');
        if (e.key === '5') onThemeChange('word');
        if (e.key === '6') onThemeChange('ppt');
        if (e.key === '0' || e.key === '`') onThemeChange('normal');
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onThemeChange, onClose]);

  const handleSubmit = (e?: React.FormEvent) => {
    e?.preventDefault();
    if (canSend) onSendMessage();
  };

  const renderMediaText = (content: string) => {
    const parts: React.ReactNode[] = [];
    let cursor = 0;
    for (const match of content.matchAll(MEDIA_TOKEN_RE)) {
      const [token, markdownUrl, uploadUrl] = match;
      const trailingDots = uploadUrl?.match(/^[^?#]*?(\.+)$/)?.[1].length ?? 0;
      const url = markdownUrl || token.slice(0, token.length - trailingDots);
      const start = match.index;
      parts.push(content.slice(cursor, start));
      if (markdownUrl || UPLOAD_IMAGE_RE.test(url.split(/[?#]/, 1)[0])) {
        const key = `${start}:${url}`;
        parts.push(showImages ? <StealthImage key={key} url={url} /> : <StealthImagePreview key={key} url={url} />);
      } else {
        parts.push(mediaLabel(url));
      }
      cursor = start + (markdownUrl ? token.length : url.length);
    }
    parts.push(content.slice(cursor));
    return parts;
  };

  const renderMessageContent = (m: StealthMessageItem) => {
    if (m.recalled) return <span className="opacity-60">该消息已撤回</span>;
    const summary = m.msgType && m.msgType !== 'text' ? summarizeStructured(m.content) : null;
    const openOps = (e: React.MouseEvent) => {
      e.stopPropagation();
      const r = e.currentTarget.getBoundingClientRect();
      setOpsFor({
        msg: m,
        x: Math.max(8, Math.min(r.right + 8, window.innerWidth - 170)),
        y: Math.max(8, Math.min(r.top, window.innerHeight - 42)),
      });
    };
    const replyId = m.reply?.id;
    return (
      <div className={`min-h-[1em] whitespace-pre-wrap break-words cursor-pointer ${summary ? 'italic opacity-80' : ''} ${highlightedMessage === m.id ? 'rounded ring-2 ring-inset ring-amber-500' : ''}`}
        onClick={openOps} onContextMenu={(e) => { e.preventDefault(); openOps(e); }}>
        {m.reply && (replyId ? (
          <button type="button" className="block max-w-full truncate text-left text-xs opacity-70 hover:underline"
            onClick={(event) => { event.stopPropagation(); jumpToReply(replyId); }}>
            {m.reply.sender} · {camouflageMedia(m.reply.snippet)}
          </button>
        ) : <span className="block text-xs opacity-60">{m.reply.sender} · {camouflageMedia(m.reply.snippet)}</span>)}
        {renderMediaText(summary || m.content)}
      </div>
    );
  };

  // 伪装层内的图片 / 表情 / 群工具：与真实聊天共用上传与发送链路。
  // variant 适配深/浅色皮肤，placement 决定面板朝上还是朝下弹（Excel 输入栏在顶部）。
  const renderComposerExtras = (variant: 'dark' | 'light' = 'dark', placement: 'up' | 'down' = 'up') => {
    const dark = variant === 'dark';
    const btnBase = `flex items-center gap-1 px-1.5 py-1 rounded transition-colors cursor-pointer disabled:opacity-40 shrink-0 ${
      dark ? 'text-zinc-400 hover:text-white hover:bg-white/10' : 'text-zinc-500 hover:text-zinc-900 hover:bg-black/5'
    }`;
    const btnOn = dark ? 'bg-white/15 text-white' : 'bg-black/10 text-zinc-900';
    const panelCls = `absolute ${
      placement === 'up' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'
    } right-0 z-[60] w-[300px] rounded-lg shadow-2xl border ${
      dark ? 'bg-[#1b1b1b]/95 backdrop-blur-md border-white/20 text-white' : 'bg-white border-zinc-200 text-zinc-800'
    }`;
    const tabOn = dark ? 'bg-white/20 text-white' : 'bg-zinc-900 text-white';
    const tabOff = dark ? 'text-zinc-400 hover:text-white hover:bg-white/10' : 'text-zinc-500 hover:text-zinc-900 hover:bg-black/5';
    const subCls = dark ? 'text-zinc-500' : 'text-zinc-400';
    const hoverCls = dark ? 'hover:bg-white/15' : 'hover:bg-black/5';

    return (
      <div className="relative flex items-center gap-0.5 shrink-0">
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            if (file) void onUploadImage?.(file);
          }}
        />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={isUploadingImage || isSending || !activeConvId || !onUploadImage}
          title="添加待发图片"
          className={btnBase}
        >
          {isUploadingImage ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />}
          <span className="text-3xs">{isUploadingImage ? `上传 ${uploadPercent}%` : '图片'}</span>
        </button>
        {pendingImageUrl && (
          <button type="button" onClick={onRemoveImage} disabled={isSending} className={btnBase} aria-label="移除待发送图片">
            {mediaLabel(pendingImageUrl)} <span aria-hidden="true">×</span>
          </button>
        )}
        <button
          type="button"
          onClick={() => { setShowEmoji((v) => !v); setShowTools(false); }}
          title="表情（常用 + 我的表情）"
          className={`${btnBase} ${showEmoji ? btnOn : ''}`}
        >
          <Smile className="w-3.5 h-3.5" />
          <span className="text-3xs">表情</span>
        </button>
        {(hasMoreHistory || loadingHistory) && (
          <button type="button" title="加载更早的消息" className={btnBase} onClick={loadEarlier} disabled={loadingHistory}>
            {loadingHistory ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ArrowUp className="w-3.5 h-3.5" />}
            <span className="text-3xs">历史</span>
          </button>
        )}
        {awayFromBottom && <button type="button" className={btnBase} onClick={() => {
          if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
        }}>回到最新</button>}
        {groupRoomId && <button
          type="button"
          onClick={() => { setShowTools((v) => !v); setShowEmoji(false); }}
          title="群工具（骰子 / 签到 / 接龙 / 求签 / 投票）"
          className={`${btnBase} ${showTools ? btnOn : ''}`}
        >
          <Wrench className="w-3.5 h-3.5" />
          <span className="text-3xs">工具</span>
        </button>}

        {showEmoji && (
          <div className={panelCls}>
            <div className="flex items-center gap-1 px-2 pt-2">
              {([['emoji', '常用表情'], ['sticker', '我的表情']] as const).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => setEmojiTab(key)}
                  className={`px-2 py-1 rounded text-3xs font-semibold transition-colors cursor-pointer ${
                    emojiTab === key ? tabOn : tabOff
                  }`}
                >
                  {label}
                </button>
              ))}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => setShowEmoji(false)}
                className={`p-1 ${dark ? 'text-zinc-400 hover:text-white' : 'text-zinc-400 hover:text-zinc-900'}`}
                title="关闭"
              >
                <X className="w-3 h-3" />
              </button>
            </div>

            <div className="p-2 max-h-[240px] overflow-y-auto">
              {emojiTab === 'emoji' ? (
                <div className="space-y-2">
                  {EMOJI_CATEGORIES.map((cat) => (
                    <div key={cat.name} className="space-y-0.5">
                      <p className={`text-[9px] font-semibold ${subCls}`}>{cat.name}</p>
                      <div className="grid grid-cols-9 gap-0.5">
                        {cat.emojis.map((emoji, idx) => (
                          <button
                            key={`${cat.name}-${idx}`}
                            type="button"
                            onClick={() => setInputText((prev) => prev + emoji)}
                            className={`w-6 h-6 flex items-center justify-center rounded text-sm leading-none cursor-pointer ${hoverCls}`}
                          >
                            {emoji}
                          </button>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              ) : stickersLoading ? (
                <div className={`py-6 flex items-center justify-center gap-1.5 text-3xs ${subCls}`}>
                  <Loader2 className="w-3 h-3 animate-spin" /> 加载中…
                </div>
              ) : stickers.length === 0 ? (
                <div className={`py-6 text-center text-3xs space-y-1 ${subCls}`}>
                  <Smile className="w-5 h-5 mx-auto opacity-50" />
                  <p>还没有收藏表情</p>
                  <p className="text-[9px] opacity-80">可在聊天表情面板「我的表情」里上传</p>
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-1">
                  {stickers.map((item, index) => (
                    <button key={item.id} type="button" title="发送这个表情"
                      disabled={!activeConvId || isSending || isUploadingImage}
                      onClick={() => { onSendSticker(item.url); setShowEmoji(false); }}
                      className={`truncate rounded px-1 py-2 text-3xs ${hoverCls}`}>
                      {item.name || `表情 ${index + 1}`}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {showTools && (
          <div className={`${panelCls} w-48 p-1 text-3xs`}>
            <div className={`px-2 py-1 font-semibold border-b ${dark ? 'text-zinc-400 border-white/10' : 'text-zinc-500 border-zinc-200'}`}>
              群互动工具
            </div>
            <label className="flex items-center gap-1 px-2 py-1.5">
              <AtSign className="h-3 w-3 shrink-0" />
              <select aria-label="提及成员" className={`min-w-0 flex-1 rounded ${dark ? 'bg-zinc-800' : 'bg-white'}`} value="" onChange={(event) => {
                const name = event.currentTarget.value;
                setInputText((value) => `${value}${value && !/\s$/.test(value) ? ' ' : ''}@${name} `);
                setShowTools(false);
              }}>
                <option value="" disabled>提及成员</option>
                {mentionMembers.map((member) => <option key={member.user_id} value={member.nickname || member.username}>{member.nickname || member.username}</option>)}
              </select>
            </label>
            {onOpenGroupAction && ([['members', '群成员'], ['levels', '群等级榜'], ...(canManageGroup ? [['checkinCfg', '签到设置']] : [])] as const).map(([key, label]) => (
              <button key={key} type="button" className={`block w-full px-2 py-1.5 text-left ${hoverCls}`}
                onClick={() => { setShowTools(false); onOpenGroupAction(key as 'members' | 'levels' | 'checkinCfg'); }}>{label}</button>
            ))}
            {[
              { key: 'dice', label: '掷骰子', hint: '直接发送' },
              { key: 'checkin', label: '发签到语', hint: '直接发送' },
              { key: 'chain', label: '成语接龙', hint: '面板内' },
              { key: 'feihua', label: '飞花令', hint: '面板内' },
              { key: 'fortune', label: '每日求签', hint: '面板内' },
              { key: 'poll', label: '群投票', hint: '面板内' },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={async () => {
                  setShowTools(false);
                  if (item.key === 'dice' || item.key === 'checkin') {
                    onToolAction?.(item.key);
                    return;
                  }
                  if (item.key === 'fortune') {
                    const data = await onDrawFortune?.();
                    if (data) { setFortuneData(data); setActivePanel('fortune'); }
                    return;
                  }
                  setActivePanel(item.key as 'chain' | 'poll' | 'feihua');
                }}
                className={`w-full flex items-center justify-between px-2 py-1.5 rounded text-left cursor-pointer ${hoverCls}`}
              >
                <span>{item.label}</span>
                <span className={`text-[9px] ${subCls}`}>{item.hint}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  };

  // 浮动摸鱼切换控制条 (右上角极简小药丸)
  const renderFloatingSwitcher = () => (
    <>
    <div className="absolute top-0 right-0 z-[80] min-w-[48px] min-h-[32px]"
      onPointerEnter={(event) => {
        if (event.pointerType !== 'mouse') return;
        switcherHovered.current = true;
        setSwitcherOpen(true);
      }}
      onPointerLeave={(event) => {
        if (event.pointerType !== 'mouse') return;
        switcherHovered.current = false;
        const focused = document.activeElement;
        if (!event.currentTarget.contains(focused) || !focused?.matches(':focus-visible')) setSwitcherOpen(false);
      }}
      onBlur={(event) => {
        if (!switcherHovered.current && !event.currentTarget.contains(event.relatedTarget)) setSwitcherOpen(false);
      }}>
      <button type="button" aria-label="皮肤切换" aria-expanded={switcherOpen}
        className={`absolute top-0 right-0 h-8 w-12 rounded-lg bg-black/90 text-white focus-visible:opacity-100 [@media(hover:none)]:opacity-100 ${switcherOpen ? 'opacity-100' : 'opacity-0'}`}
        onClick={() => setSwitcherOpen((open) => !open)}>
        <Settings className="mx-auto h-4 w-4" />
      </button>
      {switcherOpen && <div aria-label="皮肤切换" className="flex min-h-8 max-w-[100vw] flex-wrap justify-end items-center gap-1.5 p-1 pr-12 rounded-lg bg-black/90 border border-white/20 text-white text-3xs font-mono shadow-2xl">
      {(
        [
          { key: 'vscode', label: 'VSCode', icon: Code2 },
          { key: 'idea', label: 'IDEA', icon: Play },
          { key: 'feishu', label: '飞书', icon: Building2 },
          { key: 'excel', label: 'Excel', icon: FileSpreadsheet },
          { key: 'word', label: 'Word', icon: FileText },
          { key: 'ppt', label: 'PPT', icon: Presentation },
        ] as const
      ).map((item) => (
        <button
          key={item.key}
          type="button"
          onClick={() => onThemeChange(item.key)}
          className={`flex items-center gap-1 px-2 py-1 rounded transition-colors cursor-pointer ${
            theme === item.key
              ? 'bg-blue-600 text-white font-bold'
              : 'hover:bg-white/10 text-zinc-300'
          }`}
          title={`切换为 ${item.label} (Alt+${item.key === 'vscode' ? 1 : item.key === 'idea' ? 2 : item.key === 'feishu' ? 3 : item.key === 'excel' ? 4 : item.key === 'word' ? 5 : 6})`}
        >
          <item.icon className="w-3 h-3" />
          <span>{item.label}</span>
        </button>
      ))}
      <button type="button" aria-pressed={showImages} onClick={() => setShowImages((value) => !value)}
        className={`px-2 py-1 rounded ${showImages ? 'bg-blue-600 text-white' : 'hover:bg-white/10'}`}>
        直接显示图片
      </button>
      <button
        type="button"
        onClick={onClose}
        className="flex items-center gap-1 px-2 py-1 rounded bg-red-600/80 hover:bg-red-600 text-white font-semibold transition-colors cursor-pointer ml-1"
        title="退出伪装返回正常聊天 (Esc)"
      >
        <X className="w-3 h-3" />
        <span>退出 (Esc)</span>
      </button>
      </div>}
    </div>

    {replyTo && (
      <div className="absolute top-14 right-4 z-[60] flex items-center gap-2 max-w-[340px] px-2.5 py-1.5 rounded-lg bg-black/85 backdrop-blur-md border border-white/20 text-white text-3xs font-mono shadow-2xl">
        <Reply className="w-3 h-3 text-emerald-400 shrink-0" />
        <span className="text-emerald-400 shrink-0">引用 {replyTo.sender}</span>
        <span className="truncate text-zinc-300">{camouflageMedia(replyTo.snippet)}</span>
        <button type="button" onClick={onCancelReply} className="shrink-0 text-zinc-400 hover:text-white" title="取消引用">
          <X className="w-3 h-3" />
        </button>
      </div>
    )}

    {opsFor && (
      <div
        className="fixed z-[9995] flex items-center gap-0.5 p-1 rounded-lg bg-black/90 backdrop-blur-md border border-white/20 text-white text-3xs font-mono shadow-2xl"
        style={{ left: opsFor.x, top: opsFor.y }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {onReply && (
          <button type="button" title="引用回复"
            onClick={() => { onReply(opsFor.msg); setOpsFor(null); }}
            className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/15 cursor-pointer">
            <Reply className="w-3 h-3" /> 回复
          </button>
        )}
        {groupRoomId && <button type="button" title="提及该用户（插入到伪装层输入框）"
          onClick={() => { setInputText((prev) => `${prev}@${opsFor.msg.senderName} `); setOpsFor(null); }}
          className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-white/15 cursor-pointer">
          <AtSign className="w-3 h-3" /> @
        </button>}
        {onRecall && opsFor.msg.isMe && (
          <button type="button" title="撤回这条消息"
            onClick={() => { onRecall(opsFor.msg.id); setOpsFor(null); }}
            className="flex items-center gap-1 px-1.5 py-1 rounded hover:bg-red-500/25 text-red-300 cursor-pointer">
            <Undo2 className="w-3 h-3" /> 撤回
          </button>
        )}
      </div>
    )}

    {(activePanel === 'chain' || activePanel === 'poll' || activePanel === 'feihua') && groupRoomId && (
      <GroupActivitiesModal
        roomId={groupRoomId}
        kind={activePanel}
        refreshKey={activePanel === 'feihua' ? activityRefreshKey?.feihua : activityRefreshKey?.chain}
        canManage={Boolean(canManageGroup)}
        toast={groupToast}
        onClose={() => setActivePanel(null)}
        onShareToGroup={onShareToGroup}
        embedded
      />
    )}

    {activePanel === 'fortune' && (
      <FortuneOverlay
        data={fortuneData}
        onClose={() => { setActivePanel(null); setFortuneData(null); }}
        embedded
      />
    )}


    </>
  );

  // ==========================================
  // 1. VS Code 风格
  // ==========================================
  if (theme === 'vscode') {
    return (
      <div className="fixed inset-0 z-[110] bg-[#1e1e1e] text-[#d4d4d4] font-mono flex flex-col select-none text-xs">
        {renderFloatingSwitcher()}

        {/* 顶部标题栏 */}
        <div className="h-8 bg-[#323233] flex items-center justify-between px-3 text-3xs text-zinc-400 border-b border-[#252526]">
          <div className="flex items-center gap-2">
            <Code2 className="w-3.5 h-3.5 text-blue-400" />
            <span>Visual Studio Code - [Workspace: /enterprise-cloud-core]</span>
          </div>
          <span className="font-sans">thread_{activeTitle.replace(/\s+/g, '_')}.ts — enterprise-cloud-core</span>
          <div className="flex items-center gap-2">
            <span>TypeScript 5.4.2</span>
          </div>
        </div>

        {/* 主体工作区 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧活动栏 (Activity Bar) */}
          <div className="w-12 bg-[#333333] flex flex-col items-center py-2 space-y-4 text-zinc-400 shrink-0 border-r border-[#252526]">
            <span title="Explorer (Ctrl+Shift+E)"><Folder className="w-5 h-5 text-white cursor-pointer" /></span>
            <span title="Search (Ctrl+Shift+F)"><Search className="w-5 h-5 hover:text-white cursor-pointer" /></span>
            <span title="Source Control"><GitBranch className="w-5 h-5 hover:text-white cursor-pointer" /></span>
            <span title="Run and Debug"><Play className="w-5 h-5 hover:text-white cursor-pointer" /></span>
            <span title="Settings" className="mt-auto"><Settings className="w-5 h-5 hover:text-white cursor-pointer" /></span>
          </div>

          {/* 文件资源管理器树 (Explorer) */}
          <div className="w-56 bg-[#252526] border-r border-[#1e1e1e] flex flex-col shrink-0 text-3xs">
            <div className="px-3 py-2 font-bold uppercase tracking-wider text-zinc-400 flex items-center justify-between border-b border-[#1e1e1e]">
              <span>EXPLORER</span>
              <span className="text-[10px] text-zinc-500">ROOT</span>
            </div>
            <div className="p-2 space-y-1 overflow-y-auto flex-1">
              <div className="flex items-center gap-1 text-zinc-400 font-semibold px-1 py-0.5">
                <ChevronDown className="w-3 h-3" />
                <Folder className="w-3 h-3 text-amber-400" />
                <span>src/channels/</span>
              </div>
              {conversations.map((c) => {
                const isSelected = c.id === activeConvId;
                return (
                  <div
                    key={c.id}
                    onClick={() => onSelectConversation?.(c.id, Boolean(c.isGroup))}
                    className={`flex items-center justify-between px-3 py-1 rounded cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#37373d] text-white font-semibold'
                        : 'hover:bg-[#2a2d2e] text-zinc-400'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 truncate">
                      <File className="w-3 h-3 text-blue-400 shrink-0" />
                      <span className="truncate">{c.name.toLowerCase().replace(/\s+/g, '_')}.ts</span>
                    </div>
                    {c.unreadCount ? (
                      <span className="px-1 text-[9px] bg-amber-500/20 text-amber-400 rounded font-mono">
                        M
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>

          {/* 右侧主代码区 + 底部终端输入 */}
          <div className="flex-1 flex flex-col bg-[#1e1e1e] overflow-hidden">
            {/* 编辑器标签条 */}
            <div className="h-8 bg-[#252526] flex items-center px-2 border-b border-[#1e1e1e] gap-1">
              <div className="flex items-center gap-1.5 px-3 py-1 bg-[#1e1e1e] text-zinc-200 border-t-2 border-blue-500 text-3xs">
                <File className="w-3 h-3 text-blue-400" />
                <span>{activeTitle.replace(/\s+/g, '_')}.ts</span>
                <X className="w-3 h-3 text-zinc-500 hover:text-white cursor-pointer ml-1" />
              </div>
            </div>

            {/* 代码正文行 (消息格式化为代码注释与函数) */}
            <div ref={scrollRef} onScroll={trackScroll} className="flex-1 p-3 overflow-y-auto space-y-1 font-mono text-xs select-text">
              <div className="text-zinc-600">// ========================================================</div>
              <div className="text-zinc-600">// Module: {activeTitle} · Auto-generated session log</div>
              <div className="text-zinc-600">// ========================================================</div>
              {messages.map((m, idx) => (
                <div key={m.id} data-message-id={m.id} className="flex items-start gap-3 hover:bg-[#262626] py-0.5 px-1 rounded">
                  <span className="w-8 text-right text-zinc-600 shrink-0 select-none">{idx + 1}</span>
                  <div className="flex-1">
                    <span className="text-[#6a9955]">// [{m.timeStr}] </span>
                    <span className={m.isMe ? 'text-[#4ec9b0]' : 'text-[#569cd6]'}>
                      @{m.senderName}:{' '}
                    </span>
                    <div className="text-[#ce9178]">{renderMessageContent(m)}</div>
                  </div>
                </div>
              ))}

            </div>

            {/* 底部伪装集成终端 (Terminal) 作为聊天输入框 */}
            <div className="h-28 bg-[#181818] border-t border-[#2d2d2d] flex flex-col p-2">
              <div className="flex items-center justify-between text-3xs text-zinc-400 px-1 pb-1 border-b border-zinc-800">
                <div className="flex items-center gap-3">
                  <span className="font-bold text-white border-b-2 border-blue-500 pb-0.5">TERMINAL</span>
                  <span>OUTPUT</span>
                  <span>DEBUG CONSOLE</span>
                  <span>PROBLEMS (0)</span>
                </div>
                <span>node v20.11.0</span>
              </div>
              <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2 pt-2">
                <span className="text-emerald-400 shrink-0">user@dev-machine:~/cloud (feat/sync)$</span>
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Type message and press Enter (伪装为终端命令输入并发送)..."
                  className="flex-1 bg-transparent border-0 outline-none text-zinc-200 text-xs font-mono placeholder:text-zinc-600"
                  autoFocus
                />
                {renderComposerExtras('dark', 'up')}
                <button
                  type="submit" disabled={!canSend}
                  className="px-3 py-1 rounded bg-blue-600 hover:bg-blue-500 text-white text-3xs font-bold shrink-0"
                >
                  RUN
                </button>
              </form>
            </div>
          </div>
        </div>

        {/* 底部经典状态栏 */}
        <div className="h-6 bg-[#007acc] text-white flex items-center justify-between px-3 text-3xs">
          <div className="flex items-center gap-3">
            <span className="flex items-center gap-1">
              <GitBranch className="w-3 h-3" /> main*
            </span>
            <span>0 Errors, 0 Warnings</span>
          </div>
          <div className="flex items-center gap-3">
            <span>Ln {messages.length + 1}, Col 24</span>
            <span>UTF-8</span>
            <span>TypeScript</span>
            <span>Prettier</span>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 2. IntelliJ IDEA 风格
  // ==========================================
  if (theme === 'idea') {
    return (
      <div className="fixed inset-0 z-[110] bg-[#2b2d30] text-[#bcbec4] font-mono flex flex-col select-none text-xs">
        {renderFloatingSwitcher()}

        {/* IDEA 顶部主菜单 */}
        <div className="h-7 bg-[#1e1f22] flex items-center justify-between px-3 text-3xs text-zinc-400 border-b border-[#1e1f22]">
          <div className="flex items-center gap-3">
            <span className="font-bold text-white">IntelliJ IDEA 2024.1</span>
            <span>File</span>
            <span>Edit</span>
            <span>View</span>
            <span>Navigate</span>
            <span>Code</span>
            <span>Refactor</span>
            <span>Build</span>
            <span>Run</span>
            <span>Tools</span>
          </div>
          <div className="flex items-center gap-2 text-zinc-500">
            <span>Git: main</span>
            <Play className="w-3 h-3 text-emerald-400 fill-current" />
          </div>
        </div>

        {/* IDEA 主体双栏 */}
        <div className="flex-1 flex overflow-hidden">
          {/* 左侧 Project 工具窗口 */}
          <div className="w-56 bg-[#1e1f22] border-r border-[#2b2d30] flex flex-col shrink-0 text-3xs">
            <div className="p-2 border-b border-[#2b2d30] flex items-center justify-between text-zinc-400">
              <span className="font-bold">Project: backend-service</span>
            </div>
            <div className="p-2 space-y-1 overflow-y-auto flex-1">
              <div className="flex items-center gap-1 text-zinc-400">
                <ChevronDown className="w-3 h-3" />
                <Folder className="w-3 h-3 text-blue-400" />
                <span>src.main.kotlin</span>
              </div>
              {conversations.map((c) => (
                <div
                  key={c.id}
                  onClick={() => onSelectConversation?.(c.id, Boolean(c.isGroup))}
                  className={`flex items-center justify-between px-3 py-1 rounded cursor-pointer ${
                    c.id === activeConvId
                      ? 'bg-[#2e436e] text-white font-semibold'
                      : 'hover:bg-[#2a2b2d] text-zinc-400'
                  }`}
                >
                  <div className="flex items-center gap-1.5 truncate">
                    <File className="w-3 h-3 text-amber-400 shrink-0" />
                    <span className="truncate">{c.name.replace(/\s+/g, '')}Service.kt</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* 右侧 Java/Kotlin 类代码展示区 */}
          <div className="flex-1 flex flex-col bg-[#1e1f22]">
            <div className="h-7 bg-[#2b2d30] flex items-center px-3 border-b border-[#1e1f22] gap-1 text-3xs text-zinc-300">
              <span className="text-amber-400 font-bold">kt</span>
              <span>{activeTitle.replace(/\s+/g, '')}Controller.kt</span>
            </div>
            <div ref={scrollRef} onScroll={trackScroll} className="flex-1 p-3 overflow-y-auto space-y-1 font-mono text-xs select-text">
              <div className="text-purple-400">package com.enterprise.cloud.controller</div>
              <div className="text-zinc-500">/** Thread Session: {activeTitle} */</div>
              <div className="text-blue-400">class {activeTitle.replace(/\s+/g, '')}Controller &#123;</div>
              {messages.map((m, idx) => (
                <div key={m.id} data-message-id={m.id} className="flex items-start gap-3 hover:bg-[#2a2b2d] py-0.5 px-2 rounded">
                  <span className="w-8 text-right text-zinc-600 select-none">{idx + 10}</span>
                  <div>
                    <span className="text-zinc-500">// {m.timeStr} </span>
                    <span className="text-amber-300">@{m.senderName}: </span>
                    <div className="text-emerald-300">{renderMessageContent(m)}</div>
                  </div>
                </div>
              ))}
              <div className="text-blue-400">&#125;</div>

            </div>

            {/* IDEA 底部 Run 控制台输入 */}
            <div className="h-28 bg-[#1e1f22] border-t border-[#2b2d30] p-2 flex flex-col">
              <div className="text-3xs text-zinc-500 border-b border-zinc-800 pb-1 flex items-center gap-3">
                <span className="text-emerald-400 font-bold">RUN: SpringBootApplication</span>
                <span>Port: 8080</span>
                <span>Connected to the target VM</span>
              </div>
              <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2 pt-2">
                <span className="text-blue-400">&gt; console.input:</span>
                <input
                  type="text"
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  placeholder="Enter message and press Enter..."
                  className="flex-1 bg-transparent border-0 outline-none text-zinc-200 text-xs font-mono"
                  autoFocus
                />
                {renderComposerExtras('dark', 'up')}
                <button
                  type="submit" disabled={!canSend}
                  className="px-3 py-1 rounded bg-blue-600 text-white text-3xs font-bold shrink-0"
                >
                  EXEC
                </button>
              </form>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 3. 飞书 (Feishu / Lark) 企业协同风格
  // ==========================================
  if (theme === 'feishu') {
    return (
      <div className="fixed inset-0 z-[110] bg-[#f5f6f7] dark:bg-[#1a1a1a] text-[#1f2329] dark:text-[#ebebeb] flex select-none text-xs">
        {renderFloatingSwitcher()}

        {/* 左侧飞书全局功能侧边栏 */}
        <div className="w-16 bg-[#2d3139] flex flex-col items-center py-4 space-y-6 text-zinc-400 shrink-0">
          <div className="w-8 h-8 rounded-lg bg-blue-500 text-white flex items-center justify-center font-bold text-sm">
            飞
          </div>
          <span title="消息"><Building2 className="w-5 h-5 text-white cursor-pointer" /></span>
          <span title="云文档"><FileText className="w-5 h-5 hover:text-white cursor-pointer" /></span>
          <span title="多维表格"><FileSpreadsheet className="w-5 h-5 hover:text-white cursor-pointer" /></span>
          <span title="日历"><Calendar className="w-5 h-5 hover:text-white cursor-pointer" /></span>
        </div>

        {/* 中间会话列表 */}
        <div className="w-64 bg-white dark:bg-[#202124] border-r border-[#dee0e3] dark:border-zinc-800 flex flex-col shrink-0">
          <div className="p-3 border-b border-[#dee0e3] dark:border-zinc-800 flex items-center justify-between">
            <span className="font-bold text-sm">工作消息</span>
            <span className="text-3xs text-blue-600 bg-blue-50 dark:bg-blue-900/30 px-1.5 py-0.5 rounded">
              企业微信互通
            </span>
          </div>
          <div className="p-2 space-y-1 overflow-y-auto flex-1">
            {conversations.map((c) => (
              <div
                key={c.id}
                onClick={() => onSelectConversation?.(c.id, Boolean(c.isGroup))}
                className={`p-2.5 rounded-xl cursor-pointer transition-colors ${
                  c.id === activeConvId
                    ? 'bg-blue-50 dark:bg-blue-950/40 text-blue-600'
                    : 'hover:bg-zinc-100 dark:hover:bg-zinc-800/60'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-semibold truncate text-xs">
                    [项目组] {c.name}
                  </span>
                  <span className="text-[10px] text-zinc-400">14:30</span>
                </div>
                <p className="text-3xs text-zinc-400 truncate mt-1">
                  {c.lastMessage ? camouflageMedia(c.lastMessage) : '点击查看协同进度...'}
                </p>
              </div>
            ))}
          </div>
        </div>

        {/* 右侧主聊天视口 */}
        <div className="flex-1 flex flex-col bg-white dark:bg-[#1a1a1a]">
          <div className="h-12 border-b border-[#dee0e3] dark:border-zinc-800 flex items-center justify-between px-4">
            <div className="flex items-center gap-2">
              <span className="font-bold text-sm">[Q4 技术攻坚] {activeTitle}</span>
              <span className="px-2 py-0.5 rounded-full text-3xs bg-emerald-100 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-400 font-medium">
                进行中 · 敏捷组
              </span>
            </div>
            <span className="text-3xs text-zinc-400">已对齐 OKR 目标</span>
          </div>

          {/* 飞书企业气泡列表 */}
          <div ref={scrollRef} onScroll={trackScroll} className="flex-1 p-4 overflow-y-auto space-y-3 select-text">
            {messages.map((m) => (
              <div key={m.id} data-message-id={m.id} className={`flex gap-2.5 ${m.isMe ? 'flex-row-reverse' : ''}`}>
                <div className={`space-y-1 max-w-[70%] ${m.isMe ? 'items-end' : ''}`}>
                  <div className="text-3xs text-zinc-400 flex items-center gap-2">
                    <span>{m.senderName}</span>
                    <span>{m.timeStr}</span>
                  </div>
                  <div
                    className={`p-3 rounded-2xl text-xs leading-relaxed ${
                      m.isMe
                        ? 'bg-blue-600 text-white rounded-tr-none'
                        : 'bg-[#f2f3f5] dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100 rounded-tl-none'
                    }`}
                  >
                    {renderMessageContent(m)}
                  </div>
                </div>
              </div>
            ))}

          </div>

          {/* 底部飞书富文本输入框 */}
          <div className="p-3 border-t border-[#dee0e3] dark:border-zinc-800 bg-[#f9fafb] dark:bg-[#202124]">
            <form onSubmit={handleSubmit} className="space-y-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="发送给协同同事（Enter 发送，Shift+Enter 换行）..."
                className="w-full px-3 py-2 text-xs bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded-lg outline-none focus:border-blue-500"
                autoFocus
              />
              <div className="flex items-center justify-between gap-2 text-3xs text-zinc-400">
                <span className="truncate">支持 Markdown 与代码块协同</span>
                <div className="flex items-center gap-1 shrink-0">
                  {renderComposerExtras('light', 'up')}
                  <button
                    type="submit" disabled={!canSend}
                    className="px-4 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold transition-colors"
                  >
                    发送
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>
    );
  }

  // ==========================================
  // 4. Excel 电子表格风格 (堪称绝杀！)
  // ==========================================
  if (theme === 'excel') {
    return (
      <div className="fixed inset-0 z-[110] bg-white text-zinc-800 font-sans flex flex-col select-none text-xs">
        {renderFloatingSwitcher()}

        {/* Excel 绿色顶栏 */}
        <div className="h-9 bg-[#107c41] text-white flex items-center justify-between px-3 text-xs">
          <div className="flex items-center gap-3">
            <FileSpreadsheet className="w-4 h-4" />
            <span className="font-bold">2026_Q4_技术资产统计与排期跟踪表.xlsx - Excel</span>
          </div>
          <span className="text-3xs text-emerald-200">自动保存已开启</span>
        </div>

        {/* Excel Ribbon 工具栏 */}
        <div className="h-8 bg-[#f3f2f1] border-b border-zinc-300 flex items-center px-3 gap-4 text-3xs text-zinc-700">
          <span className="font-bold text-[#107c41] border-b-2 border-[#107c41] pb-1">开始</span>
          <span>插入</span>
          <span>页面布局</span>
          <span>公式</span>
          <span>数据</span>
          <span>审阅</span>
          <span>视图</span>
        </div>

        {/* Excel 公式编辑栏 (作为核心输入框！) */}
        <div className="h-9 bg-white border-b border-zinc-300 flex items-center px-3 gap-2">
          <span className="font-mono font-bold text-zinc-500 px-2 py-0.5 border border-zinc-300 bg-zinc-50 rounded text-3xs">
            B{messages.length + 2}
          </span>
          <span className="font-serif italic font-bold text-zinc-400">fx</span>
          <form onSubmit={handleSubmit} className="flex-1 flex items-center gap-2">
            <input
              type="text"
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="=CONCATENATE(单元格数据录入，按 Enter 自动上报至聊天并写入单元格)..."
              className="flex-1 text-xs border border-zinc-300 rounded px-2 py-1 outline-none font-mono focus:border-[#107c41]"
              autoFocus
            />
            {renderComposerExtras('light', 'down')}
            <button
              type="submit" disabled={!canSend}
              className="px-3 py-1 bg-[#107c41] text-white rounded text-3xs font-semibold shrink-0"
            >
              录入
            </button>
          </form>
        </div>

        {/* 电子表格数据矩阵 */}
        <div ref={scrollRef} onScroll={trackScroll} className="flex-1 overflow-auto bg-white">
          <table className="w-full border-collapse text-3xs font-mono">
            <thead>
              <tr className="bg-[#f3f2f1] text-zinc-600 text-center border-b border-zinc-300">
                <th className="w-10 border-r border-zinc-300 py-1"></th>
                <th className="w-20 border-r border-zinc-300 py-1">A (序号)</th>
                <th className="w-32 border-r border-zinc-300 py-1">B (时间戳)</th>
                <th className="w-36 border-r border-zinc-300 py-1">C (经办责任人)</th>
                <th className="w-40 border-r border-zinc-300 py-1">D (会话/群组)</th>
                <th className="border-r border-zinc-300 py-1 text-left px-2">E (业务沟通与执行明细记录)</th>
              </tr>
            </thead>
            <tbody>
              {messages.map((m, idx) => (
                <tr key={m.id} data-message-id={m.id} className="border-b border-zinc-200 hover:bg-emerald-50/40">
                  <td className="bg-[#f3f2f1] text-center text-zinc-500 border-r border-zinc-300 py-1 select-none">
                    {idx + 1}
                  </td>
                  <td className="text-center border-r border-zinc-200 py-1 text-zinc-500">
                    TSK-100{idx + 1}
                  </td>
                  <td className="text-center border-r border-zinc-200 py-1 text-zinc-500">{m.timeStr}</td>
                  <td className="text-center border-r border-zinc-200 py-1 font-semibold text-blue-700">
                    {m.senderName}
                  </td>
                  <td className="text-center border-r border-zinc-200 py-1 text-zinc-600">
                    {activeTitle}
                  </td>
                  <td className="px-2 py-1 text-zinc-900 font-sans text-xs select-text">{renderMessageContent(m)}</td>
                </tr>
              ))}
              {/* 当前正在输入的空白待录入行 */}
              <tr className="bg-emerald-50/20 border-b border-zinc-200">
                <td className="bg-[#f3f2f1] text-center text-zinc-500 border-r border-zinc-300 py-1">
                  {messages.length + 1}
                </td>
                <td className="text-center border-r border-zinc-200 py-1 text-zinc-400">PENDING</td>
                <td className="text-center border-r border-zinc-200 py-1 text-zinc-400">NOW</td>
                <td className="text-center border-r border-zinc-200 py-1 text-emerald-600 font-bold">ME</td>
                <td className="text-center border-r border-zinc-200 py-1 text-zinc-400">{activeTitle}</td>
                <td className="px-2 py-1 text-zinc-400 italic">
                  {inputText ? `[待写入] ${inputText}` : '双击上方公式栏 fx 录入新数据并发送...'}
                </td>
              </tr>
            </tbody>
          </table>

        </div>

        {/* Excel 底部工作表标签条 */}
        <div className="min-h-8 shrink-0 bg-[#f3f2f1] border-t border-zinc-300 flex items-center px-3 gap-2 text-3xs text-zinc-600">
          <nav aria-label="切换群聊" className="flex min-w-0 flex-1 overflow-x-auto">
            {groups.length === 0 && <span className="py-1">暂无群聊</span>}
            {groups.map((group) => (
              <button key={group.id} type="button" aria-current={groupRoomId === group.id ? 'true' : undefined}
                onClick={() => onSelectConversation?.(group.id, true)}
                className={`shrink-0 whitespace-nowrap border-t-2 px-3 py-1 ${groupRoomId === group.id ? 'bg-white border-[#107c41] font-bold text-[#107c41]' : 'border-transparent hover:bg-zinc-200'}`}>
                {group.name}{Boolean(group.unreadCount) && ` (${group.unreadCount})`}
              </button>
            ))}
          </nav>
          <span className="shrink-0">计数={messages.length}</span>
        </div>
      </div>
    );
  }

  // ==========================================
  // 5. Word 办公文档审阅报告风格
  // ==========================================
  if (theme === 'word') {
    return (
      <div className="fixed inset-0 z-[110] bg-[#f3f2f1] text-zinc-900 font-serif flex flex-col select-none text-xs">
        {renderFloatingSwitcher()}

        {/* Word 蓝色顶栏 */}
        <div className="h-9 bg-[#185abd] text-white flex items-center justify-between px-3 text-xs font-sans">
          <div className="flex items-center gap-3">
            <FileText className="w-4 h-4" />
            <span className="font-bold">企业级分布式架构治理与演进实施方案.docx - Word</span>
          </div>
          <span className="text-3xs text-blue-200">审阅批注模式已开启</span>
        </div>

        {/* Word 标尺与主文档页面 (仿 A4 白纸) */}
        <div ref={scrollRef} onScroll={trackScroll} className="flex-1 overflow-auto p-6 flex justify-center bg-[#eae9e8]">
          <div className="w-[800px] min-h-[900px] bg-white shadow-2xl p-12 border border-zinc-300 flex flex-col justify-between">
            <div className="space-y-6">
              <div className="text-center border-b pb-4 border-zinc-300">
                <h1 className="text-xl font-bold font-sans text-zinc-800">
                  关于《{activeTitle}》技术协同与推进情况汇报
                </h1>
                <p className="text-3xs text-zinc-400 font-sans mt-1">
                  密级：内部公开 · 编制部门：技术架构委员会 · 归档时间：2026年11月
                </p>
              </div>

              {/* 正文与审阅批注对话流 */}
              <div className="space-y-4 font-sans text-xs select-text">
                <div className="text-zinc-600 font-semibold border-l-4 border-blue-600 pl-2">
                  第一章节：实时协作通讯与议题跟踪
                </div>

                {messages.map((m) => (
                  <div key={m.id} data-message-id={m.id} className="p-3 bg-zinc-50 border border-zinc-200 rounded-lg space-y-1">
                    <div className="flex items-center justify-between text-3xs text-zinc-400">
                      <span className="font-bold text-blue-700">【批注评审人】@{m.senderName}</span>
                      <span>{m.timeStr}</span>
                    </div>
                    <div className="text-zinc-800 leading-relaxed font-sans">{renderMessageContent(m)}</div>
                  </div>
                ))}

              </div>
            </div>

            {/* Word 底部追加批注输入框 */}
            <form onSubmit={handleSubmit} className="pt-6 border-t border-zinc-200 mt-6 flex gap-2 font-sans">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="在文档末尾追加修订批注并同步到消息群（Enter 发送）..."
                className="flex-1 px-3 py-2 text-xs border border-zinc-300 rounded outline-none focus:border-blue-600"
                autoFocus
              />
              {renderComposerExtras('light', 'up')}
              <button
                type="submit" disabled={!canSend}
                className="px-4 py-2 bg-[#185abd] text-white rounded font-semibold text-xs shrink-0"
              >
                追加批注
              </button>
            </form>
          </div>
        </div>

        {/* Word 底部页码状态栏 */}
        <div className="h-6 bg-white border-t border-zinc-300 flex items-center justify-between px-4 text-3xs text-zinc-500 font-sans">
          <span>第 1 页，共 4 页 · {messages.length * 35} 字</span>
          <span>中文(中国) · 批注模式</span>
        </div>
      </div>
    );
  }

  // ==========================================
  // 6. PowerPoint 幻灯片演讲者模式
  // ==========================================
  if (theme === 'ppt') {
    return (
      <div className="fixed inset-0 z-[110] bg-[#1e1e1e] text-white font-sans flex flex-col select-none text-xs">
        {renderFloatingSwitcher()}

        {/* PPT 橙色顶栏 */}
        <div className="h-9 bg-[#c43e1c] text-white flex items-center justify-between px-3 text-xs">
          <div className="flex items-center gap-3">
            <Presentation className="w-4 h-4" />
            <span className="font-bold">2026年度业务架构战略发布会.pptx - PowerPoint (演讲者视图)</span>
          </div>
          <span className="text-3xs text-orange-200">放映时间: 00:24:15</span>
        </div>

        {/* PPT 主体双屏模式 */}
        <div className="flex-1 flex overflow-hidden p-4 gap-4 bg-[#2b2b2b]">
          {/* 左侧大幻灯片主屏 */}
          <div className="flex-1 bg-black rounded-xl p-8 flex flex-col justify-between border border-zinc-700 shadow-2xl">
            <div className="space-y-4">
              <span className="px-3 py-1 bg-red-600 text-white font-bold text-3xs rounded-full">
                SLIDE 04 / 12
              </span>
              <h2 className="text-2xl font-bold tracking-tight text-zinc-100">
                {activeTitle} · 系统核心攻坚与战略对齐
              </h2>
              <div className="grid grid-cols-2 gap-4 pt-4 text-xs">
                <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                  <h4 className="font-bold text-amber-400 mb-1">关键里程碑</h4>
                  <p className="text-zinc-400 text-3xs leading-relaxed">
                    全面接入云原生服务治理架构，支持实时全双工通讯与秒级无感热升级。
                  </p>
                </div>
                <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800">
                  <h4 className="font-bold text-emerald-400 mb-1">组织协同效能</h4>
                  <p className="text-zinc-400 text-3xs leading-relaxed">
                    跨组无缝对齐，消除沟通壁垒，端到端项目交付提速 300%。
                  </p>
                </div>
              </div>
            </div>
            <div className="text-3xs text-zinc-500">提示：下一张为《Q4核心营收指标测算与财务预测》</div>
          </div>

          {/* 右侧演讲者备注栏 (聊天消息流！) */}
          <div className="w-96 bg-[#1f1f1f] rounded-xl border border-zinc-700 p-4 flex flex-col justify-between">
            <div className="space-y-2 border-b border-zinc-700 pb-2 flex items-center justify-between">
              <span className="font-bold text-xs text-orange-400">演讲者备忘录与团队提词 (Notes)</span>
              <span className="text-3xs text-zinc-400">{messages.length} 条备忘</span>
            </div>

            {/* 备注流 */}
            <div ref={scrollRef} onScroll={trackScroll} className="flex-1 overflow-y-auto space-y-2.5 py-3 select-text">
              {messages.map((m) => (
                <div key={m.id} data-message-id={m.id} className="p-2.5 rounded-lg bg-zinc-800/80 border border-zinc-700 text-xs">
                  <div className="flex items-center justify-between text-3xs text-zinc-400 mb-1">
                    <span className="font-bold text-orange-300">@{m.senderName}</span>
                    <span>{m.timeStr}</span>
                  </div>
                  <div className="text-zinc-200 leading-relaxed font-sans">{renderMessageContent(m)}</div>
                </div>
              ))}

            </div>

            {/* 演讲者实时提词输入框 */}
            <form onSubmit={handleSubmit} className="pt-2 border-t border-zinc-700 flex gap-2">
              <input
                type="text"
                value={inputText}
                onChange={(e) => setInputText(e.target.value)}
                placeholder="录入演讲提词与协同意见（Enter 发送）..."
                className="flex-1 px-3 py-1.5 text-xs bg-zinc-800 border border-zinc-600 rounded text-zinc-100 outline-none focus:border-orange-500"
                autoFocus
              />
              {renderComposerExtras('dark', 'up')}
              <button
                type="submit" disabled={!canSend}
                className="px-3 py-1.5 bg-[#c43e1c] hover:bg-orange-600 text-white rounded font-bold text-xs shrink-0"
              >
                提词
              </button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return null;
};
