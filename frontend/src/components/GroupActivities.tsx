import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Plus, BarChart3, Brush, CheckCircle2, ClipboardList, Link2, Feather } from 'lucide-react';
import { apiClient } from '../api/client';
import { useDialogA11y } from '../hooks/useDialogA11y';
import { DrawGuessPanel } from './DrawGuessPanel';

const ROOM_PATH = (roomId: string, tail: string) => `/chat/groups/${roomId}/${tail}`;

/**
 * 群经验反馈：游戏接口都会回传本次实得经验。
 * - 实得 0 且今日额度用尽 → 明确告诉用户是上限，而不是「没反应」；
 * - 升级 → 提示并广播给聊天页，让铭牌/等级立刻刷新。
 */
export const reportGroupExp = (toast: any, data: any) => {
  const gain = Number(data?.exp_gained);
  if (!Number.isFinite(gain)) return;
  window.dispatchEvent(new CustomEvent('geek:group-exp-changed', {
    detail: {
      exp_gained: gain,
      group_level: Number(data?.group_level) || 0,
      level_up: Boolean(data?.level_up),
      daily_exp_left: Number(data?.daily_exp_left) || 0,
    },
  }));
  if (data?.level_up) {
    toast?.success?.(`群等级提升到 Lv.${data?.group_level ?? ''}`);
  } else if (gain === 0 && Number(data?.daily_exp_left) === 0) {
    toast?.info?.('今日群经验已达上限，明天再来');
  }
};

/* ==================== 每日求签：运势卡片 ==================== */
export interface FortuneResult {
  tier: string; label: string; grade: string; stars: number; style: string;
  icon: string; wish: string; quote: string; lucky: string; remaining: number;
}

export const FortuneOverlay: React.FC<{ data: FortuneResult | null; onClose: () => void; embedded?: boolean }> = ({ data, onClose, embedded = false }) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!data) return null;
  return createPortal(
    <div
      className={embedded
        ? 'fixed inset-0 flex items-center justify-center p-4 z-[9995] bg-black/35'
        : 'fixed inset-0 z-[300] flex items-center justify-center bg-black/65 backdrop-blur-md p-4'}
      onClick={onClose}
    >
      <div className={`fortune-card ${data.style}`} onClick={(e) => e.stopPropagation()}>
        <button type="button" onClick={onClose} aria-label="关闭"
          className="absolute top-3 right-3 w-8 h-8 rounded-full bg-black/10 hover:bg-black/20 inline-flex items-center justify-center">
          <X className="w-4 h-4" />
        </button>
        <div className="fortune-card__inner">
          <p className="text-3xs font-mono tracking-[0.3em] opacity-70">DAILY FORTUNE · 每日求签</p>
          <div className="text-[64px] leading-none my-3 animate-[wb-pop_0.5s_ease-out]">{data.icon}</div>
          <h2 className="text-lg font-bold">{data.label}</h2>
          <p className="text-2xs font-mono mt-1 opacity-80">{data.grade} · {'★'.repeat(data.stars)}{'☆'.repeat(5 - data.stars)}</p>
          <div className="my-4 h-px bg-current opacity-20" />
          <p className="text-xs font-semibold leading-relaxed">{data.wish}</p>
          <p className="text-2xs leading-relaxed mt-2 opacity-85">{data.quote}</p>
          <p className="mt-4 inline-block px-3 py-1 rounded-capsule bg-black/10 text-2xs font-semibold">{data.lucky}</p>
          <p className="text-3xs opacity-70 mt-4">今天还可求签 {data.remaining} 次</p>
        </div>
      </div>
    </div>, document.body
  );
};

/* ==================== 成语接龙 ==================== */
const ChainPanel: React.FC<{ roomId: string; toast: any; refreshKey?: number }> = ({ roomId, toast, refreshKey = 0 }) => {
  const [state, setState] = useState<any>(null);
  const [active, setActive] = useState(false);
  const [result, setResult] = useState<any>(null);
  const [canManage, setCanManage] = useState(false);
  const [presets, setPresets] = useState<number[]>([5, 10, 15, 30]);
  const [minutes, setMinutes] = useState<number>(10);
  const [remaining, setRemaining] = useState<number>(0);
  const [idiomStats, setIdiomStats] = useState<any>(null);
  const [word, setWord] = useState('');
  const [busy, setBusy] = useState(false);
  const reloadGuardRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get(ROOM_PATH(roomId, 'idiom-chain/state'));
      const d = r.data || {};
      setActive(Boolean(d.active));
      setState(d.state || null);
      setResult(d.result || null);
      setCanManage(Boolean(d.can_manage));
      if (Array.isArray(d.presets) && d.presets.length) setPresets(d.presets);
      if (d.default_minutes) setMinutes((m) => (d.active ? m : Number(d.default_minutes) || m));
      setRemaining(Number(d.remaining_seconds || 0));
      if (d.idiom_stats) setIdiomStats(d.idiom_stats);
    } catch { setActive(false); }
  }, [roomId]);
  useEffect(() => { void load(); }, [load]);

  // 别人答题 / 开局 / 结算：后端 chain_update 推过来就立刻刷新，
  // 否则会出现「他已经接了，我这边还显示上一个结尾字」。
  useEffect(() => {
    if (!refreshKey) return;
    void load();
  }, [refreshKey, load]);

  // 兜底轮询：WS 漏帧、断线或跨标签页时，最多 3 秒也能追上进度
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(timer);
  }, [active, load]);

  // 倒计时：本地每秒递减；归零时回后端拉一次战报（只触发一次）
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setRemaining((prev) => Math.max(0, prev - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [active]);

  useEffect(() => {
    if (remaining > 0) { reloadGuardRef.current = false; return; }
    if (active && !reloadGuardRef.current) {
      reloadGuardRef.current = true;
      void load();
    }
  }, [active, remaining, load]);

  const countdown = useMemo(() => {
    const m = Math.floor(Math.max(0, remaining) / 60);
    const s = Math.max(0, remaining) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [remaining]);

  // 实时榜单（接对次数降序，答错少者优先）
  const liveRows = useMemo(() => {
    const scores = state?.scores || {};
    return (Object.values(scores) as any[])
      .map((s) => ({ user: s?.user || '成员', ok: Number(s?.ok || 0), wrong: Number(s?.wrong || 0) }))
      .filter((r) => r.ok > 0)
      .sort((a, b) => b.ok - a.ok || a.wrong - b.wrong)
      .slice(0, 5);
  }, [state]);

  const ranking: any[] = Array.isArray(result?.ranking) ? result.ranking : [];

  const start = async () => {
    setBusy(true);
    try {
      const r = await apiClient.post(ROOM_PATH(roomId, 'idiom-chain/start'), { duration_minutes: minutes });
      setActive(true);
      setState(r.data?.state);
      setResult(null);
      setRemaining(Number(r.data?.remaining_seconds || minutes * 60));
      toast.success(`接龙开局，本局 ${minutes} 分钟`);
    } catch (e: any) { toast.error(e?.response?.data?.detail || '开局失败'); }
    finally { setBusy(false); }
  };
  const answer = async () => {
    const raw = word.trim();
    if (!raw) return;
    // 允许粘贴整段文字或一次写多个词：取第一个四字成语提交；
    // 未满四个字时只提示、不清空输入，用户可以继续补全
    const candidate = (raw.match(/[\u4e00-\u9fa5]{4}/) || [])[0] || raw;
    if (candidate.length !== 4) {
      toast.info('请输入一个四字成语');
      return;
    }
    setBusy(true);
    try {
      const r = await apiClient.post(ROOM_PATH(roomId, 'idiom-chain/answer'), { word: candidate });
      if (r.data?.state) setState(r.data.state);
      setWord('');
      if (r.data?.ok) {
        const gain = Number(r.data?.exp_gained || 0);
        toast.success(gain > 0 ? `接对了！群经验 +${gain}` : '接对了！');
      } else toast.warning(r.data?.reason || '接错了，本轮淘汰');
      reportGroupExp(toast, r.data);
      if (r.data?.ended) {
        setActive(false);
        await load();
      }
    } catch (e: any) { toast.error(e?.response?.data?.detail || '提交失败'); }
    finally { setBusy(false); }
  };
  const end = async () => {
    try {
      await apiClient.post(ROOM_PATH(roomId, 'idiom-chain/end'));
      toast.success('本局接龙已结束');
      await load();
    } catch (e: any) { toast.error(e?.response?.data?.detail || '结束失败'); }
  };

  return (
    <div className="space-y-3">
      <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle">
        {active && state ? (
          <>
            <div className="flex items-center justify-between">
              <p className="text-2xs text-wb-text-muted">当前要接的读音</p>
              <span className="text-2xs font-mono font-bold text-wb-warn">⏱ {countdown}</span>
            </div>
            <p className="text-2xl font-bold text-wb-text-primary my-1">
              {state.current_char}
              {state.current_sound && <span className="ml-1.5 text-base font-mono text-wb-text-secondary">({state.current_sound})</span>}
            </p>
            <p className="text-3xs text-wb-text-muted">
              同音不同字也可以 · 开局：{state.starter} · 第 {state.round} 轮 · 已用 {state.used?.length || 0} 个成语
            </p>
            {liveRows.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1">
                {liveRows.map((r, i) => (
                  <span key={i} className="px-1.5 py-0.5 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-3xs">
                    {r.user} · {r.ok}
                  </span>
                ))}
              </div>
            )}
          </>
        ) : ranking.length > 0 ? (
          <div className="space-y-1">
            <p className="text-2xs font-bold text-wb-text-primary">🏁 上局战报</p>
            {ranking.map((r: any, i: number) => (
              <div key={i} className="flex items-center gap-2 text-xs">
                <span className="w-5 text-center">{['🥇', '🥈', '🥉'][i] || `${i + 1}.`}</span>
                <span className="font-semibold truncate flex-1">{r.user}</span>
                <span className="text-3xs text-wb-text-muted">接对 {r.ok} 个</span>
              </div>
            ))}
            <p className="text-3xs text-wb-text-muted">
              共 {result?.participants ?? ranking.length} 人接对 · 时长 {result?.duration_minutes ?? 10} 分钟
            </p>
          </div>
        ) : (
          <p className="text-2xs text-wb-text-secondary">
            还没有进行中的接龙。选个时长开局，机器人先出首个成语，成员轮流接末字读音（同音即可），答对一次 +5 群经验，到点自动结算前三名。
          </p>
        )}
        {idiomStats && (
          <p className="text-3xs text-wb-text-muted font-mono">
            词库 {idiomStats.words} 条 · {idiomStats.sounds} 个读音 · 同音接龙（crazywhalecc/idiom-database）
          </p>
        )}
      </div>
      {active ? (
        <>
          <div className="flex gap-1.5">
            <input value={word} onChange={(e) => setWord(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void answer(); }}
              placeholder="输入四字成语（同音即可，可粘贴）"
              className="flex-1 h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs focus:outline-none" />
            <button type="button" disabled={busy || !word.trim()} onClick={() => void answer()}
              className="h-9 px-4 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold disabled:opacity-40">接龙</button>
          </div>
          <div className="max-h-32 overflow-y-auto space-y-1">
            {(state?.entries || []).slice(-8).reverse().map((e: any, i: number) => (
              <div key={`${e.ts || i}-${i}`} className={`flex items-center gap-2 px-2 py-1 rounded-lg text-3xs ${e.bot ? 'bg-wb-brand/10 border border-wb-brand/20' : 'bg-wb-bg-subtle/50'}`}>
                <span className={e.ok ? 'text-wb-success' : 'text-wb-danger'}>{e.ok ? '✓' : '✕'}</span>
                <span className="font-semibold">{e.word}</span>
                <span className="text-wb-text-muted truncate">{e.user}{e.bot ? ' · AI 接词' : e.reason ? ` · ${e.reason}` : ''}</span>
              </div>
            ))}
          </div>
          {canManage && (
            <button type="button" onClick={() => void end()}
              className="w-full h-8 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-3xs text-wb-text-secondary">提前结束本局</button>
          )}
        </>
      ) : (
        <div className="space-y-2">
          <div>
            <p className="text-3xs text-wb-text-muted mb-1">本局时长</p>
            <div className="flex gap-1.5">
              {presets.map((m) => (
                <button key={m} type="button" onClick={() => setMinutes(m)}
                  className={`flex-1 h-8 rounded-capsule text-3xs font-semibold border transition-colors ${
                    minutes === m
                      ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary'
                      : 'bg-wb-bg-subtle border-wb-border-subtle text-wb-text-secondary'
                  }`}>
                  {m} 分钟
                </button>
              ))}
            </div>
          </div>
          <button type="button" disabled={busy} onClick={() => void start()}
            className="w-full h-9 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold disabled:opacity-40">
            {busy ? '开局中…' : `开始成语接龙（${minutes} 分钟）`}
          </button>
        </div>
      )}
    </div>
  );
};

/* ==================== 群投票 ==================== */
const PIE_COLORS = ['#6b8afd', '#43c9a2', '#f3a952', '#e8738a', '#a97be8', '#59b8d8', '#d3a04b', '#8e9aa8'];

const PieChart: React.FC<{ options: any[] }> = ({ options }) => {
  const total = options.reduce((s, o) => s + (o.votes || 0), 0);
  let acc = 0;
  const stops = total
    ? options.map((o, i) => {
        const from = acc; acc += (o.votes / total) * 100;
        return `${PIE_COLORS[i % PIE_COLORS.length]} ${from}% ${acc}%`;
      }).join(', ')
    : `${PIE_COLORS[0]} 0% 100%`;
  return (
    <div className="flex items-center gap-3">
      <div className="w-20 h-20 rounded-full shrink-0 border border-wb-border-subtle"
           style={{ background: `conic-gradient(${stops})` }} aria-label="投票饼图" />
      <div className="flex-1 min-w-0 space-y-1">
        {options.map((o, i) => (
          <div key={o.id} className="flex items-center gap-1.5 text-3xs">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: PIE_COLORS[i % PIE_COLORS.length] }} />
            <span className="truncate flex-1">{o.text}</span>
            <span className="font-mono">{o.percentage}%</span>
          </div>
        ))}
      </div>
    </div>
  );
};

const PollPanel: React.FC<{ roomId: string; toast: any; canManage: boolean; onShareToGroup?: (text: string) => void }> = ({ roomId, toast, canManage, onShareToGroup }) => {
  const [polls, setPolls] = useState<any[]>([]);
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ title: '', description: '', options: '选项A\n选项B', is_multiple: false, is_anonymous: false, max_choices: 2, duration_hours: 72 });
  const [selected, setSelected] = useState<Record<string, number[]>>({});
  const [busy, setBusy] = useState(false);
  const [detailId, setDetailId] = useState('');
  const [report, setReport] = useState<any>(null);

  const load = useCallback(async () => {
    try { const r = await apiClient.get(ROOM_PATH(roomId, 'polls')); setPolls(r.data?.items || []); }
    catch { setPolls([]); }
  }, [roomId]);
  useEffect(() => { void load(); }, [load]);

  const create = async () => {
    const opts = form.options.split('\n').map((s) => s.trim()).filter(Boolean);
    if (form.title.trim().length < 2 || opts.length < 2) return toast.warning('请填标题和至少两个选项');
    setBusy(true);
    try {
      await apiClient.post(ROOM_PATH(roomId, 'polls'), {
        title: form.title.trim(), description: form.description.trim() || null,
        options: opts, is_multiple: form.is_multiple, is_anonymous: form.is_anonymous,
        max_choices: form.is_multiple ? form.max_choices : 1, duration_hours: form.duration_hours,
      });
      setCreating(false); setForm({ ...form, title: '', description: '', options: '选项A\n选项B' });
      toast.success('投票已发起'); await load();
    } catch (e: any) { toast.error(e?.response?.data?.detail || '发起失败'); }
    finally { setBusy(false); }
  };

  const vote = async (p: any) => {
    const ids = selected[p.id] || [];
    if (!ids.length) return toast.warning('先选一个选项');
    setBusy(true);
    try {
      const r = await apiClient.post(ROOM_PATH(roomId, `polls/${p.id}/vote`), { option_ids: ids });
      const gain = Number(r.data?.exp_gained || 0);
      toast.success(gain > 0 ? `投票成功 · 群经验 +${gain}` : '投票成功');
      reportGroupExp(toast, r.data);
      await load();
    }
    catch (e: any) { toast.error(e?.response?.data?.detail || '投票失败'); }
    finally { setBusy(false); }
  };
  const toggle = (p: any, oid: number) => {
    const cur = selected[p.id] || [];
    let next: number[];
    if (p.is_multiple) next = cur.includes(oid) ? cur.filter((x) => x !== oid) : (cur.length >= p.max_choices ? cur : [...cur, oid]);
    else next = [oid];
    setSelected({ ...selected, [p.id]: next });
  };
  const showReport = async (p: any) => {
    try { const r = await apiClient.get(ROOM_PATH(roomId, `polls/${p.id}/report`)); setReport(r.data); }
    catch (e: any) { toast.error(e?.response?.data?.detail || '报告生成失败'); }
  };

  return (
    <div className="space-y-3">
      {canManage && (
        creating ? (
          <div className="p-3 rounded-2xl bg-wb-bg-subtle/60 border border-wb-border-subtle space-y-2">
            <input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })}
              placeholder="投票标题" maxLength={200} className="w-full h-9 px-3 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-2xs" />
            <textarea value={form.options} onChange={(e) => setForm({ ...form, options: e.target.value })}
              rows={3} placeholder="一行一个选项" className="w-full p-2 rounded-xl bg-wb-bg-surface border border-wb-border-subtle text-2xs" />
            <div className="flex flex-wrap gap-2 text-3xs">
              {([['is_multiple', '多选'], ['is_anonymous', '匿名投票']] as const).map(([k, label]) => (
                <label key={k} className="inline-flex items-center gap-1 cursor-pointer">
                  <input type="checkbox" checked={(form as any)[k]} onChange={(e) => setForm({ ...form, [k]: e.target.checked })} />
                  {label}
                </label>
              ))}
              <label className="inline-flex items-center gap-1">最多选
                <input type="number" min={1} max={12} value={form.max_choices}
                  onChange={(e) => setForm({ ...form, max_choices: Number(e.target.value) || 1 })}
                  className="w-12 h-6 px-1 rounded bg-wb-bg-surface border border-wb-border-subtle" /> 项</label>
              <label className="inline-flex items-center gap-1">截止
                <input type="number" min={1} max={720} value={form.duration_hours}
                  onChange={(e) => setForm({ ...form, duration_hours: Number(e.target.value) || 72 })}
                  className="w-14 h-6 px-1 rounded bg-wb-bg-surface border border-wb-border-subtle" /> 小时后</label>
            </div>
            <div className="flex gap-2">
              <button type="button" disabled={busy} onClick={() => void create()}
                className="flex-1 h-8 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold">发起</button>
              <button type="button" onClick={() => setCreating(false)}
                className="h-8 px-3 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-2xs">取消</button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setCreating(true)}
            className="w-full h-9 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold inline-flex items-center justify-center gap-1.5">
            <Plus className="w-3.5 h-3.5" /> 发起群投票
          </button>
        )
      )}

      {polls.length === 0 && <p className="py-4 text-center text-2xs text-wb-text-muted">暂无群投票</p>}
      {polls.map((p) => (
        <div key={p.id} className="p-3 rounded-2xl bg-wb-bg-subtle/50 border border-wb-border-subtle space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-2xs font-bold text-wb-text-primary truncate">{p.title}</p>
              <p className="text-3xs text-wb-text-muted">
                {p.is_multiple ? `多选（最多 ${p.max_choices} 项）` : '单选'} · {p.is_anonymous ? '匿名' : '实名'} · {p.total_votes} 票
                {p.is_expired ? ' · 已结束' : ''}
              </p>
            </div>
            <button type="button" onClick={() => void showReport(p)} title="统计报告"
              className="p-1 rounded-lg text-wb-text-muted hover:text-wb-brand hover:bg-wb-brand/10"><BarChart3 className="w-3.5 h-3.5" /></button>
          </div>

          {p.has_voted || p.is_expired ? (
            <>
              <PieChart options={p.options} />
              <div className="space-y-1">
                {p.options.map((o: any, i: number) => (
                  <div key={o.id} className="text-3xs">
                    <div className="flex justify-between"><span className="truncate">{o.text}</span><span className="font-mono">{o.votes} 票</span></div>
                    <div className="h-1.5 rounded-capsule bg-wb-bg-surface overflow-hidden mt-0.5">
                      <div className="h-full rounded-capsule" style={{ width: `${o.percentage}%`, background: PIE_COLORS[i % PIE_COLORS.length] }} />
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="space-y-1">
                {p.options.map((o: any) => (
                  <button key={o.id} type="button" onClick={() => toggle(p, o.id)}
                    className={`w-full text-left px-2.5 py-1.5 rounded-xl text-2xs border transition-colors ${(selected[p.id] || []).includes(o.id) ? 'bg-wb-brand/15 border-wb-brand/40 font-semibold' : 'bg-wb-bg-surface border-wb-border-subtle'}`}>
                    {o.text}
                  </button>
                ))}
              </div>
              <button type="button" disabled={busy} onClick={() => void vote(p)}
                className="w-full h-8 rounded-capsule bg-wb-text-primary text-wb-bg-page text-2xs font-semibold disabled:opacity-40">提交投票</button>
            </>
          )}
          <button type="button" onClick={async () => {
            setDetailId(detailId === p.id ? '' : p.id);
            if (detailId !== p.id) {
              try { const r = await apiClient.get(ROOM_PATH(roomId, `polls/${p.id}`)); setPolls((prev) => prev.map((x) => x.id === p.id ? { ...x, details: r.data.details, details_note: r.data.details_note } : x)); }
              catch { /* 忽略 */ }
            }
          }} className="text-3xs text-wb-text-muted hover:text-wb-text-primary underline underline-offset-2">
            {detailId === p.id ? '收起明细' : '查看投票明细'}
          </button>
          {onShareToGroup && (
            <button
              type="button"
              onClick={() => {
                const lines = (p.options || []).map((o: any) => `${o.text}：${o.votes || 0} 票`);
                onShareToGroup(`【群投票】${p.title}\n${lines.join('\n')}`);
                toast.success('投票结果已发送到群聊');
              }}
              className="text-3xs text-wb-brand hover:underline underline-offset-2"
            >
              发送结果到群聊
            </button>
          )}
          {detailId === p.id && (
            <div className="text-3xs text-wb-text-muted">
              {p.details_note || (p.details?.length
                ? p.details.map((d: any, i: number) => <p key={i}>{d.user} → {d.option}</p>)
                : '暂无投票记录')}
            </div>
          )}
        </div>
      ))}

      {report && createPortal(
        <div className="fixed inset-0 z-[310] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4" onClick={() => setReport(null)}>
          <div className="w-full max-w-sm rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">投票统计报告</h3>
              <button type="button" onClick={() => setReport(null)} className="p-1 rounded-lg"><X className="w-4 h-4" /></button>
            </div>
            <p className="text-2xs font-semibold">{report.title} · {report.status}</p>
            <p className="text-2xs text-wb-text-secondary leading-relaxed">{report.summary}</p>
            <div className="space-y-1">
              {report.ranking?.map((o: any, i: number) => (
                <div key={o.id} className="flex items-center gap-2 text-2xs">
                  <span className="w-4 font-mono text-wb-text-muted">{i + 1}</span>
                  <span className="flex-1 truncate">{o.text}</span>
                  <span className="font-mono">{o.votes} 票 · {o.percentage}%</span>
                </div>
              ))}
            </div>
            {report.winner && <p className="text-2xs text-wb-success flex items-center gap-1"><CheckCircle2 className="w-3.5 h-3.5" /> 领先选项：{report.winner}</p>}
          </div>
        </div>, document.body
      )}
    </div>
  );
};

/* ==================== 飞花令 ==================== */
const FeihuaPanel: React.FC<{ roomId: string; toast: any; canManage: boolean; refreshKey?: number }> = ({
  roomId, toast, canManage, refreshKey = 0,
}) => {
  const [active, setActive] = useState(false);
  const [state, setState] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [remaining, setRemaining] = useState(0);
  const [flags, setFlags] = useState<{ flag: string; cnt: number }[]>([]);
  const [presets, setPresets] = useState<number[]>([5, 10, 15, 30]);
  const [minutes, setMinutes] = useState(10);
  const [flagInput, setFlagInput] = useState('');
  const [verse, setVerse] = useState('');
  const [busy, setBusy] = useState(false);
  const [starting, setStarting] = useState(false);
  const guardRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const r = await apiClient.get(ROOM_PATH(roomId, 'feihua/state'));
      const d = r.data || {};
      setActive(Boolean(d.active));
      setState(d.state || null);
      setResult(d.result || null);
      setRemaining(Number(d.remaining_seconds || 0));
      if (Array.isArray(d.flags) && d.flags.length) setFlags(d.flags);
      if (Array.isArray(d.presets) && d.presets.length) setPresets(d.presets);
      if (d.default_minutes) setMinutes((m) => (d.active ? m : Number(d.default_minutes) || m));
    } catch { /* 面板静默失败，不打断聊天 */ }
  }, [roomId]);

  useEffect(() => { void load(); }, [load]);
  // WS 推送 feihua_update 时立刻刷新（别人答对/开局/结算）
  useEffect(() => {
    if (!refreshKey) return;
    void load();
  }, [refreshKey, load]);
  // 兜底轮询：WS 漏帧或跨标签页也能追上
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => { void load(); }, 3000);
    return () => window.clearInterval(t);
  }, [active, load]);
  // 本地倒计时（归零后回后端拉一次战报）
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => setRemaining((p) => Math.max(0, p - 1)), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  useEffect(() => {
    if (remaining > 0) { guardRef.current = false; return; }
    if (active && !guardRef.current) {
      guardRef.current = true;
      void load();
    }
  }, [active, remaining, load]);

  const countdown = useMemo(() => {
    const m = Math.floor(Math.max(0, remaining) / 60);
    const s = Math.max(0, remaining) % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }, [remaining]);

  const ranking = useMemo(() => {
    const scores = state?.scores || {};
    return (Object.values(scores) as any[])
      .map((s) => ({ user: s?.user || '成员', ok: Number(s?.ok || 0), wrong: Number(s?.wrong || 0), first: s?.first }))
      .filter((r) => r.ok > 0)
      .sort((a, b) => b.ok - a.ok || a.wrong - b.wrong || Number(a.first || 0) - Number(b.first || 0))
      .slice(0, 6);
  }, [state]);

  const answered = useMemo(
    () => (Array.isArray(state?.entries) ? state.entries.filter((e: any) => e.ok).length : 0),
    [state],
  );
  const stream = useMemo(
    () => (Array.isArray(state?.entries)
      ? [...state.entries].reverse().filter((e: any) => e.ok).slice(0, 8)
      : []),
    [state],
  );

  const flag = state?.flag || '';
  const mode = state?.flag_mode;

  const startGame = async () => {
    setStarting(true);
    try {
      const payload: any = { duration_minutes: minutes };
      const f = flagInput.trim();
      if (f) payload.flag = f;
      const r = await apiClient.post(ROOM_PATH(roomId, 'feihua/start'), payload);
      setActive(true);
      setState(r.data?.state || null);
      setResult(null);
      setRemaining(Number(r.data?.remaining_seconds || minutes * 60));
      setFlagInput('');
      toast.success(`飞花令开局：令字「${r.data?.state?.flag || ''}」`);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '开局失败');
    } finally {
      setStarting(false);
    }
  };

  const submitVerse = async () => {
    const v = verse.trim();
    if (!v || busy) return;
    setBusy(true);
    try {
      const r = await apiClient.post(ROOM_PATH(roomId, 'feihua/answer'), { verse: v });
      setVerse('');
      if (r.data?.state) setState(r.data.state);
      const gain = Number(r.data?.exp_gained || 0);
      const expText = gain > 0 ? ` · 群经验 +${gain}` : '';
      toast.success((r.data?.info ? `✓ ${r.data.verse} —— ${r.data.info}` : '✓ 答对了') + expText);
      reportGroupExp(toast, r.data);
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '这句不行');
    } finally {
      setBusy(false);
    }
  };

  const endGame = async () => {
    if (!canManage) return;
    try {
      await apiClient.post(ROOM_PATH(roomId, 'feihua/end'));
      toast.success('本局已结束');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '结束失败');
    }
  };

  return (
    <div className="space-y-3">
      {!active && (
        <div className="space-y-3">
          <p className="text-2xs text-wb-text-muted leading-relaxed">
            选一个令字（留空随机），大家抢答含该字的诗句。答对 +1 分、群经验 +5，同一句不能重复，直接在群里发诗句也算。
          </p>

          <div className="flex items-center gap-2">
            <input
              value={flagInput}
              onChange={(e) => setFlagInput(e.target.value.replace(/\s/g, '').slice(0, 1))}
              placeholder="令"
              className="w-16 h-14 text-center text-2xl font-serif font-black rounded-2xl bg-wb-bg-subtle border border-wb-border-strong text-wb-text-primary focus:outline-none focus:border-wb-text-primary"
              title="自选令字，留空随机"
            />
            <div className="flex-1 flex flex-wrap gap-1">
              {flags.slice(0, 12).map((f) => (
                <button
                  key={f.flag}
                  type="button"
                  onClick={() => setFlagInput(f.flag)}
                 className={`px-1.5 py-0.5 rounded-md text-2xs font-serif border transition-colors ${
                    flagInput === f.flag
                      ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary'
                      : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle hover:text-wb-text-primary'
                  }`}
                  title={`诗库 ${f.cnt} 句`}
                >
                  {f.flag}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-2xs text-wb-text-muted">时长</span>
            {presets.map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => setMinutes(m)}
                className={`px-2 py-0.5 rounded-capsule text-2xs font-mono border transition-colors ${
                  minutes === m
                    ? 'bg-wb-text-primary text-wb-bg-page border-wb-text-primary'
                    : 'bg-wb-bg-subtle text-wb-text-secondary border-wb-border-subtle'
                }`}
              >
                {m}分
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={startGame}
            disabled={starting}
            className="w-full py-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-60"
          >
            {starting ? '开局中…' : '开始飞花令'}
          </button>
        </div>
      )}

      {active && (
        <>
          <div className="flex items-start justify-between">
            <div className="flex items-center gap-3">
              <div className="w-16 h-16 rounded-2xl bg-wb-danger/10 border-2 border-wb-danger/30 flex items-center justify-center">
                <span className="text-3xl font-serif font-black text-wb-text-primary">{flag}</span>
              </div>
              <div>
                <div className="text-2xs font-bold text-wb-text-primary">令字「{flag}」</div>
                <div className="text-3xs text-wb-text-muted">
                  {mode === 'strict' ? `诗库 ${state?.library_count ?? 0} 句可答` : '自由模式 · 含该字即可'}
                </div>
              </div>
            </div>
            <div className="text-right">
              <div className="text-xs font-mono font-bold text-wb-warn">⏱ {countdown}</div>
              <div className="text-3xs text-wb-text-muted">已答 {answered} 句</div>
              {canManage && (
                <button type="button" onClick={endGame} className="mt-1 text-3xs text-wb-text-muted hover:text-wb-danger">
                  结束本局
                </button>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <input
              value={verse}
              onChange={(e) => setVerse(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); void submitVerse(); }
              }}
              placeholder={`输入含「${flag}」的诗句…`}
              maxLength={40}
              className="flex-1 px-3 py-2 rounded-xl text-xs bg-wb-bg-subtle border border-wb-border-subtle text-wb-text-primary focus:outline-none focus:border-wb-border-strong"
            />
            <button
              type="button"
              onClick={submitVerse}
              disabled={busy || !verse.trim()}
              className="px-3 py-2 rounded-xl bg-wb-text-primary text-wb-bg-page text-xs font-bold disabled:opacity-50"
            >
              提交
            </button>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className="text-2xs font-bold text-wb-text-primary mb-1">实时榜</div>
              {ranking.length === 0 ? (
                <p className="text-3xs text-wb-text-muted">还没人答对，抢第一句</p>
              ) : (
                <div className="space-y-1">
                  {ranking.map((r, i) => (
                    <div key={r.user + i} className="flex items-center justify-between text-2xs">
                      <span className="truncate text-wb-text-primary">
                        {['🥇', '🥈', '🥉'][i] || `${i + 1}.`} {r.user}
                      </span>
                      <span className="font-mono text-wb-text-muted">{r.ok}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-2xs font-bold text-wb-text-primary mb-1">诗句流</div>
              <div className="space-y-1.5 max-h-40 overflow-y-auto thin-scrollbar pr-1">
                {stream.length === 0 ? (
                  <p className="text-3xs text-wb-text-muted">等第一句诗…</p>
                ) : (
                  stream.map((e: any, i: number) => (
                    <div key={i} className="min-w-0">
                      <div className="text-2xs text-wb-text-primary truncate">{e.verse}</div>
                      <div className="text-3xs text-wb-text-muted truncate">
                        —— {e.info || e.user}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </>
      )}

      {!active && result && (
        <div className="p-3 rounded-2xl bg-wb-bg-subtle border border-wb-border-subtle space-y-1">
          <div className="text-xs font-bold text-wb-text-primary">上局战报 · 令字「{result.flag}」</div>
          {(result.ranking || []).map((r: any, i: number) => (
            <div key={i} className="text-2xs text-wb-text-secondary">
              {['🥇', '🥈', '🥉'][i] || ''} {r.user} · 答对 {r.ok} 句
            </div>
          ))}
          <div className="text-3xs text-wb-text-muted">
            共 {result.participants || 0} 人参与，累计 {result.total_ok || 0} 句
          </div>
        </div>
      )}
    </div>
  );
};

/* ==================== 统一入口 ==================== */
interface Props {
  roomId: string;
  kind: 'chain' | 'poll' | 'feihua' | 'draw' | null;
  canManage: boolean;
  toast: any;
  /** 递增即触发接龙面板刷新（后端 chain_update 推送时更新） */
  refreshKey?: number;
  onClose: () => void;
  /** 嵌入专业版伪装层：层级更高、遮罩更淡、卡片更紧凑，伪装背景仍可见 */
  embedded?: boolean;
  /** 把投票结果作为一条消息发到群里 */
  onShareToGroup?: (text: string) => void;
}

const DrawGuessModal: React.FC<Pick<Props, 'roomId' | 'toast' | 'onClose' | 'embedded'>> = ({ roomId, toast, onClose, embedded }) => {
  const dialogRef = useDialogA11y(true, onClose, embedded ? 9995 : 160);

  return createPortal(
    <div className={`fixed inset-0 flex items-center justify-center sm:p-3 lg:p-5 ${embedded ? 'z-[9995] bg-black/35' : 'z-[160] bg-black/50 backdrop-blur-sm'}`} onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="你画我猜" tabIndex={-1}
        className="flex h-full min-h-0 w-full max-w-[1360px] flex-col overflow-hidden bg-wb-bg-page shadow-2xl outline-none sm:h-auto sm:max-h-[min(96dvh,1000px)] sm:rounded-2xl sm:border sm:border-wb-border-subtle"
        onClick={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-wb-border-subtle bg-wb-bg-surface px-3 py-1 sm:px-5">
          <h3 className="flex items-center gap-2 text-base font-bold text-wb-text-primary"><Brush className="h-4 w-4 text-wb-brand" />你画我猜</h3>
          <button type="button" onClick={onClose} aria-label="关闭你画我猜" className="inline-flex h-10 w-10 items-center justify-center rounded-lg text-wb-text-muted hover:bg-wb-bg-subtle focus-visible:outline focus-visible:outline-wb-brand">
            <X className="h-5 w-5" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:p-4">
          <DrawGuessPanel key={roomId} roomId={roomId} onGroupExp={(data) => reportGroupExp(toast, data)} />
        </div>
      </div>
    </div>, document.body
  );
};

export const GroupActivitiesModal: React.FC<Props> = ({ roomId, kind, canManage, toast, refreshKey = 0, onClose, embedded = false, onShareToGroup }) => {
  useEffect(() => {
    if (!kind || kind === 'draw') return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [kind, onClose]);
  if (!kind) return null;
  if (kind === 'draw') return <DrawGuessModal roomId={roomId} toast={toast} onClose={onClose} embedded={embedded} />;
  return createPortal(
    <div
      className={embedded
        ? 'fixed inset-0 flex items-center justify-center p-4 z-[9995] bg-black/35'
        : 'fixed inset-0 z-[160] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4'}
      onClick={onClose}
    >
      <div className={embedded
        ? 'w-full overflow-y-auto bg-wb-bg-surface border border-wb-border-subtle shadow-2xl space-y-3 max-w-md max-h-[70vh] rounded-2xl p-4'
        : 'w-full max-w-lg max-h-[86vh] overflow-y-auto rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-2xl p-5 space-y-3'}
           onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-wb-text-primary flex items-center gap-1.5">
            {kind === 'chain' ? <><Link2 className="w-4 h-4" /> 成语接龙</>
              : kind === 'feihua' ? <><Feather className="w-4 h-4" /> 飞花令</>
              : <><ClipboardList className="w-4 h-4" /> 群投票</>}
          </h3>
          <button type="button" onClick={onClose} className="p-1 rounded-lg text-wb-text-muted hover:bg-wb-bg-subtle"><X className="w-4 h-4" /></button>
        </div>
        {kind === 'chain' ? <ChainPanel roomId={roomId} toast={toast} refreshKey={refreshKey} />
          : kind === 'feihua' ? <FeihuaPanel roomId={roomId} toast={toast} canManage={canManage} refreshKey={refreshKey} />
          : <PollPanel roomId={roomId} toast={toast} canManage={canManage} onShareToGroup={onShareToGroup} />}
      </div>
    </div>, document.body
  );
};
