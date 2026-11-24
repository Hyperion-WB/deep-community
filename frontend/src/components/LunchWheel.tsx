import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, RefreshCw, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import { apiClient } from '../api/client';
import { useToast } from './Toast';

interface Props {
  groupId?: string | null;
  groupName?: string;
  onClose: () => void;
  /** 超管测试：立即预览 11:00 提醒（由 Chat 控制横幅） */
  onTestReminder?: () => void;
  /** 其他成员加菜/删菜时由 Chat 递增，触发重新拉状态 */
  refreshKey?: number;
}

interface GroupState {
  pool_id: string;
  status: 'open' | 'frozen';
  freeze_time: string;
  cap: number;
  dishes: { id: string; name: string; mine: boolean }[];
  my_count: number;
  spin_used: number;
  spin_left: number;
  can_manage: boolean;
  member_count: number;
}

interface SpinResult {
  dish: string;
  index: number;
  options: string[];
  message: string;
  intro?: string;
  source: 'personal' | 'group';
  spin_left?: number;
}

const PALETTE: [string, string][] = [
  ['#f6c453', '#e0a32e'], // 琥珀
  ['#7fb77e', '#4f8a4c'], // 抹茶
  ['#e88b6a', '#c96545'], // 陶土
  ['#6fa8dc', '#3f78b5'], // 雾蓝
  ['#c78bd6', '#9b5fb0'], // 梅紫
  ['#f2a0b5', '#d86f8d'], // 玫瑰
  ['#8fd3c7', '#57a99a'], // 青瓷
  ['#d9b26f', '#b58a3c'], // 麦色
  ['#9aa7e0', '#6b7ac7'], // 长春花
  ['#ef9f9f', '#cf7070'], // 珊瑚
];

/**
 * 黑白质感转盘：SVG 扇区 + 银色外圈 + 玻璃高光。
 * 扇区超过 8 个时不画文字，靠 hover/点击显示「第 N 格 · 菜名」。
 */
const MonoWheel: React.FC<{
  options: string[];
  rotation: number;
  spinning: boolean;
  hovered: number | null;
  onHover: (index: number | null) => void;
}> = ({ options, rotation, spinning, hovered, onHover }) => {
  const n = Math.max(2, options.length);
  const slice = 360 / n;
  const R = 148;
  const C = 150;
  const showLabels = n <= 8;

  const polar = (deg: number, rad: number) => {
    const a = ((deg - 90) * Math.PI) / 180;
    return [C + rad * Math.cos(a), C + rad * Math.sin(a)];
  };

  const paths = useMemo(() => options.map((_, i) => {
    const [x1, y1] = polar(i * slice, R);
    const [x2, y2] = polar((i + 1) * slice, R);
    const large = slice > 180 ? 1 : 0;
    return `M ${C} ${C} L ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} Z`;
  }), [options.length, slice]);

  return (
    <div className="relative mx-auto" style={{ width: 300, height: 300 }}>
      <div className="absolute inset-[-18px] rounded-full lunch-wheel__halo" aria-hidden="true" />

      {/* 指针 */}
      <div className="absolute left-1/2 -top-3 -translate-x-1/2 z-30 pointer-events-none" aria-hidden="true">
        <div className="lunch-wheel__pointer">
          <span className="lunch-wheel__pointer-shine" />
        </div>
      </div>

      {/* 无外圈包边：圆盘直接作为边界，只保留极细高光 */}
      <div className="absolute inset-0 rounded-full overflow-hidden shadow-[0_26px_70px_rgba(0,0,0,.5)]">
        <svg
          viewBox="0 0 300 300"
          className="w-full h-full"
          onMouseLeave={() => onHover(null)}
          aria-label="午餐转盘"
        >
          <defs>
            <radialGradient id="lunch-gloss" cx="30%" cy="22%" r="78%">
              <stop offset="0%" stopColor="#ffffff" stopOpacity=".5" />
              <stop offset="42%" stopColor="#ffffff" stopOpacity=".07" />
              <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
            </radialGradient>
          </defs>

          <g
            style={{
              transform: `rotate(${rotation}deg)`,
              transformOrigin: '150px 150px',
              transition: spinning ? 'transform 4.6s cubic-bezier(.12,.72,.16,1)' : 'none',
              willChange: 'transform',
            }}
          >
            {paths.map((d, i) => {
              const [fill, shade] = PALETTE[i % PALETTE.length];
              const hover = hovered === i;
              return (
                <path
                  key={i}
                  d={d}
                  fill={hover ? shade : fill}
                  stroke="rgba(255,255,255,.35)"
                  strokeWidth="0.8"
                  className="cursor-pointer transition-[filter] duration-150"
                  style={{ filter: hover ? 'brightness(1.08)' : undefined }}
                  onMouseEnter={() => onHover(i)}
                  onClick={() => onHover(i)}
                >
                  <title>{`第 ${i + 1} 格 · ${options[i]}`}</title>
                </path>
              );
            })}

            {showLabels && options.map((label, i) => (
              <text
                key={`label-${i}`}
                x={C}
                y={C - 112}
                transform={`rotate(${i * slice + slice / 2} ${C} ${C})`}
                textAnchor="middle"
                fontSize="10"
                fontWeight="800"
                fill="#ffffff"
                stroke="rgba(0,0,0,.32)"
                strokeWidth="2.2"
                paintOrder="stroke"
                style={{ userSelect: 'none', pointerEvents: 'none' }}
              >
                {label.length > 6 ? `${label.slice(0, 6)}…` : label}
              </text>
            ))}
          </g>

          <circle cx={C} cy={C} r={R} fill="url(#lunch-gloss)" pointerEvents="none" />
        </svg>
      </div>

      {/* 中心轴：缩小，减少"机械感" */}
      <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-20 lunch-wheel__hub">
        <span className="lunch-wheel__hub-shine" />
        <span className="text-base leading-none">🍚</span>
      </div>

      {hovered !== null && (
        <div className="absolute left-1/2 -bottom-1 -translate-x-1/2 translate-y-full z-30 px-2.5 py-1 rounded-capsule bg-wb-text-primary text-wb-bg-page text-[10px] font-semibold whitespace-nowrap shadow-lg pointer-events-none">
          第 {hovered + 1} 格 · {options[hovered]}
        </div>
      )}
    </div>
  );
};

export const LunchWheel: React.FC<Props> = ({ groupId, groupName, onClose, onTestReminder, refreshKey = 0 }) => {
  const toast = useToast();
  const [tab, setTab] = useState<'personal' | 'group'>(groupId ? 'group' : 'personal');
  const [meta, setMeta] = useState<any>(null);
  const [personalOptions, setPersonalOptions] = useState<string[]>([]);
  const [personalDraft, setPersonalDraft] = useState('');
  const [group, setGroup] = useState<GroupState | null>(null);
  const [dishName, setDishName] = useState('');
  const [suggestions, setSuggestions] = useState<{ 名称: string; 简短介绍?: string }[]>([]);
  const [hovered, setHovered] = useState<number | null>(null);
  const [rotation, setRotation] = useState(0);
  const [spinning, setSpinning] = useState(false);
  const [result, setResult] = useState<SpinResult | null>(null);
  const [freezeDraft, setFreezeDraft] = useState('11:30');
  const [busy, setBusy] = useState(false);
  const [testing, setTesting] = useState(false);
  const searchTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await apiClient.get('/food/wheel', { params: groupId ? { group_id: groupId } : {} });
      setMeta(res.data);
      setPersonalOptions(res.data?.personal?.options || []);
      setGroup(res.data?.group || null);
      if (res.data?.group?.freeze_time) setFreezeDraft(res.data.group.freeze_time);
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '转盘加载失败');
    }
  }, [groupId, toast]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (refreshKey) void load(); }, [refreshKey, load]);
  useEffect(() => { setHovered(null); }, [tab, group?.dishes.length, personalOptions.length]);
  useEffect(() => () => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
  }, []);

  const searchDishes = (q: string) => {
    if (searchTimer.current) window.clearTimeout(searchTimer.current);
    if (!q.trim()) {
      setSuggestions([]);
      return;
    }
    searchTimer.current = window.setTimeout(() => {
      apiClient.get('/food/dishes', { params: { q: q.trim(), limit: 6 } })
        .then((res) => setSuggestions(res.data?.items || []))
        .catch(() => setSuggestions([]));
    }, 180);
  };

  const spin = async () => {
    if (spinning || busy) return;
    setBusy(true);
    try {
      // 个人 tab 必须转个人盘：之前无条件带 group_id，导致个人盘实际请求了群盘，
      // 群盘为空/冻结时就表现为“加了菜也转不动”。
      const spinningGroup = tab === 'group' && Boolean(groupId);
      const res = await apiClient.post('/food/wheel/spin', null, {
        params: spinningGroup ? { group_id: groupId } : {},
      });
      const data = res.data as SpinResult;
      const options = data.options || [];
      const n = Math.max(2, options.length);
      const angle = 360 / n;
      const target = data.index * angle + angle / 2;
      setSpinning(true);
      setRotation((prev) => prev + 360 * 6 + ((360 - target - (prev % 360) + 720) % 360));
      window.setTimeout(() => {
        setSpinning(false);
        setResult(data);
        setBusy(false);
        if (groupId) void load();
      }, 4750);
    } catch (e: any) {
      setBusy(false);
      toast.error(e?.response?.data?.detail || '转盘失败');
    }
  };

  const addPersonal = () => {
    const name = personalDraft.trim().slice(0, 20);
    if (!name) return;
    if (personalOptions.includes(name)) {
      setPersonalDraft('');
      return toast.warning('这道菜已经在盘里了');
    }
    if (personalOptions.length >= 20) return toast.warning('最多 20 道菜');
    setPersonalOptions((prev) => [...prev, name]);
    setPersonalDraft('');
  };

  const removePersonal = (name: string) => {
    setPersonalOptions((prev) => prev.filter((d) => d !== name));
  };

  const savePersonal = async () => {
    if (personalOptions.length < 2) return toast.warning('至少保留 2 道菜才能转');
    try {
      await apiClient.put('/food/wheel/personal', { options: personalOptions });
      toast.success('已保存个人转盘');
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '保存失败');
    }
  };

  const randomizePersonal = async () => {
    try {
      const res = await apiClient.get('/food/dishes', { params: { limit: 12 } });
      const names = (res.data?.items || []).map((d: any) => d.名称).filter(Boolean);
      if (names.length >= 2) {
        setPersonalOptions(names);
        toast.success('已随机 12 道，记得保存');
      }
    } catch {
      toast.error('换一批失败');
    }
  };

  const addDish = async (name?: string) => {
    const value = (name ?? dishName).trim();
    if (value.length < 2) return toast.warning('菜名至少 2 个字');
    try {
      await apiClient.post(`/food/wheel/group/${groupId}/dishes`, { name: value });
      setDishName('');
      setSuggestions([]);
      // 先本地插入，群友的 WS 广播回来前也能立刻看到并开转
      setGroup((prev) => prev ? {
        ...prev,
        dishes: [...prev.dishes, { id: `tmp-${Date.now()}`, name: value, mine: true }],
        my_count: prev.my_count + 1,
      } : prev);
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '加菜失败');
    }
  };

  const removeDish = async (dishId: string) => {
    try {
      await apiClient.delete(`/food/wheel/group/${groupId}/dishes/${dishId}`);
      setGroup((prev) => prev ? {
        ...prev,
        dishes: prev.dishes.filter((d) => d.id !== dishId),
        my_count: Math.max(0, prev.my_count - 1),
      } : prev);
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '删除失败');
    }
  };

  const saveFreeze = async () => {
    try {
      await apiClient.put(`/food/wheel/group/${groupId}/settings`, { freeze_time: freezeDraft });
      toast.success('冻结时间已保存（次日生效）');
      void load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '保存失败');
    }
  };

  const testReset = async () => {
    if (!groupId) return;
    setTesting(true);
    try {
      await apiClient.post(`/food/wheel/group/${groupId}/test-reset`);
      toast.success('测试菜盘已重置：已开放，冻结时间临时设为 23:59');
      await load();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '重置失败');
    } finally {
      setTesting(false);
    }
  };

  const share = async () => {
    if (!result) return;
    try {
      await apiClient.post('/food/cards', {
        dish_names: [result.dish],
        content: result.message,
        meal_type: 'lunch',
        source: 'spin',
        group_id: tab === 'group' ? (groupId || undefined) : undefined,
      });
      toast.success('已晒到美食帖');
      setResult(null);
      onClose();
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || '晒卡失败');
    }
  };

  const options = tab === 'group' ? (group?.dishes || []).map((d) => d.name) : personalOptions;
  const isSuper = Boolean(meta?.is_super_admin);

  return createPortal(
    <div
      className="fixed inset-0 z-[210] bg-black/60 backdrop-blur-md flex items-end sm:items-center justify-center p-0 sm:p-4"
      onClick={onClose}
    >
      <div
        className="w-full sm:max-w-lg h-[88dvh] sm:h-[640px] max-h-[90vh] flex flex-col overflow-hidden rounded-t-3xl sm:rounded-3xl bg-wb-bg-surface border border-wb-border-strong shadow-[0_30px_90px_rgba(0,0,0,.55)] animate-[lunch-modal-in_.3s_cubic-bezier(.2,.9,.3,1.1)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="shrink-0 flex items-center gap-2 px-4 py-3 bg-wb-bg-surface/92 backdrop-blur-xl border-b border-wb-border-subtle">
          <div className="w-8 h-8 rounded-full bg-wb-text-primary text-wb-bg-page flex items-center justify-center shadow-inner">
            <span className="text-base leading-none">🍱</span>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-black text-wb-text-primary truncate">今天吃什么</h3>
            <p className="text-[10px] text-wb-text-muted truncate">{groupName || '午饭选择困难症急救站'}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full text-wb-text-muted hover:text-wb-text-primary hover:bg-wb-bg-subtle">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto [scrollbar-gutter:stable] p-4 space-y-3">
          {groupId && (
            <div className="flex items-center gap-1">
              {([['group', '本群多人盘'], ['personal', '我的转盘']] as const).map(([key, label]) => (
                <button key={key} type="button" onClick={() => setTab(key)}
                  className={`h-7 px-3 rounded-capsule text-2xs font-semibold transition-colors ${
                    tab === key
                      ? 'bg-wb-text-primary text-wb-bg-page'
                      : 'bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary'
                  }`}>{label}</button>
              ))}
              {group && (
                <span className="ml-auto text-[10px] text-wb-text-muted">
                  {group.status === 'frozen' ? '已冻结' : `${group.freeze_time} 冻结`} · 今日剩 {group.spin_left} 次
                </span>
              )}
            </div>
          )}

          {options.length >= 2 ? (
            <MonoWheel
              options={options}
              rotation={rotation}
              spinning={spinning}
              hovered={hovered}
              onHover={setHovered}
            />
          ) : (
            <div className="h-44 rounded-3xl border border-dashed border-wb-border-subtle flex flex-col items-center justify-center gap-1 text-2xs text-wb-text-muted">
              <span className="text-3xl">🍽️</span>
              {tab === 'group' && group?.status === 'frozen'
                ? '今天的菜盘已冻结，明天再来或使用测试重置'
                : options.length === 0
                  ? '还没有菜，先在下面加两道'
                  : `再加 ${2 - options.length} 道就能开转`}
            </div>
          )}

          <p className="text-center text-[10px] text-wb-text-muted">
            {tab === 'group' && group
              ? `${group.dishes.length}/${group.cap} 道 · 你已加 ${group.my_count}/5 道 · 每人每天 10 次 · 鼠标移到色块可看菜名`
              : `${personalOptions.length}/20 道 · 鼠标移到色块可看菜名`}
          </p>

          <button type="button" onClick={() => void spin()} disabled={spinning || busy || options.length < 2}
            className="w-full h-11 rounded-capsule bg-wb-text-primary text-wb-bg-page text-sm font-black disabled:opacity-40 inline-flex items-center justify-center gap-1.5 shadow-sm hover:opacity-90 transition-opacity">
            <RefreshCw className={`w-4 h-4 ${spinning ? 'animate-spin' : ''}`} />
            {spinning ? '转盘转动中…' : '开始转盘'}
          </button>

          {tab === 'group' && group && (
            <div className="space-y-2 pt-1">
              <div className="relative flex items-center gap-1.5">
                <input value={dishName}
                  onChange={(e) => { setDishName(e.target.value); searchDishes(e.target.value); }}
                  maxLength={32}
                  onKeyDown={(e) => { if (e.key === 'Enter') void addDish(); }}
                  placeholder={group.status === 'frozen' ? '菜盘已冻结，可用下方测试重置' : '加一道菜（输入会联想 1376 道菜）'}
                  disabled={group.status === 'frozen'}
                  className="flex-1 h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs focus:outline-none focus:border-wb-border-strong disabled:opacity-60" />
                <button type="button" onClick={() => void addDish()} disabled={group.status === 'frozen'}
                  className="h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1 disabled:opacity-50 hover:bg-wb-bg-surface">
                  <Plus className="w-3.5 h-3.5" /> 加菜
                </button>
                {suggestions.length > 0 && (
                  <div className="absolute left-0 right-0 top-full mt-1 z-20 p-1.5 rounded-xl bg-wb-bg-surface border border-wb-border-strong shadow-2xl">
                    <div className="flex flex-wrap gap-1">
                      {suggestions.map((sugg) => (
                        <button key={sugg.名称} type="button"
                          onClick={() => { void addDish(sugg.名称); }}
                          className="px-2 py-1 rounded-capsule bg-wb-bg-subtle hover:bg-wb-bg-surface text-2xs text-wb-text-secondary hover:text-wb-text-primary">
                          {sugg.名称}
                          {sugg.简短介绍 && <span className="ml-1 text-[10px] opacity-50">{sugg.简短介绍}</span>}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
              </div>

              <div className="flex flex-wrap gap-1.5">
                {group.dishes.map((d) => (
                  <span key={d.id} className="inline-flex items-center gap-1 px-2 py-1 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-[10px] text-wb-text-secondary">
                    {d.name}
                    {(d.mine && group.status !== 'frozen') && (
                      <button type="button" onClick={() => void removeDish(d.id)} aria-label="删除"
                        className="text-wb-text-muted hover:text-wb-danger"><Trash2 className="w-3 h-3" /></button>
                    )}
                  </span>
                ))}
                {group.dishes.length === 0 && <span className="text-[10px] text-wb-text-muted">还没人加菜，先加两道再开转</span>}
              </div>

              {group.can_manage && (
                <div className="flex items-center gap-1.5 pt-1">
                  <Settings2 className="w-3.5 h-3.5 text-wb-text-muted" />
                  <span className="text-[10px] text-wb-text-muted">冻结时间</span>
                  <input type="time" value={freezeDraft} onChange={(e) => setFreezeDraft(e.target.value)}
                    min="10:00" max="14:00"
                    className="h-7 px-1.5 rounded-lg bg-wb-bg-subtle border border-wb-border-subtle text-[10px]" />
                  <button type="button" onClick={() => void saveFreeze()}
                    className="h-7 px-2 rounded-capsule bg-wb-text-primary text-wb-bg-page text-[10px] font-semibold">保存</button>
                  <span className="text-[9px] text-wb-text-muted">修改次日生效</span>
                </div>
              )}

              {/* 超管测试：低对比度黄字已换成中性色 */}
              {isSuper && (
                <div className="rounded-xl border border-dashed border-wb-border-strong bg-wb-bg-subtle p-2.5 space-y-1.5">
                  <p className="text-[10px] font-bold text-wb-text-secondary flex items-center gap-1">
                    <Sparkles className="w-3 h-3" /> 测试模式（仅超级管理员可见）
                  </p>
                  <p className="text-[10px] text-wb-text-muted leading-relaxed">
                    当前时间已过冻结点时会自动锁盘。重置后今日菜盘清空并开放，冻结时间临时设为 23:59，可完整测试加菜 → 转盘 → 晒卡。
                  </p>
                  <div className="flex items-center gap-2">
                    <button type="button" onClick={() => void testReset()} disabled={testing}
                      className="h-7 px-2.5 rounded-capsule bg-wb-text-primary text-wb-bg-page text-[10px] font-semibold disabled:opacity-50">
                      {testing ? '重置中…' : '重置今日菜盘'}
                    </button>
                    {onTestReminder && (
                      <button type="button" onClick={onTestReminder}
                        className="h-7 px-2.5 rounded-capsule bg-wb-bg-surface text-wb-text-secondary border border-wb-border-subtle text-[10px] font-semibold">
                        预览 11:00 提醒
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}

          {tab === 'personal' && (
            <div className="space-y-2 pt-1">
              <div className="flex items-center gap-2">
                <p className="text-[10px] text-wb-text-muted flex-1">个人转盘长期保存，2–20 道都行</p>
                <button type="button" onClick={() => void randomizePersonal()}
                  className="h-7 px-2 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-[10px] text-wb-text-secondary inline-flex items-center gap-1 hover:text-wb-text-primary">
                  <Sparkles className="w-3 h-3" /> 随机 12 道
                </button>
              </div>

              {/* 菜品用 chips 管理，避免之前 textarea 边打字边拆分导致的怪行为 */}
              <div className="flex flex-wrap gap-1.5 min-h-[36px] p-2 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle">
                {personalOptions.length === 0 && (
                  <span className="text-[10px] text-wb-text-muted">还没有菜，先加几道吧</span>
                )}
                {personalOptions.map((d) => (
                  <span key={d} className="inline-flex items-center gap-1 px-2 py-1 rounded-capsule bg-wb-bg-surface border border-wb-border-subtle text-[10px] text-wb-text-secondary">
                    {d}
                    <button type="button" onClick={() => removePersonal(d)} aria-label={`删除 ${d}`}
                      className="text-wb-text-muted hover:text-wb-danger">
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>

              <div className="flex items-center gap-1.5">
                <input
                  value={personalDraft}
                  onChange={(e) => setPersonalDraft(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addPersonal(); } }}
                  maxLength={20}
                  placeholder="添加一道菜，回车确认"
                  className="flex-1 h-9 px-3 rounded-xl bg-wb-bg-subtle border border-wb-border-subtle text-2xs focus:outline-none focus:border-wb-border-strong"
                />
                <button type="button" onClick={addPersonal}
                  className="h-9 px-3 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-2xs font-semibold inline-flex items-center gap-1 hover:bg-wb-bg-surface">
                  <Plus className="w-3.5 h-3.5" /> 添加
                </button>
              </div>

              <button type="button" onClick={() => void savePersonal()}
                className="h-9 w-full rounded-capsule bg-wb-text-primary text-wb-bg-page text-xs font-bold hover:opacity-90">
                保存我的转盘
              </button>
            </div>
          )}
        </div>

        {result && createPortal(
          <div className="fixed inset-0 z-[230] flex items-center justify-center bg-black/65 backdrop-blur-md p-4" onClick={() => setResult(null)}>
            <div className="lunch-result-card" onClick={(e) => e.stopPropagation()}>
              <span className="lunch-result-card__shine" aria-hidden="true" />
              {Array.from({ length: 16 }).map((_, i) => (
                <span
                  key={i}
                  className="lunch-result-card__confetti"
                  style={{
                    left: `${6 + (i * 17) % 88}%`,
                    background: i % 3 === 0 ? '#f5f5f7' : i % 3 === 1 ? '#8e8e93' : '#2c2c2e',
                    animationDelay: `${(i % 6) * 0.16}s`,
                    transform: `rotate(${(i * 37) % 360}deg)`,
                  }}
                  aria-hidden="true"
                />
              ))}
              <div className="lunch-result-card__inner">
                <p className="text-[10px] font-mono tracking-[0.32em] text-white/45">TODAY'S LUNCH</p>
                <span className="lunch-result-card__emoji">🍚</span>
                <p className="text-2xs text-white/55">今天就吃</p>
                <h3 className="text-2xl font-black text-white mt-0.5">{result.dish}</h3>
                {result.intro && <p className="text-[11px] text-white/50 mt-0.5">{result.intro}</p>}
                <p className="text-xs text-white/75 mt-2 leading-relaxed">{result.message}</p>
                <p className="text-[9px] text-white/35 mt-2">
                  {result.source === 'group'
                    ? `本群多人盘 · 今日还剩 ${result.spin_left ?? 0} 次`
                    : '我的转盘 · 不限次数'}
                </p>
                <div className="flex items-center justify-center gap-2 mt-4">
                  <button type="button" onClick={() => void share()}
                    className="h-9 px-4 rounded-capsule bg-white text-[#1c1c1e] text-xs font-bold shadow-lg hover:bg-white/90">
                    晒到美食帖
                  </button>
                  <button type="button" onClick={() => { setResult(null); void spin(); }}
                    className="h-9 px-4 rounded-capsule bg-white/10 text-white/85 text-xs font-semibold border border-white/20 hover:bg-white/15">
                    再转一次
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body
        )}
      </div>
    </div>,
    document.body,
  );
};
