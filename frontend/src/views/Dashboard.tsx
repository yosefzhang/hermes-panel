import { useCallback, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import * as echarts from 'echarts';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  BarChart3,
  MessageSquare,
  Target,
  TrendingUp,
  Users,
  Zap,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';

interface ProfileStat {
  id: number;
  profile_name: string;
  path: string | null;
  session_count: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_rate: number;
  model_top5: Array<{ model: string; total_tokens: number; sessions: number }>;
  provider_top5: Array<{ provider: string; total_tokens: number; sessions: number }>;
  daily_tokens: Array<{ day: string; total_tokens: number; input_tokens: number; output_tokens: number }>;
  updated_at: number;
  source: 'local' | 'remote';
  panel_name: string | null;
}

interface DashboardData {
  profiles: ProfileStat[];
}

const RANGE_OPTIONS = [
  { value: 'today', label: '今日' },
  { value: '7d', label: '近 7 天' },
  { value: '30d', label: '近 30 天' },
  { value: 'all', label: '总统计' },
] as const;

type RangeValue = (typeof RANGE_OPTIONS)[number]['value'];

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function profileLabel(p: ProfileStat): string {
  return p.source === 'remote' && p.panel_name ? `${p.profile_name}（${p.panel_name}）` : p.profile_name;
}

function useDashboardStats(data: DashboardData | null) {
  return useMemo(() => {
    const allProfiles = data?.profiles ?? [];

    const totalTokens = allProfiles.reduce((sum, p) => sum + p.total_tokens, 0);
    const totalInputTokens = allProfiles.reduce((sum, p) => sum + p.total_input_tokens, 0);
    const totalOutputTokens = allProfiles.reduce((sum, p) => sum + p.total_output_tokens, 0);
    const totalSessions = allProfiles.reduce((sum, p) => sum + p.session_count, 0);
    const profileCount = allProfiles.length;
    const avgCacheHitRate =
      profileCount > 0
        ? allProfiles.reduce((sum, p) => sum + p.cache_hit_rate, 0) / profileCount
        : 0;

    // Token 使用量 Top5（按 profile 汇总）
    const profileRank = [...allProfiles]
      .sort((a, b) => b.total_tokens - a.total_tokens)
      .slice(0, 5)
      .map((p) => ({
        name: profileLabel(p),
        value: p.total_tokens,
      }));

    // 模型使用量 Top5（跨 profile 合并 model_top5）
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

    // Token 用量趋势：跨 profile 按日汇总（数据已由后端按范围过滤）
    const dayMap: Record<string, { total_tokens: number; input_tokens: number; output_tokens: number }> = {};
    for (const p of allProfiles) {
      for (const d of p.daily_tokens ?? []) {
        const entry = dayMap[d.day] ?? { total_tokens: 0, input_tokens: 0, output_tokens: 0 };
        entry.total_tokens += d.total_tokens ?? 0;
        entry.input_tokens += d.input_tokens ?? 0;
        entry.output_tokens += d.output_tokens ?? 0;
        dayMap[d.day] = entry;
      }
    }
    const dailyTrend = Object.keys(dayMap)
      .sort()
      .map((day) => ({ day, ...dayMap[day] }));

    // 按 Profile 分组的 daily 趋势
    const profileDailyTrends = allProfiles.map((p) => ({
      id: p.id,
      name: profileLabel(p),
      daily_tokens: p.daily_tokens ?? [],
    }));

    return {
      totalTokens,
      totalInputTokens,
      totalOutputTokens,
      totalSessions,
      avgCacheHitRate,
      profileRank,
      modelTop5,
      dailyTrend,
      profileCount,
      profileDailyTrends,
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
          Token 使用量 Top5
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

interface DailyTrendPoint {
  day: string;
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
}

interface ProfileDailyTrend {
  id: number;
  name: string;
  daily_tokens: DailyTrendPoint[];
}

function DailyTrendCard({
  title,
  allData,
  profileDailyTrends,
  selectedProfileId,
  onProfileChange,
}: {
  title: string;
  allData: DailyTrendPoint[];
  profileDailyTrends: ProfileDailyTrend[];
  selectedProfileId: number | null; // null = 全部
  onProfileChange: (id: number | null) => void;
}) {
  const data = useMemo(() => {
    if (selectedProfileId === null) {
      return allData;
    }
    const profile = profileDailyTrends.find((p) => p.id === selectedProfileId);
    return profile?.daily_tokens ?? [];
  }, [allData, profileDailyTrends, selectedProfileId]);

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
          name: selectedProfileId === null ? '总 Token' : 'Token',
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
    [data, selectedProfileId]
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-4">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-primary" />
            {title}
          </CardTitle>
          <Select
            value={selectedProfileId?.toString() ?? 'all'}
            onValueChange={(value) => onProfileChange(value === 'all' ? null : parseInt(value, 10))}
          >
            <SelectTrigger className="w-[200px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">全部 Profile</SelectItem>
              {profileDailyTrends.map((p) => (
                <SelectItem key={p.id} value={p.id.toString()}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
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
  const [range, setRange] = useState<RangeValue>('today');
  const [selectedProfileId, setSelectedProfileId] = useState<number | null>(null); // null = 全部
  const fetchDashboard = useCallback(() => api.profileStats(range), [range]);
  const { data, loading, error } = useApi<DashboardData>(fetchDashboard, [range]);
  const stats = useDashboardStats(data);

  const rangeLabel = RANGE_OPTIONS.find((opt) => opt.value === range)?.label ?? '总统计';

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
          <Select value={range} onValueChange={(value) => setRange(value as RangeValue)}>
            <SelectTrigger className="w-[130px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {RANGE_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {loading && <Loading className="py-12" />}

      {!loading && data && (
        <div className="space-y-6">
          {/* 小单元卡片：一行展示核心指标 */}
          <div className="grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
            <MetricCard
              metric={{
                icon: Users,
                label: 'Profile 数',
                value: String(stats.profileCount),
                iconClass: 'bg-green-100 text-green-600',
              }}
            />
            <MetricCard
              metric={{
                icon: MessageSquare,
                label: '会话数',
                value: fmt(stats.totalSessions),
                iconClass: 'bg-purple-100 text-purple-600',
              }}
            />
            <MetricCard
              metric={{
                icon: Zap,
                label: 'Tokens 用量',
                value: fmt(stats.totalTokens),
                iconClass: 'bg-primary/10 text-primary',
              }}
            />
            <MetricCard
              metric={{
                icon: ArrowDownToLine,
                label: '输入 Tokens',
                value: fmt(stats.totalInputTokens),
                iconClass: 'bg-blue-100 text-blue-600',
              }}
            />
            <MetricCard
              metric={{
                icon: ArrowUpFromLine,
                label: '输出 Tokens',
                value: fmt(stats.totalOutputTokens),
                iconClass: 'bg-fuchsia-100 text-fuchsia-600',
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
          </div>

          {/* 图表：Token 使用量 Top5 与模型使用量 Top5 */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <RankChartCard data={stats.profileRank} />
            <ModelTop5Card data={stats.modelTop5} />
          </div>

          {/* Token 用量趋势 - 今日时隐藏 */}
          {range !== 'today' && (
            <DailyTrendCard
              title={`Token 用量趋势（${rangeLabel}）`}
              allData={stats.dailyTrend}
              profileDailyTrends={stats.profileDailyTrends}
              selectedProfileId={selectedProfileId}
              onProfileChange={setSelectedProfileId}
            />
          )}
        </div>
      )}
    </PageContainer>
  );
}