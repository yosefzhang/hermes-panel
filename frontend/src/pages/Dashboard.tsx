import { useCallback, useMemo } from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  CheckCircle2,
  Layers,
  MessageSquare,
  RefreshCw,
  Server,
  Target,
  TrendingUp,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';

interface ProfileStat {
  id: number;
  server_id: string;
  host: string | null;
  profile_name: string;
  path: string | null;
  gateway_status: string | null;
  session_count: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_rate: number;
  model_top5: Array<{ model: string; total_tokens: number; sessions: number }>;
  provider_top5: Array<{ provider: string; total_tokens: number; sessions: number }>;
  daily_tokens: Array<{ day: string; total_tokens: number; input_tokens: number; output_tokens: number }>;
  updated_at: number;
}

interface ServerInfo {
  id: string;
  name: string;
  host: string | null;
  is_local: boolean;
  online: boolean;
  profiles: ProfileStat[];
}

interface DashboardData {
  servers: ServerInfo[];
}

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

const CHART_COLORS = ['#3b82f6', '#06b6d4', '#8b5cf6', '#f59e0b', '#ef4444', '#94a3b8'];

function useDashboardStats(data: DashboardData | null) {
  return useMemo(() => {
    const allProfiles = (data?.servers ?? []).flatMap((s) => s.profiles);

    const hostCount = data?.servers.length ?? 0;
    const profileCount = allProfiles.length;
    const runningProfiles = allProfiles.filter((p) => p.gateway_status === 'running').length;
    const totalTokens = allProfiles.reduce((sum, p) => sum + p.total_tokens, 0);
    const totalInputTokens = allProfiles.reduce((sum, p) => sum + p.total_input_tokens, 0);
    const totalOutputTokens = allProfiles.reduce((sum, p) => sum + p.total_output_tokens, 0);
    const totalSessions = allProfiles.reduce((sum, p) => sum + p.session_count, 0);
    const avgCacheHitRate =
      profileCount > 0
        ? allProfiles.reduce((sum, p) => sum + p.cache_hit_rate, 0) / profileCount
        : 0;

    const profileRank = [...allProfiles]
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, 10)
      .map((p) => ({
        name: p.profile_name,
        value: p.total_tokens,
      }));

    const modelUsage: Record<string, number> = {};
    for (const p of allProfiles) {
      for (const m of p.model_top5 ?? []) {
        modelUsage[m.model] = (modelUsage[m.model] ?? 0) + m.total_tokens;
      }
    }
    const modelTop5 = Object.entries(modelUsage)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([name, value]) => ({ name, value }));

    const today = new Date().toISOString().slice(0, 10);
    const todayTop5 = [...allProfiles]
      .map((p) => {
        const found = p.daily_tokens?.find((d) => d.day === today);
        return { name: p.profile_name, value: found?.total_tokens ?? 0 };
      })
      .filter((p) => p.value > 0)
      .sort((a, b) => b.value - a.value)
      .slice(0, 5);

    // Last 15 days token trend (aggregated across all profiles)
    const days: string[] = [];
    for (let i = 14; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      days.push(d.toISOString().slice(0, 10));
    }
    const dailyTrend = days.map((day) => {
      let total = 0;
      let input = 0;
      let output = 0;
      for (const p of allProfiles) {
        const found = p.daily_tokens?.find((d) => d.day === day);
        if (found) {
          total += found.total_tokens ?? 0;
          input += found.input_tokens ?? 0;
          output += found.output_tokens ?? 0;
        }
      }
      return { day, total_tokens: total, input_tokens: input, output_tokens: output };
    });

    return {
      hostCount,
      profileCount,
      runningProfiles,
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalSessions,
      avgCacheHitRate,
      profileRank,
      modelTop5,
      todayTop5,
      dailyTrend,
    };
  }, [data]);
}

interface MetricItem {
  icon: React.ElementType;
  label: string;
  value: string;
  iconClass: string;
}

function MetricCard({ metric }: { metric: MetricItem }) {
  const { icon: Icon, label, value, iconClass } = metric;
  return (
    <Card className="hover:shadow-float transition-shadow">
      <CardContent className="p-4">
        <div className="flex items-center gap-3">
          <div className={`flex-shrink-0 rounded-lg p-2 ${iconClass}`}>
            <Icon className="h-4 w-4" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-xs font-medium text-muted-foreground">{label}</p>
            <p className="mt-1 text-2xl font-bold tracking-tight text-card-foreground">{value}</p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function MetricGroup({
  title,
  icon: Icon,
  children,
}: {
  title: string;
  icon: React.ElementType;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-foreground/80">
        <Icon className="h-4 w-4 text-muted-foreground" />
        {title}
      </h3>
      <div className="grid grid-cols-2 md:grid-cols-3 gap-4">{children}</div>
    </div>
  );
}

function RankChartCard({ data }: { data: { name: string; value: number }[] }) {
  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        formatter: (params: Array<{ name: string; value: number }>) => {
          const p = params[0];
          return `${p.name}<br/>${fmt(p.value)} tokens`;
        },
      },
      grid: { left: 16, right: 24, top: 16, bottom: 24, containLabel: true },
      xAxis: {
        type: 'value' as const,
        splitLine: { lineStyle: { color: '#f1f5f9' } },
        axisLabel: { formatter: (v: number) => fmt(v), color: '#64748b' },
      },
      yAxis: {
        type: 'category' as const,
        data: data.map((d) => d.name).reverse(),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#475569', fontSize: 11 },
      },
      series: [
        {
          type: 'bar',
          data: data.map((d) => d.value).reverse(),
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: '#a78bfa' },
              { offset: 1, color: '#7c3aed' },
            ]),
            borderRadius: [0, 6, 6, 0] as unknown as number,
          },
          barMaxWidth: 20,
        },
      ],
    }),
    [data]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-primary" />
          总 Token 使用量 Top5
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <ReactECharts option={option} style={{ height: 260 }} />
        ) : (
          <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ModelTop5Card({ data }: { data: { name: string; value: number }[] }) {
  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        formatter: (params: Array<{ name: string; value: number }>) => {
          const p = params[0];
          return `${p.name}<br/>${fmt(p.value)} tokens`;
        },
      },
      grid: { left: 16, right: 24, top: 16, bottom: 24, containLabel: true },
      xAxis: {
        type: 'value' as const,
        splitLine: { lineStyle: { color: '#f1f5f9' } },
        axisLabel: { formatter: (v: number) => fmt(v), color: '#64748b' },
      },
      yAxis: {
        type: 'category' as const,
        data: data.map((d) => d.name).reverse(),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#475569', fontSize: 11 },
      },
      series: [
        {
          type: 'bar',
          data: data.map((d) => d.value).reverse(),
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: '#c084fc' },
              { offset: 1, color: '#9333ea' },
            ]),
            borderRadius: [0, 6, 6, 0] as unknown as number,
          },
          barMaxWidth: 20,
        },
      ],
    }),
    [data]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-primary" />
          模型使用量 Top5
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <ReactECharts option={option} style={{ height: 260 }} />
        ) : (
          <div className="h-[260px] flex items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function TodayTop5Card({ data }: { data: { name: string; value: number }[] }) {
  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis' as const,
        axisPointer: { type: 'shadow' as const },
        formatter: (params: Array<{ name: string; value: number }>) => {
          const p = params[0];
          return `${p.name}<br/>${fmt(p.value)} tokens`;
        },
      },
      grid: { left: 16, right: 24, top: 16, bottom: 24, containLabel: true },
      xAxis: {
        type: 'value' as const,
        splitLine: { lineStyle: { color: '#f1f5f9' } },
        axisLabel: { formatter: (v: number) => fmt(v), color: '#64748b' },
      },
      yAxis: {
        type: 'category' as const,
        data: data.map((d) => d.name).reverse(),
        axisLine: { show: false },
        axisTick: { show: false },
        axisLabel: { color: '#475569', fontSize: 11 },
      },
      series: [
        {
          type: 'bar',
          data: data.map((d) => d.value).reverse(),
          itemStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [
              { offset: 0, color: '#a78bfa' },
              { offset: 1, color: '#7c3aed' },
            ]),
            borderRadius: [0, 6, 6, 0] as unknown as number,
          },
          barMaxWidth: 20,
        },
      ],
    }),
    [data]
  );

  return (
    <Card className="h-full flex flex-col">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <Zap className="h-4 w-4 text-primary" />
          今日 Token 使用量 Top5
        </CardTitle>
      </CardHeader>
      <CardContent>
        {data.length > 0 ? (
          <ReactECharts option={option} style={{ height: '100%', minHeight: 260 }} />
        ) : (
          <div className="h-full min-h-[260px] flex items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}

interface DailyTrendPoint {
  day: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

function DailyTrendCard({ data }: { data: DailyTrendPoint[] }) {
  const hasData = data.some((d) => d.total_tokens > 0);
  const option = useMemo(
    () => ({
      tooltip: {
        trigger: 'axis' as const,
        formatter: (params: Array<{ seriesName: string; name: string; value: number; marker: string }>) => {
          const p = params[0];
          return `${p?.name ?? ''}<br/>${p?.marker ?? ''} ${p?.seriesName ?? ''}: ${fmt(p?.value)}`;
        },
      },
      grid: { left: 16, right: 24, top: 24, bottom: 24, containLabel: true },
      xAxis: {
        type: 'category' as const,
        data: data.map((d) => d.day.slice(5)),
        axisLine: { lineStyle: { color: '#e2e8f0' } },
        axisLabel: { fontSize: 11, color: '#64748b' },
      },
      yAxis: {
        type: 'value' as const,
        splitLine: { lineStyle: { color: '#f1f5f9' } },
        axisLabel: { formatter: (v: number) => fmt(v), color: '#64748b' },
      },
      series: [
        {
          name: '总 Token',
          type: 'line' as const,
          data: data.map((d) => d.total_tokens),
          smooth: true,
          symbol: 'circle',
          symbolSize: 6,
          lineStyle: { width: 3, color: '#7c3aed' },
          itemStyle: { color: '#7c3aed' },
          areaStyle: {
            color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(124, 58, 237, 0.2)' },
              { offset: 1, color: 'rgba(124, 58, 237, 0.02)' },
            ]),
          },
        },
      ],
    }),
    [data]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2">
          <TrendingUp className="h-4 w-4 text-primary" />
          近 15 日 Token 用量趋势
        </CardTitle>
      </CardHeader>
      <CardContent>
        {hasData ? (
          <ReactECharts option={option} style={{ height: 320 }} />
        ) : (
          <div className="h-[320px] flex items-center justify-center text-sm text-muted-foreground">
            暂无数据
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export default function Dashboard() {
  const fetchDashboard = useCallback(() => api.refreshProfileStats(), []);
  const { data, loading, error, execute: refresh } = useApi<DashboardData>(fetchDashboard, []);
  const stats = useDashboardStats(data);

  if (error) {
    return (
      <PageContainer>
        <ErrorAlert message={error} />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader
        extra={
          <Button variant="outline" size="sm" onClick={refresh}>
            <RefreshCw className="mr-2 h-4 w-4" />
            刷新
          </Button>
        }
      />

      {loading && <Loading className="py-12" />}

      {!loading && data && (
        <div className="space-y-8">
          {/* Metrics + Today top5 side by side */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
            <div className="space-y-6">
              {/* Infrastructure */}
              <MetricGroup title="基础设施" icon={Server}>
                <MetricCard
                  metric={{
                    icon: Server,
                    label: '主机数',
                    value: String(stats.hostCount),
                    iconClass: 'bg-violet-100 text-violet-600',
                  }}
                />
                <MetricCard
                  metric={{
                    icon: Layers,
                    label: 'Profile 数',
                    value: String(stats.profileCount),
                    iconClass: 'bg-indigo-100 text-indigo-600',
                  }}
                />
                <MetricCard
                  metric={{
                    icon: CheckCircle2,
                    label: '网关正常运行',
                    value: String(stats.runningProfiles),
                    iconClass: 'bg-emerald-100 text-emerald-600',
                  }}
                />
              </MetricGroup>

              {/* Token usage */}
              <MetricGroup title="Token 用量" icon={Zap}>
                <MetricCard
                  metric={{
                    icon: Zap,
                    label: '总 Token',
                    value: fmt(stats.totalTokens),
                    iconClass: 'bg-violet-100 text-violet-600',
                  }}
                />
                <MetricCard
                  metric={{
                    icon: ArrowDownToLine,
                    label: '总输入',
                    value: fmt(stats.totalInputTokens),
                    iconClass: 'bg-blue-100 text-blue-600',
                  }}
                />
                <MetricCard
                  metric={{
                    icon: ArrowUpFromLine,
                    label: '总输出',
                    value: fmt(stats.totalOutputTokens),
                    iconClass: 'bg-fuchsia-100 text-fuchsia-600',
                  }}
                />
              </MetricGroup>

              {/* Activity & performance */}
              <MetricGroup title="活动与性能" icon={Activity}>
                <MetricCard
                  metric={{
                    icon: MessageSquare,
                    label: '总会话数',
                    value: fmt(stats.totalSessions),
                    iconClass: 'bg-purple-100 text-purple-600',
                  }}
                />
                <MetricCard
                  metric={{
                    icon: Target,
                    label: '平均缓存命中率',
                    value: `${stats.avgCacheHitRate.toFixed(1)}%`,
                    iconClass: 'bg-amber-100 text-amber-600',
                  }}
                />
              </MetricGroup>
            </div>

            <div className="h-full min-h-[360px]">
              <TodayTop5Card data={stats.todayTop5} />
            </div>
          </div>

          {/* Charts row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RankChartCard data={stats.profileRank} />
            <ModelTop5Card data={stats.modelTop5} />
          </div>

          {/* Daily trend */}
          <DailyTrendCard data={stats.dailyTrend} />
        </div>
      )}
    </PageContainer>
  );
}
