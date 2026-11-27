import { CommentDrawer, type CommentFontSize } from './CommentDrawer';
import React, { useEffect, useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { ArrowLeft, ArrowUp, SmilePlus, Clock, SlidersHorizontal, Tag, Heart, Eye, ShieldAlert, BarChart3, Bookmark, Share2, Edit3, Trash2, Archive, CornerDownRight, Pin, Lock, Unlock, Maximize2, Minimize2, Sparkles, ExternalLink, ChevronDown, MessageSquare, Quote, Copy, RefreshCw, ListFilter, ChevronRight, ImagePlus } from 'lucide-react';
import { apiClient } from '../../api/client';
import { trimUrlEnding } from '../../components/ExternalLinkModal';
import { thumbUrl, thumbSrcSet } from '../../utils/thumb';
import { Modal } from '../../components/Modal';
import type { PostDetail as PostDetailType, CommentItem, PollDetail, UserProfile } from '../../types';
import { LevelBadge } from '../../components/LevelBadge';
import { CodeBlock } from '../../components/CodeBlock';
import { UserAvatar } from '../../components/UserAvatar';
import { PostShareModal } from '../../components/PostShareModal';
import { TableOfContents } from '../../components/TableOfContents';
import { RelatedPosts } from '../../components/RelatedPosts';
import { MentionTextarea } from '../../components/MentionTextarea';
import { ReadingProgressBar } from '../../components/ReadingProgressBar';
import { FoodTopic } from '../../components/FoodTopic';
import { ReactionPicker, REACTION_LIST, type ReactionCounts } from '../../components/ReactionPicker';
import { PostDetailSkeleton } from '../../components/Skeleton';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmModal';
import { GitHubRepoCard, parseGitHubRepo } from '../../components/GitHubRepoCard';
import { formatEast8Date, formatEast8Full, getSmartDailyTitle } from '../../utils/format';
import { addReadingHistory, removeReadingHistoryItem } from '../../utils/history';
import { createHeadingIdFactory, headingTextFromChildren } from '../../utils/heading';
import { mdTableComponents } from '../../utils/mdComponents';
import { useScrollVisibility } from '../../hooks/useScrollVisibility';
import { buildTocFromMarkdown } from '../../utils/heading';
import { ImageLightbox } from '../../components/ImageLightbox';
import { SafeImage } from '../../components/SafeImage';
import { QaBountyCard, type QaState } from '../../components/QaBountyCard';
import { acquireScrollLock } from '../../utils/overlay';
import { readPosition, savePosition } from '../../utils/readingPosition';
import { openCollectionModal, onCollectionChanged } from '../../utils/collection';
import { AddToSeriesButton } from '../../components/AddToSeriesButton';
import { MobileTocSheet } from '../../components/MobileTocSheet';


// 旧内嵌评论区专用组件已移除，统一由 CommentDrawer 承担

export interface PostDetailPopupProps {
  postId: string;
  targetCommentId?: string | null;
  commentFocusSeq?: number;
  commentsAutoOpenToken?: number | null;
  onConsumeAutoOpen?: () => void;
  user: UserProfile | null;
  onBack: () => void;
  onSelectPost?: (postId: string) => void;
  onRequireAuth: () => void;
  onSelectUser?: (username: string) => void;
  onToggleMode?: () => void;
}

export const PostDetailPopup: React.FC<PostDetailPopupProps> = ({ postId, targetCommentId, commentFocusSeq = 0, commentsAutoOpenToken = null, onConsumeAutoOpen, user, onBack, onRequireAuth, onSelectUser, onSelectPost, onToggleMode }) => {
  const confirm = useConfirm();
  const [post, setPost] = useState<PostDetailType | null>(null);
  // 'notfound' = 确实不存在/无权；'network' = 请求失败（可重试），二者不能混为一谈
  const [loadError, setLoadError] = useState<'notfound' | 'network' | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const scrollHidden = useScrollVisibility();

  const [comments, setComments] = useState<CommentItem[]>([]);
  const [, setCommentPage] = useState(1);
  const [, setCommentsHasMore] = useState(false);
  const [poll, setPoll] = useState<PollDetail | null>(null);
  const [selectedPollOptions, setSelectedPollOptions] = useState<number[]>([]);
  const votingRef = useRef(false);
  const [zenMode, setZenMode] = useState(false);
  // 沉浸模式下隐藏顶部导航与底部导航条，避免与「返回 / 退出沉浸」按钮重叠
  useEffect(() => {
    try {
      document.body.classList.toggle('zen-active', zenMode);
      // 沉浸模式正文由 window 滚动，根节点也要用可拖拽的阅读滚动条
      document.documentElement.classList.toggle('reader-scrollbar', zenMode);
    } catch {}
    return () => {
      try {
        document.body.classList.remove('zen-active');
        document.documentElement.classList.remove('reader-scrollbar');
      } catch {}
    };
  }, [zenMode]);
  const [lightboxImage, setLightboxImage] = useState<{ src: string; alt?: string } | null>(null);
  // 内联快速评论：点底栏就地写，不再滚动到评论区
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickText, setQuickText] = useState('');
  const [quickSending, setQuickSending] = useState(false);
  const quickInputRef = useRef<HTMLTextAreaElement | null>(null);
  // 软键盘占位高度：键盘弹起时评论栏要让位
  const [kbOffset, setKbOffset] = useState(0);
  // 是否已滚到评论区：到评论区后评论栏让位给底部 Tab 栏，避免两层悬浮叠加
  const [atComments, setAtComments] = useState(false);
  // 手机端目录面板（与正文布局解耦）
  const [mobileTocOpen, setMobileTocOpen] = useState(false);
  const tocCount = React.useMemo(() => buildTocFromMarkdown(post?.content_md || '').length, [post?.content_md]);
  const [lightboxIdx, setLightboxIdx] = useState(0);
  // 正文里的插图集合，供灯箱左右切换
  const gallery = useMemo(() => {
    const md = post?.content_md || '';
    const fromMd = Array.from(md.matchAll(/!\[([^\]]*)\]\(([^)\s]+)/g)).map((m) => ({
      src: m[2],
      alt: (m[1] || '').trim(),
    }));
    // 九宫格相册也要进图集：否则点开相册图后没有「上一张 / 下一张」
    const fromGrid = ((post as any)?.image_urls || []).map((url: string) => ({ src: url, alt: '' }));
    const seen = new Set<string>();
    return [...fromGrid, ...fromMd].filter((item) => {
      if (!item.src || seen.has(item.src)) return false;
      seen.add(item.src);
      return true;
    });
  }, [post?.content_md, (post as any)?.image_urls]);

  const openLightbox = (src: string, alt?: string) => {
    if (!src) return;
    const idx = gallery.findIndex((g) => g.src === src);
    setLightboxIdx(idx >= 0 ? idx : 0);
    setLightboxImage({ src, alt });
  };

  const stepLightbox = (delta: number) => {
    if (gallery.length < 2) return;
    const next = (lightboxIdx + delta + gallery.length) % gallery.length;
    setLightboxIdx(next);
    setLightboxImage({ src: gallery[next].src, alt: gallery[next].alt });
    // 预加载再下一张，连续左右切换时不会白屏
    const ahead = gallery[(next + delta + gallery.length) % gallery.length];
    if (ahead) new Image().src = ahead.src;
  };
  // 键盘弹起时一并隐藏，避免评论栏压在输入法上
  const barHidden = scrollHidden || kbOffset > 0 || atComments;



  // 给正文标题补锚点 id：目录组件与正文必须共用 buildTocFromMarkdown 的同一套 id 规则，
  // 否则点击目录项 getElementById 取不到节点，表现为"点了没反应"。
  useEffect(() => {
    if (!post?.content_md) return;
    const items = buildTocFromMarkdown(post.content_md);
    if (!items.length) return;
    const nodes = document.querySelectorAll<HTMLElement>('.prose h2, .prose h3');
    nodes.forEach((el, i) => {
      if (items[i]) el.id = items[i].id;
    });
  }, [post?.content_md, post?.id]);

  // 键盘弹起检测：visualViewport 高度缩水即为软键盘
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const diff = window.innerHeight - vv.height;
      setKbOffset(diff > 120 ? diff : 0);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // 滚到底时通知底栏回来（离开页面时复位）
  useEffect(() => {
    let last = false;
    const check = () => {
      const nearBottom =
        window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 140;
      if (nearBottom !== last) {
        last = nearBottom;
        setAtComments(nearBottom);
        window.dispatchEvent(new CustomEvent('geek:article-bottom', { detail: nearBottom }));
      }
    };
    check();
    window.addEventListener('scroll', check, { passive: true });
    return () => {
      window.removeEventListener('scroll', check);
      window.dispatchEvent(new CustomEvent('geek:article-bottom', { detail: false }));
    };
  }, []);

  // 评论草稿本地保存：误触遮罩关掉后内容不丢
  useEffect(() => {
    if (!quickOpen) return;
    try {
      const saved = localStorage.getItem(`geek:quickComment:${postId}`);
      if (saved) setQuickText((prev) => prev || saved);
    } catch {}
  }, [quickOpen, postId]);

  useEffect(() => {
    try {
      if (quickText) localStorage.setItem(`geek:quickComment:${postId}`, quickText);
    } catch {}
  }, [quickText, postId]);

  // 打开内联评论时自动聚焦并拉起键盘
  useEffect(() => {
    if (!quickOpen) return;
    const t = window.setTimeout(() => quickInputRef.current?.focus(), 120);
    return () => window.clearTimeout(t);
  }, [quickOpen]);

  const handleQuickSubmit = async () => {
    if (!user) return onRequireAuth();
    const text = quickText.trim();
    if (!text) return;
    setQuickSending(true);
    try {
      await apiClient.post('/comments', {
        post_id: postId,
        content: text,
        is_anonymous: isAnonymous,
      });
      // 计数统一以服务端为准，不再本地 +1（避免与抽屉回调叠加/回退）
      void fetchDetail();
      setQuickText('');
      setQuickOpen(false);
      // 评论区由 CommentDrawer 独立维护，这里只能通过令牌让它重新拉取；
      // 同时打开抽屉，用户能立刻看到自己刚发的评论
      setCommentsRefreshToken((n) => n + 1);
      if (!zenMode) setCommentDrawerOpen(true);
      try {
        localStorage.removeItem(`geek:quickComment:${postId}`);
      } catch {}
      showToast('评论已发布');
    } catch (err: any) {
      showToast(err.response?.data?.detail || '发送失败，请重试');
    } finally {
      setQuickSending(false);
    }
  };

  // 移动端手势右滑返回 (Swipe Back) 状态与判定
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const [swipeProgress, setSwipeProgress] = useState<number>(0);

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 1) {
      const touch = e.touches[0];
      // 仅当触摸从屏幕最左边缘 (<= 45px) 发起时才激活，避免与正文内横向滚动/选择文字冲突
      if (touch.clientX <= 45) {
        touchStartRef.current = {
          x: touch.clientX,
          y: touch.clientY,
          time: Date.now(),
        };
      } else {
        touchStartRef.current = null;
      }
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (!touchStartRef.current || e.touches.length !== 1) return;
    const touch = e.touches[0];
    const diffX = touch.clientX - touchStartRef.current.x;
    const diffY = touch.clientY - touchStartRef.current.y;

    // 垂直偏差过大时放弃手势判定，交由系统自然上下滚动
    if (Math.abs(diffY) > 55 && diffX < 40) {
      touchStartRef.current = null;
      setSwipeProgress(0);
      return;
    }

    if (diffX > 8) {
      const progress = Math.min(1, Math.max(0, diffX / 90));
      setSwipeProgress(progress);
    } else {
      setSwipeProgress(0);
    }
  };

  const handleTouchEnd = (e: React.TouchEvent) => {
    if (!touchStartRef.current) return;
    const touch = e.changedTouches[0];
    const diffX = touch.clientX - touchStartRef.current.x;
    const diffY = touch.clientY - touchStartRef.current.y;
    const elapsed = Date.now() - touchStartRef.current.time;

    touchStartRef.current = null;
    setSwipeProgress(0);

    // 判定条件：向右滑行超过 65px，垂直偏离不超过 75px，且耗时在 700ms 内完成
    if (diffX >= 65 && Math.abs(diffY) <= 75 && elapsed < 700) {
      onBack();
    }
  };

  // 自动沉淀阅读历史足迹
  useEffect(() => {
    if (post && post.id) {
      addReadingHistory({
        id: String(post.id),
        title: post.title,
        author_username: post.author_username,
        author_nickname: post.author_nickname,
        author_avatar: post.author_avatar,
        category_name: post.category_name,
        reading_time_minutes: post.reading_time_minutes,
      });
    }
  }, [post?.id, post?.title]);

  // 评论定位由 CommentDrawer 的 targetCommentId 自行处理

  const scrollToComments = () => {
    const el = document.getElementById('comments-section');
    if (el) {
      el.scrollIntoView({ behavior: 'smooth' });
      setTimeout(() => {
        const textarea = el.querySelector('textarea');
        if (textarea) textarea.focus();
      }, 400);
    }
  };
  
  const [quoteTooltip, setQuoteTooltip] = useState<{
    text: string;
    x: number;
    y: number;
  } | null>(null);

  useEffect(() => {
    const handleMouseUp = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setQuoteTooltip(null);
        return;
      }

      const selectedText = selection.toString().trim();
      if (!selectedText || selectedText.length < 2) {
        setQuoteTooltip(null);
        return;
      }

      const anchorNode = selection.anchorNode;
      const el = anchorNode?.nodeType === Node.ELEMENT_NODE ? (anchorNode as HTMLElement) : anchorNode?.parentElement;
      if (!el || !el.closest('article')) {
        setQuoteTooltip(null);
        return;
      }

      try {
        const range = selection.getRangeAt(0);
        const rect = range.getBoundingClientRect();
        if (rect && rect.width > 0) {
          setQuoteTooltip({
            text: selectedText,
            x: rect.left + rect.width / 2,
            y: rect.top - 8,
          });
        }
      } catch {
        setQuoteTooltip(null);
      }
    };

    const handleSelectionChange = () => {
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        setQuoteTooltip(null);
      }
    };

    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  const handleQuoteToComment = () => {
    if (!quoteTooltip) return;
    const cleanQuote = quoteTooltip.text.replace(/\n+/g, ' ').slice(0, 300);
    const quote = `> ${cleanQuote}\n\n`;
    // 评论区已统一为 CommentDrawer：引文通过 prop 传进去，不再写入本地状态
    setQuoteForComment(`${Date.now()}|${quote}`);
    if (!zenMode) setCommentDrawerOpen(true);
    setQuoteTooltip(null);
    window.getSelection()?.removeAllRanges();
    toast.info('已引用到评论框');
  };

  const handleCopyQuote = async () => {
    if (!quoteTooltip || !post) return;
    const cleanQuote = quoteTooltip.text;
    const title = getSmartDailyTitle(post.title, post.content_md);
    const quoteText = `> ${cleanQuote}\n\n—— 选自 @${post.author_username}《${title}》\n${window.location.origin}?post=${post.id}`;
    try {
      await navigator.clipboard.writeText(quoteText);
      toast.success('已复制引文与出处！');
    } catch {}
    setQuoteTooltip(null);
    window.getSelection()?.removeAllRanges();
  };
  
  const toast = useToast();
  // 问答广场：悬赏状态 + 批量采纳选择
  const [qaState, setQaState] = useState<QaState | null>(null);
  const [qaSelectMode, setQaSelectMode] = useState(false);
  const [qaSelected, setQaSelected] = useState<string[]>([]);
  const loadQaState = async () => {
    try {
      const r = await apiClient.get(`/qa/posts/${postId}`);
      setQaState(r.data?.is_qa ? r.data : null);
    } catch { setQaState(null); }
  };
  const toggleQaAnswer = (id: string) => {
    setQaSelected((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= (qaState?.max_accepted || 5)) { toast.warning('已达到最多采纳人数'); return prev; }
      return [...prev, id];
    });
  };
  // 评论输入
  const [quoteForComment, setQuoteForComment] = useState<string | null>(null);
  const [isAnonymous] = useState(false);

  // 表情插入已由 CommentDrawer 内的统一面板承担

  // 沉浸阅读模式与排版字号

  const [fontSize, setFontSize] = useState<'sm' | 'base' | 'lg'>('base');
  const [commentFontSize, setCommentFontSize] = useState<CommentFontSize>('base');


  // 极客互动表情反应（服务端持久化：所有访客看到同一份统计）
  const [postReactions, setPostReactions] = useState<ReactionCounts>({});
  const [postUserReactions, setPostUserReactions] = useState<string[]>([]);
  const [reactingPost, setReactingPost] = useState(false);

  useEffect(() => {
    if (!postId) return;
    apiClient
      .get('/reactions/summary', { params: { target_type: 'post', target_id: postId } })
      .then((res) => {
        setPostReactions(res.data?.counts || {});
        setPostUserReactions(res.data?.user_reactions || []);
      })
      .catch(() => {});
  }, [postId]);

  const handleTogglePostReaction = async (emoji: string) => {
    if (!user) return onRequireAuth();
    if (reactingPost) return;
    const hasReacted = postUserReactions.includes(emoji);
    const prevCounts = postReactions;
    const prevMine = postUserReactions;

    // 乐观更新
    setPostUserReactions(hasReacted ? prevMine.filter((e) => e !== emoji) : [...prevMine, emoji]);
    setPostReactions({
      ...prevCounts,
      [emoji]: Math.max(0, (prevCounts[emoji] || 0) + (hasReacted ? -1 : 1)),
    });

    setReactingPost(true);
    try {
      const res = await apiClient.post('/reactions/toggle', {
        target_type: 'post',
        target_id: postId,
        emoji,
      });
      setPostReactions(res.data?.counts || {});
      setPostUserReactions(res.data?.user_reactions || []);
      showToast(res.data?.toggled ? `已添加 ${emoji} 反应` : `已取消 ${emoji} 反应`);
    } catch (err: any) {
      setPostReactions(prevCounts);
      setPostUserReactions(prevMine);
      showToast(err.response?.data?.detail || '表情反应失败，请稍后重试');
    } finally {
      setReactingPost(false);
    }
  };

  const [, setCommentReactions] = useState<Record<string, ReactionCounts>>({});
  const [, setCommentUserReactions] = useState<Record<string, string[]>>({});

  // 评论列表变化后批量拉取表情统计（避免每条评论一次请求）
  useEffect(() => {
    const ids: string[] = [];
    const walk = (list: CommentItem[]) => {
      list.forEach((c) => {
        ids.push(c.id);
        const replies = (c as any).replies as CommentItem[] | undefined;
        if (replies && replies.length) walk(replies);
      });
    };
    walk(comments || []);
    if (ids.length === 0) {
      setCommentReactions({});
      setCommentUserReactions({});
      return;
    }
    apiClient
      .get('/reactions/batch', {
        params: { target_type: 'comment', target_ids: ids.slice(0, 200).join(',') },
      })
      .then((res) => {
        const items = res.data?.items || {};
        const counts: Record<string, ReactionCounts> = {};
        const mine: Record<string, string[]> = {};
        Object.entries(items).forEach(([key, value]: [string, any]) => {
          counts[key] = value?.counts || {};
          mine[key] = value?.user_reactions || [];
        });
        setCommentReactions(counts);
        setCommentUserReactions(mine);
      })
      .catch(() => {});
  }, [comments]);

  // 已移除旧内嵌评论区专用逻辑：handleToggleCommentReaction

  // 举报弹窗
  const [reportOpen, setReportOpen] = useState(false);
  const [reportReason, setReportReason] = useState('spam');
  const [reportDesc, setReportDesc] = useState('');
  const [reportImageUrl, setReportImageUrl] = useState('');
  const [reportImageUploading, setReportImageUploading] = useState(false);
  const [reportSubmitting, setReportSubmitting] = useState(false);

  const handleReportImage = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = Array.from(e.target.files || [])[0];
    e.target.value = '';
    if (!file || !file.type.startsWith('image/')) return;
    setReportImageUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      const res = await apiClient.post('/posts/upload-image', fd, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      if (res.data?.url) setReportImageUrl(res.data.url);
    } catch (err: any) {
      showToast(err?.response?.data?.detail || '截图上传失败');
    } finally {
      setReportImageUploading(false);
    }
  };

  const showToast = (msg: string) => {
    toast.info(msg);
  };

  // 旧内嵌评论区的就地回复状态与逻辑已移除，统一由 CommentDrawer 承担

  const [managementMenuOpen, setManagementMenuOpen] = useState(false);
  // 管理操作下拉：ESC 可关闭（此前只有全屏遮罩的 onClick，遮罩被裁时无法收起）
  useEffect(() => {
    if (!managementMenuOpen) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setManagementMenuOpen(false);
    };
    document.addEventListener('keydown', onEsc);
    return () => document.removeEventListener('keydown', onEsc);
  }, [managementMenuOpen]);
  const [changeCategoryOpen, setChangeCategoryOpen] = useState(false);
  const [categoryList, setCategoryList] = useState<{ id: number; name: string; slug?: string }[]>([]);

  const openChangeCategoryModal = async () => {
    setManagementMenuOpen(false);
    try {
      const res = await apiClient.get('/posts/categories');
      if (Array.isArray(res.data) && res.data.length > 0) {
        setCategoryList(res.data);
      } else {
        setCategoryList([
          { id: 1, name: '前端工程与设计' },
          { id: 2, name: '技术思考' },
          { id: 3, name: '开源生态' },
          { id: 4, name: '极客日常' },
        ]);
      }
    } catch {
      setCategoryList([
        { id: 1, name: '前端工程与设计' },
        { id: 2, name: '技术思考' },
        { id: 3, name: '开源生态' },
        { id: 4, name: '极客日常' },
      ]);
    }
    setChangeCategoryOpen(true);
  };

  const handleChangeCategory = async (catId: number, catName: string) => {
    try {
      await apiClient.put(`/posts/${postId}`, { category_id: catId });
      setPost((prev) => (prev ? { ...prev, category_id: catId, category_name: catName } : null));
      setChangeCategoryOpen(false);
      showToast(`文章已成功转移至分区「${catName}」！`);
    } catch (err: any) {
      showToast(err.response?.data?.detail || '更换分区失败');
    }
  };

  // 管理菜单按角色给功能：作者只能编辑自己的内容，版务操作只给管理员/版主
  const isStaffRole = Boolean(user && ['super_admin', 'admin', 'moderator'].includes(user.role));
  const isPostAuthor = Boolean(user && post && user.username === post.author_username);
  const isAuthorOrAdmin = Boolean(user && post && (isPostAuthor || isStaffRole));

  const buildHeadingComponents = () => {
    const nextId = createHeadingIdFactory();
    const mk = (Tag: string) => ({ children }: any) =>
      React.createElement(Tag, { id: nextId(headingTextFromChildren(children)) }, children);
    return {
      h1: mk('h1'), h2: mk('h2'), h3: mk('h3'),
      h4: mk('h4'), h5: mk('h5'), h6: mk('h6'),
      ...mdTableComponents,
    };
  };

  const renderManagementMenu = () => {
    return (
      <div className="relative">
        <button
          type="button"
          onClick={() => setManagementMenuOpen((prev) => !prev)}
          className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle hover:bg-wb-bg-surface text-xs font-semibold text-wb-text-primary hover:border-wb-border-strong transition-all shadow-xs shrink-0 select-none cursor-pointer"
          title="文章编辑与版务管理"
        >
          <SlidersHorizontal className="w-3.5 h-3.5 text-wb-brand" />
          <span>管理操作</span>
          <ChevronDown
            className={`w-3 h-3 text-wb-text-muted transition-transform duration-200 ${
              managementMenuOpen ? 'rotate-180' : ''
            }`}
          />
        </button>

        {managementMenuOpen && (
          <>
            <div
              className="fixed inset-0 z-[60] overflow-y-auto"
              onClick={() => setManagementMenuOpen(false)}
            />
            <div className="absolute right-0 top-full mt-2 w-64 rounded-2xl bg-white dark:bg-[#181a20] border border-wb-border-strong shadow-2xl p-2.5 z-[100] animate-fade-in space-y-1.5 ring-1 ring-black/10 dark:ring-white/10">
              {/* 分组 1: 编辑与分区 */}
              <div className="space-y-0.5">
                <div className="px-2.5 py-1 text-3xs font-bold text-wb-text-muted uppercase tracking-wider">
                  内容编辑
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    setEditTitle(post?.title || '');
                    setEditContent(post?.content_md || '');
                    setEditPostOpen(true);
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  <Edit3 className="w-3.5 h-3.5 text-blue-500 shrink-0" />
                  <span>编辑文章与标题</span>
                </button>

                <button
                  type="button"
                  onClick={openChangeCategoryModal}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  <Tag className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>更换所属分区 (换区)</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    openEditHistory();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  <Clock className="w-3.5 h-3.5 text-indigo-500 shrink-0" />
                  <span>查看版本编辑历史</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    handleWithdrawPost();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-warn hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  <Archive className="w-3.5 h-3.5 text-amber-500 shrink-0" />
                  <span>下架存入个人草稿</span>
                </button>
              </div>

              {/* 分组 2: 社区版务管理 */}
              {isStaffRole && (
              <div className="pt-1.5 border-t border-wb-border-subtle space-y-0.5">
                <div className="px-2.5 py-1 text-3xs font-bold text-wb-text-muted uppercase tracking-wider">
                  版务管理
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    handleTogglePin();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  <Pin className={`w-3.5 h-3.5 shrink-0 ${post?.is_pinned ? 'text-wb-brand fill-current' : ''}`} />
                  <span>{post?.is_pinned ? '取消置顶' : '设为置顶'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    handleToggleEssence();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-brand hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  <Sparkles className={`w-3.5 h-3.5 shrink-0 ${post?.is_essence ? 'text-amber-500 fill-current' : ''}`} />
                  <span>{post?.is_essence ? '取消推荐' : '设为精华 (Staff Pick)'}</span>
                </button>

                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    handleToggleLock();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-wb-text-secondary hover:text-wb-text-primary hover:bg-wb-bg-subtle transition-colors text-left"
                >
                  {post?.comment_policy === 'closed' ? (
                    <>
                      <Unlock className="w-3.5 h-3.5 text-emerald-500 shrink-0" />
                      <span>恢复评论区开放</span>
                    </>
                  ) : (
                    <>
                      <Lock className="w-3.5 h-3.5 text-rose-500 shrink-0" />
                      <span>锁定评论区</span>
                    </>
                  )}
                </button>
              </div>
              )}

              {/* 分组 3: 危险操作 */}
              {isStaffRole && (
              <div className="pt-1.5 border-t border-wb-border-subtle">
                <button
                  type="button"
                  onClick={() => {
                    setManagementMenuOpen(false);
                    handleDeletePost();
                  }}
                  className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-xl text-xs text-rose-500 hover:bg-rose-500/10 transition-colors text-left font-medium"
                >
                  <Trash2 className="w-3.5 h-3.5 shrink-0" />
                  <span>彻底删除文章</span>
                </button>
              </div>
              )}
            </div>
          </>
        )}
      </div>
    );
  };

  // 作者与管理功能状态
  const [editPostOpen, setEditPostOpen] = useState(false);
  const [editTitle, setEditTitle] = useState('');
  const [editContent, setEditContent] = useState('');
  // 编辑历史
  const [commentDrawerOpen, setCommentDrawerOpen] = useState(false);
  // 删除/下架后的延时返回：用户若在 800ms 内自己点了返回，这里必须能被取消，
  // 否则会覆盖用户后续的导航（把人又拽回列表）。
  const navigateTimerRef = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (navigateTimerRef.current) window.clearTimeout(navigateTimerRef.current);
    },
    []
  );
  // 底部快速评论发完后，通知真正的评论区重新拉取（两者 state 互相独立）
  const [commentsRefreshToken, setCommentsRefreshToken] = useState(0);

  // 通知中心点评论类通知（含没有 comment_id 的历史通知）时打开评论区。
  // 令牌是一次性的：文章页挂载后立刻消费，避免普通方式打开文章也弹抽屉。
  useEffect(() => {
    if (!commentsAutoOpenToken) return;
    if (zenMode) {
      scrollToComments();
    } else {
      setCommentDrawerOpen(true);
    }
    onConsumeAutoOpen?.();
  }, [commentsAutoOpenToken, zenMode]);

  // 从通知中心 / 分享链接带评论 id 进来时：
  //   非沉浸 → 自动打开评论抽屉（评论区已不再内嵌常驻）
  //   沉浸   → 评论区本来就在下方，滚过去即可
  // 只在同一目标首次到达时触发，用户手动关掉抽屉不会被反复弹开
  useEffect(() => {
    if (!targetCommentId) return;
    if (zenMode) {
      const timer = window.setTimeout(() => scrollToComments(), 320);
      return () => window.clearTimeout(timer);
    }
    setCommentDrawerOpen(true);
  }, [targetCommentId, zenMode, commentFocusSeq]);
  const [floatingReactionOpen, setFloatingReactionOpen] = useState(false);
  const articleScrollRef = useRef<HTMLElement | null>(null);

  const layoutRef = useRef<HTMLDivElement | null>(null);

  // 滚轮接管：鼠标在右侧胶囊 / 右栏留白上时，滚轮同样滚动正文。
  // 用 window 级监听 + preventDefault，避免浏览器同时消费掉一部分 deltaY
  // （之前挂在容器上，滚一次只动几十像素，手感很"黏"）。
  useEffect(() => {
    if (typeof window === 'undefined' || window.innerWidth < 1024) return;
    const onWheel = (e: WheelEvent) => {
      // 灯箱打开时滚轮只用来缩放图片，绝不能同时滚动正文
      if (lightboxImage) return;
      // 沉浸模式走整页原生滚动，这里不再接管 scrollTop
      if (zenMode) return;
      const mainEl = articleScrollRef.current;
      const layout = layoutRef.current;
      if (!mainEl || !layout) return;
      const target = e.target as Node;
      // 正文与左栏各自原生滚动
      if (mainEl.contains(target)) return;
      const left = layout.querySelector('aside[data-left-column="1"]');
      if (left && left.contains(target)) return;
      // 抽屉 / 弹窗等覆盖层内不接管，避免"滚评论却在滚正文"
      if ((target as HTMLElement).closest?.('[data-overlay="1"], [role="dialog"]')) return;

      e.preventDefault();
      // 与浏览器原生滚轮完全一致：按事件给的位移直接移动，不加任何缓动。
      // deltaMode=1 是"行"、2 是"页"，换算成像素后再滚。
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? mainEl.clientHeight : 1;
      mainEl.scrollTop += e.deltaY * unit;
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, []);

  // 桌面端文章页是全屏阅读：锁住整页滚动，避免底部出现一条可滚动的空白
  useEffect(() => {
    if (typeof window === 'undefined') return;
    // 沉浸模式走整页文档流：显式放开滚动，保证滚轮生效
    if (zenMode) {
      document.body.style.overflow = 'auto';
      return;
    }
    // 只有桌面是「正文在固定高度的容器内部滚动」，才需要锁住整页。
    // 移动端正文靠整页滚动，锁了 body 就会完全滑不动（这是之前手机端卡死的根因）。
    const mq = window.matchMedia('(min-width: 1024px)');
    let release: (() => void) | null = null;
    const sync = () => {
      if (mq.matches && !release) {
        release = acquireScrollLock();
      } else if (!mq.matches && release) {
        release();
        release = null;
      }
    };
    sync();
    mq.addEventListener('change', sync);
    return () => {
      mq.removeEventListener('change', sync);
      if (release) release();
    };
  }, [zenMode]);

  // 阅读位置记忆：按文章保存滚动比例，重新打开时回到原位（普通模式滚内部容器，沉浸模式滚 window）
  useEffect(() => {
    if (!postId || !post?.id) return;
    const pid = postId;
    let saveTimer: number | undefined;
    const ratioOf = () => {
      if (zenMode) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        return max > 0 ? window.scrollY / max : 0;
      }
      const el = articleScrollRef.current;
      const max = el ? el.scrollHeight - el.clientHeight : 0;
      return max > 0 ? el!.scrollTop / max : 0;
    };
    const onScroll = () => {
      window.clearTimeout(saveTimer);
      saveTimer = window.setTimeout(() => savePosition(pid, ratioOf()), 250);
    };
    const restoreTimer = window.setTimeout(() => {
      const ratio = readPosition(pid);
      if (ratio <= 0) return;
      if (zenMode) {
        const max = document.documentElement.scrollHeight - window.innerHeight;
        if (max > 0) window.scrollTo({ top: Math.round(ratio * max) });
      } else {
        const el = articleScrollRef.current;
        const max = el ? el.scrollHeight - el.clientHeight : 0;
        if (max > 0) el!.scrollTo({ top: Math.round(ratio * max) });
      }
    }, 350);
    const target: any = zenMode ? window : articleScrollRef.current;
    target?.addEventListener?.('scroll', onScroll, { passive: true });
    return () => {
      window.clearTimeout(restoreTimer);
      window.clearTimeout(saveTimer);
      target?.removeEventListener?.('scroll', onScroll);
    };
  }, [postId, post?.id, zenMode]);

  const handleScrollToTop = () => {
    if (articleScrollRef.current) {
      articleScrollRef.current.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  // 快捷键 C 唤起讨论抽屉；但 Ctrl/Cmd+C 必须放行，不能抢系统的复制
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      // 组合键（Ctrl+C / Cmd+C / Alt+C）一律不处理，交给浏览器复制
      if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return;
      const active = document.activeElement as HTMLElement | null;
      const activeTag = active?.tagName?.toLowerCase() || '';
      if (activeTag === 'input' || activeTag === 'textarea' || activeTag === 'select' || active?.isContentEditable) return;
      // 有选中文本时也不抢快捷键：用户可能刚选完字准备复制
      if (window.getSelection()?.toString()) return;
      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault();
        setCommentDrawerOpen((prev) => !prev);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, []);

  // 渲染右侧竖列胶囊悬浮交互栏 (放大尺寸、深层毛玻璃高通透质感、精致光效与微动效)
  const renderFloatingVerticalDock = () => {
    return (
      <div className="relative group/dock flex flex-col items-center">
        {/* 外层优雅深邃环境呼吸微光环 (光效微散) */}
        <div className="absolute -inset-2 rounded-full bg-gradient-to-b from-wb-brand/20 via-wb-text-primary/10 to-wb-brand/20 blur-xl opacity-45 group-hover/dock:opacity-90 transition-opacity duration-700 pointer-events-none" />

        {/* 胶囊主体轨道: 尺寸加宽加大 (w-14)、高透光真实毛玻璃质感 (bg-white/60 backdrop-blur-2xl) */}
        <div
          className="relative w-14 py-4 px-1.5 rounded-full bg-gradient-to-b from-white/72 via-white/50 to-white/38 dark:from-white/[0.10] dark:via-[#0f1116]/60 dark:to-[#0f1116]/45 backdrop-blur-[28px] backdrop-saturate-150 border border-white/70 dark:border-white/15 flex flex-col items-center gap-3 select-none transition-all duration-300
            shadow-[0_10px_36px_rgba(0,0,0,0.14),0_2px_8px_rgba(0,0,0,0.06),inset_0_1px_0_rgba(255,255,255,0.95),inset_0_-1px_0_rgba(255,255,255,0.35),inset_0_0_24px_rgba(255,255,255,0.18)]
            dark:shadow-[0_10px_36px_rgba(0,0,0,0.65),0_2px_8px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.22),inset_0_-1px_0_rgba(255,255,255,0.06),inset_0_0_24px_rgba(255,255,255,0.06)]
            hover:shadow-[0_16px_46px_rgba(0,0,0,0.2),inset_0_1px_0_rgba(255,255,255,0.95),inset_0_0_28px_rgba(255,255,255,0.22)]"
        >
          {/* 胶囊顶部微光反射层 */}
          {/* 顶部亮边：只保留 2px 的折射高光，避免在按钮上方糊出一块白斑 */}
          <div className="absolute top-0 inset-x-3 h-[2px] rounded-full bg-gradient-to-r from-transparent via-white/70 to-transparent dark:via-white/25 pointer-events-none" />

          {/* 1. 点赞 (放大按键 w-11 h-11、毛玻璃微透底) */}
          <div className="relative group">
            <button
              type="button"
              onClick={handleLike}
              className={`w-11 h-11 rounded-full flex flex-col items-center justify-center transition-all duration-200 cursor-pointer ${
                post?.is_liked
                  ? 'bg-wb-text-primary text-wb-bg-page border-transparent shadow-[0_0_16px_rgba(0,0,0,0.3)] dark:shadow-[0_0_16px_rgba(255,255,255,0.35)] scale-105'
                  : 'bg-white/25 dark:bg-white/[0.04] hover:bg-white/85 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/45 dark:border-white/10 hover:border-white/95 hover:scale-110 active:scale-95 shadow-[inset_0_1px_0_rgba(255,255,255,0.9),inset_0_-1px_0_rgba(255,255,255,0.25),0_1px_2px_rgba(0,0,0,0.05)] dark:shadow-[inset_0_1px_0_rgba(255,255,255,0.12)]'
              }`}
            >
              <Heart className={`w-4 h-4 transition-transform duration-200 ${post?.is_liked ? 'fill-current scale-110' : 'group-hover:scale-110'}`} />
              {post?.like_count !== undefined && post.like_count > 0 && (
                <span className="text-[11px] font-mono font-bold leading-none mt-0.5">
                  {post.like_count > 999 ? '999+' : post.like_count}
                </span>
              )}
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              {post?.is_liked ? '已点赞' : '点赞支持'} {post?.like_count ? `(${post.like_count})` : ''}
            </div>
          </div>

          {/* 2. 评论 (点击即刻展开侧边抽屉) */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => setCommentDrawerOpen((prev) => !prev)}
              className={`w-11 h-11 rounded-full flex flex-col items-center justify-center transition-all duration-200 cursor-pointer ${
                commentDrawerOpen
                  ? 'bg-wb-text-primary text-wb-bg-page border-transparent shadow-[0_0_16px_rgba(0,0,0,0.3)] dark:shadow-[0_0_16px_rgba(255,255,255,0.35)] scale-105'
                  : 'bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs'
              }`}
            >
              <MessageSquare className="w-4 h-4 transition-transform duration-200 group-hover:scale-110" />
              {post?.comment_count !== undefined && post.comment_count > 0 && (
                <span className="text-[11px] font-mono font-bold leading-none mt-0.5">
                  {post.comment_count > 999 ? '999+' : post.comment_count}
                </span>
              )}
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              讨论交流 ({post?.comment_count || 0}) · 点击展开抽屉
            </div>
          </div>

          {/* 3. 表情互动反应 */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => setFloatingReactionOpen((prev) => !prev)}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer ${
                floatingReactionOpen
                  ? 'bg-wb-text-primary text-wb-bg-page border-transparent shadow-[0_0_16px_rgba(0,0,0,0.3)] dark:shadow-[0_0_16px_rgba(255,255,255,0.35)] scale-105'
                  : 'bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs'
              }`}
            >
              <SmilePlus className="w-4 h-4 transition-transform duration-200 group-hover:scale-110" />
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              表情互动反应
            </div>

            {/* 表情反应横向气泡浮层 (毛玻璃质感) */}
            {floatingReactionOpen && (
              <>
                <div
                  className="fixed inset-0 z-40"
                  onClick={() => setFloatingReactionOpen(false)}
                />
                <div className="absolute right-full mr-4 top-1/2 -translate-y-1/2 z-50 p-2 rounded-2xl bg-white/85 dark:bg-[#12141a]/90 border border-white/70 dark:border-white/15 shadow-2xl flex items-center gap-1.5 backdrop-blur-2xl animate-scale-in">
                  {REACTION_LIST.map(({ emoji, label }) => {
                    const count = postReactions[emoji] || 0;
                    const active = postUserReactions.includes(emoji);
                    return (
                      <button
                        key={emoji}
                        type="button"
                        onClick={() => {
                          handleTogglePostReaction(emoji);
                        }}
                        title={label}
                        className={`wb-pressable flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs transition-all ${
                          active
                            ? 'bg-wb-text-primary/10 border border-wb-text-primary/25 text-wb-text-primary font-bold shadow-xs'
                            : 'hover:bg-wb-bg-subtle border border-transparent text-wb-text-secondary hover:text-wb-text-primary'
                        }`}
                      >
                        <span className="text-sm">{emoji}</span>
                        {count > 0 && <span className="text-3xs font-mono font-bold">{count}</span>}
                      </button>
                    );
                  })}
                </div>
              </>
            )}
          </div>

          <AddToSeriesButton postId={postId} />

          {/* 4. 收藏 */}
          <div className="relative group">
            <button
              type="button"
              onClick={handleCollect}
              className={`w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer ${
                post?.is_collected
                  ? 'bg-wb-text-primary text-wb-bg-page border-transparent shadow-[0_0_16px_rgba(0,0,0,0.3)] dark:shadow-[0_0_16px_rgba(255,255,255,0.35)] scale-105'
                  : 'bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs'
              }`}
            >
              <Bookmark className={`w-4 h-4 transition-transform duration-200 ${post?.is_collected ? 'fill-current scale-110' : 'group-hover:scale-110'}`} />
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              {post?.is_collected ? '取消收藏' : '收藏文章'}
            </div>
          </div>

          {/* 5. 分享 */}
          <div className="relative group">
            <button
              type="button"
              onClick={handleShare}
              className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs"
            >
              <Share2 className="w-4 h-4 transition-transform duration-200 group-hover:scale-110" />
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              分享文章海报 / 链接
            </div>
          </div>

          {/* 6. 举报 */}
          <div className="relative group">
            <button
              type="button"
              onClick={() => setReportOpen(true)}
              className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-danger border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs"
            >
              <ShieldAlert className="w-4 h-4 transition-transform duration-200 group-hover:scale-110" />
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              举报违规内容
            </div>
          </div>

          {/* 分割线 */}
          <div className="w-5 h-[1px] bg-wb-border-subtle/80 my-0.5" />

          {/* 7. 回到顶部 (平滑滚动独立正文区域) */}
          <div className="relative group">
            <button
              type="button"
              onClick={handleScrollToTop}
              className="w-11 h-11 rounded-full flex items-center justify-center transition-all duration-200 cursor-pointer bg-white/70 dark:bg-white/5 hover:bg-white/95 dark:hover:bg-white/15 backdrop-blur-md text-wb-text-secondary hover:text-wb-text-primary border border-white/80 dark:border-white/10 hover:border-wb-border-strong hover:scale-110 active:scale-95 shadow-xs"
            >
              <ArrowUp className="w-4 h-4 transition-transform duration-200 group-hover:-translate-y-0.5" />
            </button>
            <div className="absolute right-full mr-3.5 top-1/2 -translate-y-1/2 px-2.5 py-1.5 rounded-xl bg-slate-900/90 dark:bg-white/95 text-white dark:text-slate-900 text-2xs font-semibold whitespace-nowrap opacity-0 group-hover:opacity-100 max-sm:opacity-70 pointer-events-none transition-all duration-200 shadow-xl z-30 scale-95 group-hover:scale-100 origin-right backdrop-blur-md">
              回到文章顶部
            </div>
          </div>
        </div>
      </div>
    );
  };
    const [editsOpen, setEditsOpen] = useState(false);
  const [edits, setEdits] = useState<
    { id: number; old_title: string; old_content_md: string; created_at: string; editor_username?: string; editor_nickname?: string }[]
  >([]);
  const [loadingEdits, setLoadingEdits] = useState(false);
  const [expandedEditId, setExpandedEditId] = useState<number | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);

  // 评论排序
  const [shareModalOpen, setShareModalOpen] = useState(false);

  const wordCount = post?.content_md ? post.content_md.trim().length : 0;
  const readingMinutes = post?.reading_time_minutes || Math.max(1, Math.ceil(wordCount / 350));

  // 加载更多主楼评论（主楼分页，楼中楼子树随主楼完整返回）
  // 已移除旧内嵌评论区专用逻辑：loadMoreComments

  const fetchDetail = async () => {
    try {
      const [pRes, cRes] = await Promise.all([
        apiClient.get(`/posts/${postId}`),
        apiClient.get(`/comments/post/${postId}`, { params: { page: 1, size: 20 } }).catch(() => ({ data: [], headers: {} })),
      ]);

      if (pRes.data && pRes.data.title) {
        setPost(pRes.data);
        void loadQaState();
        if (pRes.data.poll) {
          setPoll(pRes.data.poll);
        } else if (pRes.data.poll_id) {
          apiClient.get(`/polls/post/${postId}`)
            .then((pollRes) => {
              if (pollRes.data && pollRes.data.title) {
                setPoll(pollRes.data);
              }
            })
            .catch(() => setPoll(null));
        } else {
          setPoll(null);
        }
      } else {
        setPost(null);
        setPoll(null);
        setLoadError('notfound');
        removeReadingHistoryItem(postId);
      }

      if (cRes.data && Array.isArray(cRes.data)) {
        setComments(cRes.data);
        setCommentPage(1);
        const hdrs = cRes.headers as any;
        setCommentsHasMore(hdrs?.['x-comments-has-more'] === '1');
      } else {
        setComments([]);
      }
    } catch (err: any) {
      // 区分「真的不存在」与「网络/服务端异常」：后者不能谎报删除，也不能清空本地阅读历史
      const status = err?.response?.status;
      setPost(null);
      setPoll(null);
      if (status === 404 || status === 403) {
        setLoadError('notfound');
        removeReadingHistoryItem(postId);
      } else {
        setLoadError('network');
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchDetail();
  }, [postId]);

  // 点赞：先乐观翻转，失败回滚，避免请求失败仍提示"已点赞"
  const handleLike = async () => {
    if (!user) return onRequireAuth();
    const prevState = post;
    if (!prevState) return;
    const nextLiked = !prevState.is_liked;

    setPost({
      ...prevState,
      is_liked: nextLiked,
      like_count: nextLiked ? prevState.like_count + 1 : Math.max(0, prevState.like_count - 1),
    });

    try {
      await apiClient.post(`/posts/${postId}/like`);
      showToast(nextLiked ? '已点赞本文' : '已取消点赞');
    } catch (err: any) {
      // 只回滚点赞相关字段，避免把期间已成功的评论数/分区等更新一并抹掉
      setPost((prev) => prev ? {
        ...prev,
        is_liked: prevState.is_liked,
        like_count: prevState.like_count,
      } : prev);
      showToast(err.response?.data?.detail || '点赞失败，请稍后重试');
    }
  };

  // 收藏：同样带回滚，避免网络/权限失败时 UI 与实际不一致
  const handleCollect = () => {
    if (!user) return onRequireAuth();
    if (!post) return;
    openCollectionModal({ id: postId, title: post.title, is_collected: post.is_collected });
  };

  // 收藏弹窗操作后同步详情里的收藏态
  useEffect(() => onCollectionChanged((c) => {
    if (c.postId !== postId) return;
    setPost((prev) => prev ? { ...prev, is_collected: c.is_collected } : prev);
  }), [postId]);

  const handleShare = () => {
    setShareModalOpen(true);
  };

  const submitPollVotes = async (optionIds: number[]) => {
    if (!user) return onRequireAuth();
    if (!poll || votingRef.current || optionIds.length === 0) return;
    votingRef.current = true;
    try {
      await apiClient.post(`/polls/${poll.id}/vote`, optionIds);
      showToast('投票成功！');
      setSelectedPollOptions([]);
      const res = await apiClient.get(`/polls/post/${postId}`);
      if (res.data) {
        setPoll(res.data);
      }
    } catch (err: any) {
      showToast(err.response?.data?.detail || '投票提交失败');
    } finally {
      votingRef.current = false;
    }
  };

  const handleVote = (optionId: number) => {
    if (!user) return onRequireAuth();
    if (!poll || poll.is_expired || poll.has_voted) return;

    if (poll.is_multiple) {
      // 多选：先本地勾选，统一提交，受 max_choices 约束
      setSelectedPollOptions((prev) => {
        if (prev.includes(optionId)) {
          return prev.filter((id) => id !== optionId);
        }
        const limit = poll.max_choices || poll.options.length;
        if (prev.length >= limit) {
          showToast(`该投票最多可选择 ${limit} 项`);
          return prev;
        }
        return [...prev, optionId];
      });
    } else {
      // 单选：点击立即提交（带防抖守卫，防双击重复提交）
      void submitPollVotes([optionId]);
    }
  };

  // 已移除旧内嵌评论区专用逻辑：handleSendComment

  const handleReport = async () => {
    const desc = reportDesc.trim();
    if (desc.length < 10) {
      showToast('请填写至少 10 个字的详细举报原因');
      return;
    }
    if (reportSubmitting) return;
    setReportSubmitting(true);
    try {
      await apiClient.post('/admin/reports', {
        target_type: 'post',
        target_id: postId,
        reason_type: reportReason,
        description: desc,
        image_url: reportImageUrl || null,
      });
      showToast('举报已提交，可在「我的举报」查看处理进度');
      setReportOpen(false);
      setReportDesc('');
      setReportImageUrl('');
      setReportReason('spam');
    } catch (err: any) {
      // 失败必须如实提示，不能假装提交成功
      showToast(err?.response?.data?.detail || '举报提交失败，请稍后重试');
    } finally {
      setReportSubmitting(false);
    }
  };

  const handleTogglePin = async () => {
    try {
      const res = await apiClient.post(`/posts/${postId}/pin`);
      setPost((prev) => (prev ? { ...prev, is_pinned: res.data.is_pinned } : null));
      showToast(res.data.message || (res.data.is_pinned ? '帖子已设为置顶' : '已取消置顶'));
    } catch (err: any) {
      showToast(err.response?.data?.detail || '操作失败');
    }
  };

  const handleToggleEssence = async () => {
    try {
      const res = await apiClient.post(`/posts/${postId}/essence`);
      setPost((prev) => (prev ? { ...prev, is_essence: res.data.is_essence } : null));
      showToast(res.data.message || (res.data.is_essence ? '已评选为精华推荐 (Staff Pick)' : '已取消精华推荐'));
    } catch (err: any) {
      showToast(err.response?.data?.detail || '操作失败');
    }
  };

  const handleToggleLock = async () => {
    try {
      const res = await apiClient.post(`/posts/${postId}/lock`);
      setPost((prev) => (prev ? { ...prev, comment_policy: res.data.comment_policy } : null));
      showToast(res.data.message || (res.data.comment_policy === 'closed' ? '评论区已锁定' : '评论区已恢复开放'));
    } catch (err: any) {
      showToast(err.response?.data?.detail || '操作失败');
    }
  };


  const handleSavePostEdit = async () => {
    if (!editTitle.trim() || !editContent.trim()) {
      showToast('标题与正文不能为空');
      return;
    }
    setSavingEdit(true);
    try {
      const res = await apiClient.put(`/posts/${postId}`, {
        title: editTitle.trim(),
        content_md: editContent.trim(),
      });
      setPost((prev) =>
        prev
          ? {
              ...prev,
              title: res.data.title,
              content_md: res.data.content_md,
              content_html: res.data.content_html,
              edits_count: (prev.edits_count || 0) + 1,
            }
          : null
      );
      setEditPostOpen(false);
      showToast('文章内容已更新！');
    } catch (err: any) {
      showToast(err.response?.data?.detail || '保存失败');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleWithdrawPost = async () => {
    const ok = await confirm({
      title: '下架文章确认',
      description: '确定要下架这篇文章吗？下架后将移出公共版块，并完整保存在您的草稿箱中，可随时重新编辑发布。',
      confirmText: '确定下架',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/posts/${postId}?action=draft`);
      removeReadingHistoryItem(postId);
      showToast('文章已成功下架并转存至草稿箱！');
      if (navigateTimerRef.current) window.clearTimeout(navigateTimerRef.current);
      navigateTimerRef.current = window.setTimeout(onBack, 800);
    } catch (err: any) {
      showToast(err.response?.data?.detail || '下架失败');
    }
  };

  const handleDeletePost = async () => {
    const ok = await confirm({
      title: '彻底删除文章',
      description: '确定要彻底删除这篇文章吗？删除后文章及历史记录将无法恢复。',
      confirmText: '彻底删除',
      cancelText: '取消',
      danger: true,
    });
    if (!ok) return;
    try {
      await apiClient.delete(`/posts/${postId}?action=delete`);
      removeReadingHistoryItem(postId);
      showToast('文章已彻底删除');
      if (navigateTimerRef.current) window.clearTimeout(navigateTimerRef.current);
      navigateTimerRef.current = window.setTimeout(onBack, 800);
    } catch (err: any) {
      showToast(err.response?.data?.detail || '删除失败');
    }
  };

  // 已移除旧内嵌评论区专用逻辑：handleCommentLike

  // 已移除旧内嵌评论区专用逻辑：handleDeleteComment

  const openEditHistory = async () => {
    setEditsOpen(true);
    setExpandedEditId(null);
    setLoadingEdits(true);
    try {
      const res = await apiClient.get(`/posts/${postId}/edits`);
      setEdits(Array.isArray(res.data) ? res.data : []);
    } catch (err: any) {
      showToast(err.response?.data?.detail || '加载编辑历史失败');
      setEdits([]);
    } finally {
      setLoadingEdits(false);
    }
  };

  // 已移除旧内嵌评论区专用逻辑：handleToggleFeature

  // 已移除旧内嵌评论区专用逻辑：handleToggleAcceptSolution

  // 已移除旧内嵌评论区专用逻辑：handleCancelReply

  // 评论数统一用后端计数：本地树只加载了分页内的一部分，
  // 用它取 max 会导致「删了评论数字不降」以及三处口径不一致
  const totalCommentsCount = post?.comment_count || 0;

  // 多维排序与楼主筛选后的评论列表
  // 已移除旧内嵌评论区专用逻辑：safeComments

  if (loading && !post) {
    return <PostDetailSkeleton />;
  }

  if (post?.post_type === 'food_topic') {
    // 美食帖是特殊类型：点开直接进入卡片流；portal 避免被祖先 transform 限制
    return createPortal(
      <div className="fixed inset-0 z-[200] bg-wb-bg-page overflow-y-auto">
        <FoodTopic onClose={onBack} user={user} embedded />
      </div>,
      document.body,
    );
  }

  if (!post) {
    // 网络异常：给出重试入口，而不是谎报"文章已删除"
    if (loadError === 'network') {
      return (
        <div className="max-w-4xl mx-auto px-4 py-16 text-center space-y-4">
          <p className="text-wb-text-primary text-sm font-semibold">内容加载失败</p>
          <p className="text-wb-text-muted text-xs">网络或服务暂时不可用，请稍后重试（已保留你的阅读记录）。</p>
          <div className="flex items-center justify-center gap-2">
            <button
              onClick={() => {
                setLoadError(null);
                fetchDetail();
              }}
              className="wb-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-capsule bg-wb-primary text-wb-primary-fg text-xs font-medium shadow-sm hover:opacity-90"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>重新加载</span>
            </button>
            <button
              onClick={onBack}
              className="wb-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface text-wb-text-secondary text-xs font-medium hover:border-wb-border-strong"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>返回列表</span>
            </button>
          </div>
        </div>
      );
    }
    return (
      <div className="max-w-4xl mx-auto px-4 py-16 text-center space-y-4">
        <p className="text-wb-text-muted text-sm">该文章不存在或已被作者下架删除</p>
        <button
          onClick={onBack}
          className="wb-pressable inline-flex items-center gap-1.5 px-4 py-2 rounded-capsule bg-wb-primary text-wb-primary-fg text-xs font-medium shadow-sm hover:opacity-90"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回社区列表</span>
        </button>
      </div>
    );
  }

  // 评论交流组件 (可在桌面端右侧边栏或移动端正文底部复用)
  // 旧的内嵌评论区已移除：弹出抽屉与沉浸模式统一使用 CommentDrawer

  if (loading) {
    return (
      <div className="min-h-[60vh] flex flex-col items-center justify-center gap-3">
        <div className="w-8 h-8 rounded-full border-2 border-wb-text-primary border-t-transparent animate-spin" />
        <p className="text-xs text-wb-text-muted font-mono">文章加载中...</p>
      </div>
    );
  }

  if (!post) {
    return (
      <div className="max-w-md mx-auto my-16 p-8 rounded-3xl surface border border-wb-border-subtle shadow-card text-center space-y-4">
        <div className="w-12 h-12 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle flex items-center justify-center mx-auto text-xl">
          🔍
        </div>
        <div className="space-y-1">
          <h3 className="font-bold text-base text-wb-text-primary">文章不存在或已被删除</h3>
          <p className="text-xs text-wb-text-muted">该内容可能已被作者下架转存至草稿箱，或已被永久删除（已自动从您的阅读足迹中移出）</p>
        </div>
        <button
          onClick={() => {
            removeReadingHistoryItem(postId);
            onBack();
          }}
          className="wb-pressable inline-flex items-center gap-2 px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm"
        >
          <ArrowLeft className="w-3.5 h-3.5" />
          <span>返回社区首页</span>
        </button>
      </div>
    );
  }

  return (
    <div
      className={`relative ${
        zenMode
          ? "min-h-screen py-4 sm:py-6 pb-24 lg:h-auto lg:min-h-screen lg:overflow-y-auto lg:pt-6 lg:pb-12"
          : "article-viewport overflow-hidden flex flex-col lg:min-h-0 lg:h-[calc(100dvh-4.75rem)]"
      }`}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* 移动端左侧边缘右滑返回手势动态指示器 */}
      {swipeProgress > 0 && (
        <div
          className="fixed left-0 top-1/2 -translate-y-1/2 z-50 pointer-events-none transition-transform duration-75 flex items-center pl-2.5 pr-3.5 py-2 rounded-r-2xl bg-zinc-900/90 text-white backdrop-blur-md shadow-2xl border border-white/15"
          style={{
            transform: `translateY(-50%) translateX(${(swipeProgress - 1) * 36}px)`,
            opacity: Math.min(1, swipeProgress * 1.6),
          }}
        >
          <ArrowLeft className="w-4 h-4 mr-1.5 text-wb-info animate-pulse" />
          <span className="text-xs font-semibold font-mono tracking-wide">
            {swipeProgress >= 0.7 ? '释放返回' : '滑动返回'}
          </span>
        </div>
      )}

      {/* 顶部阅读进度条 */}
      <ReadingProgressBar targetRef={articleScrollRef} />

      {zenMode ? (
        /* 沉浸专注模式 (单栏居中无侧边干扰)：顶部给固定导航留出空间 */
        <div className="max-w-3xl mx-auto px-4 pb-10 space-y-6 transition-all duration-300">
          <div className="flex items-center justify-between">
            <button
              onClick={onBack}
              className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary shadow-sm"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              <span>返回列表</span>
            </button>
            <button
              type="button"
              onClick={() => setZenMode(false)}
              className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm"
            >
              <Minimize2 className="w-3.5 h-3.5" />
              <span>退出沉浸模式</span>
            </button>
          </div>

          {/* 文章正文卡片 */}
          <article className="p-6 md:p-8 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-6">
            <div className="space-y-3 border-b border-wb-border-subtle pb-6">
              <div className="flex items-center gap-2 text-xs text-wb-text-secondary flex-wrap">
                <div
                  onClick={() => onSelectUser?.(post.author_username)}
                  className="inline-flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity group/author"
                  title={`查看 @${post.author_username} 的极客主页`}
                >
                  <UserAvatar
                    username={post.author_username}
                    avatarUrl={post.author_avatar}
                    size="xs"
                  />
                  <span className="font-semibold text-wb-text-primary group-hover/author:underline">
                    {post.author_nickname || post.author_username}
                  </span>
                  {post.author_nickname && (
                    <span className="text-2xs text-wb-text-muted font-mono">
                      @{post.author_username}
                    </span>
                  )}
                </div>
                <LevelBadge level={post.author_level} />
                {post.is_pinned && (
                  <span className="inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-primary font-semibold">
                    <Pin className="w-3 h-3" /> 置顶
                  </span>
                )}
                {post.is_essence && (
                  <span className="inline-flex items-center gap-1 text-2xs px-2.5 py-0.5 rounded-capsule bg-wb-brand/15 text-wb-brand border border-wb-brand/25 font-bold shadow-xs">
                    <Sparkles className="w-3 h-3 text-wb-brand" /> 精华推荐
                  </span>
                )}
              </div>

              <h1 className="text-xl md:text-3xl font-bold text-wb-text-primary leading-tight">
                {getSmartDailyTitle(post.title, post.content_md)}
              </h1>

              <div className="flex items-center gap-4 text-xs text-wb-text-muted flex-wrap">
                <span className="inline-flex items-center gap-1 font-mono">
                  <Clock className="w-3.5 h-3.5" /> 发布于 {formatEast8Full(post.created_at)}
                </span>
                <span className="inline-flex items-center gap-1 font-mono">
                  约 {wordCount} 字
                </span>
                <span className="inline-flex items-center gap-1 font-mono">
                  <Eye className="w-3.5 h-3.5" /> {post.view_count} 次阅读
                </span>
                {post.edits_count > 0 &&
                  user &&
                  (user.username === post.author_username ||
                    ['super_admin', 'admin', 'moderator'].includes(user.role)) && (
                    <button
                      type="button"
                      onClick={openEditHistory}
                      className="inline-flex items-center gap-1 font-mono underline underline-offset-2 hover:text-wb-text-primary transition-colors"
                    >
                      <Clock className="w-3.5 h-3.5" /> {post.edits_count} 次编辑记录
                    </button>
                  )}
              </div>
            </div>

            {/* 好文分享：明显标注原创 / 搬运，搬运附一行地址 */}
            {post.source_type && (
              <div className={`mb-4 p-3 rounded-2xl border ${post.source_type === 'original' ? 'bg-wb-success/10 border-wb-success/30' : 'bg-wb-info/10 border-wb-info/30'}`}>
                <div className="flex items-center gap-2 text-2xs font-bold text-wb-text-primary">
                  <span className={`px-2 py-0.5 rounded-capsule text-3xs ${post.source_type === 'original' ? 'bg-wb-success text-white' : 'bg-wb-info text-white'}`}>
                    {post.source_type === 'original' ? '原创' : '搬运'}
                  </span>
                  {post.source_type === 'original' ? '本文由作者原创发布' : '本文搬运自其它来源，版权归原作者所有'}
                </div>
                {post.source_type === 'repost' && post.source_note && (
                  <p className="mt-1.5 text-3xs text-wb-text-secondary break-all">
                    搬运地址：{
                      /^https?:\/\//i.test(post.source_note)
                        ? <a href={post.source_note} target="_blank" rel="noreferrer noopener" className="text-wb-info underline underline-offset-2">{post.source_note}</a>
                        : post.source_note
                    }
                  </p>
                )}
              </div>
            )}

            {/* 问答广场：悬赏状态、采纳期与批量采纳结算 */}
            {qaState && (
              <div className="mb-4">
                <QaBountyCard
                  postId={postId}
                  state={qaState}
                  selectMode={qaSelectMode}
                  selected={qaSelected}
                  onToggleSelectMode={() => { setQaSelectMode((v) => !v); setQaSelected([]); }}
                  onClearSelected={() => { setQaSelected([]); setQaSelectMode(false); }}
                  onSettled={() => { void fetchDetail(); setCommentsRefreshToken((n) => n + 1); }}
                />
              </div>
            )}

            {/* Markdown 正文 */}
            <div
              className={`prose dark:prose-invert max-w-none max-w-full min-w-0 text-wb-text-primary space-y-4 ${
                fontSize === 'sm'
                  ? 'text-sm leading-normal'
                  : fontSize === 'lg'
                  ? 'text-lg leading-loose'
                  : 'text-base leading-relaxed'
              }`}
            >
              {(post as any).content_type === 'plain' ? (
                <div className="whitespace-pre-wrap break-words text-sm md:text-base leading-relaxed">{post.content_md}</div>
              ) : (
              <ReactMarkdown
                remarkPlugins={[remarkGfm, remarkBreaks]}
                components={{
                  ...buildHeadingComponents(),
                  code({ inline, className, children, ...props }: any) {
                    const match = /language-(\w+)/.exec(className || '');
                    const codeString = String(children).replace(/\n$/, '');
                    const isMultiLine = codeString.includes('\n');
                    return !inline && (match || isMultiLine) ? (
                      <CodeBlock language={match ? match[1] : 'text'} value={codeString} />
                    ) : (
                      <code className="px-1.5 py-0.5 rounded-lg bg-wb-bg-subtle font-mono text-xs" {...props}>
                        {children}
                      </code>
                    );
                  },
                  img({ src, alt, ...props }: any) {
                    return (
                      <span className="block my-4 text-center">
                        <SafeImage
                          compatiblePreview
                          fallback={<span className="text-wb-text-muted">图片加载失败</span>}
                          src={src}
                          alt={alt}
                          onClick={() => openLightbox(src || '', alt)}
                          className="rounded-2xl max-h-[520px] max-w-full w-auto h-auto mx-auto object-contain cursor-zoom-in border border-wb-border-subtle hover:brightness-105 transition-all shadow-sm"
                          loading="lazy"
                          decoding="async"
                          {...props}
                        />
                        {alt && <span className="block text-center text-xs text-wb-text-muted mt-2 font-mono">{alt}</span>}
                      </span>
                    );
                  },
                  a({ href, children, ...props }: any) {
                    const safeHref = typeof href === 'string' ? trimUrlEnding(href) : href;
                    if (safeHref && parseGitHubRepo(safeHref)) {
                      const isStandalone = !children || String(children).includes('github.com') || String(children).trim() === '';
                      return <GitHubRepoCard url={safeHref} inline={!isStandalone} />;
                    }
                    return (
                      <a
                        href={safeHref}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-wb-text-primary underline font-medium hover:opacity-80"
                        {...props}
                      >
                        {children}
                      </a>
                    );
                  },
                }}
              >
                {post.content_md}
              </ReactMarkdown>
              )}
            </div>

            {/* 附加投票 */}
            {poll && (
              <div className="p-5 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-3 my-6">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <BarChart3 className="w-4 h-4 text-wb-text-primary" />
                    <h4 className="font-semibold text-sm text-wb-text-primary">{poll.title}</h4>
                  </div>
                  <span className="text-2xs text-wb-text-muted">
                    {poll.is_expired ? '已截止' : '进行中'} · 共 {poll.total_votes} 票
                  </span>
                </div>

                <div className="space-y-2">
                  {poll.options.map((opt) => {
                    const isSelected = selectedPollOptions.includes(opt.id);
                    return (
                      <button
                        key={opt.id}
                        disabled={poll.is_expired || poll.has_voted}
                        onClick={() => handleVote(opt.id)}
                        className={`w-full relative overflow-hidden text-left p-3 rounded-xl border text-xs transition-all ${
                          opt.is_voted || isSelected
                            ? 'border-wb-text-primary bg-wb-bg-surface font-semibold'
                            : 'border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong'
                        }`}
                      >
                        {poll.has_voted && (
                          <div
                            className="absolute inset-0 bg-wb-border-subtle/40 -z-0 transition-all duration-500"
                            style={{ width: `${opt.percentage}%` }}
                          />
                        )}
                        <div className="relative z-10 flex items-center justify-between">
                          <span>{poll.is_multiple && !poll.has_voted ? `${isSelected ? '☑' : '☐'} ` : ''}{opt.option_text}</span>
                          {poll.has_voted && (
                            <span className="font-mono text-wb-text-muted">
                              {opt.vote_count} 票 ({opt.percentage}%)
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>

                {poll.is_multiple && !poll.has_voted && !poll.is_expired && (
                  <button
                    onClick={() => submitPollVotes(selectedPollOptions)}
                    disabled={selectedPollOptions.length === 0}
                    className={`w-full py-2.5 rounded-xl text-xs font-semibold transition-all ${
                      selectedPollOptions.length > 0
                        ? 'bg-wb-text-primary text-wb-bg hover:opacity-90'
                        : 'bg-wb-bg-subtle text-wb-text-muted cursor-not-allowed'
                    }`}
                  >
                    {selectedPollOptions.length > 0
                      ? `提交投票（已选 ${selectedPollOptions.length}/${poll.max_choices || poll.options.length} 项）`
                      : `提交投票（可多选，最多 ${poll.max_choices || poll.options.length} 项）`}
                  </button>
                )}
              </div>
            )}
            {/* 九宫格相册：按张数自动切换 1 列 / 2 列 / 3 列 */}
            {(post as any).image_urls && (post as any).image_urls.length > 0 && (
              <div className="mt-5">
                {(() => {
                  const urls: string[] = (post as any).image_urls;
                  const n = urls.length;
                  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
                  const maxW = n === 1 ? 'max-w-[420px]' : n <= 4 ? 'max-w-[520px]' : 'max-w-[600px]';
                  return (
                    <div
                      className={`grid gap-1.5 ${maxW}`}
                      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                    >
                      {urls.map((url, i) => (
                        <button
                          key={`${url}-${i}`}
                          type="button"
                          onClick={() => openLightbox(url, `图片 ${i + 1}/${n}`)}
                          className="relative overflow-hidden rounded-xl border border-wb-border-subtle group cursor-zoom-in bg-wb-bg-subtle"
                          style={{ aspectRatio: n === 1 ? 'auto' : '1 / 1' }}
                        >
                          <img
                            src={thumbUrl(url, 480)}
                            srcSet={thumbSrcSet(url)}
                            sizes="(max-width: 768px) 33vw, 200px"
                            alt={`图片 ${i + 1}`}
                            loading="lazy"
                            decoding="async"
                            className={`w-full ${n === 1 ? 'h-auto max-h-[520px] object-contain' : 'h-full object-cover'} transition-transform duration-200 group-hover:scale-[1.03]`}
                          />
                          {n > 9 && i === 8 && (
                            <span className="absolute inset-0 bg-black/55 text-white text-lg font-semibold flex items-center justify-center">
                              +{n - 9}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}
          </article>

          {/* 讨论区：与弹出抽屉共用同一套评论实现，沉浸模式下直接嵌在正文下方 */}
          <div id="comments-section">
            <CommentDrawer
              fontSize={commentFontSize}
              onFontSizeChange={setCommentFontSize}
              embedded
              isOpen
              onClose={() => {}}
              postId={postId}
              postAuthorUsername={post?.author_username}
              commentCount={post?.comment_count || 0}
              commentPolicy={post?.comment_policy}
              quoteText={quoteForComment}
              user={user}
              onRequireAuth={onRequireAuth}
              onSelectUser={onSelectUser}
              targetCommentId={targetCommentId}
              focusSeq={commentFocusSeq}
              refreshToken={commentsRefreshToken}
              onCommentCountChange={() => { void fetchDetail(); }}
              qaSelectMode={qaSelectMode}
              qaSelectedIds={qaSelected}
              onToggleQaAnswer={toggleQaAnswer}
            />
          </div>
        </div>
      ) : (
        /* 全屏宽屏三栏专业布局 (左目录与作者名片 + 中文章正文 + 右互动与讨论交流) */
        <div className="h-full min-h-0 max-w-[1440px] mx-auto px-3 sm:px-6 xl:px-8 lg:h-[calc(100dvh-4.75rem)] lg:overflow-hidden">
          <div
            ref={layoutRef}
            className="flex flex-col lg:flex-row items-center justify-center gap-5 xl:gap-6 h-full min-h-0"
          >
            {/* 左侧栏：固定在视口中保持静止，支持独立静默滚动 */}
            <aside data-left-column="1" className="w-56 xl:w-60 shrink-0 hidden lg:flex flex-col gap-4 h-full pt-10 pb-4 overflow-y-auto thin-scrollbar overscroll-contain">
              {/* 快捷导航与设置 */}
              <div className="p-4 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={onBack}
                    className="wb-pressable flex-1 inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary shadow-sm"
                  >
                    <ArrowLeft className="w-3.5 h-3.5" />
                    <span>返回列表</span>
                  </button>

                  <a
                    href={`/?post=${post.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="在独立新网页标签中打开"
                    className="wb-pressable inline-flex items-center justify-center p-2 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary shadow-sm"
                  >
                    <ExternalLink className="w-3.5 h-3.5" />
                  </a>
                </div>

                <div className="flex items-center justify-between pt-1">
                  {/* 字号微调 */}
                  <div className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-mono shadow-sm">
                    {(['sm', 'base', 'lg'] as const).map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => setFontSize(sz)}
                        className={`px-2 py-0.5 rounded-capsule transition-all ${
                          fontSize === sz
                            ? 'bg-wb-text-primary text-wb-bg-page font-bold shadow-sm'
                            : 'text-wb-text-muted hover:text-wb-text-primary'
                        }`}
                      >
                        {sz === 'sm' ? 'A-' : sz === 'base' ? 'A' : 'A+'}
                      </button>
                    ))}
                  </div>

                  {/* 沉浸阅读 */}
                  <button
                    type="button"
                    onClick={() => setZenMode(true)}
                    className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1 rounded-capsule border border-wb-border-subtle text-2xs text-wb-text-secondary hover:text-wb-text-primary bg-wb-bg-subtle"
                  >
                    <Maximize2 className="w-3 h-3" />
                    <span>沉浸</span>
                  </button>
                </div>
              </div>

              {/* 作者名片卡片 */}
              <div className="p-4 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-3">
                <div className="flex items-center justify-between text-2xs font-semibold text-wb-text-muted">
                  <span>作者名片</span>
                  <LevelBadge level={post.author_level} />
                </div>
                <div
                  onClick={() => onSelectUser?.(post.author_username)}
                  className="flex items-center gap-3 cursor-pointer group"
                >
                  <UserAvatar
                    username={post.author_username}
                    avatarUrl={post.author_avatar}
                    size={42}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="font-bold text-sm text-wb-text-primary group-hover:underline truncate">
                      {post.author_nickname || post.author_username}
                    </div>
                    <div className="text-xs text-wb-text-muted font-mono truncate">
                      @{post.author_username}
                    </div>
                  </div>
                </div>

                <div className="pt-2 border-t border-wb-border-subtle flex items-center justify-between text-xs text-wb-text-muted">
                  <span>{formatEast8Date(post.created_at)}</span>
                  <button
                    type="button"
                    onClick={() => onSelectUser?.(post.author_username)}
                    className="text-wb-text-primary hover:underline font-medium text-xs"
                  >
                    查看主页 &rarr;
                  </button>
                </div>
              </div>

              {/* 文章大纲目录 (左侧固定) */}
              {post.content_md && (
                <>
                  <TableOfContents contentMd={post.content_md} defaultOpen={true} />
                  <RelatedPosts
                    postId={post.id}
                    categoryId={(post as any).category_id}
                    categoryName={(post as any).category?.name || (post as any).category_name}
                    onSelectPost={onSelectPost}
                  />
                </>
              )}
            </aside>

            {/* 中间栏：正文内容 */}
            <main ref={articleScrollRef} className="flex-1 min-w-0 max-w-[820px] xl:max-w-[860px] w-full h-full min-h-0 overflow-y-auto overflow-x-clip overscroll-contain py-4 px-1 pb-28 lg:pb-4 reader-scrollbar space-y-6 scroll-smooth">
              {/* 移动端顶部快捷条 */}
              <div className="flex lg:hidden items-center justify-between gap-2 overflow-x-auto no-scrollbar -mx-1 px-1">
                <button
                  onClick={onBack}
                  className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary shadow-sm shrink-0"
                >
                  <ArrowLeft className="w-3.5 h-3.5" />
                  <span>返回列表</span>
                </button>

                <div className="flex items-center gap-2 flex-wrap shrink-0">
                  <a
                    href={`/?post=${post.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="新标签页打开"
                    className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary shadow-sm"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>新窗口</span>
                  </a>

                  {/* 弹出抽屉快捷按钮 */}
                  <button
                    type="button"
                    onClick={() => setCommentDrawerOpen(true)}
                    className="wb-pressable inline-flex items-center gap-1.5 px-3 py-1.5 rounded-capsule bg-wb-brand text-white text-xs font-semibold shadow-sm hover:opacity-95"
                    title="展开讨论与问答抽屉 (快捷键 C)"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    <span>讨论中心</span>
                    <span className="px-1.5 py-0.2 rounded-full bg-white/25 text-3xs font-mono">
                      {post?.comment_count || 0}
                    </span>
                  </button>

                  {/* 布局版本切换器 */}
                  {onToggleMode && (
                    <button
                      type="button"
                      onClick={onToggleMode}
                      className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle hover:border-wb-border-strong text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary shadow-sm"
                      title="切换回侧边栏常驻版"
                    >
                      <span className="text-wb-warn">⚡</span>
                      <span>切回侧栏版</span>
                    </button>
                  )}

                  {/* 字号微调切换器 */}
                  <div className="inline-flex items-center p-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-2xs font-mono shadow-sm">
                    {(['sm', 'base', 'lg'] as const).map((sz) => (
                      <button
                        key={sz}
                        type="button"
                        onClick={() => setFontSize(sz)}
                        className={`px-1.5 py-0.5 rounded-capsule ${
                          fontSize === sz ? 'bg-wb-text-primary text-wb-bg-page font-bold' : 'text-wb-text-muted'
                        }`}
                      >
                        {sz === 'sm' ? 'A-' : sz === 'base' ? 'A' : 'A+'}
                      </button>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => setZenMode(true)}
                    className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs text-wb-text-secondary"
                  >
                    <Maximize2 className="w-3.5 h-3.5" />
                    <span className="hidden sm:inline">沉浸</span>
                  </button>

                  <button
                    onClick={handleShare}
                    className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs text-wb-text-secondary"
                  >
                    <Share2 className="w-3.5 h-3.5" />
                  </button>

                  <button
                    onClick={handleCollect}
                    className="wb-pressable inline-flex items-center gap-1 px-2.5 py-1.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-xs text-wb-text-secondary"
                  >
                    <Bookmark className={`w-3.5 h-3.5 ${post.is_collected ? 'fill-current' : ''}`} />
                  </button>
                </div>
              </div>

              {/* 主文章卡片 */}
              <article className="p-6 md:p-8 rounded-3xl surface border border-wb-border-subtle shadow-card space-y-6">
                {/* 元信息 */}
                <div className="space-y-3 border-b border-wb-border-subtle pb-6">
                  <div className="flex items-center justify-between gap-3 text-xs text-wb-text-secondary flex-wrap pb-1">
                    <div className="flex items-center gap-2 flex-wrap min-w-0">
                    <div
                      onClick={() => onSelectUser?.(post.author_username)}
                      className="inline-flex items-center gap-2 cursor-pointer hover:opacity-80 transition-opacity group/author"
                      title={`查看 @${post.author_username} 的极客主页`}
                    >
                      <UserAvatar
                        username={post.author_username}
                        avatarUrl={post.author_avatar}
                        size="xs"
                      />
                      <span className="font-semibold text-wb-text-primary group-hover/author:underline">
                        {post.author_nickname || post.author_username}
                      </span>
                      {post.author_nickname && (
                        <span className="text-2xs text-wb-text-muted font-mono">
                          @{post.author_username}
                        </span>
                      )}
                    </div>
                    <LevelBadge level={post.author_level} />
                    {post.is_pinned && (
                      <span className="inline-flex items-center gap-1 text-2xs px-2 py-0.5 rounded-capsule bg-wb-bg-subtle text-wb-text-primary font-semibold">
                        <Pin className="w-3 h-3" /> 置顶
                      </span>
                    )}
                    {post.is_essence && (
                      <span className="inline-flex items-center gap-1 text-2xs px-2.5 py-0.5 rounded-capsule bg-wb-brand/15 text-wb-brand border border-wb-brand/25 font-bold shadow-xs">
                        <Sparkles className="w-3 h-3 text-wb-brand" /> 精华推荐
                      </span>
                    )}
                    </div>
                    {/* 聚合式文章与版务管理菜单 */}
                    <div className="ml-auto shrink-0">
                      {isAuthorOrAdmin && renderManagementMenu()}
                    </div>
                  </div>

                  <h1 className="text-xl md:text-3xl font-bold text-wb-text-primary leading-tight">
                    {getSmartDailyTitle(post.title, post.content_md)}
                  </h1>

                  <div className="flex items-center gap-4 text-xs text-wb-text-muted flex-wrap">
                    <span className="inline-flex items-center gap-1 font-mono">
                      <Clock className="w-3.5 h-3.5" /> 发布于 {formatEast8Full(post.created_at)}
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono">
                      约 {wordCount} 字
                    </span>
                    <span className="inline-flex items-center gap-1 font-mono">
                      <Eye className="w-3.5 h-3.5" /> {post.view_count} 次阅读
                    </span>
                  </div>

                  {/* 话题标签 */}
                  {post.tags && post.tags.length > 0 && (
                    <div className="flex items-center gap-1.5 flex-wrap pt-1">
                      {post.tags.map((tag) => (
                        <span
                          key={tag}
                          className="text-xs font-mono px-2.5 py-0.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-secondary select-none"
                        >
                          #{tag}
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                {/* 移动端/小屏文章大纲目录 (桌面端已在左侧栏展示) */}
                <div className="lg:hidden">
                  {/* 手机上目录默认收起：整块展开会吃掉大半屏，读者还没看到正文就先看到一屏标题 */}
                  {!zenMode && post.content_md && (
                    <button
                      type="button"
                      onClick={() => setMobileTocOpen(true)}
                      className="w-full min-h-[44px] flex items-center justify-between gap-2 px-4 py-3 rounded-2xl border border-wb-border-subtle bg-wb-bg-surface/60 text-xs font-semibold text-wb-text-primary active:scale-[0.99] transition-transform"
                    >
                      <span className="flex items-center gap-2">
                        <ListFilter className="w-4 h-4" />
                        文章目录
                      </span>
                      <span className="flex items-center gap-1 text-3xs font-normal text-wb-text-muted">
                        {tocCount} 节
                        <ChevronRight className="w-3.5 h-3.5" />
                      </span>
                    </button>
                  )}
                </div>

        {/* 好文分享：明显标注原创 / 搬运，搬运附一行地址 */}
        {post.source_type && (
        <div className={`mb-4 p-3 rounded-2xl border ${post.source_type === 'original' ? 'bg-wb-success/10 border-wb-success/30' : 'bg-wb-info/10 border-wb-info/30'}`}>
        <div className="flex items-center gap-2 text-2xs font-bold text-wb-text-primary">
        <span className={`px-2 py-0.5 rounded-capsule text-3xs ${post.source_type === 'original' ? 'bg-wb-success text-white' : 'bg-wb-info text-white'}`}>
        {post.source_type === 'original' ? '原创' : '搬运'}
        </span>
        {post.source_type === 'original' ? '本文由作者原创发布' : '本文搬运自其它来源，版权归原作者所有'}
        </div>
        {post.source_type === 'repost' && post.source_note && (
        <p className="mt-1.5 text-3xs text-wb-text-secondary break-all">
        搬运地址：{
        /^https?:\/\//i.test(post.source_note)
        ? <a href={post.source_note} target="_blank" rel="noreferrer noopener" className="text-wb-info underline underline-offset-2">{post.source_note}</a>
        : post.source_note
        }
        </p>
        )}
        </div>
        )}

        {/* 问答广场：悬赏状态、采纳期与批量采纳结算 */}
        {qaState && (
        <div className="mb-4">
        <QaBountyCard
        postId={postId}
        state={qaState}
        selectMode={qaSelectMode}
        selected={qaSelected}
        onToggleSelectMode={() => { setQaSelectMode((v) => !v); setQaSelected([]); }}
        onClearSelected={() => { setQaSelected([]); setQaSelectMode(false); }}
        onSettled={() => { void fetchDetail(); setCommentsRefreshToken((n) => n + 1); }}
        />
        </div>
        )}

                {/* Markdown 正文渲染 */}
                <div
                  className={`prose dark:prose-invert max-w-none max-w-full min-w-0 text-wb-text-primary space-y-4 ${
                    fontSize === 'sm'
                      ? 'text-sm leading-normal'
                      : fontSize === 'lg'
                      ? 'text-lg leading-loose'
                      : 'text-base leading-relaxed'
                  }`}
                >
                  {(post as any).content_type === 'plain' ? (
                    <div className="whitespace-pre-wrap break-words text-sm md:text-base leading-relaxed">{post.content_md}</div>
                  ) : (
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm, remarkBreaks]}
                    components={{
                      ...buildHeadingComponents(),
                      code({ inline, className, children, ...props }: any) {
                        const match = /language-(\w+)/.exec(className || '');
                        const codeString = String(children).replace(/\n$/, '');
                        const isMultiLine = codeString.includes('\n');
                        return !inline && (match || isMultiLine) ? (
                          <CodeBlock language={match ? match[1] : 'text'} value={codeString} />
                        ) : (
                          <code className="px-1.5 py-0.5 rounded-lg bg-wb-bg-subtle font-mono text-xs" {...props}>
                            {children}
                          </code>
                        );
                      },
                      img({ src, alt, ...props }: any) {
                        return (
                          <span className="block my-4 text-center">
                            <SafeImage
                              compatiblePreview
                              fallback={<span className="text-wb-text-muted">图片加载失败</span>}
                              src={src}
                              alt={alt}
                              onClick={() => openLightbox(src || '', alt)}
                              className="rounded-2xl max-h-[520px] max-w-full w-auto h-auto mx-auto object-contain cursor-zoom-in border border-wb-border-subtle hover:brightness-105 transition-all shadow-sm"
                              loading="lazy"
                              decoding="async"
                              {...props}
                            />
                            {alt && <span className="block text-center text-xs text-wb-text-muted mt-2 font-mono">{alt}</span>}
                          </span>
                        );
                      },
                      a({ href, children, ...props }: any) {
                        const safeHref = typeof href === 'string' ? trimUrlEnding(href) : href;
                        if (safeHref && parseGitHubRepo(safeHref)) {
                          const isStandalone = !children || String(children).includes('github.com') || String(children).trim() === '';
                          return <GitHubRepoCard url={safeHref} inline={!isStandalone} />;
                        }
                        return (
                          <a
                            href={safeHref}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-wb-text-primary underline font-medium hover:opacity-80"
                            {...props}
                          >
                            {children}
                          </a>
                        );
                      },
                    }}
                  >
                    {post.content_md}
                  </ReactMarkdown>
                  )}
                </div>

                {/* 嵌入式投票组件 */}
                {poll && (
                  <div className="p-5 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-3 my-6">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <BarChart3 className="w-4 h-4 text-wb-text-primary" />
                        <h4 className="font-semibold text-sm text-wb-text-primary">{poll.title}</h4>
                      </div>
                      <span className="text-2xs text-wb-text-muted">
                        {poll.is_expired ? '已截止' : '进行中'} · 共 {poll.total_votes} 票
                      </span>
                    </div>

                    <div className="space-y-2">
                      {poll.options.map((opt) => {
                        const isSelected = selectedPollOptions.includes(opt.id);
                        return (
                          <button
                            key={opt.id}
                            disabled={poll.is_expired || poll.has_voted}
                            onClick={() => handleVote(opt.id)}
                            className={`w-full relative overflow-hidden text-left p-3 rounded-xl border text-xs transition-all ${
                              opt.is_voted || isSelected
                                ? 'border-wb-text-primary bg-wb-bg-surface font-semibold'
                                : 'border-wb-border-subtle bg-wb-bg-surface hover:border-wb-border-strong'
                            }`}
                          >
                            {poll.has_voted && (
                              <div
                                className="absolute inset-0 bg-wb-border-subtle/40 -z-0 transition-all duration-500"
                                style={{ width: `${opt.percentage}%` }}
                              />
                            )}
                            <div className="relative z-10 flex items-center justify-between">
                              <span>{poll.is_multiple && !poll.has_voted ? `${isSelected ? '☑' : '☐'} ` : ''}{opt.option_text}</span>
                              {poll.has_voted && (
                                <span className="font-mono text-wb-text-muted">
                                  {opt.vote_count} 票 ({opt.percentage}%)
                                </span>
                              )}
                            </div>
                          </button>
                        );
                      })}
                    </div>

                    {poll.is_multiple && !poll.has_voted && !poll.is_expired && (
                      <button
                        onClick={() => submitPollVotes(selectedPollOptions)}
                        disabled={selectedPollOptions.length === 0}
                        className={`w-full py-2.5 rounded-xl text-xs font-semibold transition-all ${
                          selectedPollOptions.length > 0
                            ? 'bg-wb-text-primary text-wb-bg hover:opacity-90'
                            : 'bg-wb-bg-subtle text-wb-text-muted cursor-not-allowed'
                        }`}
                      >
                        {selectedPollOptions.length > 0
                          ? `提交投票（已选 ${selectedPollOptions.length}/${poll.max_choices || poll.options.length} 项）`
                          : `提交投票（可多选，最多 ${poll.max_choices || poll.options.length} 项）`}
                      </button>
                    )}
                  </div>
                )}

                {/* 互动行动栏: 点赞 / 表情反应 / 收藏 / 分享 */}
                <div className="flex flex-wrap items-center justify-between gap-3 pt-6 border-t border-wb-border-subtle">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      onClick={handleLike}
                      className={`wb-pressable flex items-center gap-2 px-5 py-2.5 rounded-capsule border text-xs font-semibold shadow-sm transition-all whitespace-nowrap shrink-0 ${
                        post.is_liked
                          ? 'bg-wb-text-primary text-wb-bg-page border-transparent'
                          : 'bg-wb-bg-surface text-wb-text-primary border-wb-border-strong hover:bg-wb-bg-subtle'
                      }`}
                    >
                      <Heart className={`w-4 h-4 shrink-0 ${post.is_liked ? 'fill-current' : ''}`} />
                      <span className="whitespace-nowrap">{post.is_liked ? '已点赞' : '点赞支持'}{post.like_count > 0 ? ` (${post.like_count})` : ''}</span>
                    </button>

                    {/* 极客表情反应选择器 */}
                    <ReactionPicker
                      targetId={post.id}
                      reactions={postReactions}
                      userReactions={postUserReactions}
                      onToggleReaction={handleTogglePostReaction}
                    />
                  </div>

                  <div className="flex items-center gap-2 flex-wrap shrink-0">
                    <button
                      onClick={handleCollect}
                      className={`wb-pressable flex items-center gap-2 px-4 py-2.5 rounded-capsule border text-xs font-semibold shadow-sm transition-all whitespace-nowrap shrink-0 ${
                        post.is_collected
                          ? 'bg-wb-text-primary text-wb-bg-page border-transparent'
                          : 'bg-wb-bg-surface text-wb-text-secondary border-wb-border-strong hover:text-wb-text-primary hover:bg-wb-bg-subtle'
                      }`}
                    >
                      <Bookmark className={`w-4 h-4 shrink-0 ${post.is_collected ? 'fill-current' : ''}`} />
                      <span className="whitespace-nowrap">{post.is_collected ? '已收藏' : '收藏'}</span>
                    </button>

                    <button
                      onClick={handleShare}
                      className="wb-pressable flex items-center gap-2 px-4 py-2.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-surface text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary hover:border-wb-border-strong transition-all shadow-sm whitespace-nowrap shrink-0"
                    >
                      <Share2 className="w-4 h-4 shrink-0" />
                      <span className="whitespace-nowrap">分享</span>
                    </button>
                  </div>
                </div>
            {/* 九宫格相册：按张数自动切换 1 列 / 2 列 / 3 列 */}
            {(post as any).image_urls && (post as any).image_urls.length > 0 && (
              <div className="mt-5">
                {(() => {
                  const urls: string[] = (post as any).image_urls;
                  const n = urls.length;
                  const cols = n === 1 ? 1 : n <= 4 ? 2 : 3;
                  const maxW = n === 1 ? 'max-w-[420px]' : n <= 4 ? 'max-w-[520px]' : 'max-w-[600px]';
                  return (
                    <div
                      className={`grid gap-1.5 ${maxW}`}
                      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
                    >
                      {urls.map((url, i) => (
                        <button
                          key={`${url}-${i}`}
                          type="button"
                          onClick={() => openLightbox(url, `图片 ${i + 1}/${n}`)}
                          className="relative overflow-hidden rounded-xl border border-wb-border-subtle group cursor-zoom-in bg-wb-bg-subtle"
                          style={{ aspectRatio: n === 1 ? 'auto' : '1 / 1' }}
                        >
                          <img
                            src={thumbUrl(url, 480)}
                            srcSet={thumbSrcSet(url)}
                            sizes="(max-width: 768px) 33vw, 200px"
                            alt={`图片 ${i + 1}`}
                            loading="lazy"
                            decoding="async"
                            className={`w-full ${n === 1 ? 'h-auto max-h-[520px] object-contain' : 'h-full object-cover'} transition-transform duration-200 group-hover:scale-[1.03]`}
                          />
                          {n > 9 && i === 8 && (
                            <span className="absolute inset-0 bg-black/55 text-white text-lg font-semibold flex items-center justify-center">
                              +{n - 9}
                            </span>
                          )}
                        </button>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}
              </article>

              {/* 移动端/小屏幕下的评论区 */}
              {/* 移动端：桌面侧栏在手机上是隐藏的，这里补一个相似文章入口 */}
              <MobileTocSheet
                open={mobileTocOpen}
                onClose={() => setMobileTocOpen(false)}
                contentMd={post.content_md || ''}
              />

              <div className="lg:hidden">
                <RelatedPosts
                  postId={post.id}
                  categoryId={(post as any).category_id}
                  categoryName={(post as any).category?.name || (post as any).category_name}
                  onSelectPost={onSelectPost}
                />
              </div>

              {/* 文章底部讨论交流抽屉唤起大卡片 */}
              <div
                onClick={() => setCommentDrawerOpen(true)}
                className="wb-pressable p-6 md:p-8 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card hover:border-wb-brand transition-all cursor-pointer flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 group"
              >
                <div className="flex items-center gap-4">
                  <div className="p-3.5 rounded-2xl bg-wb-brand/10 text-wb-brand group-hover:scale-110 transition-transform shrink-0">
                    <MessageSquare className="w-6 h-6" />
                  </div>
                  <div>
                    <h3 className="font-bold text-base text-wb-text-primary group-hover:text-wb-brand transition-colors flex items-center gap-2">
                      <span>讨论交流与问答中心</span>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-wb-brand/15 text-wb-brand font-mono font-bold">
                        {post?.comment_count || 0} 条讨论
                      </span>
                    </h3>
                    <p className="text-xs text-wb-text-muted mt-1">
                      阅读完毕？点击右侧悬浮栏或此处展开抽屉参与交流，支持就地跟帖、表情包与 Markdown 代码
                    </p>
                  </div>
                </div>
                <button
                  type="button"
                  className="wb-pressable px-4 py-2.5 rounded-capsule bg-wb-brand text-white text-xs font-semibold shadow-md group-hover:opacity-95 flex items-center gap-2 shrink-0"
                >
                  <span>展开讨论抽屉</span>
                  <CornerDownRight className="w-3.5 h-3.5" />
                </button>
              </div>
            </main>

            {/* 右侧栏：与左侧栏完全对等 (w-56 xl:w-60)，全高上下居中 (justify-center) 悬浮胶囊，pl-2 紧贴文章右侧 */}
            <aside className="w-56 xl:w-60 shrink-0 hidden lg:flex flex-col items-start justify-center h-full pl-2 pointer-events-none">
              <div className="pointer-events-auto">
                {renderFloatingVerticalDock()}
              </div>
            </aside>
          </div>
        </div>
      )}

      {/* 消息通知样式的右侧滑出抽屉评论中心 */}
      {/* 沉浸模式已有下方常驻评论区，不再重复挂载弹出抽屉 */}
      {!zenMode && (
      <CommentDrawer
        fontSize={commentFontSize}
        onFontSizeChange={setCommentFontSize}
        isOpen={commentDrawerOpen}
        onClose={() => setCommentDrawerOpen(false)}
        postId={postId}
        postAuthorUsername={post?.author_username}
        commentCount={post?.comment_count || 0}
        user={user}
        onRequireAuth={onRequireAuth}
        onSelectUser={onSelectUser}
        targetCommentId={targetCommentId}
        focusSeq={commentFocusSeq}
        refreshToken={commentsRefreshToken}
        commentPolicy={post?.comment_policy}
        quoteText={quoteForComment}
        onCommentCountChange={() => { void fetchDetail(); }}
        qaSelectMode={qaSelectMode}
        qaSelectedIds={qaSelected}
        onToggleQaAnswer={toggleQaAnswer}
      />
      )}

      {/* 更换分区弹窗 (换区) */}
      {changeCategoryOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="操作对话框"
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={(e) => {
              if (e.target === e.currentTarget) setChangeCategoryOpen(false);
            }}
          >
            <div className="max-w-sm w-full surface border border-wb-border-subtle rounded-3xl p-6 shadow-2xl space-y-4 animate-scale-in">
              <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
                <div className="flex items-center gap-2">
                  <Tag className="w-4 h-4 text-wb-brand" />
                  <h3 className="font-bold text-sm text-wb-text-primary">更换文章分区 (换区)</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setChangeCategoryOpen(false)}
                  className="text-wb-text-muted hover:text-wb-text-primary p-1 text-xs"
                >
                  ✕
                </button>
              </div>
              <p className="text-xs text-wb-text-muted">
                当前分区：<strong className="text-wb-text-primary font-semibold">{post?.category_name || '未分区'}</strong>。请选择要转移至的目标版块：
              </p>
              <div className="space-y-2 max-h-60 overflow-y-auto pr-1">
                {categoryList.map((cat) => (
                  <button
                    key={cat.id}
                    type="button"
                    onClick={() => handleChangeCategory(cat.id, cat.name)}
                    className={`w-full flex items-center justify-between p-3 rounded-2xl border text-xs font-medium transition-all ${
                      post?.category_id === cat.id
                        ? 'border-wb-brand bg-wb-brand/10 text-wb-brand font-bold'
                        : 'border-wb-border-subtle hover:border-wb-border-strong bg-wb-bg-subtle hover:bg-wb-bg-surface text-wb-text-primary'
                    }`}
                  >
                    <span>{cat.name}</span>
                    {post?.category_id === cat.id && (
                      <span className="text-2xs font-mono px-2 py-0.5 rounded-capsule bg-wb-brand text-white">当前</span>
                    )}
                  </button>
                ))}
              </div>
              <div className="pt-2 border-t border-wb-border-subtle flex justify-end">
                <button
                  type="button"
                  onClick={() => setChangeCategoryOpen(false)}
                  className="wb-pressable px-4 py-1.5 rounded-capsule bg-wb-bg-subtle text-xs text-wb-text-secondary hover:text-wb-text-primary"
                >
                  取消
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* 举报模态弹窗 - 采用 createPortal 挂载至 document.body，绝不被页面长滚动或父级 transform 破坏视口居中 */}
      {reportOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="操作对话框"
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={(e) => {
              if (e.target === e.currentTarget) setReportOpen(false);
            }}
          >
            <div
              className="w-full max-w-sm bg-wb-bg-elevated border border-wb-border-strong rounded-3xl p-6 shadow-2xl space-y-4 animate-scale-up"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between pb-2 border-b border-wb-border-subtle">
                <div className="flex items-center gap-2 text-wb-text-primary">
                  <ShieldAlert className="w-4 h-4 text-wb-danger" />
                  <h3 className="font-semibold text-sm">向管理员举报违规</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setReportOpen(false)}
                  className="text-wb-text-muted hover:text-wb-text-primary text-xs"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-2.5 text-xs text-wb-text-secondary">
                <span className="text-2xs text-wb-text-muted font-medium block">请选择违规类型:</span>
                {[
                  { key: 'spam', label: '垃圾广告 / 推广营销' },
                  { key: 'attack', label: '人身攻击 / 恶意辱骂' },
                  { key: 'illegal', label: '违法违规内容' },
                  { key: 'privacy', label: '侵权 / 隐私泄露' },
                  { key: 'other', label: '其他违规事由' },
                ].map((item) => (
                  <label
                    key={item.key}
                    className={`flex items-center gap-2 p-2.5 rounded-xl border cursor-pointer transition-colors ${
                      reportReason === item.key
                        ? 'border-wb-text-primary bg-wb-bg-subtle text-wb-text-primary font-medium'
                        : 'border-wb-border-subtle hover:border-wb-border-strong'
                    }`}
                  >
                    <input
                      type="radio"
                      name="reason"
                      checked={reportReason === item.key}
                      onChange={() => setReportReason(item.key)}
                      className="text-wb-text-primary focus:ring-0"
                    />
                    <span>{item.label}</span>
                  </label>
                ))}
              </div>

              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-2xs text-wb-text-muted font-medium">详细举报原因 <span className="text-wb-danger">*</span></span>
                  <span className={`text-3xs font-mono ${reportDesc.trim().length < 10 ? 'text-wb-danger' : 'text-wb-text-muted'}`}>
                    {reportDesc.length}/500 · 至少 10 字
                  </span>
                </div>
                <textarea
                  rows={4}
                  value={reportDesc}
                  maxLength={500}
                  onChange={(e) => setReportDesc(e.target.value)}
                  placeholder="请具体说明违规位置、表现与影响，帮助管理员快速核实…"
                  className="w-full p-2.5 text-xs bg-wb-bg-subtle border border-wb-border-subtle rounded-xl text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:border-wb-border-strong resize-none"
                />
              </div>

              {/* 可选截图：点击上传或直接粘贴 */}
              <div className="flex items-center gap-2 flex-wrap">
                <label className="inline-flex items-center gap-1.5 h-8 px-2.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-2xs text-wb-text-secondary hover:text-wb-text-primary cursor-pointer">
                  {reportImageUploading ? (
                    <span className="w-3 h-3 border-2 border-wb-text-muted border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <ImagePlus className="w-3.5 h-3.5" />
                  )}
                  {reportImageUploading ? '上传中' : '附上截图'}
                  <input type="file" accept="image/*" className="hidden" onChange={handleReportImage} />
                </label>
                {reportImageUrl && (
                  <div className="inline-flex items-center gap-1.5">
                    <img src={reportImageUrl} alt="举报截图" className="w-8 h-8 rounded-lg object-cover border border-wb-border-subtle" />
                    <button type="button" onClick={() => setReportImageUrl('')} className="text-3xs text-wb-text-muted hover:text-wb-danger">移除</button>
                  </div>
                )}
                <span className="text-3xs text-wb-text-muted">选填，可附一张截图</span>
              </div>

              <div className="flex gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={() => setReportOpen(false)}
                  className="wb-pressable flex-1 py-2.5 rounded-capsule bg-wb-bg-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleReport}
                  disabled={reportSubmitting || reportDesc.trim().length < 10}
                  className="wb-pressable flex-1 py-2.5 rounded-capsule bg-wb-danger text-white text-xs font-semibold shadow-sm hover:opacity-95 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {reportSubmitting ? '提交中…' : '确认提交举报'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* 作者编辑文章模态弹窗 */}
      {/* 编辑历史弹窗 */}
      <Modal open={editsOpen} onClose={() => setEditsOpen(false)} widthClass="max-w-2xl">
        <div className="p-5 md:p-6 space-y-4 max-h-[75vh] overflow-y-auto">
          <div className="flex items-center justify-between gap-2">
            <h3 className="font-bold text-sm text-wb-text-primary flex items-center gap-2">
              <Clock className="w-4 h-4" /> 编辑历史
            </h3>
            <span className="text-2xs text-wb-text-muted font-mono">最近 {edits.length} 个历史版本</span>
          </div>

          {loadingEdits ? (
            <p className="py-10 text-center text-xs text-wb-text-muted">加载中...</p>
          ) : edits.length === 0 ? (
            <p className="py-10 text-center text-xs text-wb-text-muted">暂无历史版本</p>
          ) : (
            <div className="space-y-2">
              {edits.map((item) => (
                <div
                  key={item.id}
                  className="p-3 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-2"
                >
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="text-xs font-medium text-wb-text-primary line-clamp-1">
                      {item.old_title || '（无标题）'}
                    </span>
                    <span className="text-2xs text-wb-text-muted font-mono shrink-0">
                      {formatEast8Date(item.created_at)}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-2xs text-wb-text-muted">
                      编辑者：{item.editor_nickname || item.editor_username || '未知'}
                    </span>
                    <button
                      type="button"
                      onClick={() => setExpandedEditId(expandedEditId === item.id ? null : item.id)}
                      className="text-2xs font-semibold text-wb-text-primary hover:underline"
                    >
                      {expandedEditId === item.id ? '收起版本' : '查看该版本正文'}
                    </button>
                  </div>
                  {expandedEditId === item.id && (
                    <pre className="mt-1 p-3 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-2xs text-wb-text-secondary whitespace-pre-wrap break-words max-h-64 overflow-y-auto">
                      {item.old_content_md}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </Modal>

      {editPostOpen &&
        createPortal(
          <div
            role="dialog"
            aria-modal="true"
            aria-label="操作对话框"
            className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-fade-in"
            onClick={(e) => {
              if (e.target === e.currentTarget) {
                const isDirty = editTitle !== (post?.title || '') || editContent !== (post?.content_md || '');
                if (!isDirty) {
                  setEditPostOpen(false);
                }
              }
            }}
          >
            <div
              className="w-full max-w-2xl bg-wb-bg-elevated border border-wb-border-strong rounded-3xl p-6 md:p-8 shadow-2xl space-y-5 animate-scale-up max-h-[90vh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between pb-3 border-b border-wb-border-subtle">
                <div className="flex items-center gap-2 text-wb-text-primary">
                  <Edit3 className="w-4 h-4 text-wb-text-primary" />
                  <h3 className="font-bold text-base">修改文章内容</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setEditPostOpen(false)}
                  className="text-wb-text-muted hover:text-wb-text-primary text-xs p-1"
                >
                  ✕
                </button>
              </div>

              <div className="space-y-4 text-xs">
                <div>
                  <label className="block text-xs font-semibold text-wb-text-secondary mb-1">
                    文章标题
                  </label>
                  <input
                    type="text"
                    value={editTitle}
                    onChange={(e) => setEditTitle(e.target.value)}
                    placeholder="输入文章标题..."
                    className="w-full px-3.5 py-2.5 bg-wb-bg-subtle border border-wb-border-subtle rounded-xl text-wb-text-primary font-medium focus:outline-none focus:border-wb-border-strong text-sm"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-wb-text-secondary mb-1">
                    Markdown 正文
                  </label>
                  <textarea
                    rows={12}
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    placeholder="编辑 Markdown 正文..."
                    className="w-full p-3.5 bg-wb-bg-subtle border border-wb-border-subtle rounded-xl text-wb-text-primary font-mono text-xs focus:outline-none focus:border-wb-border-strong leading-relaxed resize-y"
                  />
                </div>
              </div>

              <div className="flex items-center justify-end gap-3 pt-2 border-t border-wb-border-subtle">
                <button
                  type="button"
                  onClick={() => setEditPostOpen(false)}
                  className="wb-pressable px-4 py-2 rounded-capsule bg-wb-bg-subtle text-xs font-medium text-wb-text-secondary hover:text-wb-text-primary"
                >
                  取消
                </button>
                <button
                  type="button"
                  disabled={savingEdit}
                  onClick={handleSavePostEdit}
                  className="wb-pressable px-5 py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-semibold shadow-sm hover:opacity-90 disabled:opacity-50"
                >
                  {savingEdit ? '保存中...' : '保存修改'}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* 文章分享卡片与海报生成弹窗 */}
      <PostShareModal
        isOpen={shareModalOpen}
        onClose={() => setShareModalOpen(false)}
        post={post}
        readingMinutes={readingMinutes}
        wordCount={wordCount}
      />

      {/* 内联快速评论：点底栏直接在原地写，不打断当前阅读位置 */}
      {quickOpen && (
        <div
          className="lg:hidden fixed inset-0 z-[80] bg-black/40"
          onClick={() => setQuickOpen(false)}
        >
          <div
            className="absolute left-2 right-2 rounded-2xl frost border border-wb-border-strong shadow-2xl p-3 space-y-2"
            style={{
              bottom:
                kbOffset > 0
                  ? `${kbOffset + 8}px`
                  : 'calc(0.75rem + env(safe-area-inset-bottom, 0px))',
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <MentionTextarea
              textareaRef={quickInputRef}
              value={quickText}
              onChange={setQuickText}
              rows={3}
              disabled={isAnonymous}
              placeholder={isAnonymous ? '匿名评论不支持 @ 提及' : '写下你的极客见解，输入 @ 可提及他人...'}
              className="w-full resize-none bg-wb-bg-subtle border border-wb-border-subtle rounded-xl p-2.5 text-xs text-wb-text-primary placeholder:text-wb-text-muted focus:outline-none focus:border-wb-border-strong"
            />
            <div className="flex items-center justify-between gap-2">
              <span className="text-3xs text-wb-text-muted">
                {isAnonymous ? '匿名发布' : `以 @${user?.username || ''} 身份发布`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => setQuickOpen(false)}
                  className="px-3 h-8 rounded-full text-xs text-wb-text-secondary border border-wb-border-subtle bg-wb-bg-subtle"
                >
                  取消
                </button>
                <button
                  type="button"
                  onClick={handleQuickSubmit}
                  disabled={quickSending || !quickText.trim()}
                  className="px-4 h-8 rounded-full text-xs font-semibold bg-wb-text-primary text-wb-bg-page disabled:opacity-40"
                >
                  {quickSending ? '发送中' : '发送'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 移动端吸底操作栏 (底栏浮动唤起) */}
      <div
        className="lg:hidden fixed left-3 right-3 z-40 frost border border-wb-border-subtle rounded-2xl px-3 h-14 shadow-lg flex items-center justify-between gap-3 transition-[transform,opacity] duration-300 ease-out will-change-transform"
        style={{
          bottom: 'calc(0.65rem + env(safe-area-inset-bottom, 0px))',
          transform: barHidden ? 'translateY(170%)' : 'translateY(0)',
          opacity: barHidden ? 0 : 1,
        }}
      >
        {/* 快捷评论输入触发框 */}
        <button
          type="button"
          onClick={() => setQuickOpen(true)}
          className="flex-1 flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-wb-bg-subtle border border-wb-border-subtle text-xs text-wb-text-muted hover:text-wb-text-primary text-left transition-colors"
        >
          <Edit3 className="w-3.5 h-3.5 text-wb-text-muted" />
          <span className="truncate">写下你的极客见解...</span>
        </button>

        {/* 快捷互动小动作 */}
        <div className="flex items-center gap-3 shrink-0">
          <button
            type="button"
            onClick={handleLike}
            className="inline-flex items-center gap-1 text-xs text-wb-text-secondary hover:text-wb-text-primary"
          >
            <Heart className={`w-4 h-4 ${post.is_liked ? 'text-wb-danger fill-current' : ''}`} />
            <span>{post.like_count > 0 ? post.like_count : ''}</span>
          </button>

          <button
            type="button"
            onClick={handleCollect}
            className="inline-flex items-center gap-1 text-xs text-wb-text-secondary hover:text-wb-text-primary"
          >
            <Bookmark className={`w-4 h-4 ${post.is_collected ? 'text-wb-text-primary fill-current' : ''}`} />
            <span>{post.is_collected ? '已收藏' : '收藏'}</span>
          </button>

          <button
            type="button"
            onClick={scrollToComments}
            className="inline-flex items-center gap-1 text-xs text-wb-text-secondary hover:text-wb-text-primary relative"
          >
            <MessageSquare className="w-4 h-4" />
            <span>{totalCommentsCount}</span>
          </button>

          <button
            type="button"
            onClick={handleShare}
            className="p-1 text-wb-text-secondary hover:text-wb-text-primary"
            title="分享文章"
          >
            <Share2 className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 统一图片灯箱：滚轮/双指缩放、左右切图、ESC 栈与滚动锁全部复用 */}
      <ImageLightbox
        src={lightboxImage?.src || null}
        alt={lightboxImage?.alt}
        onClose={() => setLightboxImage(null)}
        onPrev={gallery.length > 1 ? () => stepLightbox(-1) : undefined}
        onNext={gallery.length > 1 ? () => stepLightbox(1) : undefined}
        index={lightboxIdx}
        total={gallery.length}
      />

      {/* 文章正文划词浮动操作栏 (Highlight to Quote) */}
      {quoteTooltip && (
        <div
          style={{
            position: 'fixed',
            left: `${quoteTooltip.x}px`,
            top: `${quoteTooltip.y}px`,
            transform: 'translate(-50%, -100%)',
          }}
          className="z-50 flex items-center gap-1.5 p-1 rounded-full bg-wb-text-primary text-wb-bg-page shadow-2xl border border-wb-border-strong animate-in fade-in zoom-in-95 duration-150 select-none cursor-default"
          onMouseDown={(e) => e.preventDefault()}
        >
          <button
            type="button"
            onClick={handleQuoteToComment}
            className="inline-flex items-center gap-1 px-3 py-1 rounded-full text-xs font-semibold hover:bg-wb-bg-page/20 transition-colors cursor-pointer"
          >
            <Quote className="w-3 h-3 fill-current" />
            <span>引用到评论</span>
          </button>
          <span className="w-px h-3 bg-wb-bg-page/30" />
          <button
            type="button"
            onClick={handleCopyQuote}
            className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold hover:bg-wb-bg-page/20 transition-colors cursor-pointer"
          >
            <Copy className="w-3 h-3" />
            <span>复制引文</span>
          </button>
        </div>
      )}
    </div>
  );
};
