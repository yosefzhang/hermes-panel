import { useCallback, useEffect, useMemo, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { RefreshCw, Coins } from 'lucide-react';
import { apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';
import EmptyState from '../components/EmptyState';
import type { TokenDashboardData, TokenDailyEntry, TokenModelEntry } from '../types';

function fmt(n: number | null | undefined): string {
  if (n == null) return '—';
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return n.toLocaleString();
}

function fmtCost(n: number | null | undefined): string {
  if (n == null || n === 0) return '$0.00';
  return '$' + n.toFixed(4);
}

const CHART_COLORS = ['#0f766e', '#0891b2', '#d97706', '#dc2626', '#7c3aed', '#94a3b8'];

interface ProfileData {
  profile: string;
  data: TokenDashboardData;
}

function topFiveWithOther(models: TokenModelEntry[]): TokenModelEntry[] {
  if (models.length <= 5) return models;
  const top5 = models.slice(0, 5);
  const otherTokens = models.slice(5).reduce((sum, m) => sum + m.total_tokens, 0);
  return [...top5, { model: 'Other', total_tokens: otherTokens, sessions: 0 }];
}

function StatCard({ title, value, color = 'text-foreground' }: { title: string; value: string; color?: string }) {
  return (
    <div className="space-y-1">
      <div className="text-sm text-muted-foreground">{title}</div>
      <div className={`text-xl font-semibold ${color}`}>{value}</div>
    </div>
  );
}

function ProfileSection({ profile, data }: { profile: string; data: TokenDashboardData }) {
  const summary = data.summary;
  const daily = data.daily ?? [];
  const byModel = data.by_model ?? [];

  const last15Days = daily.slice(-15);

  const dailyChartOption = useMemo(() => ({
    tooltip: {
      trigger: 'axis' as const,
      formatter: (params: Array<{ name: string; value: number }>) => {
        const p = params[0];
        return `${p.name}<br/>${fmt(p.value)} tokens`;
      },
    },
    grid: { left: 60, right: 16, top: 16, bottom: 40 },
    xAxis: {
      type: 'category' as const,
      data: last15Days.map((d: TokenDailyEntry) => d.day),
      axisLabel: { fontSize: 11, rotate: last15Days.length > 10 ? 45 : 0 },
    },
    yAxis: {
      type: 'value' as const,
      axisLabel: { formatter: (v: number) => fmt(v) },
    },
    series: [
      {
        type: 'bar',
        data: last15Days.map((d: TokenDailyEntry) => d.total_tokens),
        itemStyle: {
          color: '#0f766e',
          borderRadius: [4, 4, 0, 0] as unknown as number,
        },
        barMaxWidth: 30,
      },
    ],
  }), [last15Days]);

  const modelChartData = topFiveWithOther(byModel);

  const modelChartOption = useMemo(() => ({
    tooltip: {
      trigger: 'item' as const,
      formatter: (p: { name: string; value: number; percent: number }) =>
        `${p.name}<br/>${fmt(p.value)} tokens (${p.percent.toFixed(1)}%)`,
    },
    legend: {
      type: 'scroll' as const,
      bottom: 0,
      left: 'center',
    },
    series: [
      {
        type: 'pie',
        radius: ['40%', '65%'],
        avoidLabelOverlap: true,
        itemStyle: { borderRadius: 4, borderColor: '#fff', borderWidth: 2 },
        label: { show: true, formatter: (p: { name: string; percent: number }) => `${p.name}\n${p.percent.toFixed(0)}%`, fontSize: 11 },
        emphasis: { label: { show: true, fontSize: 13, fontWeight: 'bold' } },
        data: modelChartData.map((m: TokenModelEntry, i: number) => ({
          name: m.model,
          value: m.total_tokens,
          itemStyle: { color: CHART_COLORS[i % CHART_COLORS.length] },
        })),
      },
    ],
  }), [modelChartData]);

  return (
    <Card className="mb-6">
      <CardHeader>
        <CardTitle>{profile}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* 统计卡片 */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
          <StatCard title="总 Token" value={fmt(summary.total_tokens)} color="text-primary" />
          <StatCard title="总输入" value={fmt(summary.total_input_tokens)} color="text-primary" />
          <StatCard title="总输出" value={fmt(summary.total_output_tokens)} color="text-primary" />
          <StatCard title="缓存命中率" value={`${summary.cache_hit_rate.toFixed(1)}%`} color="text-primary" />
          <StatCard title="会话数" value={summary.total_sessions.toString()} color="text-primary" />
          <StatCard title="估算费用" value={fmtCost(summary.total_cost_usd)} color="text-primary" />
        </div>

        {/* 图表区域 */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <Card>
            <CardHeader>
              <CardTitle>每日 Token 用量（近 15 天）</CardTitle>
            </CardHeader>
            <CardContent>
              {last15Days.length > 0 ? (
                <ReactECharts option={dailyChartOption} style={{ height: 260 }} />
              ) : (
                <div className="h-[260px] flex items-center justify-center text-muted-foreground">
                  暂无数据
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>模型分布（Top 5）</CardTitle>
            </CardHeader>
            <CardContent>
              {modelChartData.length > 0 ? (
                <ReactECharts option={modelChartOption} style={{ height: 260 }} />
              ) : (
                <div className="h-[260px] flex items-center justify-center text-muted-foreground">
                  暂无数据
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </CardContent>
    </Card>
  );
}

export default function TokenUsage() {
  const { profiles } = useConfigStore();
  const [profileData, setProfileData] = useState<ProfileData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        profiles.map(async (profile) => {
          const res = await apiClient.get<TokenDashboardData>('/tokens/dashboard', { params: { profile } });
          return { profile, data: res.data } as ProfileData;
        }),
      );
      const data: ProfileData[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          data.push(result.value);
        }
      }
      setProfileData(data);
    } catch {
      setError('加载 Token 数据失败');
    } finally {
      setLoading(false);
    }
  }, [profiles]);

  useEffect(() => {
    loadData();

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') {
        loadData();
      }
    }, 60000);

    return () => clearInterval(interval);
  }, [loadData]);

  return (
    <PageContainer>
      <PageHeader
        extra={
          <Button onClick={loadData} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        }
      />

      {error && <ErrorAlert message={error} />}

      {loading ? (
        <Loading className="py-12" />
      ) : profileData.length > 0 ? (
        profileData.map((item) => <ProfileSection key={item.profile} profile={item.profile} data={item.data} />)
      ) : (
        <EmptyState text="暂无 Token 使用数据" />
      )}
    </PageContainer>
  );
}
