import React, { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Home, Medal, Trophy, Clock } from 'lucide-react';
import { apiClient } from '../api/client';
import { CustomDropdown } from './CustomDropdown';

const FleaGameFrame = lazy(() =>
  import('./minigames/FleaGameFrame').then((m) => ({ default: m.FleaGameFrame }))
);
import type { Match } from "./minigames/BoardGame";

const BoardGame = lazy(() =>
  import('./minigames/BoardGame').then((m) => ({ default: m.BoardGame }))
);
const Snake = lazy(() =>
  import('./minigames/CanvasGames').then((m) => ({ default: m.Snake }))
);

interface GameDef {
  code: string; name: string; zone: 'solo' | 'versus';
  engine: string; path: string; difficulty: number;
  target_score: number; ref_seconds: number; license: string;
}

const TIER_META: Record<string, { label: string; style: string }> = {
  gold: { label: '迷途霸主', style: 'border-amber-400/50 bg-amber-400/10 text-amber-600' },
  silver: { label: '迷途高手', style: 'border-slate-300/60 bg-slate-300/10 text-slate-500' },
  bronze: { label: '迷路玩家', style: 'border-orange-400/50 bg-orange-400/10 text-orange-600' },
};

const MEDAL_LABELS = [
  '月度摸鱼战神 / 月度惜败高手 / 月度运气选手',
  '不死连杀王 / 稳赢机器 / 好运传送带',
  '老牌赢麻大师 / 对局劳模 / 长期上分选手',
];

const RankCard: React.FC<{ title: string; url: string; season: string; reload: number; unit?: string }> =
  ({ title, url, season, reload, unit }) => {
    const [items, setItems] = useState<any[]>([]);
    const [myRank, setMyRank] = useState<number | null>(null);
    const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
    const [attempt, setAttempt] = useState(0);
    useEffect(() => {
      const request = new AbortController();
      setStatus('loading');
      apiClient.get(url, { params: { season }, signal: request.signal })
        .then(({ data }) => {
          if (request.signal.aborted) return;
          setItems(data.items || []);
          setMyRank(data.my_rank ?? null);
          setStatus('ready');
        })
        .catch(() => { if (!request.signal.aborted) setStatus('error'); });
      return () => request.abort();
    }, [url, season, reload, attempt]);
    return (
      <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle">
        <div className="flex items-center gap-1.5 mb-2">
          <Trophy className="w-3.5 h-3.5 text-wb-brand" />
          <h3 className="text-2xs font-bold text-wb-text-primary">{title}</h3>
          <span className="ml-auto text-3xs text-wb-text-muted">前 10</span>
        </div>
        {status === 'loading' ? (
          <p role="status" className="text-3xs text-wb-text-muted py-3 text-center">正在加载排行榜…</p>
        ) : status === 'error' ? (
          <div className="flex items-center justify-center gap-2 py-2 text-3xs text-wb-text-muted">
            <span role="status">排行榜加载失败</span>
            <button type="button" onClick={() => setAttempt((n) => n + 1)} className="rounded px-2 py-1 text-wb-brand hover:bg-wb-bg-subtle">重试</button>
          </div>
        ) : items.length === 0 ? (
          <p className="text-3xs text-wb-text-muted py-3 text-center">本赛季暂无成绩</p>
        ) : (
          <ol className="space-y-1">
            {items.slice(0, 10).map((r) => (
              <li key={r.user_id || r.rank} className="flex items-center gap-2 text-2xs">
                <span className={`w-5 text-center font-mono font-bold ${r.rank <= 3 ? 'text-wb-brand' : 'text-wb-text-muted'}`}>
                  {r.rank}
                </span>
                <span className="flex-1 truncate text-wb-text-primary">{r.nickname || r.username}</span>
                <span className="font-mono text-wb-text-secondary">
                  {r.total_score ?? r.score}{unit || ''}
                </span>
              </li>
            ))}
          </ol>
        )}
        {status === 'ready' && myRank !== null && <p className="mt-2 text-2xs text-wb-text-secondary">我的排名 · 第 {myRank} 名</p>}
      </div>
    );
  };

/** 贪吃蛇保留自研，但接入同一套 run_id 反作弊凭证 */
const SnakeScored: React.FC<{ loggedIn: boolean; onDone?: () => void }> = ({ loggedIn, onDone }) => {
  type Round = { id?: string; result?: { score: number; durationMs: number; won: boolean }; sending: boolean };
  const current = useRef<Round | undefined>(undefined);
  const [status, setStatus] = useState('');
  const [canRetry, setCanRetry] = useState(false);
  const onRoundStart = useCallback(async () => {
    const round: Round = { sending: false };
    current.current = round;
    setCanRetry(false);
    if (!loggedIn) return;
    setStatus('正在领取本局计分凭证');
    try {
      const { data } = await apiClient.post<{ run_id: string }>('/minigames/snake/run');
      round.id = data.run_id;
      setStatus(round.id ? '本局结束后自动结算' : '本局未取得计分凭证');
    } catch {
      setStatus('本局以练习模式进行，计分凭证领取失败');
    }
  }, [loggedIn]);
  const submit = useCallback(async (round: Round) => {
    if (!round.id || !round.result || round.sending) return;
    const { score, durationMs, won } = round.result;
    round.sending = true;
    setCanRetry(false);
    setStatus('正在结算本局成绩');
    try {
      const { data } = await apiClient.post<{ season_score: number }>('/minigames/snake/score', {
        run_id: round.id, score, duration_ms: durationMs, completed: true,
        metrics: { raw: score, elapsedMs: durationMs, won, finished: true },
      });
      if (current.current === round) setStatus(`已计分 · 原始分 ${score} · 赛季分 ${data.season_score}`);
      onDone?.();
    } catch (error: any) {
      if (current.current !== round) return;
      if (error.response?.status === 409 && error.response?.data?.detail === '该局已结算，不能重复上报') {
        setStatus('本局成绩已计入赛季积分');
        onDone?.();
        return;
      }
      round.sending = false;
      setStatus(error.response?.data?.detail || '成绩结算失败');
      setCanRetry(!error.response || error.response.status >= 500);
    }
  }, [onDone]);
  const onScore = useCallback((score: number, durationMs: number, won: boolean) => {
    const round = current.current;
    if (!round?.id || round.result) return;
    round.result = { score, durationMs, won };
    void submit(round);
  }, [submit]);
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-3xs text-wb-text-muted">
        <span role="status">{loggedIn ? status : '登录后成绩才会计入榜单'}</span>
        {canRetry && <button type="button" className="text-wb-brand" onClick={() => {
          if (current.current) void submit(current.current);
        }}>重试成绩提交</button>}
      </div>
      <Snake onScore={onScore} onRoundStart={onRoundStart} />
    </div>
  );
};

/** 404 页：注册中心驱动的游戏大厅 + 赛季榜单 + 棋类对战。 */
export const NotFoundGame: React.FC = () => {
  const [games, setGames] = useState<GameDef[]>([]);
  const [zones, setZones] = useState<Record<string, string>>({ solo: '单人摸鱼池', versus: '双人互坑局' });
  const [zone, setZone] = useState<'solo' | 'versus'>('solo');
  const [selected, setSelected] = useState('');
  const [season, setSeason] = useState('');
  const [seasons, setSeasons] = useState<string[]>([]);
  const [tiers, setTiers] = useState<string[]>([]);
  const [reload, setReload] = useState(0);
  const [entryMatch, setEntryMatch] = useState<Match>();
  const [deepGame, setDeepGame] = useState('');
  const [myId, setMyId] = useState('');
  const [battles, setBattles] = useState<{ items: Match[]; active?: Match | null }>({ items: [] });
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [battleRefresh, setBattleRefresh] = useState(0);
  const finishedBattlesRef = useRef<Set<string> | null>(null);
  const pendingInvites = battles.items.filter((m) => m.status === "pending" && m.invitee_id === myId);
  const refreshBattles = useCallback(() => setBattleRefresh((n) => n + 1), []);
  const reportBattleResult = useCallback((id: string) => {
    const finished = finishedBattlesRef.current ??= new Set();
    if (finished.has(id)) return;
    finished.add(id);
    setReload((n) => n + 1);
  }, []);
  const autoEnteredRef = useRef<Set<string>>(new Set());
  const deepLockRef = useRef('');
  const loggedIn = !!localStorage.getItem('access_token');


  // 页内对战邀请：不用跳去通知中心，在 404 页直接看到并接受
  useEffect(() => {
    if (!loggedIn) return;
    let alive = true;
    apiClient.get('/auth/me')
      .then((res) => { if (alive) setMyId(res.data?.id || ''); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [loggedIn]);

  useEffect(() => {
    if (!loggedIn || !myId) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const poll = async () => {
      try {
        const res = await apiClient.get("/battles/me", {
          params: { active_match_id: activeMatchId || undefined },
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const items: Match[] = res.data?.items || [];
        const active: Match | null = res.data?.active || null;
        const finished = items.filter((match) => match.status === "finished");
        if (active?.status === "finished") finished.push(active);
        if (finishedBattlesRef.current === null) {
          finishedBattlesRef.current = new Set(finished.map((match) => match.id));
        } else {
          finished.forEach((match) => reportBattleResult(match.id));
        }
        setBattles({ items, active });

        // 明确的深链或当前打开的棋局优先于自动进入另一局。
        if (activeMatchId || new URLSearchParams(window.location.search).get("match")) return;
        const begun = items.find((m) =>
          m.status === "playing" && m.inviter_id === myId &&
          !autoEnteredRef.current.has(m.id) &&
          m.created_at && Date.now() - new Date(m.created_at).getTime() < 10 * 60 * 1000
        );
        if (begun) {
          autoEnteredRef.current.add(begun.id);
          setDeepGame(begun.game_code);
          setZone("versus");
          setSelected(begun.game_code);
          setEntryMatch(begun);
        }
      } catch { /* 下次轮询继续同步 */ }
      finally {
        if (!controller.signal.aborted) timer = window.setTimeout(() => void poll(), 2500);
      }
    };
    void poll();
    return () => { controller.abort(); window.clearTimeout(timer); };
  }, [loggedIn, myId, activeMatchId, battleRefresh, reportBattleResult]);

  const GAME_NAME: Record<string, string> = { gomoku: '五子棋', xiangqi: '中国象棋', tictactoe: '井字棋' };

  const [inviteNotice, setInviteNotice] = useState('');

  const answerInvite = async (m: Match, action: 'accept' | 'decline') => {
    try {
      const res = await apiClient.post(`/battles/${m.id}/${action}`);
      setBattles((prev) => ({ ...prev, items: prev.items.map((match) => match.id === m.id
        ? { ...match, status: action === "accept" ? "playing" : "declined" } : match) }));
      refreshBattles();
      if (action === 'accept') {
        setDeepGame(m.game_code);
        setZone('versus');
        setSelected(m.game_code);
        setEntryMatch({ ...m, ...res.data });
      }
    } catch (err: any) {
      setInviteNotice(err?.response?.data?.detail || '操作失败，请到「我的对局」里处理');
    }
  };

  // 把任意未知路径统一规范成正式的 /404 入口（保留查询串，便于深链）
  useEffect(() => {
    const target = '/404';
    const p = window.location.pathname.replace(/\/+$/, '') || '/';
    if (p !== target) {
      try {
        window.history.replaceState({}, '', target + window.location.search + window.location.hash);
      } catch { /* 某些浏览器隐私模式可能拒绝 */ }
    }
  }, []);

  // 通知/深链带 ?zone=versus&match=<id> 时自动切到双人区并选中对应棋种
  useEffect(() => {
    const q = new URLSearchParams(window.location.search);
    const mid = q.get('match');
    if (q.get('zone') === 'versus') setZone('versus');
    if (!mid) return;
    apiClient.get(`/battles/${mid}`, { params: { include_moves: false } })
      .then((res) => {
        const code = res.data?.game_code;
        if (code) { setEntryMatch(res.data); setDeepGame(code); setZone('versus'); setSelected(code); }
      })
      .catch(() => setZone('versus'));
  }, []);

  useEffect(() => {
    let alive = true;
    apiClient.get('/minigames/games').then((res) => {
      if (!alive) return;
      const d = res.data || {};
      setGames(d.games || []);
      setZones(d.zones || zones);
      setSeason((s) => s || d.season || '');
    }).catch(() => undefined);
    apiClient.get('/minigames/seasons').then((res) => {
      if (alive) setSeasons(res.data?.seasons || []);
    }).catch(() => undefined);
    if (loggedIn) {
      apiClient.get('/minigames/me/status').then((res) => {
        if (alive) setTiers(res.data?.tiers || []);
      }).catch(() => undefined);
    }
    return () => { alive = false; };
  }, [loggedIn]);

  const zoneGames = useMemo(() => games.filter((g) => g.zone === zone), [games, zone]);
  useEffect(() => {
    // 深链指定的棋种只强制应用一次，避免用户手动切 tab 后被反复拉回
    if (deepGame && deepLockRef.current !== deepGame && zoneGames.some((g) => g.code === deepGame)) {
      deepLockRef.current = deepGame;
      if (selected !== deepGame) setSelected(deepGame);
      return;
    }
    if (zoneGames.length && !zoneGames.some((g) => g.code === selected)) {
      setSelected(zoneGames[0].code);
    }
  }, [zoneGames, selected, deepGame]);
  const current = zoneGames.find((g) => g.code === selected) || zoneGames[0];

  const bump = useCallback(() => setReload((n) => n + 1), []);

  return (
    <div className="min-h-screen py-8 px-4 bg-wb-bg-page text-wb-text-primary">
      <div className="max-w-5xl mx-auto space-y-5">
        <header className="text-center space-y-1">
          <p className="text-[56px] leading-none font-black tracking-tighter bg-gradient-to-br from-wb-text-primary to-wb-text-secondary bg-clip-text text-transparent select-none">404</p>
          <h1 className="text-sm font-semibold">摸鱼游乐场 · 这个页面不存在，但游戏是真的</h1>
          <p className="text-3xs text-wb-text-muted">赛季积分 = 难度系数 × 完成度 ÷ 用时，统一换算 0–100；每月结算发勋章</p>
        </header>

        {inviteNotice && (
          <div className="px-3 py-2 rounded-2xl bg-wb-danger/10 border border-wb-danger/30 text-2xs text-wb-danger">
            {inviteNotice}
          </div>
        )}

        {/* 页内对战邀请：有待接受邀请时直接横幅提示，不必跳去通知中心 */}
        {pendingInvites.length > 0 && (
          <div className="space-y-1.5">
            {pendingInvites.map((m) => (
              <div key={m.id} className="flex items-center gap-2 flex-wrap px-3 py-2 rounded-2xl bg-wb-info/10 border border-wb-info/30 text-2xs">
                <span className="flex-1 min-w-0 truncate text-wb-text-primary font-semibold">
                  {m.inviter_name || '有人'} 邀请你下{GAME_NAME[m.game_code] || '棋'}
                </span>
                <button type="button" onClick={() => void answerInvite(m, 'accept')}
                  className="h-7 px-3 rounded-capsule bg-wb-success text-white font-semibold shrink-0">接受并进入</button>
                <button type="button" onClick={() => void answerInvite(m, 'decline')}
                  className="h-7 px-3 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle shrink-0">拒绝</button>
              </div>
            ))}
          </div>
        )}

        {/* 分区 + 赛季（全部榜单支持回看） */}
        <div className="flex items-center justify-between gap-2 flex-wrap p-2 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle">
          <div className="flex items-center gap-1.5">
            {(['solo', 'versus'] as const).map((z) => (
              <button key={z} type="button" onClick={() => { setZone(z); setDeepGame(''); setEntryMatch(undefined); deepLockRef.current = ''; }}
                className={`h-8 px-3 rounded-capsule text-2xs font-semibold whitespace-nowrap transition-colors ${zone === z ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'}`}>
                {zones[z]}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1.5 text-2xs text-wb-text-muted">
            <Clock className="w-3.5 h-3.5" /> <span>赛季</span>
            <CustomDropdown
              value={season}
              onChange={(v) => setSeason(String(v))}
              options={(seasons.length ? seasons : [season || '']).filter(Boolean).map((s) => ({ value: s, label: s }))}
              icon={<Clock className="w-3 h-3" />}
              size="xs"
              align="right"
              menuWidth="w-32"
            />
          </div>
        </div>

        {/* 游戏 tab（注册中心下发，懒加载） */}
        <div className="flex gap-1.5 overflow-x-auto no-scrollbar pb-1">
          {zoneGames.map((g) => (
            <button key={g.code} type="button" onClick={() => {
              setSelected(g.code); setDeepGame(''); setEntryMatch(undefined); deepLockRef.current = '';
            }}
              className={`h-9 px-3 rounded-capsule text-2xs font-semibold whitespace-nowrap shrink-0 transition-colors ${current?.code === g.code ? 'bg-wb-text-primary text-wb-bg-page' : 'bg-wb-bg-surface border border-wb-border-subtle text-wb-text-secondary hover:text-wb-text-primary'}`}>
              {g.name}
            </button>
          ))}
        </div>

        {/* 游戏区 */}
        <div className="p-3 md:p-4 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle">
          <Suspense fallback={<div className="py-16 text-center text-2xs text-wb-text-muted">游戏加载中…</div>}>
            {current?.engine === 'iframe' && (
              <FleaGameFrame game={current} loggedIn={loggedIn} onScoreSubmitted={bump} />
            )}
            {current?.engine === 'react' && (
              <div className="space-y-2">
                <p className="text-3xs text-wb-text-muted px-1">登录后成绩计入赛季积分</p>
                <SnakeScored loggedIn={loggedIn} onDone={bump} />
              </div>
            )}
            {current?.engine === 'battle' && (
              <BoardGame
                key={current.code} gameCode={current.code as "gomoku" | "xiangqi" | "tictactoe"}
                loggedIn={loggedIn} myId={myId} matches={battles.items} activeSnapshot={battles.active}
                initialMatch={entryMatch} onActiveMatch={setActiveMatchId}
                onResult={reportBattleResult} refreshBattles={refreshBattles}
              />
            )}
          </Suspense>
        </div>

        {/* 榜单区 */}
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <Medal className="w-4 h-4 text-wb-brand" />
            <h2 className="text-xs font-bold">{season} 赛季榜单</h2>
            <span className="text-3xs text-wb-text-muted">切换上方赛季可回看历史</span>
          </div>
          <div className="grid sm:grid-cols-2 gap-3">
            <RankCard title="跨游戏总榜" url="/minigames/overall" season={season} reload={reload} unit=" 分" />
            {current?.zone === 'solo' && current && (
              <RankCard title={`${current.name} · 独立榜`} url={`/minigames/${current.code}/leaderboard`} season={season} reload={reload} />
            )}
            <RankCard title="连胜榜" url="/minigames/streak" season={season} reload={reload} unit=" 连胜" />
            <RankCard title="累计胜利榜" url="/minigames/wins" season={season} reload={reload} unit=" 胜" />
          </div>
        </div>

        {/* 勋章说明 */}
        <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle space-y-2">
          <div className="flex items-center gap-1.5 text-2xs font-semibold">
            <Medal className="w-3.5 h-3.5 text-wb-brand" /> 摸鱼勋章 · 每月结算，下月佩戴整月
          </div>
          <p className="text-3xs text-wb-text-muted leading-relaxed">
            总榜前三：{MEDAL_LABELS[0]}<br />
            连胜榜前三：{MEDAL_LABELS[1]}<br />
            累计胜利榜前三：{MEDAL_LABELS[2]}
          </p>
          <p className="text-3xs text-wb-text-muted/80">
            单游戏段位实时判定：🥉 有成绩 · 🥈 任意一款前 5 · 🥇 任意一款第 1
          </p>
          {tiers.length > 0 && (
            <div className="flex gap-1.5 flex-wrap">
              {tiers.map((t) => (
                <span key={t} className={`px-2 py-0.5 rounded-capsule border text-3xs font-semibold ${TIER_META[t]?.style || ''}`}>
                  {TIER_META[t]?.label || t}
                </span>
              ))}
            </div>
          )}
          <p className="text-3xs text-wb-text-muted/70">
            游戏来源：huazie/flea-game、stringify/ChineseChessOnline（MIT）。和棋中断连胜，认输计负；AI 练习不计分。
          </p>
        </div>

        <div className="text-center">
          <button type="button" onClick={() => { window.location.href = '/'; }}
            className="inline-flex items-center gap-1.5 text-2xs font-semibold text-wb-text-secondary hover:text-wb-text-primary px-3 py-2">
            <Home className="w-3.5 h-3.5" /> 回到首页
          </button>
        </div>
      </div>
    </div>
  );
};
