import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowLeft, CalendarCheck, Check, Flame, Globe2, Heart, ImagePlus, Lock, MessageCircle, Plus, Target, Trophy, X } from 'lucide-react';
import { apiClient, UPLOAD_TIMEOUT } from '../api/client';
import { UserAvatar } from '../components/UserAvatar';
import { ImageLightbox } from '../components/ImageLightbox';
import { formatEast8Date } from '../utils/format';
import type { UserProfile } from '../types';

interface Props {
  user: UserProfile | null;
  onBack: () => void;
  onRequireAuth: () => void;
}
interface Person { id: string; username: string; nickname: string | null; avatar_url: string | null }
type Visibility = 'public' | 'private';
interface GoalDraft { title: string; description: string; visibility: Visibility }
interface Goal extends GoalDraft {
  id: string; owner: Person; current_streak: number; longest_streak: number;
  checked_in_today: boolean; is_following: boolean;
}
interface Entry {
  id: string; goal: Goal; checkin_date: string; content: string; has_image: boolean;
  liked: boolean; like_count: number; comment_count: number;
}
interface Comment { id: string; author: Person; content: string; created_at: string; can_delete: boolean }
interface Rank { rank: number; goal: Goal }
type View = 'square' | 'mine' | 'leaderboard';

const BASE = '/habits';
const PAGE_SIZE = 20;
const card = 'min-w-0 rounded-xl border border-wb-border-subtle bg-wb-bg-surface p-3 sm:p-4';
const button = 'inline-flex min-h-10 items-center justify-center gap-1.5 rounded-lg px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-wb-brand disabled:cursor-not-allowed disabled:opacity-50';
const secondary = `${button} border border-wb-border-subtle text-wb-text-secondary hover:bg-wb-bg-subtle`;
const primary = `${button} bg-wb-brand/15 text-wb-brand hover:bg-wb-brand/25`;
const field = 'block w-full min-w-0 rounded-lg border border-wb-border-strong bg-wb-bg-elevated px-3 py-2 text-sm text-wb-text-primary placeholder:text-wb-text-muted focus:border-wb-brand focus:outline-none';
const muted = 'text-sm text-wb-text-muted';
const quickReplies = ['继续加油！', '坚持得真棒！', '一起打卡！'];

function errorText(error: unknown, fallback: string) {
  const detail = (error as { response?: { data?: { detail?: unknown } } } | null)?.response?.data?.detail;
  return typeof detail === 'string' && detail.trim() ? detail : fallback;
}

function Notice({ children, retry }: { children: ReactNode; retry?: () => void }) {
  return <div role={retry ? 'alert' : 'status'} className="flex flex-wrap items-center justify-center gap-2 rounded-xl border border-dashed border-wb-border-strong p-5 text-center text-sm text-wb-text-muted">
    {children}{retry && <button className={secondary} type="button" onClick={retry}>重试</button>}
  </div>;
}

function ErrorLine({ message }: { message: string }) {
  return message ? <p role="alert" className="break-words text-sm text-wb-danger">{message}</p> : null;
}

function useList<T extends { id: string } | Rank>(url: string, paginated = true) {
  const [items, setItems] = useState<T[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const request = useRef<AbortController | null>(null);
  const requestedOffset = useRef(0);
  const load = useCallback(async (start = 0) => {
    requestedOffset.current = start;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const { data } = await apiClient.get<T[]>(url, {
        signal: controller.signal,
        params: paginated ? { offset: start, limit: PAGE_SIZE } : undefined,
      });
      if (controller.signal.aborted) return;
      const key = (item: T) => 'id' in item ? item.id : item.goal.id;
      setItems(previous => Array.from(new Map([...(start ? previous : []), ...data].map(item => [key(item), item] as const)).values()));
      setOffset(start + data.length);
      setMore(paginated && data.length === PAGE_SIZE);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorText(error, '加载失败，请重试。'));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [url, paginated]);
  useEffect(() => {
    setItems([]);
    setOffset(0);
    setMore(false);
    void load();
    return () => request.current?.abort();
  }, [load]);
  return { items, setItems, loading, error, more, load, loadMore: () => load(offset), retry: () => load(requestedOffset.current) };
}

type ListStatusProps = { loading: boolean; error: string; more: boolean; empty: boolean; emptyText: string; retry: () => void; next: () => void };
function ListStatus({ loading, error, more, empty, emptyText, retry, next }: ListStatusProps) {
  if (loading) return <Notice>加载中…</Notice>;
  if (error) return <Notice retry={retry}>{error}</Notice>;
  if (empty) return <Notice>{emptyText}</Notice>;
  return more ? <div className="flex justify-center"><button className={secondary} type="button" onClick={next}>加载更多</button></div> : null;
}

export function HabitCheckin({ user, onBack, onRequireAuth }: Props) {
  return <section aria-labelledby="habit-title" className="mx-auto w-full max-w-5xl min-w-0 px-3 pb-10 pt-4 sm:px-6 sm:pt-7">
    <header className="flex items-center gap-3 border-b border-wb-border-subtle pb-4">
      <button className={`${secondary} shrink-0 px-2`} type="button" aria-label="返回" title="返回" onClick={onBack}><ArrowLeft size={18} /></button>
      <CalendarCheck size={22} className="shrink-0 text-wb-brand" aria-hidden="true" />
      <h1 id="habit-title" className="min-w-0 text-xl font-bold text-wb-text-primary sm:text-2xl">自律打卡</h1>
    </header>
    {user ? <HabitViews key={user.id} viewerId={user.id} /> :
      <div className="mt-5"><Notice>登录后参与自律打卡 <button className={primary} type="button" onClick={onRequireAuth}>登录</button></Notice></div>}
  </section>;
}

function HabitViews({ viewerId }: { viewerId: string }) {
  const [view, setView] = useState<View>('mine');
  return <>
    <nav aria-label="打卡视图" className="mb-5 mt-4 grid grid-cols-3 gap-1 rounded-xl bg-wb-bg-subtle p-1 sm:inline-grid">
      {([['mine', '我的打卡', Target], ['square', '打卡广场', Globe2], ['leaderboard', '连续榜', Trophy]] as const).map(([id, label, Icon]) =>
        <button key={id} type="button" aria-current={view === id ? 'page' : undefined} onClick={() => setView(id)} className={`${button} min-w-0 px-1 sm:px-4 ${view === id ? 'bg-wb-bg-elevated text-wb-brand shadow-sm' : 'text-wb-text-secondary hover:bg-wb-bg-surface'}`}><Icon size={15} aria-hidden="true" className="hidden shrink-0 min-[360px]:block" />{label}</button>)}
    </nav>
    {view === 'mine' && <MyHabits viewerId={viewerId} />}
    {view === 'square' && <Square viewerId={viewerId} />}
    {view === 'leaderboard' && <Leaderboard viewerId={viewerId} />}
  </>;
}

function Square({ viewerId }: { viewerId: string }) {
  const [scope, setScope] = useState<'public' | 'following'>('public');
  return <div className="space-y-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-lg font-bold text-wb-text-primary">打卡广场</h2>
      <div className="flex flex-wrap gap-1" role="group" aria-label="广场筛选">
        <button className={scope === 'public' ? primary : secondary} type="button" aria-pressed={scope === 'public'} onClick={() => setScope('public')}>全部动态</button>
        <button className={scope === 'following' ? primary : secondary} type="button" aria-pressed={scope === 'following'} onClick={() => setScope('following')}>我关注的</button>
      </div>
    </div>
    <EntryList key={scope} scope={scope} viewerId={viewerId} />
  </div>;
}

function EntryList({ scope, viewerId }: { scope: 'public' | 'following' | 'mine'; viewerId: string }) {
  const entries = useList<Entry>(`${BASE}/feed?scope=${scope}`);
  const { setItems } = entries;
  const follow = useFollow();
  const updateFollow = (id: string, following: boolean) => {
    if (scope === 'following' && !following) {
      setItems(items => items.filter(item => item.goal.id !== id));
      void entries.load();
      return;
    }
    setItems(items => items.map(item => item.goal.id === id ? { ...item, goal: { ...item.goal, is_following: following } } : item));
  };
  const updateEntry = (id: string, patch: Partial<Entry>) => setItems(items => items.map(item => item.id === id ? { ...item, ...patch } : item));
  return <div className="space-y-3">
    <ErrorLine message={follow.error} />
    {entries.items.map(entry => <EntryCard key={entry.id} entry={entry} viewerId={viewerId} followBusy={!!follow.pending[entry.goal.id]} onFollow={() => void follow.toggle(entry.goal, updateFollow)} onChange={patch => updateEntry(entry.id, patch)} />)}
    <ListStatus {...entries} empty={entries.items.length === 0 && !entries.more} emptyText={scope === 'following' ? '关注的目标暂无公开动态。' : scope === 'mine' ? '还没有打卡记录。' : '还没有公开打卡。'} retry={entries.retry} next={entries.loadMore} />
  </div>;
}

function Identity({ person }: { person: Person }) {
  return <div className="flex min-w-0 items-center gap-2 text-wb-text-primary">
    <UserAvatar size="sm" username={person.username} avatarUrl={person.avatar_url} className="shrink-0" />
    <span className="truncate text-sm font-semibold" title={person.nickname || person.username}>{person.nickname || person.username}</span>
  </div>;
}

function useFollow() {
  const [pending, setPending] = useState<Record<string, boolean>>({});
  const locks = useRef(new Set<string>());
  const [error, setError] = useState('');
  const toggle = async (goal: Goal, onChange: (id: string, following: boolean) => void) => {
    if (locks.current.has(goal.id)) return;
    locks.current.add(goal.id);
    setPending(previous => ({ ...previous, [goal.id]: true }));
    setError('');
    try {
      const { data } = await apiClient.request<{ is_following: boolean }>({ method: goal.is_following ? 'DELETE' : 'PUT', url: `${BASE}/goals/${goal.id}/follow` });
      onChange(goal.id, data.is_following);
    } catch (error) {
      setError(errorText(error, '关注操作失败，请重试。'));
    } finally {
      locks.current.delete(goal.id);
      setPending(previous => ({ ...previous, [goal.id]: false }));
    }
  };
  return { pending, error, toggle };
}

function FollowButton({ goal, disabled, onClick }: { goal: Goal; disabled: boolean; onClick: () => void }) {
  return <button className={`${secondary} shrink-0`} type="button" aria-pressed={goal.is_following} aria-label={goal.is_following ? `取消关注 ${goal.title}` : `关注 ${goal.title}`} disabled={disabled} onClick={onClick}>
    {goal.is_following ? <Check size={15} /> : <Plus size={15} />}{goal.is_following ? '已关注' : '关注目标'}
  </button>;
}

function EntryCard({ entry, viewerId, followBusy, onFollow, onChange }: { entry: Entry; viewerId: string; followBusy: boolean; onFollow: () => void; onChange: (patch: Partial<Entry>) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [commentOpen, setCommentOpen] = useState(false);
  const path = `${BASE}/checkins/${entry.id}`;
  const doLike = async () => {
    setBusy(true);
    setError('');
    try {
      const { data } = await apiClient.request<Pick<Entry, 'liked' | 'like_count'>>({ method: entry.liked ? 'DELETE' : 'PUT', url: `${path}/like` });
      onChange(data);
    } catch (error) {
      setError(errorText(error, '点赞操作失败，请重试。'));
    } finally {
      setBusy(false);
    }
  };
  return <article className={`${card} space-y-3`}>
    <header className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <Identity person={entry.goal.owner} />
      {viewerId !== entry.goal.owner.id && <FollowButton goal={entry.goal} disabled={followBusy} onClick={onFollow} />}
    </header>
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <h3 className="min-w-0 break-words text-base font-bold text-wb-text-primary [overflow-wrap:anywhere]">{entry.goal.title}</h3>
      <time className={muted} dateTime={entry.checkin_date}>{entry.checkin_date}</time>
    </div>
    {entry.content && <p className="whitespace-pre-wrap break-words text-sm leading-relaxed text-wb-text-secondary [overflow-wrap:anywhere]">{entry.content}</p>}
    {entry.has_image && <HabitImage path={`${path}/image`} />}
    <div className="flex flex-wrap gap-2">
      <button className={entry.liked ? primary : secondary} type="button" disabled={busy} aria-pressed={entry.liked} onClick={() => void doLike()}><Heart size={16} className={entry.liked ? 'fill-current' : undefined} /> 赞 {entry.like_count}</button>
      <button className={secondary} type="button" aria-expanded={commentOpen} aria-controls={`habit-comments-${entry.id}`} onClick={() => setCommentOpen(open => !open)}><MessageCircle size={16} /> 评论 {entry.comment_count}</button>
    </div>
    <ErrorLine message={error} />
    {commentOpen && <div id={`habit-comments-${entry.id}`}><Comments path={`${path}/comments`} onCount={delta => onChange({ comment_count: Math.max(0, entry.comment_count + delta) })} /></div>}
  </article>;
}

function HabitImage({ path }: { path: string }) {
  const frame = useRef<HTMLDivElement>(null);
  const [requested, setRequested] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [src, setSrc] = useState('');
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const node = frame.current;
    if (!node || typeof IntersectionObserver === 'undefined') { setRequested(true); return; }
    const observer = new IntersectionObserver(items => {
      if (items.some(item => item.isIntersecting)) { setRequested(true); observer.disconnect(); }
    }, { rootMargin: '160px' });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!requested) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setFailed(false);
    setSrc('');
    apiClient.get<Blob>(path, { responseType: 'blob', signal: controller.signal }).then(({ data }) => {
      if (!controller.signal.aborted) {
        objectUrl = URL.createObjectURL(data);
        setSrc(objectUrl);
      }
    }).catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path, requested, attempt]);
  return <div ref={frame} className="min-h-10">
    {failed ? <Notice retry={() => setAttempt(value => value + 1)}>图片加载失败</Notice> : src ?
      <button type="button" className="block max-w-full overflow-hidden rounded-lg bg-wb-bg-subtle focus-visible:outline focus-visible:outline-2 focus-visible:outline-wb-brand" aria-label="查看打卡图片" onClick={() => setOpen(true)}>
        <img src={src} alt="打卡图片" className="max-h-72 max-w-full object-contain" onError={() => { setOpen(false); setFailed(true); }} />
      </button> : <span className={muted}>图片加载中…</span>}
    {open && <ImageLightbox src={src} alt="打卡图片" onClose={() => setOpen(false)} />}
  </div>;
}

function Comments({ path, onCount }: { path: string; onCount: (delta: number) => void }) {
  const comments = useList<Comment>(path);
  const [content, setContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const onSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!content.trim() || saving || deleting) return;
    setSaving(true); setError('');
    try {
      const { data } = await apiClient.post<Comment>(path, { content: content.trim() });
      if (!comments.more && !comments.loading) comments.setItems(items => [...items, data]);
      else void comments.load();
      onCount(1);
      setContent('');
    } catch (error) { setError(errorText(error, '评论发送失败。')); }
    finally { setSaving(false); }
  };
  const remove = async (id: string) => {
    setDeleting(id); setError('');
    try {
      await apiClient.delete(`${path}/${id}`);
      onCount(-1);
      setConfirmId(null);
      void comments.load();
    } catch (error) { setError(errorText(error, '删除评论失败。')); }
    finally { setDeleting(null); }
  };
  return <div className="space-y-3 border-t border-wb-border-subtle pt-3">
    {comments.items.map(comment => <div key={comment.id} className="space-y-1.5 border-b border-wb-border-subtle pb-2">
      <div className="flex flex-wrap items-center justify-between gap-1">
        <Identity person={comment.author} /><time className="text-xs text-wb-text-muted" dateTime={comment.created_at}>{formatEast8Date(comment.created_at)}</time>
      </div>
      <p className="whitespace-pre-wrap break-words text-sm text-wb-text-secondary [overflow-wrap:anywhere]">{comment.content}</p>
      {comment.can_delete && <div className="flex flex-wrap items-center gap-1">
        {confirmId === comment.id ? <><span className={muted}>删除这条评论？</span><button type="button" className={`${secondary} text-wb-danger`} disabled={!!deleting || saving} onClick={() => void remove(comment.id)}>确认删除</button><button type="button" className={secondary} disabled={!!deleting} onClick={() => setConfirmId(null)}>取消</button></> :
          <button type="button" className={`${button} px-0 text-wb-text-muted hover:text-wb-danger`} onClick={() => setConfirmId(comment.id)}>删除</button>}
      </div>}
    </div>)}
    <ListStatus {...comments} empty={!comments.items.length} emptyText="还没有评论。" retry={comments.retry} next={comments.loadMore} />
    <form onSubmit={onSubmit} className="space-y-2">
      <label className={muted}>评论<textarea className={`${field} mt-1`} rows={2} maxLength={500} value={content} disabled={saving} onChange={event => setContent(event.target.value)} /></label>
      <div className="flex flex-wrap gap-2">
        {quickReplies.map(text => <button type="button" className={secondary} key={text} disabled={saving || `${content}${text}`.length + (content ? 1 : 0) > 500} onClick={() => setContent(previous => previous ? `${previous}\n${text}` : text)}>{text}</button>)}
      </div>
      <ErrorLine message={error} />
      <button type="submit" className={primary} disabled={saving || !!deleting || !content.trim()}>{saving ? '发送中…' : '发送评论'}</button>
    </form>
  </div>;
}

function Leaderboard({ viewerId }: { viewerId: string }) {
  const list = useList<Rank>(`${BASE}/leaderboard`);
  const follow = useFollow();
  const updateFollow = (id: string, following: boolean) => list.setItems(items => items.map(item => item.goal.id === id ? { ...item, goal: { ...item.goal, is_following: following } } : item));
  return <div className="space-y-3">
    <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-wb-border-subtle pb-3">
      <h2 className="text-lg font-bold text-wb-text-primary">连续榜</h2><span className={muted}>每人仅统计连续天数最多的公开目标</span>
    </div>
    <ol className="divide-y divide-wb-border-subtle">
      {list.items.map(({ rank, goal }) => <li key={goal.id} className="flex flex-wrap items-center gap-2 py-3 sm:gap-3">
        <span aria-label={`第 ${rank} 名`} className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg text-sm font-bold tabular-nums ${rank <= 3 ? 'bg-wb-brand/10 text-wb-brand' : 'text-wb-text-muted'}`}>{rank}</span>
        <div className="min-w-0 flex-1 basis-20"><Identity person={goal.owner} /><p className="mt-1 break-words text-xs text-wb-text-muted [overflow-wrap:anywhere]">{goal.title}</p></div>
        <span className="shrink-0 text-sm font-semibold tabular-nums text-wb-brand"><Flame size={15} className="mr-1 inline" aria-hidden="true" />{goal.current_streak} 天</span>
        {viewerId !== goal.owner.id && <FollowButton goal={goal} disabled={!!follow.pending[goal.id]} onClick={() => void follow.toggle(goal, updateFollow)} />}
      </li>)}
    </ol>
    <ErrorLine message={follow.error} />
    <ListStatus {...list} empty={!list.items.length} emptyText="还没有符合上榜条件的公开目标。" retry={() => void (list.items.length ? list.loadMore() : list.load())} next={list.loadMore} />
  </div>;
}

function MyHabits({ viewerId }: { viewerId: string }) {
  const goals = useList<Goal>(`${BASE}/goals`, false);
  const [editing, setEditing] = useState<Goal | 'new' | null>(null);
  const [checking, setChecking] = useState<Goal | null>(null);
  const [historyVersion, setHistoryVersion] = useState(0);
  const [notice, setNotice] = useState('');
  const updateGoal = (goal: Goal) => goals.setItems(items => items.some(item => item.id === goal.id) ? items.map(item => item.id === goal.id ? goal : item) : [goal, ...items]);
  const pending = goals.items.filter(goal => !goal.checked_in_today);
  const completed = goals.items.filter(goal => goal.checked_in_today);
  const formOpen = Boolean(editing || checking);
  return <div className="space-y-6">
    <section className="space-y-4" aria-labelledby="habit-goals-title">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-wb-border-subtle pb-4">
        <div>
          <h2 id="habit-goals-title" className="text-lg font-bold text-wb-text-primary">今日行动</h2>
          {!goals.loading && !goals.error && goals.items.length > 0 && <p className="mt-1 text-sm tabular-nums text-wb-text-secondary"><span className="font-semibold text-wb-brand">{completed.length} / {goals.items.length}</span> 项已完成{pending.length === 0 ? ' · 今日目标全部达成' : ` · 还有 ${pending.length} 项待打卡`}</p>}
        </div>
        <button type="button" className={secondary} disabled={formOpen || goals.loading} onClick={() => { setNotice(''); setEditing('new'); }}><Plus size={16} /> 新建目标</button>
      </div>
      {notice && <p role="status" className="text-sm text-wb-success">{notice}</p>}
      {checking && <CheckinForm key={checking.id} goal={checking} onCancel={() => setChecking(null)} onSaved={entry => {
        updateGoal(entry.goal); setChecking(null); setNotice('打卡成功。'); setHistoryVersion(value => value + 1);
      }} onDuplicate={() => {
        setChecking(null); setNotice('此目标今日已打卡。'); void goals.load(); setHistoryVersion(value => value + 1);
      }} />}
      {editing && <GoalForm key={editing === 'new' ? 'new' : editing.id} goal={editing === 'new' ? undefined : editing} onCancel={() => setEditing(null)} onSaved={goal => {
        updateGoal(goal); setEditing(null); setHistoryVersion(value => value + 1); setNotice(editing === 'new' ? '目标已创建。' : '目标已更新。');
      }} />}
      {([{ label: '待打卡', items: pending }, { label: '今日已完成', items: completed }]).map(({ label, items }) => items.length > 0 && <div key={label} className="space-y-2">
        <h3 className="text-sm font-semibold text-wb-text-secondary">{label}</h3>
        <div className={`grid gap-2 ${items[0].checked_in_today ? '' : 'sm:grid-cols-2'}`}>
          {items.map(goal => <article className={`${card} flex flex-col gap-2 ${goal.checked_in_today ? 'sm:flex-row sm:items-center' : ''}`} key={goal.id}>
            <div className="min-w-0 flex-1 space-y-2">
              <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                <h4 className="min-w-0 break-words font-bold text-wb-text-primary [overflow-wrap:anywhere]">{goal.title}</h4>
                <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-wb-text-muted">{goal.visibility === 'public' ? <Globe2 size={14} /> : <Lock size={14} />}{goal.visibility === 'public' ? '公开' : '私密'}</span>
              </div>
              {goal.description && <p className="whitespace-pre-wrap break-words text-sm text-wb-text-secondary [overflow-wrap:anywhere]">{goal.description}</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs tabular-nums"><span className="font-semibold text-wb-brand"><Flame size={14} className="mr-1 inline" aria-hidden="true" />连续 {goal.current_streak} 天</span><span className="text-wb-text-muted">最长 {goal.longest_streak} 天</span></div>
            </div>
            <div className={`flex flex-wrap items-center gap-2 ${goal.checked_in_today ? '' : 'mt-auto pt-2'}`}>
              {goal.checked_in_today ? <span className="inline-flex items-center gap-1 px-2 text-sm font-semibold text-wb-success"><Check size={16} aria-hidden="true" /> 今日已打卡</span> :
                <button type="button" className={primary} disabled={formOpen} onClick={() => { setNotice(''); setChecking(goal); }}><CalendarCheck size={16} /> 今日打卡</button>}
              <button type="button" className={secondary} disabled={formOpen} onClick={() => { setNotice(''); setEditing(goal); }}>编辑目标</button>
            </div>
          </article>)}
        </div>
      </div>)}
      <ListStatus {...goals} empty={!goals.items.length} emptyText="还没有目标。新建一个目标，开始第一次打卡。" retry={() => void goals.load()} next={goals.loadMore} />
    </section>
    <section className="space-y-3" aria-labelledby="habit-history-title">
      <h2 id="habit-history-title" className="font-bold text-wb-text-primary">我的打卡记录</h2>
      <EntryList key={historyVersion} scope="mine" viewerId={viewerId} />
    </section>
  </div>;
}

function GoalForm({ goal, onCancel, onSaved }: { goal?: Goal; onCancel: () => void; onSaved: (goal: Goal) => void }) {
  const [draft, setDraft] = useState<GoalDraft>(() => goal ? { title: goal.title, description: goal.description, visibility: goal.visibility } : { title: '', description: '', visibility: 'private' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draft.title.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const payload = { ...draft, title: draft.title.trim(), description: draft.description.trim() };
      const { data } = goal ? await apiClient.patch<Goal>(`${BASE}/goals/${goal.id}`, payload) : await apiClient.post<Goal>(`${BASE}/goals`, payload);
      onSaved(data);
    } catch (error) { setError(errorText(error, '保存目标失败。')); }
    finally { setBusy(false); }
  };
  return <form className={`${card} space-y-3`} onSubmit={submit}>
    <h3 className="font-bold text-wb-text-primary">{goal ? '编辑目标' : '新建目标'}</h3>
    <label className={muted}>目标名称 <input className={`${field} mt-1`} maxLength={60} required value={draft.title} onChange={event => setDraft({ ...draft, title: event.target.value })} disabled={busy} /></label>
    <label className={muted}>目标描述（选填） <textarea className={`${field} mt-1`} maxLength={300} rows={2} value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} disabled={busy} /></label>
    <fieldset disabled={busy} className="text-sm text-wb-text-secondary">
      <legend className="mb-1">可见性</legend>
      <div className="flex flex-wrap gap-4">
        <label className="inline-flex min-h-8 items-center gap-1.5"><input type="radio" name="habit-visibility" checked={draft.visibility === 'private'} onChange={() => setDraft({ ...draft, visibility: 'private' })} /> 私密</label>
        <label className="inline-flex min-h-8 items-center gap-1.5"><input type="radio" name="habit-visibility" checked={draft.visibility === 'public'} onChange={() => setDraft({ ...draft, visibility: 'public' })} /> 公开</label>
      </div>
      <p className={muted}>{draft.visibility === 'public' ? '公开打卡会出现在广场和连续榜；此前私密的记录不会公开。' : '设为私密会隐藏该目标的所有打卡。'}</p>
    </fieldset>
    <ErrorLine message={error} />
    <div className="flex flex-wrap gap-2"><button type="submit" className={primary} disabled={busy || !draft.title.trim()}>{busy ? '保存中…' : '保存目标'}</button><button type="button" className={secondary} disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}

const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];
function CheckinForm({ goal, onCancel, onSaved, onDuplicate }: { goal: Goal; onCancel: () => void; onSaved: (entry: Entry) => void; onDuplicate: () => void }) {
  const [content, setContent] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const formRef = useRef<HTMLFormElement>(null);
  useEffect(() => { formRef.current?.scrollIntoView({ block: 'nearest' }); }, []);
  useEffect(() => {
    if (!file) { setPreview(''); return; }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);
  const chooseFile = (selected: File | undefined) => {
    if (!selected) return;
    setError('');
    if ((selected.type && !IMAGE_TYPES.includes(selected.type)) || (!selected.type && !/\.(jpe?g|png|webp|gif)$/i.test(selected.name))) { setError('请选择 JPG、PNG、WebP 或 GIF 图片。'); return; }
    if (selected.size > 5 * 1024 * 1024) { setError('图片不能超过 5 MiB。'); return; }
    setFile(selected);
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true); setError('');
    try {
      const body = new FormData();
      body.append('content', content.trim());
      if (file) body.append('image', file);
      const { data } = await apiClient.post<Entry>(`${BASE}/goals/${goal.id}/checkins`, body, { timeout: UPLOAD_TIMEOUT, headers: { 'Content-Type': 'multipart/form-data' } });
      onSaved(data);
    } catch (error) {
      if ((error as { response?: { status?: number } } | null)?.response?.status === 409) onDuplicate();
      else setError(errorText(error, '打卡失败，请重试。'));
    } finally { setBusy(false); }
  };
  return <form className={`${card} space-y-3`} onSubmit={submit} ref={formRef}>
    <h3 className="break-words font-bold text-wb-text-primary [overflow-wrap:anywhere]">今日打卡：{goal.title}</h3>
    <p className={muted}>{goal.visibility === 'public' ? '这条打卡将公开。' : '这条打卡仅自己可见。'}</p>
    <label className={muted}>打卡内容（选填） <textarea className={`${field} mt-1`} rows={3} maxLength={500} value={content} disabled={busy} onChange={event => setContent(event.target.value)} /></label>
    <div className="flex flex-wrap items-center gap-2">
      <label className={`${secondary} relative cursor-pointer focus-within:outline focus-within:outline-2 focus-within:outline-wb-brand`}><ImagePlus size={16} /> {file ? '更换图片' : '添加图片'}
        <input type="file" className="sr-only" accept={IMAGE_TYPES.join(',')} disabled={busy} onChange={event => { chooseFile(event.target.files?.[0]); event.target.value = ''; }} />
      </label>
      <span className={muted}>最多 1 张、5 MiB；动图只保留首帧</span>
    </div>
    {file && <div className="flex flex-wrap items-start gap-2">
      {preview && <img src={preview} alt="待上传图片预览" className="max-h-32 max-w-full rounded-lg object-contain" />}
      <button type="button" className={secondary} title="移除图片" aria-label="移除图片" disabled={busy} onClick={() => setFile(null)}><X size={16} /></button>
    </div>}
    <ErrorLine message={error} />
    <div className="flex flex-wrap gap-2"><button type="submit" className={primary} disabled={busy}>{busy ? '提交中…' : '确认打卡'}</button><button type="button" className={secondary} disabled={busy} onClick={onCancel}>取消</button></div>
  </form>;
}
