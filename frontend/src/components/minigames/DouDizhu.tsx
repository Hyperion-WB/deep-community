import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { CSSProperties, FormEvent } from 'react';
import { ArrowRight, Bell, Bot, Check, Coins, Copy, DoorOpen, Lightbulb, Search, Smile, UserPlus, Users } from 'lucide-react';
import { apiClient } from '../../api/client';
import { UserAvatar } from '../UserAvatar';
import './DouDizhu.css';

type HumanCount = 1 | 2 | 3;
type Phase = 'waiting' | 'bidding' | 'playing' | 'finished' | 'closed';
type Action = { action: 'bid'; bid: 0 | 1 | 2 | 3 }
  | { action: 'play'; cards: number[] }
  | { action: 'pass' | 'restart' | 'leave' };

type Player = { name: string; ai: boolean; count: number; seat: number; avatar_url?: string | null };
type InteractionKind = 'chat' | 'taunt' | 'nudge';
type InteractionPreset = { id: string; kind: InteractionKind; text: string };
type Interaction = { id: string; kind: InteractionKind; text: string; from_seat: number; target_seat: number | null; at: string };
type Room = {
  code: string;
  humans: HumanCount;
  host: boolean;
  revision: number;
  me: number;
  players: Player[];
  phase: Phase;
  turn: number | null;
  landlord: number | null;
  hand: number[];
  bottom: number[];
  bid: number;
  last: { seat: number; cards: number[] } | null;
  winner: 'landlord' | 'farmers' | null;
  hint: number[];
  canPass: boolean;
  interactions?: Interaction[];
  turn_started_at?: string | null;
  nudge_idle_seconds?: number;
  interaction_cooldown_seconds?: number;
};

type Points = { points: number; checkedIn: boolean; dailyReward: number };

const ROOMS = '/doudizhu/rooms';
const POINTS = '/doudizhu/points';
const RANKS = ['3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K', 'A', '2'];
const SUITS = ['♣', '♦', '♥', '♠'];
const SUIT_NAMES = ['梅花', '方块', '红桃', '黑桃'];
const MODES = [
  { count: 1, label: '单人练习', detail: '和两位电脑玩家开局' },
  { count: 2, label: '两人组局', detail: '邀请一位好友，电脑补位' },
  { count: 3, label: '三人组局', detail: '邀请两位好友一起玩' },
] as const;

const PHASE_LABELS: Record<Phase, string> = {
  waiting: '等待入座', bidding: '叫地主', playing: '出牌中', finished: '已结算', closed: '已关闭',
};

function apiError(error: unknown, fallback: string) {
  const response = (error as { response?: { status?: number; data?: { detail?: unknown } } })?.response;
  const detail = response?.data?.detail;
  return { status: response?.status, message: typeof detail === 'string' ? detail : fallback };
}

function roomStorage(key: string, code?: string | null) {
  try {
    if (code === undefined) return localStorage.getItem(key);
    if (code === null) localStorage.removeItem(key);
    else localStorage.setItem(key, code);
  } catch {
    // 禁用站点存储时仍可通过房间号回到牌桌。
  }
  return null;
}

function cardFace(card: number) {
  if (card >= 52) {
    const large = card === 53;
    return { rank: large ? '大' : '小', suit: '★', label: large ? '大王' : '小王', red: large };
  }
  const rank = RANKS[Math.floor(card / 4)];
  const suit = card % 4;
  return { rank, suit: SUITS[suit], label: `${SUIT_NAMES[suit]}${rank}`, red: suit === 1 || suit === 2 };
}

function Card({ card, selected = false, onToggle }: { card: number; selected?: boolean; onToggle?: () => void }) {
  const { rank, suit, label, red } = cardFace(card);
  const className = `ddz-card${red ? ' ddz-card--red' : ''}`;
  const face = <>
    <span className="ddz-card-corner" aria-hidden="true"><b>{rank}</b><span>{suit}</span></span>
    <span className="ddz-card-suit" aria-hidden="true">{suit}</span>
  </>;
  return onToggle ? (
    <button type="button" className={className} aria-label={label} aria-pressed={selected} onClick={onToggle}>{face}</button>
  ) : (
    <span className={className} role="img" aria-label={label}>{face}</span>
  );
}

function CardLine({ cards, label }: { cards: number[]; label: string }) {
  return <div className="ddz-card-line" role="group" aria-label={label} style={{ '--ddz-overlaps': Math.max(0, cards.length - 1) } as CSSProperties}>
    {cards.map(card => <Card key={card} card={card} />)}
  </div>;
}

function HandCards({ cards, selected, onToggle }: {
  cards: number[];
  selected: number[];
  onToggle?: (card: number) => void;
}) {
  const ordered = [...cards].sort((a, b) => b - a);
  const split = ordered.length > 11 ? Math.ceil(ordered.length / 2) : ordered.length;
  return (
    <div className="ddz-hand" role="group" aria-label="我的手牌" style={{ '--ddz-overlaps': ordered.length - 1 } as CSSProperties}>
      {[ordered.slice(0, split), ordered.slice(split)].filter(row => row.length).map((row, index) => (
        <div className="ddz-hand-row" key={index} style={{ '--ddz-row-overlaps': row.length - 1 } as CSSProperties}>
          {row.map(card => <Card key={card} card={card} selected={selected.includes(card)} onToggle={onToggle && (() => onToggle(card))} />)}
        </div>
      ))}
    </div>
  );
}

function Rules() {
  return <details className="ddz-rules">
    <summary>玩法说明</summary>
    <ul>
      <li>三人使用一副牌。叫分最高的玩家成为地主，拿走三张底牌。</li>
      <li>地主先出牌。跟牌通常要用同牌型、更大的牌，也可以用炸弹或王炸。其他两人都不出时，上一位出牌者可重新出任意合法牌型。</li>
      <li>地主出完牌则地主胜。任一农民先出完牌，两位农民一起获胜。</li>
    </ul>
  </details>;
}

function Header({ room }: { room?: Room | null }) {
  return <header className="ddz-heading">
    <div className="ddz-emblem" aria-hidden="true"><span>♠</span><span>♥</span></div>
    <div>
      <h2>斗地主</h2>
      <p>{room ? MODES[room.humans - 1].label : '叫分、跟牌，先出完手牌'}</p>
    </div>
  </header>;
}

function Seat({ player, seat, room, interactionPanelId, expanded, onInteract }: {
  player: Player | undefined;
  seat: number;
  room: Room;
  interactionPanelId?: string;
  expanded?: boolean;
  onInteract?: () => void;
}) {
  const mine = seat === room.me;
  const active = seat === room.turn;
  const role = room.landlord === null ? undefined : seat === room.landlord ? '地主' : '农民';
  const displayName = player?.name || '空座';
  return (
    <div className={`ddz-seat${active ? ' ddz-seat--active' : ''}${mine ? ' ddz-seat--mine' : ''}`} aria-current={active ? 'true' : undefined}>
      <div className="ddz-seat-avatar">
        <span className="ddz-seat-icon" aria-hidden="true">
          {player?.ai ? <Bot size={16} /> : player?.avatar_url ? <UserAvatar username={displayName} avatarUrl={player.avatar_url} size={26} alt="" />
            : player ? Array.from(displayName)[0] : <Users size={15} />}
        </span>
        {onInteract && <button type="button" className="ddz-seat-interact" aria-expanded={expanded}
          aria-controls={expanded ? interactionPanelId : undefined} aria-label={mine ? '向全桌打招呼' : `与 ${displayName} 互动`}
          title={mine ? '全桌互动' : `与 ${displayName} 互动`} onClick={onInteract}><Smile size={17} aria-hidden="true" /></button>}
      </div>
      <span className="ddz-seat-text">
        <strong title={displayName}>{mine ? `${displayName}（你）` : displayName}</strong>
        <span>{active && <span className="ddz-seat-turn">当前回合</span>}{role ?? (player?.ai ? '电脑' : player ? '玩家' : '等待入座')}</span>
      </span>
      {player && room.phase !== 'waiting' && <span className="ddz-seat-count" title="剩余手牌">{player.count}<span> 张</span></span>}
    </div>
  );
}

const INTERACTION_LABELS: Record<InteractionKind, string> = { chat: '快捷消息', taunt: '调侃', nudge: '催牌' };

function InteractionOptions({ id, room, target, busy, onSend }: {
  id: string;
  room: Room;
  target: Player;
  busy: boolean;
  onSend: (preset: InteractionPreset, target: number | null) => Promise<boolean>;
}) {
  const [presets, setPresets] = useState<InteractionPreset[] | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [clock, setClock] = useState(Date.now);
  const broadcast = target.seat === room.me;
  const canNudge = !broadcast && room.turn === target.seat && Boolean(room.turn_started_at);
  const nudgeAt = canNudge ? Date.parse(room.turn_started_at!) + (room.nudge_idle_seconds ?? 10) * 1000 : 0;
  const lastSent = room.interactions?.findLast(event => event.from_seat === room.me);
  const cooldownUntil = lastSent ? Date.parse(lastSent.at) + (room.interaction_cooldown_seconds ?? 3) * 1000 : 0;
  const waiting = clock < cooldownUntil;

  useEffect(() => {
    const controller = new AbortController();
    apiClient.get<{ items: InteractionPreset[] }>('/doudizhu/interactions/presets', { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setPresets(data.items); })
      .catch(error => {
        if (!controller.signal.aborted) setError(apiError(error, '互动选项加载失败。').message);
      });
    return () => controller.abort();
  }, [retry]);

  useEffect(() => {
    const deadline = [nudgeAt, cooldownUntil].filter(time => time > clock).sort((a, b) => a - b)[0];
    if (deadline === undefined) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, deadline - Date.now()) + 25);
    return () => clearTimeout(timer);
  }, [clock, cooldownUntil, nudgeAt]);

  return <div id={id} className="ddz-interaction-panel" role="group" aria-label={broadcast ? '向全桌发送快捷消息' : `与 ${target.name} 互动`}>
    <strong>{broadcast ? '向全桌发送快捷消息' : `与 ${target.name} 互动`}</strong>
    {!presets && <p className="ddz-feedback" role="status">{error || '正在加载互动选项…'}</p>}
    {error && <button type="button" onClick={() => { setError(''); setRetry(value => value + 1); }}>重试</button>}
    {presets && (Object.keys(INTERACTION_LABELS) as InteractionKind[]).filter(kind => !broadcast || kind === 'chat').map(kind => {
      const items = presets.filter(preset => preset.kind === kind);
      if (!items.length) return null;
      const nudgeBlocked = kind === 'nudge' && (!canNudge || clock < nudgeAt);
      return <div key={kind} className="ddz-interaction-group">
        {!broadcast && <span>{INTERACTION_LABELS[kind]}</span>}
        <div>{items.map(preset => <button key={preset.id} type="button" disabled={busy || waiting || nudgeBlocked}
          onClick={() => void onSend(preset, broadcast ? null : target.seat)}>{preset.text}</button>)}</div>
        {nudgeBlocked && <small>{canNudge ? '等对方考虑一会儿后可催牌。' : '可催促当前回合的玩家。'}</small>}
      </div>;
    })}
    {waiting && <p className="ddz-feedback" role="status">稍等片刻后可以继续发送。</p>}
  </div>;
}

function Table({ room, busy, selected, onSelect, onAction, onSend }: {
  room: Room;
  busy: boolean;
  selected: number[];
  onSelect: (cards: number[]) => void;
  onAction: (action: Action) => void;
  onSend: (preset: InteractionPreset, target: number | null) => Promise<boolean>;
}) {
  const [targetSeat, setTargetSeat] = useState<number | null>(null);
  const interactionPanelId = useId();
  const left = (room.me + 1) % 3;
  const right = (room.me + 2) % 3;
  const current = room.players.find(player => player.seat === room.turn);
  const playing = room.phase === 'playing';
  const bidding = room.phase === 'bidding';
  const myTurn = room.turn === room.me;
  const selectedCards = selected.filter(card => room.hand.includes(card));
  const humanSeats = room.players.filter(player => !player.ai).length;
  const target = room.players.find(player => player.seat === targetSeat && !player.ai);
  const canInteract = humanSeats > 1;
  const events = room.interactions?.slice(-3);
  const bidLabel = room.bid ? `当前最高 ${room.bid} 分` : '等待首个叫分';
  const lastPlayer = room.players.find(player => player.seat === room.last?.seat);
  const won = room.winner === (room.landlord === room.me ? 'landlord' : 'farmers');
  let message = room.phase === 'waiting' ? `已入座 ${humanSeats} / ${room.humans} 人`
    : room.phase === 'finished' ? `${room.winner === 'landlord' ? '地主' : '农民'}获胜 · ${won ? '你赢了' : '本局结束'}`
    : myTurn ? (bidding ? '轮到你叫分' : '轮到你出牌')
    : `等待 ${current?.name || '其他玩家'}${bidding ? '叫分' : '出牌'}`;
  if (playing && myTurn && room.canPass && !room.hint.length) message = '没有可跟的牌，可以选择不出';
  const toggleCard = (card: number) => {
    onSelect(selectedCards.includes(card) ? selectedCards.filter(value => value !== card) : [...selectedCards, card]);
  };

  function showSeat(seat: number) {
    const player = room.players.find(candidate => candidate.seat === seat);
    return <Seat key={seat} player={player} seat={seat} room={room}
      expanded={targetSeat === seat} interactionPanelId={interactionPanelId}
      onInteract={canInteract && player && !player.ai ? () => setTargetSeat(previous => previous === seat ? null : seat) : undefined} />;
  }

  function nameForSeat(seat: number) {
    return seat === room.me ? '你' : room.players.find(player => player.seat === seat)?.name || '玩家';
  }

  const interactionOptions = canInteract && target && <InteractionOptions key={target.seat} id={interactionPanelId}
    room={room} target={target} busy={busy} onSend={onSend} />;

  return <div className="ddz-table">
    <div className="ddz-seats">{[left, right].map(showSeat)}</div>
    {targetSeat !== room.me && interactionOptions}
    <div className="ddz-center">
      <div className="ddz-bottom">
        <span>底牌</span>
        {room.bottom.length ? <CardLine cards={room.bottom} label="地主底牌" />
          : <span className="ddz-card-backs" aria-label="三张未公开的底牌" role="img"><i /><i /><i /></span>}
      </div>
      <p className="ddz-table-status" role="status">{message}</p>
      {room.phase === 'waiting' && <p className="ddz-table-note">好友入座后自动发牌</p>}
      {bidding && <p className="ddz-table-note">{bidLabel}</p>}
      {room.last && (playing || room.phase === 'finished') && <div className="ddz-last">
        <span>{room.last.seat === room.me ? '你' : lastPlayer?.name || '玩家'}的上手牌</span>
        <CardLine cards={room.last.cards} label="上手牌" />
      </div>}
      {playing && !room.last && <p className="ddz-table-note">本轮可自由领出合法牌型</p>}
    </div>
    {canInteract && <div className="ddz-interaction-feed" role="log" aria-label="牌桌互动">
      {events?.map(event => <p key={event.id}>
        <span>{INTERACTION_LABELS[event.kind]}</span>
        <strong>{nameForSeat(event.from_seat)}{event.target_seat === null ? '' : ` → ${nameForSeat(event.target_seat)}`}</strong>
        {event.text}
      </p>)}
    </div>}
    <div className="ddz-table-bottom">
      {showSeat(room.me)}
      {targetSeat === room.me && interactionOptions}
      {room.hand.length > 0 && <HandCards cards={room.hand} selected={selectedCards}
        onToggle={playing && myTurn && !busy ? toggleCard : undefined} />}
    </div>
    <div className="ddz-actions">
      {bidding && <>
        <button type="button" disabled={!myTurn || busy} onClick={() => onAction({ action: 'bid', bid: 0 })}>不叫</button>
        {([1, 2, 3] as const).map(bid => <button type="button" key={bid} className={bid === 3 ? 'ddz-primary' : undefined}
          disabled={!myTurn || busy || bid <= room.bid} onClick={() => onAction({ action: 'bid', bid })}>{bid} 分</button>)}
      </>}
      {playing && <>
        <button type="button" disabled={!myTurn || !room.canPass || busy} onClick={() => onAction({ action: 'pass' })}>不出</button>
        <button type="button" disabled={!myTurn || !room.hint.length || busy} onClick={() => onSelect(room.hint)}><Lightbulb size={15} />提示</button>
        <button type="button" className="ddz-primary" disabled={!myTurn || !selectedCards.length || busy}
          onClick={() => onAction({ action: 'play', cards: selectedCards })}>出牌{selectedCards.length ? ` · ${selectedCards.length}` : ''}</button>
      </>}
    </div>
  </div>;
}

type InviteCandidate = { user_id: string; username: string; nickname: string; avatar_url: string; online: boolean };
type Invitation = { id: string; code: string; inviter_name: string; expires_at: string };

function InvitePlayers({ code }: { code: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [results, setResults] = useState<{ query: string; users: InviteCandidate[]; error?: string }>();
  const [sending, setSending] = useState('');
  const [sent, setSent] = useState<string[]>([]);
  const [feedback, setFeedback] = useState('');
  const sendRequest = useRef<AbortController | null>(null);
  const searchId = useId();
  const query = text.trim();
  const currentResults = results?.query === query ? results : undefined;

  useEffect(() => () => sendRequest.current?.abort(), []);

  useEffect(() => {
    if (!open || !query) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      apiClient.get<{ items: InviteCandidate[] }>('/doudizhu/lobby/users', { params: { q: query }, signal: controller.signal })
        .then(({ data }) => {
          if (!controller.signal.aborted) setResults({ query, users: data.items });
        })
        .catch(error => {
          if (!controller.signal.aborted) setResults({ query, users: [], error: apiError(error, '搜索失败，请修改关键词后重试。').message });
        });
    }, 250);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [open, query]);

  async function invite(user: InviteCandidate) {
    if (sendRequest.current) return;
    const controller = new AbortController();
    sendRequest.current = controller;
    setSending(user.user_id);
    setFeedback('');
    try {
      await apiClient.post(`${ROOMS}/${code}/invitations`, { user_id: user.user_id }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setSent(previous => previous.includes(user.user_id) ? previous : [...previous, user.user_id]);
      setFeedback(`已邀请 ${user.nickname || user.username}`);
    } catch (error) {
      if (!controller.signal.aborted) setFeedback(apiError(error, '邀请发送失败，请重试。').message);
    } finally {
      sendRequest.current = null;
      if (!controller.signal.aborted) setSending('');
    }
  }

  return <details className="ddz-invite-search" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><UserPlus size={17} aria-hidden="true" />邀请玩家</summary>
    <div className="ddz-invite-body">
      <label htmlFor={searchId}>搜索社区玩家</label>
      <div className="ddz-search-input"><Search size={16} aria-hidden="true" />
        <input id={searchId} type="search" placeholder="输入昵称或用户名" value={text} maxLength={64}
          autoComplete="off" onChange={event => setText(event.target.value)} />
      </div>
      {query && (!currentResults || currentResults.error || !currentResults.users.length) &&
        <p className="ddz-feedback" role="status">{currentResults ? currentResults.error || '没有找到其他玩家。' : '正在搜索…'}</p>}
      {currentResults && currentResults.users.length > 0 && <ul className="ddz-invite-list">
        {currentResults.users.map(user => <li key={user.user_id}>
          <UserAvatar username={user.username} avatarUrl={user.avatar_url} size={30} alt="" />
          <span className="ddz-invite-user"><strong>{user.nickname || user.username}</strong><small>@{user.username}{user.online && ' · 在线'}</small></span>
          <button type="button" aria-label={`邀请 ${user.nickname || user.username}`} disabled={Boolean(sending)}
            onClick={() => void invite(user)}>{sending === user.user_id ? '发送中…' : sent.includes(user.user_id) ? '重新邀请' : '邀请'}</button>
        </li>)}
      </ul>}
      {feedback && <p className="ddz-feedback" role="status">{feedback}</p>}
    </div>
  </details>;
}

const INVITATIONS = '/doudizhu/invitations';
type InviteDecision = 'accept' | 'reject';

function InvitationInbox({ activeCode, busy, onReply }: {
  activeCode: string | null;
  busy: boolean;
  onReply: (invitation: Invitation, decision: InviteDecision) => Promise<boolean>;
}) {
  const [items, setItems] = useState<Invitation[] | null>(null);
  const [pending, setPending] = useState('');
  const [loadError, setLoadError] = useState(false);
  const [deepInvite, setDeepInvite] = useState(() => new URLSearchParams(window.location.search).get('invite'));
  const headingId = useId();

  useEffect(() => {
    if (pending) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        if (document.hidden) return;
        const { data } = await apiClient.get<{ items: Invitation[] }>(INVITATIONS, { signal: controller.signal });
        if (!controller.signal.aborted) {
          setItems(data.items);
          setLoadError(false);
        }
      } catch {
        if (!controller.signal.aborted) setLoadError(true);
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, 3500);
      }
    };
    void poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [pending]);

  async function reply(invitation: Invitation, decision: InviteDecision) {
    setPending(invitation.id);
    try {
      if (!await onReply(invitation, decision)) return;
      setItems(previous => previous?.filter(item => item.id !== invitation.id) ?? []);
      if (deepInvite === invitation.id) {
        setDeepInvite(null);
        const url = new URL(window.location.href);
        url.searchParams.delete('invite');
        window.history.replaceState(window.history.state, '', url);
      }
    } finally {
      setPending('');
    }
  }

  if (!items?.length && !deepInvite) return null;
  const highlighted = items?.find(item => item.id === deepInvite);
  const invitations = highlighted ? [highlighted, ...(items ?? []).filter(item => item.id !== deepInvite)] : items;
  const needsExit = invitations?.some(invitation => activeCode && activeCode !== invitation.code);

  return <section className="ddz-invite-inbox" aria-labelledby={headingId}>
    <h3 id={headingId}><Bell size={16} aria-hidden="true" />斗地主邀请</h3>
    <div role="status">
      {loadError && <p className="ddz-feedback">暂时无法载入邀请，正在重试…</p>}
      {deepInvite && !highlighted && !loadError && <p className="ddz-feedback">
        {invitations ? '这条邀请已失效或已处理。' : '正在查找邀请…'}
      </p>}
      {needsExit && <p className="ddz-feedback">离开当前牌桌后，可以接受其他房间的邀请。</p>}
    </div>
    {invitations && invitations.length > 0 && <ul className="ddz-invite-list" aria-live="polite">
      {invitations.map(invitation => <li key={invitation.id} className={invitation.id === deepInvite ? 'ddz-invite-highlight' : undefined}>
        <span className="ddz-invite-user"><strong>{invitation.inviter_name} 邀请你斗地主</strong><small>房间 {invitation.code}</small></span>
        <div className="ddz-invite-actions">
          <button type="button" className="ddz-primary" disabled={busy || Boolean(pending) || Boolean(activeCode && activeCode !== invitation.code)}
            onClick={() => void reply(invitation, 'accept')}>接受并入座</button>
          <button type="button" disabled={busy || Boolean(pending)} onClick={() => void reply(invitation, 'reject')}>拒绝</button>
        </div>
      </li>)}
    </ul>}
  </section>;
}

function PointsPanel({ onPointsChange }: { onPointsChange?: () => void }) {
  const [points, setPoints] = useState<Points | null>(null);
  const [checkingIn, setCheckingIn] = useState(false);
  const [retry, setRetry] = useState(0);
  const [loadError, setLoadError] = useState('');
  const [checkInStatus, setCheckInStatus] = useState('');
  const checkInRequest = useRef<AbortController | null>(null);

  useEffect(() => () => checkInRequest.current?.abort(), []);

  useEffect(() => {
    if (checkingIn) return;
    const controller = new AbortController();
    setLoadError('');
    apiClient.get<Points>(POINTS, { signal: controller.signal })
      .then(({ data }) => { if (!controller.signal.aborted) setPoints(data); })
      .catch(error => {
        if (!controller.signal.aborted) setLoadError(apiError(error, '积分暂时无法加载。').message);
      });
    return () => controller.abort();
  }, [checkingIn, retry]);

  async function checkIn() {
    if (checkInRequest.current || !points || points.checkedIn) return;
    const controller = new AbortController();
    checkInRequest.current = controller;
    setCheckingIn(true);
    setCheckInStatus('');
    try {
      const { data } = await apiClient.post<Points>(`${POINTS}/check-in`, undefined, { signal: controller.signal });
      if (controller.signal.aborted) return;
      setPoints(data);
      setCheckInStatus('签到成功');
      onPointsChange?.();
    } catch (error) {
      if (!controller.signal.aborted) setCheckInStatus(apiError(error, '签到失败，请重试。').message);
    } finally {
      checkInRequest.current = null;
      if (!controller.signal.aborted) setCheckingIn(false);
    }
  }

  return <div className="ddz-points" aria-label="斗地主积分">
    <div className="ddz-points-balance"><Coins size={18} aria-hidden="true" />
      <span>我的积分</span><strong>{points?.points.toLocaleString() ?? '—'}</strong>
    </div>
    {points && <button type="button" disabled={checkingIn || points.checkedIn} onClick={() => void checkIn()}>
      {points.checkedIn && <Check size={15} aria-hidden="true" />}
      {checkingIn ? '签到中…' : points.checkedIn ? '今日已签到' : `签到领 ${points.dailyReward} 分`}
    </button>}
    {loadError && <button type="button" onClick={() => setRetry(value => value + 1)}>重试</button>}
    <p className="ddz-feedback">当月每 100 积分折算 1 总榜分，每月最多加 3 分。</p>
    {(loadError || checkInStatus) && <p className="ddz-feedback" role="status">{loadError || checkInStatus}</p>}
  </div>;
}

function normalizeCode(value: string) {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
}

function RoomGame({ userId, onPointsChange }: { userId?: string; onPointsChange?: () => void }) {
  const storageKey = `deep-community:doudizhu:room:${userId ? `user:${userId}` : 'guest'}`;
  const [room, setRoom] = useState<Room | null>(null);
  const [savedRoom, setSavedRoom] = useState(() => roomStorage(storageKey));
  const [joinCode, setJoinCode] = useState(() => normalizeCode(new URLSearchParams(window.location.search).get('room') || ''));
  const [restore, setRestore] = useState(() => Boolean(savedRoom && (!userId || !joinCode || savedRoom === joinCode)));
  const [mode, setMode] = useState<HumanCount>(1);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [connection, setConnection] = useState('');
  const [copied, setCopied] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mutation = useRef(0);
  const currentRoom = useRef<Room | null>(null);
  const inputId = useId();
  const activeCode = room?.code ?? (restore ? savedRoom : null);
  const solo = room?.humans === 1;

  useEffect(() => () => request.current?.abort(), []);

  const abandonRoom = useCallback(() => {
    roomStorage(storageKey, null);
    currentRoom.current = null;
    setRoom(null);
    setSavedRoom(null);
    setRestore(false);
    setSelected([]);
    setConnection('');
    setCopied(false);
  }, [storageKey]);

  const acceptRoom = useCallback((next: Room) => {
    const previous = currentRoom.current;
    if (previous?.code === next.code && next.revision < previous.revision) return;
    if (next.phase === 'closed') {
      abandonRoom();
      setError('房间已关闭，可以创建或加入新房间。');
      return;
    }
    if (previous?.code !== next.code || previous.phase !== next.phase) setSelected([]);
    if (previous?.code !== next.code) {
      roomStorage(storageKey, next.code);
      setSavedRoom(next.code);
      setCopied(false);
    }
    currentRoom.current = next;
    setRoom(next);
    setRestore(false);
  }, [abandonRoom, storageKey]);

  useEffect(() => {
    if (!activeCode) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const startedInRoom = currentRoom.current !== null;
      const startedBeforeMutation = mutation.current;
      const stale = () => controller.signal.aborted || request.current || mutation.current !== startedBeforeMutation
        || (startedInRoom && currentRoom.current?.code !== activeCode);
      try {
        if (request.current || (document.hidden && startedInRoom)) return;
        const { data } = await apiClient.get<Room>(`${ROOMS}/${activeCode}`, { signal: controller.signal });
        if (stale()) return;
        setConnection('');
        acceptRoom(data);
      } catch (error) {
        if (stale()) return;
        const { status, message } = apiError(error, '暂时无法连接牌桌。');
        if (status === 403 || status === 404 || status === 410) {
          abandonRoom();
          setError(message);
        } else if (!currentRoom.current) {
          setRestore(false);
          setError(message);
        } else {
          setConnection('正在重新连接牌桌…');
        }
      } finally {
        if (!controller.signal.aborted) timer = setTimeout(poll, document.hidden || solo ? 5000 : 1600);
      }
    };
    if (currentRoom.current) timer = setTimeout(poll, solo ? 5000 : 1600);
    else void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [abandonRoom, acceptRoom, activeCode, solo]);

  async function post(path: string, payload?: unknown, action?: Action['action']) {
    if (request.current || restore) return false;
    const controller = new AbortController();
    request.current = controller;
    mutation.current += 1;
    setBusy(true);
    setError('');
    try {
      const { data } = await apiClient.post<Room | { ok: boolean }>(path, payload, { signal: controller.signal });
      if (controller.signal.aborted) return false;
      if ('code' in data) {
        setConnection('');
        if (action === 'leave') abandonRoom();
        else acceptRoom(data);
      }
      if (action) setSelected([]);
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      const { status, message } = apiError(error, '操作未完成，请稍后重试。');
      if (action && (status === 404 || status === 410)) abandonRoom();
      setError(message);
      return false;
    } finally {
      if (request.current === controller) request.current = null;
      if (!controller.signal.aborted) setBusy(false);
    }
  }

  function submitJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (userId && joinCode.length === 6) void post(`${ROOMS}/${joinCode}/join`);
  }

  function act(action: Action) {
    const latest = currentRoom.current;
    if (latest) void post(`${ROOMS}/${latest.code}/action`, { ...action, revision: latest.revision }, action.action);
  }

  function sendInteraction(preset: InteractionPreset, target: number | null) {
    const latest = currentRoom.current;
    if (!latest) return Promise.resolve(false);
    return post(`${ROOMS}/${latest.code}/interactions`, { kind: preset.kind, preset: preset.id, target_seat: target });
  }

  function replyInvitation(invitation: Invitation, decision: InviteDecision) {
    const latest = currentRoom.current;
    if (decision === 'accept' && latest && latest.code !== invitation.code) return Promise.resolve(false);
    return post(`${INVITATIONS}/${invitation.id}/${decision}`);
  }

  async function copyInvite(code: string) {
    const invite = new URL('/404', window.location.origin);
    invite.searchParams.set('game', 'doudizhu');
    invite.searchParams.set('room', code);
    try {
      await navigator.clipboard.writeText(invite.href);
      if (currentRoom.current?.code === code) setCopied(true);
    } catch {
      if (currentRoom.current?.code === code) setError('未能自动复制，请手动选中房间号复制。');
    }
  }

  return <>
    <div className="ddz-top">
      <Header room={room} />
      {room && <div className="ddz-room-tools">
        <div className="ddz-room-code">
          <span>房间号</span><code>{room.code}</code>
          {room.humans > 1 && <button type="button" aria-label={copied ? '邀请链接已复制' : '复制邀请链接'}
            title={copied ? '已复制' : '复制邀请链接'} onClick={() => void copyInvite(room.code)}>
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>}
        </div>
        <button type="button" disabled={busy} onClick={() => act({ action: 'leave' })}><DoorOpen size={16} />离开</button>
      </div>}
    </div>
    {userId && <>
      <PointsPanel onPointsChange={onPointsChange} />
      <InvitationInbox activeCode={activeCode} busy={busy || restore} onReply={replyInvitation} />
    </>}
    {error && <p className="ddz-feedback ddz-feedback--error" role="alert">{error}</p>}
    {connection && room && <p className="ddz-feedback" role="status">{connection}</p>}
    {room ? <>
      <div className="ddz-room-status">
        <span>{PHASE_LABELS[room.phase]}</span>
        {room.phase === 'finished' && (room.host
          ? <button type="button" className="ddz-primary" disabled={busy} onClick={() => act({ action: 'restart' })}>再来一局<ArrowRight size={16} /></button>
          : <span>等待房主开始下一局</span>)}
      </div>
      {userId && room.host && room.phase === 'waiting' && room.humans > 1 && <InvitePlayers key={`invite-${room.code}`} code={room.code} />}
      <Table key={room.code} room={room} busy={busy} selected={selected} onSelect={setSelected} onAction={act} onSend={sendInteraction} />
    </> : <div className="ddz-entry">
      {restore ? <p className="ddz-feedback" role="status">正在恢复房间 {savedRoom}…</p> : <>
        {savedRoom && <button type="button" className="ddz-resume" disabled={busy} onClick={() => { setError(''); setRestore(true); }}>
          返回房间 <code>{savedRoom}</code><ArrowRight size={16} />
        </button>}
        {userId ? <fieldset className="ddz-modes" disabled={busy}>
          <legend>创建牌桌</legend>
          <div className="ddz-mode-options">
            {MODES.map(({ count, label, detail }) => <label className="ddz-mode" key={count}>
              <input type="radio" name={inputId} checked={mode === count} onChange={() => setMode(count)} />
              <span><strong>{label}</strong><small>{detail}</small></span>
            </label>)}
          </div>
        </fieldset> : <p className="ddz-feedback">可直接与两位电脑玩家练习。登录后可创建或加入好友房间。</p>}
        <div className="ddz-entry-tools">
          <button type="button" className="ddz-primary" disabled={busy} onClick={() => void post(ROOMS, { humans: mode })}>
            {mode === 1 ? '开始练习' : '创建房间'}<ArrowRight size={16} />
          </button>
          {userId && <form className="ddz-join" onSubmit={submitJoin}>
            <label htmlFor={inputId}>加入好友房间</label>
            <div>
              <input id={inputId} value={joinCode} disabled={busy} placeholder="输入房间号" autoComplete="off" autoCapitalize="characters"
                spellCheck={false} onChange={event => setJoinCode(normalizeCode(event.target.value))} />
              <button type="submit" disabled={busy || joinCode.length !== 6}>加入</button>
            </div>
          </form>}
        </div>
      </>}
    </div>}
    <Rules />
  </>;
}

export default function DouDizhu({ userId, onPointsChange }: { userId?: string | null; onPointsChange?: () => void }) {
  return <section className="ddz" aria-label="斗地主">
    {userId === null ? <>
      <Header />
      <div className="ddz-entry"><p className="ddz-feedback" role="status">正在准备牌桌…</p></div>
    </> : <RoomGame key={userId ?? 'guest'} userId={userId} onPointsChange={onPointsChange} />}
  </section>;
}
