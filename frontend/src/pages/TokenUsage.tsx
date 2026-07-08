import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Row, Spin, Statistic } from 'antd';
import ReactECharts from 'echarts-for-react';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
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
    <div style={{ marginBottom: 24 }}>
      <Card
        title={<span style={{ fontWeight: 600 }}>{profile}</span>}
        size="small"
        styles={{ header: { background: '#f0f7f6' } }}
      >
        <Row gutter={[12, 12]}>
          <Col xs={12} sm={8} md={4}>
            <Statistic title="总 Token" value={fmt(summary.total_tokens)} valueStyle={{ color: '#0f766e', fontSize: 20 }} />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic title="总输入" value={fmt(summary.total_input_tokens)} valueStyle={{ color: '#0891b2', fontSize: 20 }} />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic title="总输出" value={fmt(summary.total_output_tokens)} valueStyle={{ color: '#d97706', fontSize: 20 }} />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic title="缓存命中率" value={summary.cache_hit_rate} suffix="%" precision={1} valueStyle={{ color: '#7c3aed', fontSize: 20 }} />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic title="会话数" value={summary.total_sessions} valueStyle={{ fontSize: 20 }} />
          </Col>
          <Col xs={12} sm={8} md={4}>
            <Statistic title="估算费用" value={fmtCost(summary.total_cost_usd)} valueStyle={{ color: '#3fb950', fontSize: 20 }} />
          </Col>
        </Row>

        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col xs={24} lg={14}>
            <Card title="每日 Token 用量（近 15 天）" size="small">
              {last15Days.length > 0 ? (
                <ReactECharts option={dailyChartOption} style={{ height: 260 }} />
              ) : (
                <EmptyState text="暂无数据" />
              )}
            </Card>
          </Col>
          <Col xs={24} lg={10}>
            <Card title="模型分布（Top 5）" size="small">
              {modelChartData.length > 0 ? (
                <ReactECharts option={modelChartOption} style={{ height: 260 }} />
              ) : (
                <EmptyState text="暂无数据" />
              )}
            </Card>
          </Col>
        </Row>
      </Card>
    </div>
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
    <>
      <PageHeader
        title="Token 统计"
        extra={
          <Button onClick={loadData} loading={loading}>刷新</Button>
        }
      />
      {error && <Alert message={error} type="error" showIcon closable style={{ marginBottom: 16 }} />}
      <Spin spinning={loading}>
        {profileData.length > 0 ? (
          profileData.map((item) => <ProfileSection key={item.profile} profile={item.profile} data={item.data} />)
        ) : (
          !loading && <EmptyState text="暂无数据" />
        )}
      </Spin>
    </>
  );
}
