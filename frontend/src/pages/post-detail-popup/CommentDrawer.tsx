import React, { useEffect, useState, useRef } from 'react';
import { useImageDrop, DROP_HINT_CLASS } from '../../hooks/useImageDrop';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  ImagePlus,
  MessageSquare,
  X,
  Send,
  Heart,
  CornerDownRight,
  CheckCircle2,
  Sparkles,
  Smile,
  ChevronDown,
  ChevronUp,
  User as UserIcon,
  Filter,
  Trash2,
  Star,
} from 'lucide-react';
import { apiClient } from '../../api/client';
import type { CommentItem, UserProfile } from '../../types';
import { UserAvatar } from '../../components/UserAvatar';
import { LevelBadge } from '../../components/LevelBadge';
import { ReactionPicker, type ReactionCounts } from '../../components/ReactionPicker';
import { EmojiStickerPanel } from '../../components/EmojiStickerPanel';
import { CommentMedia } from '../../components/CommentMedia';
import { EmptyState } from '../../components/EmptyState';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmModal';
import { MentionTextarea } from '../../components/MentionTextarea';
import { ImageLightbox } from '../../components/ImageLightbox';
import { formatEast8Time } from '../../utils/format';
import { registerEsc } from '../../utils/overlay';

export type CommentFontSize = 'sm' | 'base' | 'lg';

interface Props {
  fontSize: CommentFontSize;
  onFontSizeChange: (size: CommentFontSize) => void;
  isOpen: boolean;
  onClose: () => void;
  postId: string;
  postAuthorUsername?: string;
  commentCount: number;
  user: UserProfile | null;
  onRequireAuth: () => void;
  onSelectUser?: (username: string) => void;
  targetCommentId?: string | null;
  onCommentCountChange?: (count: number) => void;
  /** 评论区策略：open / member_only / closed */
  commentPolicy?: string;
  /** 沉浸模式下把同一套评论区直接嵌在正文下方，不再以抽屉弹出 */
  embedded?: boolean;
  /** 正文划词引用：带时间戳，变化时追加到输入框 */
  quoteText?: string | null;
  /** 每次从通知中心点进来都会递增，用于强制重新定位同一条评论 */
  focusSeq?: number;
  /** 外部（底部快速评论）发完评论后递增，触发评论区重新拉取 */
  refreshToken?: number;
  /** 问答广场批量采纳模式 */
  qaSelectMode?: boolean;
  qaSelectedIds?: string[];
  onToggleQaAnswer?: (id: string) => void;
}

const formatMentions = (text: string) => {
  const parts = text.split(/(@[a-zA-Z0-9_\u4e00-\u9fa5]+)/g);
  return parts.map((part, i) => {
    if (part.startsWith('@')) {
      return (
        <span key={i} className="text-wb-text-primary font-semibold hover:underline inline-block mx-0.5">
          {part}
        </span>
      );
    }
    return part;
  });
};

const ExpandableCommentContent: React.FC<{
  content: string;
  maxChars?: number;
  className?: string;
}> = ({ content, maxChars = 160, className = '' }) => {
  const [expanded, setExpanded] = useState(false);
  const isLong = content.length > maxChars || (content.match(/\n/g) || []).length >= 3;

  if (!isLong) {
    return <p className={`leading-relaxed whitespace-pre-wrap ${className}`}>{formatMentions(content)}</p>;
  }

  const displayText = expanded ? content : content.slice(0, maxChars).trim();

  return (
    <div className={className}>
      <span className="leading-relaxed whitespace-pre-wrap">
        {formatMentions(displayText)}
        {!expanded && '...'}
      </span>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setExpanded(!expanded);
        }}
        className="inline-flex items-center gap-0.5 text-wb-brand font-medium hover:underline ml-1.5 text-2xs select-none cursor-pointer"
      >
        <span>{expanded ? '收起' : '展开全文'}</span>
      </button>
    </div>
  );
};

export const CommentDrawer: React.FC<Props> = ({
  fontSize: commentFontSize,
  onFontSizeChange: setCommentFontSize,
  isOpen,
  onClose,
  postId,
  postAuthorUsername,
  commentCount,
  onSelectUser,
  targetCommentId,
  onCommentCountChange,
  user,
  commentPolicy = 'open',
  embedded = false,
  quoteText,
  onRequireAuth,
  focusSeq = 0,
  refreshToken = 0,
  qaSelectMode = false,
  qaSelectedIds = [],
  onToggleQaAnswer,
}) => {
  const toast = useToast();
  const confirm = useConfirm();

  // 权限：作者本人 / 版务可以管理评论
  const isStaff = Boolean(user && ['super_admin', 'admin', 'moderator'].includes(user.role));
  const isPostAuthor = Boolean(user && postAuthorUsername && user.username === postAuthorUsername);
  const canModerate = isStaff || isPostAuthor;
  const commentsClosed = commentPolicy === 'closed';

  const commentTextSize = { sm: 'text-xs', base: 'text-[0.8125rem]', lg: 'text-sm' }[commentFontSize];
  const [comments, setComments] = useState<CommentItem[]>([]);
  const [loading, setLoading] = useState<boolean>(false);
  // 首屏评论是否已经真正拉完：在此之前不能判定「目标评论不存在」
  const [commentsLoaded, setCommentsLoaded] = useState(false);
  const [commentPage, setCommentPage] = useState(1);
  const [hasMoreComments, setHasMoreComments] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  // 评论深链定位：短暂高亮目标评论
  const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
  const handledTargetRef = useRef<string>('');
  const scheduledTargetRef = useRef<string>('');
  const targetSearchPagesRef = useRef(0);
  const loadMoreReqIdRef = useRef(0);
  const lastFocusSeqRef = useRef(focusSeq);
  // 定位相关定时器：只在整个组件卸载时统一清理。
  // 之前把 cleanup 挂在定位 effect 上，依赖一变就把任务取消、标记已处理，
  // 结果高亮永远不出现；这里改成独立的卸载清理。
  const locateTimerRef = useRef<number | null>(null);
  const locateRetryRef = useRef<number | null>(null);
  const highlightTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (locateTimerRef.current) window.clearTimeout(locateTimerRef.current);
      if (locateRetryRef.current) window.clearTimeout(locateRetryRef.current);
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
    },
    []
  );
  const [commentSort, setCommentSort] = useState<'featured' | 'latest' | 'hot'>('featured');
  const [authorOnly, setAuthorOnly] = useState<boolean>(false);
  const [expandedReplies, setExpandedReplies] = useState<Record<string, boolean>>({});

  // 底部吸底主输入框
  // 主评论草稿按文章存进 sessionStorage：切换沉浸模式会卸载/重建评论区，
  // 纯内存状态会整段丢失；刷新误触也能保住未发送内容。
  const [mainContent, setMainContent] = useState<string>(() => {
    try {
      return sessionStorage.getItem(`wb:commentDraft:${postId}`) || '';
    } catch {
      return '';
    }
  });
  useEffect(() => {
    try {
      if (mainContent.trim()) sessionStorage.setItem(`wb:commentDraft:${postId}`, mainContent);
      else sessionStorage.removeItem(`wb:commentDraft:${postId}`);
    } catch {}
  }, [mainContent, postId]);
  // 评论配图：单条最多一张（图片或自定义表情）
  const [mainImage, setMainImage] = useState<{ url: string; kind: 'photo' | 'sticker' } | null>(null);
  const [mainImageUploading, setMainImageUploading] = useState(false);
  // 抽屉内部的大图预览（不依赖外部 lightbox）
  const [lightboxSrc, setLightboxSrc] = useState<string | null>(null);
  // 就地回复也可以只发一张图 / 表情
  const [inlineReplyImage, setInlineReplyImage] = useState<{ url: string; kind: 'photo' | 'sticker' } | null>(null);
  const [inlineReplyUploading, setInlineReplyUploading] = useState(false);
  const [mainAnonymous, setMainAnonymous] = useState<boolean>(false);
  const [mainSubmitting, setMainSubmitting] = useState<boolean>(false);
  const [showMainEmojiPicker, setShowMainEmojiPicker] = useState<boolean>(false);
  const mainTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 就地内联楼层回复
  const [inlineReplyId, setInlineReplyId] = useState<string | null>(null);
  const [inlineReplyParentId, setInlineReplyParentId] = useState<string | null>(null);
  const [inlineReplyTargetAuthor, setInlineReplyTargetAuthor] = useState<string>('');
  const [inlineReplyContent, setInlineReplyContent] = useState<string>('');
  const [inlineReplyAnonymous, setInlineReplyAnonymous] = useState<boolean>(false);
  const [inlineReplySubmitting, setInlineReplySubmitting] = useState<boolean>(false);
  const [showInlineEmojiPicker, setShowInlineEmojiPicker] = useState<boolean>(false);
  const inlineReplyTextareaRef = useRef<HTMLTextAreaElement | null>(null);

  // 表情互动状态
  const [commentReactions, setCommentReactions] = useState<Record<string, ReactionCounts>>({});
  const [commentUserReactions, setCommentUserReactions] = useState<Record<string, string[]>>({});

  // 监听 Esc 快捷键关闭抽屉
  useEffect(() => {
    if (!isOpen) return;
    return registerEsc('comment-drawer', onClose);
  }, [isOpen, onClose]);

  // 正文划词「引用到评论」：把引文追加到主输入框并聚焦
  const lastQuoteStampRef = useRef<string>('');
  useEffect(() => {
    if (!quoteText) return;
    const sep = quoteText.indexOf('|');
    if (sep < 0) return;
    const stamp = quoteText.slice(0, sep);
    const text = quoteText.slice(sep + 1);
    if (lastQuoteStampRef.current === stamp) return;
    lastQuoteStampRef.current = stamp;
    setMainContent((prev) => text + prev);
    window.setTimeout(() => mainTextareaRef.current?.focus(), 120);
  }, [quoteText]);

  // 打开抽屉（或沉浸模式挂载）时拉取评论第一页
  useEffect(() => {
    if ((!isOpen && !embedded) || !postId) return;
    // 每次重拉第一页都作废旧的分页请求，避免旧第 2 页追加重叠
    loadMoreReqIdRef.current += 1;
    const fetchComments = async () => {
      setLoading(true);
      setCommentsLoaded(false);
      try {
        const res = await apiClient.get(`/comments/post/${postId}`, { params: { page: 1, size: 20 } });
        if (Array.isArray(res.data)) {
          setComments(res.data);
          setCommentPage(1);
          setHasMoreComments(res.data.length >= 20);
        }
      } catch {
        toast.info('加载讨论失败，请重试');
      } finally {
        setLoading(false);
        setCommentsLoaded(true);
      }
    };
    fetchComments();
  }, [isOpen, embedded, postId, refreshToken]);

  // 加载更早的评论（分页，不再是一次性只拿 50 条）
  const handleLoadMoreComments = async () => {
    if (loadingMore || !hasMoreComments) return;
    setLoadingMore(true);
    const reqId = ++loadMoreReqIdRef.current;
    try {
      const next = commentPage + 1;
      const res = await apiClient.get(`/comments/post/${postId}`, { params: { page: next, size: 20 } });
      if (reqId !== loadMoreReqIdRef.current) return;
      if (Array.isArray(res.data)) {
        setComments((prev) => {
          const seen = new Set(prev.map((c) => c.id));
          return [...prev, ...res.data.filter((c: any) => !seen.has(c.id))];
        });
        setCommentPage(next);
        setHasMoreComments(res.data.length >= 20);
      }
    } catch {
      toast.info('加载更多评论失败');
    } finally {
      setLoadingMore(false);
    }
  };

  // 通知中心重复点击同一条评论时，重置定位标记，允许再次跳转
  useEffect(() => {
    if (lastFocusSeqRef.current === focusSeq) return;
    lastFocusSeqRef.current = focusSeq;
    handledTargetRef.current = '';
    scheduledTargetRef.current = '';
    targetSearchPagesRef.current = 0;
  }, [focusSeq]);

  // 评论深链定位：从通知中心 / 分享链接带 targetCommentId 进来时，
  // 找到目标（必要时自动翻页）、展开楼中楼、滚动到可视区并短暂高亮。
  // 弹出抽屉与沉浸模式共用这套逻辑。
  useEffect(() => {
    if (!targetCommentId || (!isOpen && !embedded) || loading || !commentsLoaded) return;
    if (handledTargetRef.current === targetCommentId) return;
    // 已经排过一次定位任务就不要重复排；注意这里不能给 effect 加 cleanup
    // 去 clearTimeout，否则 comments/loading 变化会把任务取消且标记已处理，高亮永远不出现。
    if (scheduledTargetRef.current === targetCommentId) return;

    let rootId: string | null = null;
    for (const c of comments) {
      if (c.id === targetCommentId) { rootId = c.id; break; }
      if (c.replies?.some((r) => r.id === targetCommentId)) { rootId = c.id; break; }
    }

    if (!rootId) {
      if (hasMoreComments && !loadingMore && targetSearchPagesRef.current < 10) {
        targetSearchPagesRef.current += 1;
        handleLoadMoreComments();
      } else if (!loadingMore) {
        handledTargetRef.current = targetCommentId;
        scheduledTargetRef.current = targetCommentId;
        toast.info('该评论可能已被删除，或在更早的记录里');
      }
      return;
    }

    // 目标是楼中楼时，先把所属主楼的回复全部展开
    setExpandedReplies((prev) => (prev[rootId!] ? prev : { ...prev, [rootId!]: true }));
    scheduledTargetRef.current = targetCommentId;
    targetSearchPagesRef.current = 0;

    const locate = (retry: number) => {
      const el = document.getElementById(`comment-${targetCommentId}`);
      if (!el) {
        if (retry > 0) {
          locateRetryRef.current = window.setTimeout(() => locate(retry - 1), 400);
        }
        return;
      }
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightedCommentId(targetCommentId);
      handledTargetRef.current = targetCommentId;
      if (highlightTimerRef.current) window.clearTimeout(highlightTimerRef.current);
      highlightTimerRef.current = window.setTimeout(
        () => setHighlightedCommentId((cur) => (cur === targetCommentId ? null : cur)),
        2600
      );
    };
    if (locateTimerRef.current) window.clearTimeout(locateTimerRef.current);
    locateTimerRef.current = window.setTimeout(() => locate(2), 350);
  }, [targetCommentId, isOpen, embedded, comments, loading, commentsLoaded, hasMoreComments, loadingMore, focusSeq]);

  // 展开主楼的全部回复：首屏只带 2 条，其余的按需拉取
  const loadAllReplies = async (rootId: string) => {
    const target = comments.find((c) => c.id === rootId);
    const total = target?.reply_total ?? target?.replies.length ?? 0;
    if (target && target.replies.length >= total) return;
    try {
      const res = await apiClient.get(`/comments/${rootId}/replies`);
      if (Array.isArray(res.data)) {
        setComments((prev) =>
          prev.map((c) =>
            c.id === rootId ? { ...c, replies: res.data, reply_total: res.data.length } : c
          )
        );
      }
    } catch {
      toast.info('加载回复失败，请重试');
    }
  };

  // 删除评论：作者本人 / 版务可用，软删除保留楼中楼
  const handleDeleteComment = async (commentId: string) => {
    if (!user) return onRequireAuth();
    const ok = await confirm({
      title: '删除评论',
      description: '确定删除此条评论吗？此操作不可撤销。',
      confirmText: '确定删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/comments/${commentId}`);
      const markDeleted = (list: CommentItem[]): CommentItem[] =>
        list.map((c) =>
          c.id === commentId
            ? { ...c, is_deleted: true, content: '' }
            : { ...c, replies: c.replies?.length ? markDeleted(c.replies) : c.replies }
        );
      setComments((prev) => markDeleted(prev));
      onCommentCountChange?.(Math.max(0, commentCount - 1));
      toast.success('评论已删除');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '删除失败');
    }
  };

  // 设为 / 取消精选（作者置顶）
  const handleToggleFeatured = async (commentId: string) => {
    if (!user) return onRequireAuth();
    try {
      const res = await apiClient.put(`/comments/${commentId}/featured`);
      const { is_featured } = res.data;
      setComments((prev) => prev.map((c) => (c.id === commentId ? { ...c, is_featured } : c)));
      toast.info(is_featured ? '已设为精选评论' : '已取消精选');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '操作失败');
    }
  };

  // 采纳 / 取消最佳答案
  const handleToggleAccept = async (commentId: string) => {
    if (!user) return onRequireAuth();
    try {
      const res = await apiClient.put(`/comments/${commentId}/accept`);
      const { is_accepted } = res.data;
      setComments((prev) =>
        prev.map((c) => ({ ...c, is_accepted: c.id === commentId ? is_accepted : false }))
      );
      toast.info(is_accepted ? '已采纳为最佳解答' : '已取消采纳');
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || '操作失败');
    }
  };

  const toggleReplies = (commentId: string) => {
    setExpandedReplies((prev) => {
      const willExpand = !prev[commentId];
      // 展开时若本地只有预览的 2 条，先把剩余回复拉回来
      if (willExpand) void loadAllReplies(commentId);
      return { ...prev, [commentId]: willExpand };
    });
  };

  // 图片上传：粘贴与拖拽共用同一条链路，行为完全一致
  const uploadImageFile = async (
    file: File,
    apply: (img: { url: string; kind: 'photo' }) => void,
    setUploading: (v: boolean) => void
  ) => {
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/posts/upload-image', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.url) apply({ url: res.data.url, kind: 'photo' });
    } catch (err: any) {
      toast.info(err?.response?.data?.detail || '图片上传失败');
    } finally {
      setUploading(false);
    }
  };

  // 粘贴图片：主评论与就地回复共用
  const handlePasteImage = (
    e: React.ClipboardEvent<HTMLTextAreaElement>,
    apply: (img: { url: string; kind: 'photo' }) => void,
    setUploading: (v: boolean) => void
  ) => {
    const file = Array.from(e.clipboardData.files).find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    void uploadImageFile(file, apply, setUploading);
  };

  // 拖拽上传：按当前激活的输入区（楼中楼 / 主评论）决定落到哪张配图
  const imageDrop = useImageDrop((file) => {
    if (inlineReplyId) {
      void uploadImageFile(file, setInlineReplyImage, setInlineReplyUploading);
    } else {
      void uploadImageFile(file, setMainImage, setMainImageUploading);
    }
  });

  const handleInsertMainEmoji = (emoji: string) => {
    const targetRef = mainTextareaRef.current;
    if (targetRef) {
      const start = targetRef.selectionStart ?? mainContent.length;
      const end = targetRef.selectionEnd ?? mainContent.length;
      const before = mainContent.slice(0, start);
      const after = mainContent.slice(end);
      const next = before + emoji + after;
      setMainContent(next);
      setTimeout(() => {
        targetRef.focus();
        const cursor = start + emoji.length;
        targetRef.setSelectionRange(cursor, cursor);
      }, 0);
    } else {
      setMainContent((prev) => prev + emoji);
    }
    setShowMainEmojiPicker(false);
  };

  const handleInsertInlineEmoji = (emoji: string) => {
    const targetRef = inlineReplyTextareaRef.current;
    if (targetRef) {
      const start = targetRef.selectionStart ?? inlineReplyContent.length;
      const end = targetRef.selectionEnd ?? inlineReplyContent.length;
      const before = inlineReplyContent.slice(0, start);
      const after = inlineReplyContent.slice(end);
      const next = before + emoji + after;
      setInlineReplyContent(next);
      setTimeout(() => {
        targetRef.focus();
        const cursor = start + emoji.length;
        targetRef.setSelectionRange(cursor, cursor);
      }, 0);
    } else {
      setInlineReplyContent((prev) => prev + emoji);
    }
    setShowInlineEmojiPicker(false);
  };

  const toggleInlineReply = (authorName: string, mainCommentId: string, replyCardId: string) => {
    if (!user) return onRequireAuth();
    if (inlineReplyId === replyCardId) {
      setInlineReplyId(null);
      setInlineReplyContent('');
      setInlineReplyImage(null);
      setShowInlineEmojiPicker(false);
      return;
    }
    setInlineReplyId(replyCardId);
    setInlineReplyParentId(mainCommentId);
    setInlineReplyTargetAuthor(authorName);
    setInlineReplyContent(`@${authorName} `);
    setShowInlineEmojiPicker(false);
  };

  // 回复框渲染后把光标移到「@某人 」之后，符合回消息的直觉
  useEffect(() => {
    if (!inlineReplyId) return;
    const el = inlineReplyTextareaRef.current;
    if (!el) return;
    el.focus();
    const end = el.value.length;
    el.setSelectionRange(end, end);
  }, [inlineReplyId]);

  // 发送主楼评论
  const handleSendMainComment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    if (commentsClosed) {
      toast.info('作者已关闭本文章的评论区');
      return;
    }
    // 允许只发一张图/表情
    if (!mainContent.trim() && !mainImage) return;
    setMainSubmitting(true);
    try {
      const res = await apiClient.post('/comments', {
        post_id: postId,
        content: mainContent.trim(),
        is_anonymous: mainAnonymous,
        ...(mainImage ? { image_url: mainImage.url, image_kind: mainImage.kind } : {}),
      });
      const newComment = res.data;
      setComments((prev) => [newComment, ...prev]);
      setMainContent('');
      setMainImage(null);
      onCommentCountChange?.(commentCount + 1);
      toast.info('评论发表成功！');
    } catch (err: any) {
      toast.info(err.response?.data?.detail || '评论发表失败');
    } finally {
      setMainSubmitting(false);
    }
  };

  // 发送楼层就地回复
  const handleSendInlineReply = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return onRequireAuth();
    if (!inlineReplyContent.trim() && !inlineReplyImage) return;
    setInlineReplySubmitting(true);
    try {
      const res = await apiClient.post('/comments', {
        post_id: postId,
        parent_id: inlineReplyParentId,
        content: inlineReplyContent.trim(),
        is_anonymous: inlineReplyAnonymous,
        ...(inlineReplyImage ? { image_url: inlineReplyImage.url, image_kind: inlineReplyImage.kind } : {}),
      });
      const newReply = res.data;
      setComments((prev) =>
        prev.map((c) => {
          if (c.id === inlineReplyParentId) {
            return {
              ...c,
              replies: [...(c.replies || []), newReply],
            };
          }
          return c;
        })
      );
      setInlineReplyId(null);
      setInlineReplyContent('');
      onCommentCountChange?.(commentCount + 1);
      toast.info(`已回复 @${inlineReplyTargetAuthor}！`);
    } catch (err: any) {
      toast.info(err.response?.data?.detail || '回复失败');
    } finally {
      setInlineReplySubmitting(false);
    }
  };

  // 同一条评论的点赞请求串行化，快速双击不会发出两个相互打架的请求
  const likePendingRef = useRef<Set<string>>(new Set());
  const handleCommentLike = async (commentId: string) => {
    if (!user) return onRequireAuth();
    if (likePendingRef.current.has(commentId)) return;
    likePendingRef.current.add(commentId);
    try {
      const res = await apiClient.post(`/comments/${commentId}/like`);
      const isLiked = Boolean(res.data?.is_liked);
      // 直接用服务端返回的真实计数，不再本地 ±1（并发时会越加越多）
      const realCount =
        typeof res.data?.like_count === 'number' ? res.data.like_count : null;
      const patch = (x: CommentItem): CommentItem => ({
        ...x,
        is_liked: isLiked,
        ...(realCount !== null ? { like_count: realCount } : {}),
      });
      setComments((prev) =>
        prev.map((c) => {
          if (c.id === commentId) return patch(c);
          if (c.replies?.some((r) => r.id === commentId)) {
            return { ...c, replies: c.replies.map((r) => (r.id === commentId ? patch(r) : r)) };
          }
          return c;
        })
      );
    } catch {
      toast.info('点赞操作失败');
    } finally {
      likePendingRef.current.delete(commentId);
    }
  };

  const handleToggleReaction = async (commentId: string, emoji: string) => {
    const curUser = commentUserReactions[commentId] || [];
    const hasReacted = curUser.includes(emoji);
    const nextUser = hasReacted ? curUser.filter((e) => e !== emoji) : [...curUser, emoji];
    const curCounts = commentReactions[commentId] || {};
    const nextCounts = {
      ...curCounts,
      [emoji]: Math.max(0, (curCounts[emoji] || 0) + (hasReacted ? -1 : 1)),
    };
    setCommentUserReactions((prev) => ({ ...prev, [commentId]: nextUser }));
    setCommentReactions((prev) => ({ ...prev, [commentId]: nextCounts }));
  };

  // 排序与筛选
  const filteredComments = comments
    .filter((c) => {
      if (authorOnly && postAuthorUsername) {
        return c.author_username === postAuthorUsername;
      }
      return true;
    })
    .sort((a, b) => {
      if (commentSort === 'featured') {
        if (a.is_accepted !== b.is_accepted) return a.is_accepted ? -1 : 1;
        if (a.is_featured !== b.is_featured) return a.is_featured ? -1 : 1;
        return (b.like_count || 0) - (a.like_count || 0);
      }
      if (commentSort === 'hot') {
        return (b.like_count || 0) - (a.like_count || 0);
      }
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });

  const renderInlineReplyBox = (cardId: string) => {
    if (inlineReplyId !== cardId) return null;

    return (
      <form
        onSubmit={handleSendInlineReply}
        className="mt-2.5 p-3 rounded-2xl bg-white dark:bg-[#181a20] border-2 border-wb-brand/40 shadow-xl space-y-2.5 animate-fade-in ring-1 ring-wb-brand/20"
      >
        <div className="flex items-center justify-between text-2xs text-wb-text-secondary pb-1 border-b border-wb-border-subtle">
          <span className="flex items-center gap-1.5 font-semibold text-wb-brand">
            <CornerDownRight className="w-3.5 h-3.5" />
            <span>就地回复 @{inlineReplyTargetAuthor}</span>
          </span>
          <button
            type="button"
            onClick={() => setInlineReplyId(null)}
            className="text-wb-text-muted hover:text-wb-danger px-1.5 py-0.5 rounded text-2xs transition-colors"
          >
            ✕ 取消
          </button>
        </div>
        <textarea
          ref={inlineReplyTextareaRef}
          autoFocus
          rows={2}
          {...imageDrop.handlers}
          value={inlineReplyContent}
          onChange={(e) => setInlineReplyContent(e.target.value)}
          onPaste={(e) => handlePasteImage(e, setInlineReplyImage, setInlineReplyUploading)}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              handleSendInlineReply(e);
            }
          }}
          placeholder={`写下你对 @${inlineReplyTargetAuthor} 的回复... (Ctrl+Enter 发送，可粘贴图片)`}
          className={`w-full p-2.5 text-xs bg-wb-bg-subtle border rounded-xl focus:outline-none text-wb-text-primary resize-none placeholder:text-wb-text-muted transition-colors ${imageDrop.dragging ? 'border-wb-brand border-2 bg-wb-brand/5' : 'border-wb-border-subtle focus:border-wb-border-strong'}`}
        />
        {imageDrop.dragging && (
          <p className="text-3xs text-wb-brand font-semibold">松开即可上传回复配图（与粘贴上传一致）</p>
        )}

        {inlineReplyImage && (
          <div className="relative inline-block">
            <img
              src={inlineReplyImage.url}
              alt=""
              className={`w-16 h-16 rounded-lg border border-wb-border-subtle ${
                inlineReplyImage.kind === 'sticker' ? 'object-contain' : 'object-cover'
              }`}
            />
            <button
              type="button"
              onClick={() => setInlineReplyImage(null)}
              title="移除图片"
              className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-wb-text-primary text-wb-bg-page flex items-center justify-center shadow"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )}
        <div className="flex items-center justify-between pt-0.5">
          <div className="flex items-center gap-2">
            <div className="relative">
              <button
                type="button"
                onClick={() => setShowInlineEmojiPicker((prev) => !prev)}
                title="插入常用与极客表情"
                className="wb-pressable flex items-center gap-1 text-2xs text-wb-text-secondary hover:text-wb-text-primary px-2 py-0.5 rounded-lg hover:bg-wb-bg-subtle transition-colors cursor-pointer border border-transparent hover:border-wb-border-subtle"
              >
                <Smile className="w-3.5 h-3.5 text-wb-warn/90" />
                <span>表情</span>
              </button>
              <EmojiStickerPanel
                isOpen={showInlineEmojiPicker}
                onClose={() => setShowInlineEmojiPicker(false)}
                onSelectEmoji={handleInsertInlineEmoji}
                onSelectSticker={(url) => {
                  setInlineReplyImage({ url, kind: 'sticker' });
                  setShowInlineEmojiPicker(false);
                }}
              />
            </div>
            <label
              title="添加一张图片"
              className={`wb-pressable flex items-center gap-1 whitespace-nowrap shrink-0 text-2xs text-wb-text-secondary hover:text-wb-text-primary px-2 py-1 rounded-lg hover:bg-wb-bg-subtle transition-colors cursor-pointer border border-transparent hover:border-wb-border-subtle ${
                inlineReplyUploading ? 'opacity-50 pointer-events-none' : ''
              }`}
            >
              {inlineReplyUploading ? (
                <span className="w-3.5 h-3.5 border-2 border-wb-text-muted border-t-transparent rounded-full animate-spin" />
              ) : (
                <ImagePlus className="w-3.5 h-3.5 text-wb-success/90" />
              )}
              <span>{inlineReplyUploading ? '上传中' : '图片'}</span>
              <input
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  setInlineReplyUploading(true);
                  try {
                    const fd = new FormData();
                    fd.append('file', file);
                    const res = await apiClient.post('/posts/upload-image', fd, {
                      headers: { 'Content-Type': 'multipart/form-data' },
                    });
                    if (res.data?.url) setInlineReplyImage({ url: res.data.url, kind: 'photo' });
                  } catch (err: any) {
                    toast.info(err?.response?.data?.detail || '图片上传失败');
                  } finally {
                    setInlineReplyUploading(false);
                  }
                }}
              />
            </label>

            <label className="flex items-center gap-1 text-2xs text-wb-text-secondary select-none cursor-pointer">
              <input
                type="checkbox"
                checked={inlineReplyAnonymous}
                onChange={(e) => setInlineReplyAnonymous(e.target.checked)}
                className="rounded border-wb-border-strong text-wb-text-primary focus:ring-0 text-xs"
              />
              <span>匿名</span>
            </label>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-3xs text-wb-text-muted font-mono hidden sm:inline">Ctrl+Enter</span>
            <button
              type="submit"
              disabled={inlineReplySubmitting}
              className="wb-pressable inline-flex items-center gap-1 px-3 py-1 rounded-capsule bg-wb-brand text-white text-xs font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm"
            >
              <Send className="w-3 h-3" />
              <span>{inlineReplySubmitting ? '发送中...' : '发送回复'}</span>
            </button>
          </div>
        </div>
      </form>
    );
  };

  // 评论配图预览：与聊天、正文共用同一套滚轮缩放组件
  const lightbox = <ImageLightbox src={lightboxSrc} onClose={() => setLightboxSrc(null)} />;

  // 评论面板本体：弹出抽屉与沉浸模式共用同一份实现
  const panelBody = (
    <>
            {/* 抽屉头部 */}
            <div className="p-4 sm:p-5 border-b border-wb-border-subtle flex items-center justify-between shrink-0 bg-wb-bg-surface/60">
              <div className="flex items-center gap-2.5">
                <div className="p-1.5 rounded-xl bg-wb-brand/10 text-wb-brand">
                  <MessageSquare className="w-4 h-4" />
                </div>
                <div>
                  <h2 className="font-bold text-sm text-wb-text-primary flex items-center gap-2">
                    <span>讨论与评论中心</span>
                    <span className="text-xs text-wb-text-muted font-normal font-mono">
                      ({commentCount} 条讨论)
                    </span>
                  </h2>
                </div>
              </div>

              {!embedded && (
                <div className="flex items-center gap-2">
                  <span className="text-3xs text-wb-text-muted font-mono hidden sm:inline px-1.5 py-0.5 rounded border border-wb-border-subtle bg-wb-bg-subtle">
                    ESC 关闭
                  </span>
                  <button
                    type="button"
                    onClick={onClose}
                    className="wb-pressable p-1.5 text-wb-text-muted hover:text-wb-text-primary rounded-xl hover:bg-wb-bg-subtle transition-colors"
                    title="关闭讨论抽屉"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              )}
            </div>

            {/* 抽屉筛选控制条 */}
            <div className="px-4 py-2.5 border-b border-wb-border-subtle/70 bg-wb-bg-surface/30 flex items-center justify-between gap-3 text-xs shrink-0 flex-wrap">
              {/* 排序分段控件 */}
              <div className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs">
                {(
                  [
                    { key: 'featured', label: '精选' },
                    { key: 'hot', label: '最热' },
                    { key: 'latest', label: '最新' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setCommentSort(tab.key)}
                    className={`px-3 py-1 rounded-capsule font-medium transition-all ${
                      commentSort === tab.key
                        ? 'bg-wb-text-primary text-wb-bg-page font-bold shadow-xs'
                        : 'text-wb-text-secondary hover:text-wb-text-primary'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div role="group" aria-label="评论字号" className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-mono shadow-sm">
                {(['sm', 'base', 'lg'] as const).map((size, index) => (
                  <button
                    key={size}
                    type="button"
                    aria-pressed={commentFontSize === size}
                    onClick={() => setCommentFontSize(size)}
                    className={`px-2 py-0.5 rounded-capsule transition-all ${
                      commentFontSize === size
                        ? 'bg-wb-text-primary text-wb-bg-page font-bold shadow-sm'
                        : 'text-wb-text-muted hover:text-wb-text-primary'
                    }`}
                  >
                    {['A-', 'A', 'A+'][index]}
                  </button>
                ))}
              </div>

              {/* 只看楼主开关 */}
              {postAuthorUsername && (
                <button
                  type="button"
                  onClick={() => setAuthorOnly(!authorOnly)}
                  className={`wb-pressable inline-flex items-center gap-1.5 px-3 py-1 rounded-capsule text-2xs font-semibold border transition-all ${
                    authorOnly
                      ? 'bg-wb-brand text-white border-transparent shadow-xs'
                      : 'border-wb-border-subtle text-wb-text-secondary hover:border-wb-border-strong bg-wb-bg-subtle/50'
                  }`}
                >
                  <Filter className="w-3 h-3" />
                  <span>只看楼主</span>
                </button>
              )}
            </div>

            {/* 评论列表区域 */}
            <div className="flex-1 overflow-y-auto overscroll-contain p-4 space-y-3">
              {loading ? (
                <div className="py-20 text-center text-xs text-wb-text-muted animate-pulse">
                  正在同步最新讨论...
                </div>
              ) : filteredComments.length === 0 ? (
                <div className="border border-dashed border-wb-border-subtle rounded-2xl my-6">
                  <EmptyState
                    compact
                    icon={<MessageSquare strokeWidth={1.5} />}
                    title={authorOnly ? '楼主尚未发表评论' : '还没有人留言，来说两句吧'}
                  />
                </div>
              ) : (
                filteredComments.map((item, idx) => {
                  const isPostAuthor = item.author_username && postAuthorUsername === item.author_username;
                  return (
                    <div
                      key={item.id}
                      id={`comment-${item.id}`}
                      className={`group/comment p-3 rounded-2xl border transition-all space-y-1.5 ${
                        highlightedCommentId === item.id
                          ? 'border-wb-warn/60 bg-wb-warn/10 ring-2 ring-wb-warn/60 shadow-lg'
                          : item.is_accepted
                          ? 'border-wb-success/50 bg-wb-success/[0.04]'
                          : 'border-wb-border-subtle bg-wb-bg-subtle/60 hover:border-wb-border-strong/60'
                      }`}
                    >
                      {qaSelectMode && !item.is_deleted && item.author_username !== user?.username && (
                        <button
                          type="button"
                          onClick={() => onToggleQaAnswer?.(item.id)}
                          className={`w-full mb-1.5 h-7 rounded-capsule border text-3xs font-semibold inline-flex items-center justify-center gap-1.5 transition-colors ${
                            (qaSelectedIds || []).includes(item.id)
                              ? 'bg-wb-success text-white border-transparent'
                              : 'bg-wb-bg-surface border-wb-border-subtle text-wb-text-secondary hover:border-wb-success'
                          }`}
                        >
                          {(qaSelectedIds || []).includes(item.id) ? '✓ 已选为采纳答案（点击取消）' : '选为采纳答案'}
                        </button>
                      )}
                      {item.is_deleted ? (
                        <div className="py-1.5 flex items-center gap-1.5 text-xs text-wb-text-muted italic">
                          <span className="text-3xs font-mono px-1 py-0.2 rounded bg-wb-bg-surface border border-wb-border-subtle shrink-0">
                            #{idx + 1}楼
                          </span>
                          <Trash2 className="w-3.5 h-3.5 opacity-50 shrink-0" />
                          <span>该评论已被删除</span>
                        </div>
                      ) : (
                        <>
                      {/* 楼层 Header */}
                      <div className="flex items-center justify-between text-xs gap-2">
                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                          <span className="text-3xs text-wb-text-muted font-mono px-1 py-0.2 rounded bg-wb-bg-surface border border-wb-border-subtle shrink-0">
                            #{idx + 1}楼
                          </span>
                          {item.is_anonymous ? (
                            <span className="font-semibold text-wb-text-primary flex items-center gap-1 truncate text-xs">
                              <UserIcon className="w-3.5 h-3.5 text-wb-text-muted shrink-0" />
                              <span className="truncate">{item.anonymous_alias || '神秘极客'}</span>
                            </span>
                          ) : (
                            <div
                              onClick={() => item.author_username && onSelectUser?.(item.author_username)}
                              className="inline-flex items-center gap-1 cursor-pointer hover:opacity-80 transition-opacity group/cauthor min-w-0"
                            >
                              <UserAvatar
                                username={item.author_username}
                                avatarUrl={item.author_avatar}
                                size={18}
                              />
                              <span className="font-medium text-wb-text-primary group-hover/cauthor:underline truncate text-xs">
                                {item.author_nickname || item.author_username}
                              </span>
                              {item.author_level !== undefined && <LevelBadge level={item.author_level} size="sm" />}
                            </div>
                          )}
                          {isPostAuthor && !item.is_anonymous && (
                            <span className="text-3xs px-1 py-0.2 rounded bg-wb-text-primary/10 text-wb-text-primary font-bold shrink-0">
                              楼主
                            </span>
                          )}
                          {highlightedCommentId === item.id && (
                            <span className="text-3xs px-1.5 py-0.2 rounded-capsule bg-wb-warn/20 text-wb-warn border border-wb-warn/40 font-semibold shrink-0">
                              通知中的评论
                            </span>
                          )}
                          {item.is_accepted && (
                            <span className="text-3xs px-1.5 py-0.2 rounded-capsule bg-wb-success/15 text-wb-success border border-wb-success/25 font-bold inline-flex items-center gap-0.5 shrink-0">
                              <CheckCircle2 className="w-2.5 h-2.5" />
                              最佳解答
                            </span>
                          )}
                          {item.is_featured && (
                            <span className="text-3xs px-1.5 py-0.2 rounded-capsule bg-wb-text-primary text-wb-bg-page font-semibold inline-flex items-center gap-0.5 shrink-0">
                              <Sparkles className="w-2 h-2 fill-current" />
                              作者精选
                            </span>
                          )}
                        </div>

                        <div className="flex items-center gap-1.5 shrink-0">
                          {/* 管理操作放在右上角、悬停才出现，避免和底部「回复」挤在一起误点 */}
                          {!item.is_deleted && canModerate && (
                            <>
                              <button
                                type="button"
                                onClick={() => handleToggleFeatured(item.id)}
                                className={`opacity-0 group-hover/comment:opacity-100 max-sm:opacity-70 p-1.5 rounded-lg transition-colors ${
                                  item.is_featured ? 'text-wb-warn' : 'text-wb-text-muted hover:text-wb-warn'
                                }`}
                                title={item.is_featured ? '取消精选' : '设为精选'}
                              >
                                <Star className={`w-4 h-4 ${item.is_featured ? 'fill-current' : ''}`} />
                              </button>
                              <button
                                type="button"
                                onClick={() => handleToggleAccept(item.id)}
                                className={`opacity-0 group-hover/comment:opacity-100 max-sm:opacity-70 p-1.5 rounded-lg transition-colors ${
                                  item.is_accepted ? 'text-wb-success' : 'text-wb-text-muted hover:text-wb-success'
                                }`}
                                title={item.is_accepted ? '取消最佳解答' : '采纳为最佳解答'}
                              >
                                <CheckCircle2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                          {!item.is_deleted && (isStaff || (user && item.author_username === user.username)) && (
                            <button
                              type="button"
                              onClick={() => handleDeleteComment(item.id)}
                              className="opacity-0 group-hover/comment:opacity-100 max-sm:opacity-70 p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger transition-colors"
                              title="删除评论"
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                          <span className="text-3xs text-wb-text-muted font-mono">
                            {formatEast8Time(item.created_at)}
                          </span>
                        </div>
                      </div>

                      {/* 评论内容 */}
                      <ExpandableCommentContent
                        content={item.content}
                        maxChars={160}
                        className={`${commentTextSize} text-wb-text-primary leading-relaxed py-0.5`}
                      />

                      {item.image_url && (
                        <CommentMedia url={item.image_url} kind={item.image_kind} onOpen={setLightboxSrc} />
                      )}

                      {/* 底部操作条 */}
                      <div className="flex items-center justify-between pt-1 border-t border-wb-border-subtle/40 text-xs">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => handleCommentLike(item.id)}
                            className={`wb-pressable inline-flex items-center gap-1 px-1.5 py-0.5 rounded-capsule border text-2xs transition-colors ${
                              item.is_liked
                                ? 'bg-wb-text-primary text-wb-bg-page border-transparent font-semibold'
                                : 'border-wb-border-subtle hover:border-wb-border-strong text-wb-text-secondary hover:text-wb-text-primary bg-wb-bg-surface/50'
                            }`}
                          >
                            <Heart className={`w-3 h-3 ${item.is_liked ? 'fill-current' : ''}`} />
                            <span>{item.like_count > 0 ? item.like_count : '赞'}</span>
                          </button>

                          <ReactionPicker
                            targetId={item.id}
                            reactions={commentReactions[item.id] || {}}
                            userReactions={commentUserReactions[item.id] || []}
                            onToggleReaction={(emoji) => handleToggleReaction(item.id, emoji)}
                          />
                        </div>

                        <button
                          type="button"
                          onClick={() =>
                            toggleInlineReply(
                              item.is_anonymous ? (item.anonymous_alias || '匿名极客') : (item.author_nickname || item.author_username || '极客'),
                              item.id,
                              item.id
                            )
                          }
                          className={`wb-pressable inline-flex items-center gap-0.5 text-2xs transition-colors px-1.5 py-0.5 rounded hover:bg-wb-bg-surface ${
                            inlineReplyId === item.id ? 'text-wb-brand font-bold bg-wb-brand/10' : 'text-wb-text-muted hover:text-wb-text-primary'
                          }`}
                        >
                          <CornerDownRight className="w-2.5 h-2.5" />
                          <span>{inlineReplyId === item.id ? '取消回复' : '回复'}</span>
                        </button>
                      </div>

                      {/* 主楼就地回复框 */}
                      {renderInlineReplyBox(item.id)}

                        </>
                      )}

                      {/* 楼中楼：主楼被删也保留完整互动，不锁死跟评 */}
                      {/* 楼中楼回复 */}
                      {item.replies && item.replies.length > 0 && (
                        <div className="mt-2 p-2 sm:p-2.5 rounded-xl bg-wb-bg-surface/75 border border-wb-border-subtle/50 space-y-2">
                          {(() => {
                            const isExpanded = Boolean(expandedReplies[item.id]);
                            const visibleReplies = isExpanded ? item.replies : item.replies.slice(0, 2);
      
                            return (
                              <>
                                {visibleReplies.map((reply, rIdx) => {
                                  const isReplyAuthorPostAuthor = reply.author_username && postAuthorUsername === reply.author_username;
                                  if (reply.is_deleted) {
                                    return (
                                      <div key={reply.id} id={`comment-${reply.id}`} className="py-1 text-wb-text-muted text-2xs italic flex items-center gap-1.5">
                                        <Trash2 className="w-3 h-3 opacity-50 shrink-0" />
                                        <span>该回复已被删除</span>
                                      </div>
                                    );
                                  }
                                  return (
                                    <div
                                      key={reply.id}
                                      id={`comment-${reply.id}`}
                                      className={`text-xs space-y-1 rounded-lg transition-all ${
                                        rIdx > 0 ? 'pt-2 border-t border-wb-border-subtle/35' : ''
                                      } ${
                                        highlightedCommentId === reply.id
                                          ? 'ring-2 ring-wb-warn/60 bg-wb-warn/10 p-1.5'
                                          : ''
                                      }`}
                                    >
                                      {/* 子楼 Header */}
                                      <div className="flex items-center justify-between text-2xs gap-1.5">
                                        <div className="flex items-center gap-1.5 flex-wrap min-w-0">
                                          {highlightedCommentId === reply.id && (
                                            <span className="text-3xs px-1 py-0.2 rounded-capsule bg-wb-warn/20 text-wb-warn border border-wb-warn/40 font-semibold shrink-0">
                                              通知中的评论
                                            </span>
                                          )}
                                          {reply.is_anonymous ? (
                                            <span className="font-semibold text-wb-text-primary text-2xs">
                                              {reply.anonymous_alias || '匿名极客'}
                                            </span>
                                          ) : (
                                            <div
                                              onClick={() => reply.author_username && onSelectUser?.(reply.author_username)}
                                              className="inline-flex items-center gap-1 cursor-pointer hover:opacity-85 transition-opacity group/rauthor"
                                            >
                                              <UserAvatar
                                                username={reply.author_username}
                                                avatarUrl={reply.author_avatar}
                                                size={16}
                                              />
                                              <span className="font-semibold text-wb-text-primary group-hover/rauthor:underline text-2xs">
                                                {reply.author_nickname || reply.author_username}
                                              </span>
                                              {reply.author_level !== undefined && (
                                                <LevelBadge level={reply.author_level} size="sm" />
                                              )}
                                            </div>
                                          )}
                                          {isReplyAuthorPostAuthor && !reply.is_anonymous && (
                                            <span className="text-3xs px-1 py-0.2 rounded bg-wb-text-primary/10 text-wb-text-primary font-bold">
                                              楼主
                                            </span>
                                          )}
                                        </div>

                                        <div className="flex items-center gap-1 shrink-0">
                                          {!reply.is_deleted && (isStaff || (user && reply.author_username === user.username)) && (
                                            <button
                                              type="button"
                                              onClick={() => handleDeleteComment(reply.id)}
                                              className="p-1.5 rounded-lg text-wb-text-muted hover:text-wb-danger transition-colors"
                                              title="删除评论"
                                            >
                                              <Trash2 className="w-4 h-4" />
                                            </button>
                                          )}
                                          <span className="text-3xs text-wb-text-muted font-mono">
                                            {formatEast8Time(reply.created_at)}
                                          </span>
                                        </div>
                                      </div>

                                      {/* 子楼内容 */}
                                      <ExpandableCommentContent
                                        content={reply.content}
                                        maxChars={120}
                                        className={`${commentTextSize} text-wb-text-primary leading-normal pl-5`}
                                      />

                                      {reply.image_url && (
                                        <div className="pl-5">
                                          <CommentMedia url={reply.image_url} kind={reply.image_kind} onOpen={setLightboxSrc} />
                                        </div>
                                      )}

                                      {/* 子楼底部快捷操作 */}
                                      <div className="flex items-center justify-between pl-5 pt-0.5 text-2xs text-wb-text-muted">
                                        <button
                                          type="button"
                                          onClick={() => handleCommentLike(reply.id)}
                                          className={`wb-pressable inline-flex items-center gap-1 px-1.5 py-0.2 rounded border text-3xs transition-colors ${
                                            reply.is_liked
                                              ? 'bg-wb-text-primary text-wb-bg-page border-transparent font-semibold shadow-xs'
                                              : 'border-wb-border-subtle hover:border-wb-border-strong text-wb-text-muted hover:text-wb-text-primary bg-wb-bg-surface/50'
                                          }`}
                                        >
                                          <Heart className={`w-2.5 h-2.5 ${reply.is_liked ? 'fill-current' : ''}`} />
                                          <span>{reply.like_count > 0 ? reply.like_count : '赞'}</span>
                                        </button>

                                        <button
                                          type="button"
                                          onClick={() =>
                                            toggleInlineReply(
                                              reply.is_anonymous ? (reply.anonymous_alias || '匿名极客') : (reply.author_nickname || reply.author_username || '极客'),
                                              item.id,
                                              reply.id
                                            )
                                          }
                                          className={`wb-pressable inline-flex items-center gap-0.5 text-3xs transition-colors ${
                                            inlineReplyId === reply.id ? 'text-wb-brand font-bold' : 'text-wb-text-muted hover:text-wb-text-primary'
                                          }`}
                                        >
                                          <CornerDownRight className="w-2.5 h-2.5" />
                                          <span>{inlineReplyId === reply.id ? '取消' : '回复'}</span>
                                        </button>
                                      </div>

                                      {/* 子楼就地回复框 */}
                                      {renderInlineReplyBox(reply.id)}
                                    </div>
                                  );
                                })}

                                {(item.reply_total ?? item.replies.length) > 2 && (
                                  <div className="pt-0.5 pl-5">
                                    <button
                                      type="button"
                                      onClick={() => toggleReplies(item.id)}
                                      className="wb-pressable inline-flex items-center gap-1 text-3xs font-medium text-wb-text-secondary hover:text-wb-text-primary py-0.5 px-2 rounded-md bg-wb-bg-subtle hover:bg-wb-bg-surface border border-wb-border-subtle transition-all cursor-pointer"
                                    >
                                      {isExpanded ? (
                                        <>
                                          <ChevronUp className="w-3 h-3 text-wb-text-muted" />
                                          <span>收起跟帖讨论</span>
                                        </>
                                      ) : (
                                        <>
                                          <ChevronDown className="w-3 h-3 text-wb-text-muted" />
                                          <span>展开全部 {item.reply_total ?? item.replies.length} 条回复</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                )}
                              </>
                            );
                          })()}
                        </div>
                      )}
                    </div>
                  );
                })
              )}

              {hasMoreComments && (
                <div className="pt-1 pb-2 flex justify-center">
                  <button
                    type="button"
                    onClick={handleLoadMoreComments}
                    disabled={loadingMore}
                    className="px-4 py-1.5 rounded-capsule text-2xs font-semibold border border-wb-border-subtle bg-wb-bg-surface text-wb-text-secondary hover:border-wb-border-strong hover:text-wb-text-primary transition-colors disabled:opacity-50"
                  >
                    {loadingMore ? '加载中…' : '加载更多评论'}
                  </button>
                </div>
              )}
            </div>

            {/* 评论区策略提示 */}
            {commentsClosed && (
              <div className="px-3 py-2 border-t border-wb-border-subtle bg-wb-warn/10 text-2xs text-wb-text-secondary">
                作者已关闭本文章的评论区，暂不能发表评论
              </div>
            )}

            {/* 抽屉底部吸底输入框 (抽屉模式核心体验优化：随时随地输入，不被滚动吞没) */}
            <form
              onSubmit={handleSendMainComment}
              {...imageDrop.handlers}
              className="p-3 sm:p-4 border-t border-wb-border-subtle bg-wb-bg-surface/90 backdrop-blur-md shrink-0 space-y-2 shadow-up relative"
            >
              {imageDrop.dragging && (
                <div className={DROP_HINT_CLASS}>
                  <ImagePlus className="w-4 h-4" /> 松开即可上传评论配图
                </div>
              )}
              <MentionTextarea
                textareaRef={mainTextareaRef}
                rows={2}
                value={mainContent}
                onChange={setMainContent}
                disabled={commentsClosed || mainAnonymous}
                required={!mainImage}
                onPaste={(e) => handlePasteImage(e, setMainImage, setMainImageUploading)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
                    e.preventDefault();
                    handleSendMainComment(e);
                  }
                }}
                placeholder="真诚交流，输入 @ 可提及站内用户... (Ctrl+Enter 快捷发送)"
                className="w-full p-2.5 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-xl focus:outline-none focus:border-wb-border-strong text-wb-text-primary resize-none placeholder:text-wb-text-muted transition-colors"
              />

              {/* 已选配图预览 */}
              {mainImage && (
                <div className="relative inline-block">
                  <img
                    src={mainImage.url}
                    alt=""
                    className={`w-16 h-16 rounded-lg border border-wb-border-subtle ${
                      mainImage.kind === 'sticker' ? 'object-contain' : 'object-cover'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setMainImage(null)}
                    title="移除图片"
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-wb-text-primary text-wb-bg-page flex items-center justify-center shadow"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              )}

              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="relative">
                    <button
                      type="button"
                      onClick={() => setShowMainEmojiPicker((prev) => !prev)}
                      title="插入表情"
                      className="wb-pressable flex items-center gap-1 text-2xs text-wb-text-secondary hover:text-wb-text-primary px-2 py-1 rounded-lg hover:bg-wb-bg-subtle transition-colors cursor-pointer border border-transparent hover:border-wb-border-subtle"
                    >
                      <Smile className="w-3.5 h-3.5 text-wb-warn/90" />
                      <span>表情</span>
                    </button>
                    <EmojiStickerPanel
                      isOpen={showMainEmojiPicker}
                      onClose={() => setShowMainEmojiPicker(false)}
                      onSelectEmoji={handleInsertMainEmoji}
                      onSelectSticker={(url) => {
                        setMainImage({ url, kind: 'sticker' });
                        setShowMainEmojiPicker(false);
                      }}
                    />
                  </div>

                  <label
                    title="添加一张图片"
                    className={`wb-pressable flex items-center gap-1 whitespace-nowrap shrink-0 text-2xs text-wb-text-secondary hover:text-wb-text-primary px-2 py-1 rounded-lg hover:bg-wb-bg-subtle transition-colors cursor-pointer border border-transparent hover:border-wb-border-subtle ${
                      mainImageUploading ? 'opacity-50 pointer-events-none' : ''
                    }`}
                  >
                    {mainImageUploading ? (
                      <span className="w-3.5 h-3.5 border-2 border-wb-text-muted border-t-transparent rounded-full animate-spin" />
                    ) : (
                      <ImagePlus className="w-3.5 h-3.5 text-wb-success/90" />
                    )}
                    <span>{mainImageUploading ? '上传中' : '图片'}</span>
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={async (e) => {
                        const file = e.target.files?.[0];
                        e.target.value = '';
                        if (!file) return;
                        setMainImageUploading(true);
                        try {
                          const fd = new FormData();
                          fd.append('file', file);
                          const res = await apiClient.post('/posts/upload-image', fd, {
                            headers: { 'Content-Type': 'multipart/form-data' },
                          });
                          if (res.data?.url) setMainImage({ url: res.data.url, kind: 'photo' });
                        } catch (err: any) {
                          toast.info(err?.response?.data?.detail || '图片上传失败');
                        } finally {
                          setMainImageUploading(false);
                        }
                      }}
                    />
                  </label>

                  <label className="flex items-center gap-1 text-2xs text-wb-text-secondary select-none cursor-pointer">
                    <input
                      type="checkbox"
                      checked={mainAnonymous}
                      onChange={(e) => setMainAnonymous(e.target.checked)}
                      className="rounded border-wb-border-strong text-wb-text-primary focus:ring-0 text-xs"
                    />
                    <span>匿名发表</span>
                  </label>
                </div>

                <div className="flex items-center gap-2">
                  <span className="text-3xs text-wb-text-muted font-mono hidden sm:inline">Ctrl+Enter</span>
                  <button
                    type="submit"
                    disabled={mainSubmitting || (!mainContent.trim() && !mainImage)}
                    className="wb-pressable inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold hover:opacity-90 disabled:opacity-50 shadow-sm"
                  >
                    <Send className="w-3.5 h-3.5" />
                    <span>{mainSubmitting ? '发送中...' : '发表跟帖'}</span>
                  </button>
                </div>
              </div>
            </form>
    </>
  );

  if (embedded) {
    return (
      <>
        <div
          className="rounded-3xl border border-wb-border-subtle bg-wb-bg-elevated overflow-hidden flex flex-col"
          style={{ height: '72vh' }}
        >
          {panelBody}
        </div>
        {lightbox}
      </>
    );
  }

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeOut' }}
          data-overlay="1"
          role="dialog"
          aria-modal="true"
          aria-label="讨论与评论中心"
          className="fixed inset-0 z-[100] flex justify-end bg-black/50 backdrop-blur-xs"
          onClick={(e) => {
            if (e.target === e.currentTarget) onClose();
          }}
        >
          <motion.div
            initial={{ x: '100%' }}
            animate={{ x: 0 }}
            exit={{ x: '100%' }}
            transition={{ duration: 0.26, ease: [0.32, 0.72, 0, 1] }}
            className="w-full sm:max-w-lg md:max-w-xl lg:max-w-2xl h-full frost-panel flex flex-col will-change-transform bg-wb-bg-elevated dark:bg-slate-900 border-l border-wb-border-subtle shadow-2xl relative"
          >
            {panelBody}
          </motion.div>
        </motion.div>
      )}
      {lightbox}
    </AnimatePresence>,
    document.body
  );
};
