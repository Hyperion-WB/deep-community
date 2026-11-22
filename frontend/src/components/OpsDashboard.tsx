import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock3,
  Cpu,
  Database,
  Eye,
  FileText,
  Gauge,
  HardDrive,
  MessageSquare,
  RefreshCw,
  Server,
  Users,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { apiClient } from '../api/client';
import { SegmentedControl } from './SegmentedControl';

interface OpsToday {
  pv: number;
  uv: number;
  api_requests: number;
  api_errors: number;
  api_slow: number;
  avg_ms: number;
}

interface OpsSystem {
  uptime_seconds: number;
  started_at: string;
  host_mem_total_mb: number;
  host_mem_available_mb: number;
  host_swap_total_mb: number;
  host_swap_free_mb: number;
  container_mem_limit_mb: number | null;
  container_mem_used_mb: number | null;
  cpu_count: number;
  load_avg: number[];
  disk_total_gb: number;
  disk_used_gb: number;
  disk_percent: number;
  db_size_mb: number;
  redis_ok: boolean;
  scheduler_running: boolean;
  scheduler_jobs: { id: string; next_run: string | null }[];
}

interface OpsOverview {
  day: string;
  today: OpsToday;
  totals: { users: number; posts: number; comments: number; pending_reports: number };
  system: OpsSystem;
  generated_at: string;
}

interface TrendPoint {
  day: string;
  pv: number;
  uv: number;
  api_requests: number;
  api_errors: number;
  api_slow: number;
  avg_ms: number;
  users_total: number;
  posts_total: number;
  comments_total: number;
}

interface TopPage {
  path: string;
  pv: number;
}

const RANGE_OPTIONS = [
  { key: '7', label: '近 7 天' },
  { key: '14', label: '近 14 天' },
  { key: '30', label: '近 30 天' },
];

const METRIC_OPTIONS = [
  { key: 'pv', label: '访问量 PV' },
  { key: 'api_requests', label: '接口请求' },
  { key: 'uv', label: '独立访客 UV' },
];

const formatUptime = (seconds: number): string => {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d} 天 ${h} 小时`;
  if (h > 0) return `${h} 小时 ${m} 分`;
  return `${m} 分钟`;
};

const formatClock = (iso: string | null): string => {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('zh-CN', { hour12: false });
};

const StatCard: React.FC<{
  icon: React.ElementType;
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: 'default' | 'warn' | 'danger';
}> = ({ icon: Icon, label, value, hint, tone = 'default' }) => {
  const toneCls =
    tone === 'danger' ? 'text-wb-danger' : tone === 'warn' ? 'text-wb-warn' : 'text-wb-brand';
  return (
    <div className="p-4 rounded-2xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-2xs font-medium text-wb-text-muted">{label}</span>
        <Icon className={`w-3.5 h-3.5 ${toneCls}`} />
      </div>
      <div className="text-lg font-bold text-wb-text-primary font-mono leading-tight">{value}</div>
      {hint && <p className="text-3xs text-wb-text-muted leading-relaxed">{hint}</p>}
    </div>
  );
};

const InfoRow: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-3 py-2 border-b border-wb-border-subtle/60 last:border-0">
    <span className="text-2xs text-wb-text-muted shrink-0">{label}</span>
    <span className="text-2xs font-medium text-wb-text-primary font-mono text-right break-all">
      {value}
    </span>
  </div>
);

export const OpsDashboard: React.FC = () => {
  const [overview, setOverview] = useState<OpsOverview | null>(null);
  const [trend, setTrend] = useState<TrendPoint[]>([]);
  const [topPages, setTopPages] = useState<TopPage[]>([]);
  const [range, setRange] = useState('14');
  const [metric, setMetric] = useState<'pv' | 'uv' | 'api_requests'>('pv');
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(
    async (days: number, silent = false) => {
      if (!silent) setRefreshing(true);
      try {
        const [ov, tr, tp] = await Promise.all([
          apiClient.get('/admin/ops/overview'),
          apiClient.get('/admin/ops/trend', { params: { days } }),
          apiClient.get('/admin/ops/top-pages', { params: { days, limit: 10 } }),
        ]);
        setOverview(ov.data);
        setTrend(Array.isArray(tr.data) ? tr.data : []);
        setTopPages(Array.isArray(tp.data) ? tp.data : []);
        setError('');
      } catch (err: any) {
        setError(err?.response?.data?.detail || '运维数据加载失败，请稍后重试');
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    []
  );

  useEffect(() => {
    load(Number(range));
  }, [range, load]);

  // 面板停留期间每 60 秒静默刷新一次
  useEffect(() => {
    const timer = window.setInterval(() => {
      // 页面不可见（切到后台标签页）时不刷新，避免无意义请求
      if (document.visibilityState === 'visible') load(Number(range), true);
    }, 60000);
    return () => window.clearInterval(timer);
  }, [range, load]);

  const chartData = useMemo(() => {
    const values = trend.map((p) => (metric === 'pv' ? p.pv : metric === 'uv' ? p.uv : p.api_requests));
    const max = Math.max(1, ...values);
    return trend.map((point, idx) => {
      const value = values[idx];
      return {
        ...point,
        value,
        height: Math.max(2, Math.round((value / max) * 100)),
        isToday: idx === trend.length - 1,
      };
    });
  }, [trend, metric]);

  const trendTotals = useMemo(() => {
    const sum = (key: 'pv' | 'uv' | 'api_requests' | 'api_errors') =>
      trend.reduce((acc, item) => acc + (item[key] || 0), 0);
    return { pv: sum('pv'), uv: sum('uv'), api: sum('api_requests'), errors: sum('api_errors') };
  }, [trend]);

  if (loading) {
    return (
      <div className="p-10 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center text-xs text-wb-text-muted">
        正在加载站点运维数据…
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-10 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle text-center space-y-3">
        <AlertTriangle className="w-6 h-6 text-wb-warn mx-auto" />
        <p className="text-xs text-wb-text-secondary">{error}</p>
        <button
          type="button"
          onClick={() => load(Number(range))}
          className="wb-pressable px-3.5 py-1.5 rounded-capsule bg-wb-bg-subtle border border-wb-border-subtle text-xs font-semibold text-wb-text-primary"
        >
          重新加载
        </button>
      </div>
    );
  }

  const today = overview?.today;
  const totals = overview?.totals;
  const system = overview?.system;

  return (
    <div className="space-y-4">
      {/* 今日概览 */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={Eye} label="今日访问量 PV" value={today?.pv ?? 0} hint={`业务日 ${overview?.day || ''}`} />
        <StatCard icon={Users} label="今日独立访客 UV" value={today?.uv ?? 0} hint="按 IP + UA 去重" />
        <StatCard icon={Activity} label="今日接口请求" value={today?.api_requests ?? 0} hint={`慢请求 ${today?.api_slow ?? 0} 次`} />
        <StatCard
          icon={Gauge}
          label="平均响应耗时"
          value={`${today?.avg_ms ?? 0} ms`}
          hint={`错误 ${today?.api_errors ?? 0} 次`}
          tone={(today?.api_errors ?? 0) > 0 ? 'danger' : 'default'}
        />
      </div>

      {/* 走势 */}
      <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-wb-brand" />
            <h3 className="text-xs font-semibold text-wb-text-primary">访问与接口走势</h3>
            <span className="text-3xs text-wb-text-muted font-mono">
              合计 PV {trendTotals.pv} · UV {trendTotals.uv} · 接口 {trendTotals.api}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <SegmentedControl
              id="ops-range"
              size="sm"
              items={RANGE_OPTIONS}
              activeKey={range}
              onChange={setRange}
            />
            <SegmentedControl
              id="ops-metric"
              size="sm"
              items={METRIC_OPTIONS}
              activeKey={metric}
              onChange={(k) => setMetric(k as 'pv' | 'uv' | 'api_requests')}
            />
            <button
              type="button"
              onClick={() => load(Number(range))}
              disabled={refreshing}
              title="刷新数据"
              className="wb-pressable p-1.5 rounded-capsule border border-wb-border-subtle bg-wb-bg-subtle text-wb-text-secondary hover:text-wb-text-primary disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        <div className="flex items-end gap-1 sm:gap-1.5 h-40 pt-2">
          {chartData.map((point) => (
            <div
              key={point.day}
              className="flex-1 min-w-0 h-full flex flex-col items-center justify-end gap-1 group"
              title={`${point.day}｜PV ${point.pv}｜UV ${point.uv}｜接口 ${point.api_requests}｜平均 ${point.avg_ms}ms`}
            >
              <span className="text-3xs text-wb-text-muted opacity-0 group-hover:opacity-100 transition-opacity font-mono">
                {point.value}
              </span>
              <div
                className={`w-full rounded-t-md transition-[height,background-color] duration-300 ${
                  point.isToday ? 'bg-wb-brand' : 'bg-wb-brand/35 group-hover:bg-wb-brand/60'
                }`}
                style={{ height: `${point.height}%` }}
              />
            </div>
          ))}
        </div>
        <div className="flex items-center justify-between text-3xs text-wb-text-muted font-mono">
          <span>{trend[0]?.day.slice(5) || ''}</span>
          <span>{trend[trend.length - 1]?.day.slice(5) || ''}</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 内容存量 */}
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-wb-brand" />
            <h3 className="text-xs font-semibold text-wb-text-primary">站点存量</h3>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <InfoRow label="注册用户" value={totals?.users ?? 0} />
            <InfoRow label="已发布文章" value={totals?.posts ?? 0} />
            <InfoRow label="可见评论" value={totals?.comments ?? 0} />
            <InfoRow label="待审举报" value={totals?.pending_reports ?? 0} />
          </div>
          <div className="flex items-center gap-2 pt-1 text-3xs text-wb-text-muted">
            <Clock3 className="w-3 h-3" />
            数据生成于 {formatClock(overview?.generated_at || null)}（每 30 秒落库一次）
          </div>
        </div>

        {/* 系统状态 */}
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Server className="w-4 h-4 text-wb-brand" />
              <h3 className="text-xs font-semibold text-wb-text-primary">运行环境</h3>
            </div>
            <span
              className={`inline-flex items-center gap-1 text-3xs font-mono ${
                system?.redis_ok ? 'text-wb-success' : 'text-wb-warn'
              }`}
            >
              {system?.redis_ok ? <Wifi className="w-3 h-3" /> : <WifiOff className="w-3 h-3" />}
              Redis {system?.redis_ok ? '正常' : '未连接'}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-0">
            <InfoRow label="服务运行时长" value={formatUptime(system?.uptime_seconds ?? 0)} />
            <InfoRow
              label="容器内存"
              value={`${system?.container_mem_used_mb ?? '—'} / ${system?.container_mem_limit_mb ?? '—'} MB`}
            />
            <InfoRow
              label="宿主内存可用"
              value={`${system?.host_mem_available_mb ?? 0} / ${system?.host_mem_total_mb ?? 0} MB`}
            />
            <InfoRow
              label="Swap 空闲"
              value={`${system?.host_swap_free_mb ?? 0} / ${system?.host_swap_total_mb ?? 0} MB`}
            />
            <InfoRow
              label="系统负载"
              value={(system?.load_avg || []).join(' / ') || '—'}
            />
            <InfoRow
              label="磁盘 / 数据库"
              value={`${system?.disk_used_gb ?? 0}/${system?.disk_total_gb ?? 0} GB (${system?.disk_percent ?? 0}%) · DB ${system?.db_size_mb ?? 0} MB`}
            />
            <InfoRow
              label="调度任务"
              value={`${system?.scheduler_running ? '运行中' : '未启动'} · ${system?.scheduler_jobs?.length ?? 0} 个`}
            />
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* 热门页面 */}
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <HardDrive className="w-4 h-4 text-wb-brand" />
              <h3 className="text-xs font-semibold text-wb-text-primary">热门页面（近 {range} 天）</h3>
            </div>
            <span className="text-3xs text-wb-text-muted">按 PV 排序</span>
          </div>
          {topPages.length === 0 ? (
            <p className="text-2xs text-wb-text-muted py-6 text-center">暂无访问数据</p>
          ) : (
            <div className="space-y-1.5">
              {topPages.map((page, idx) => {
                const max = topPages[0]?.pv || 1;
                return (
                  <div key={`${page.path}-${idx}`} className="space-y-1">
                    <div className="flex items-center justify-between text-2xs">
                      <span className="font-mono text-wb-text-secondary truncate max-w-[70%]">
                        {page.path || '/'}
                      </span>
                      <span className="font-mono text-wb-text-muted">{page.pv}</span>
                    </div>
                    <div className="h-1 rounded-full bg-wb-bg-subtle overflow-hidden">
                      <div
                        className="h-full rounded-full bg-wb-brand/60"
                        style={{ width: `${Math.max(4, Math.round((page.pv / max) * 100))}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* 历史明细 */}
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <FileText className="w-4 h-4 text-wb-brand" />
              <h3 className="text-xs font-semibold text-wb-text-primary">历史明细</h3>
            </div>
            <span className="text-3xs text-wb-text-muted">最近 7 天</span>
          </div>
          <div className="overflow-x-auto no-scrollbar">
            <table className="w-full text-2xs font-mono">
              <thead>
                <tr className="text-wb-text-muted">
                  <th className="text-left font-medium py-1.5">日期</th>
                  <th className="text-right font-medium">PV</th>
                  <th className="text-right font-medium">UV</th>
                  <th className="text-right font-medium">接口</th>
                  <th className="text-right font-medium">错误</th>
                  <th className="text-right font-medium">均耗时</th>
                </tr>
              </thead>
              <tbody>
                {[...trend]
                  .slice(-7)
                  .reverse()
                  .map((row) => (
                    <tr key={row.day} className="border-t border-wb-border-subtle/60">
                      <td className="py-1.5 text-wb-text-secondary">{row.day.slice(5)}</td>
                      <td className="text-right text-wb-text-primary">{row.pv}</td>
                      <td className="text-right text-wb-text-secondary">{row.uv}</td>
                      <td className="text-right text-wb-text-secondary">{row.api_requests}</td>
                      <td className={`text-right ${row.api_errors > 0 ? 'text-wb-danger' : 'text-wb-text-muted'}`}>
                        {row.api_errors}
                      </td>
                      <td className="text-right text-wb-text-muted">{row.avg_ms}ms</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* 调度任务 */}
      {!!system?.scheduler_jobs?.length && (
        <div className="p-5 rounded-3xl bg-wb-bg-surface border border-wb-border-subtle shadow-card space-y-3">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-wb-brand" />
            <h3 className="text-xs font-semibold text-wb-text-primary">后台调度任务</h3>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
            {system.scheduler_jobs.map((job) => (
              <div
                key={job.id}
                className="flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-xl bg-wb-bg-subtle/50 text-3xs font-mono"
              >
                <span className="text-wb-text-secondary truncate">{job.id}</span>
                <span className="text-wb-text-muted shrink-0">{formatClock(job.next_run)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-center gap-2 text-3xs text-wb-text-muted">
        <MessageSquare className="w-3 h-3" />
        本面板仅超级管理员可见；访问明细保留 60 天，接口指标按日归档。
      </div>
    </div>
  );
};
