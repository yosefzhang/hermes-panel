import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Descriptions, Modal, Row, Spin, Statistic, Table, Tag, Tooltip } from 'antd';
import ReactECharts from 'echarts-for-react';
import ReactMarkdown from 'react-markdown';
import PageHeader from '../components/PageHeader';
import EmptyState from '../components/EmptyState';
import { useApi } from '../hooks/useApi';
import { apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import { useAuthStore } from '../store/authStore';
import { getProfileColor } from '../config/profileColors';
import type { TokenDashboardData, TokenDailyEntry, TokenModelEntry } from '../types';

interface HermesHomeInfo {
  path: string;
  exists: boolean;
}

interface DbStats {
  size: number;
  size_formatted: string;
  session_count: number;
}

interface ProfileInfo {
  name: string;
  path: string;
  exists: boolean;
  config_exists: boolean;
  env_exists: boolean;
  state_db_exists: boolean;
  skills_path: string;
  skills_exists: boolean;
  db_stats: DbStats | null;
}

interface DashboardInfo {
  hermes_home: HermesHomeInfo;
  profiles: ProfileInfo[];
  versions: Record<string, string>;
}

interface HermesUpdateInfo {
  current_version: string;
  latest_version: string | null;
  latest_version_tag: string;
  has_update: boolean;
  release_notes: string;
  published_at: string;
  release_url: string;
  error?: string;
}

const versionLabels: Record<string, string> = {
  python: 'Python',
  node: 'Node.js',
  npm: 'npm',
  git: 'Git',
  hermes: 'Hermes',
};

const badgeColors: Record<string, string> = {
  python: '#3776ab',
  node: '#339933',
  npm: '#cb3837',
  git: '#f05032',
  hermes: '#0f766e',
};

function GitHubBadge({ label, version, color }: { label: string; version: string; color: string }) {
  return (
    <span style={{ display: 'inline-flex', borderRadius: 4, overflow: 'hidden', fontSize: 12, lineHeight: '20px', fontFamily: 'Verdana, sans-serif' }}>
      <span style={{ padding: '0 6px', background: '#555', color: '#fff' }}>{label}</span>
      <span style={{ padding: '0 6px', background: color, color: '#fff' }}>{version}</span>
    </span>
  );
}

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

function topFiveWithOther(models: TokenModelEntry[]): TokenModelEntry[] {
  if (models.length <= 5) return models;
  const top5 = models.slice(0, 5);
  const otherTokens = models.slice(5).reduce((sum, m) => sum + m.total_tokens, 0);
  return [...top5, { model: 'Other', total_tokens: otherTokens, sessions: 0 }];
}

interface ProfileTokenData {
  profile: string;
  data: TokenDashboardData;
}

function ProfileTokenSection({ profile, data }: { profile: string; data: TokenDashboardData }) {
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

export default function Dashboard() {
  const { profiles } = useConfigStore();
  const { user } = useAuthStore();
  const isAdmin = user?.role === 'admin';
  
  const fetchInfo = useCallback(
    () => apiClient.get<DashboardInfo>('/system/hermes-info').then((res) => res.data),
    [],
  );

  const { data, loading, error, execute } = useApi(fetchInfo, []);

  // Token statistics
  const [profileTokenData, setProfileTokenData] = useState<ProfileTokenData[]>([]);
  const [tokenLoading, setTokenLoading] = useState(true);

  // Gateway status
  interface GatewayStatus {
    profile: string;
    running: boolean;
    pid: number | null;
    state: string | null;
    platforms: Record<string, unknown>;
    updated_at: string | null;
  }
  const [gatewayStatuses, setGatewayStatuses] = useState<GatewayStatus[]>([]);
  const [gatewayLoading, setGatewayLoading] = useState(true);
  const [gatewayActionLoading, setGatewayActionLoading] = useState<string | null>(null);

  // Hermes update check
  const [updateInfo, setUpdateInfo] = useState<HermesUpdateInfo | null>(null);
  const [updateModalVisible, setUpdateModalVisible] = useState(false);

  // Hermes upgrade state
  const [upgrading, setUpgrading] = useState(false);
  const [upgradeSuccess, setUpgradeSuccess] = useState<boolean | null>(null);
  const [upgradeOutput, setUpgradeOutput] = useState('');

  const checkForUpdates = useCallback(async () => {
    if (!isAdmin) return;
    try {
      const res = await apiClient.get<HermesUpdateInfo>('/system/hermes-update');
      setUpdateInfo(res.data);
    } catch {
      // ignore
    }
  }, [isAdmin]);

  useEffect(() => {
    checkForUpdates();
  }, [checkForUpdates]);

  // Poll upgrade status
  useEffect(() => {
    if (!upgrading) return;
    const poll = setInterval(async () => {
      try {
        const res = await apiClient.get<{ running: boolean; success: boolean | null; output: string }>('/system/hermes-upgrade/status');
        setUpgradeOutput(res.data.output || '');
        if (!res.data.running) {
          setUpgrading(false);
          setUpgradeSuccess(res.data.success);
          // 升级完成后刷新版本信息
          checkForUpdates();
        }
      } catch {
        // ignore
      }
    }, 2000);
    return () => clearInterval(poll);
  }, [upgrading, checkForUpdates]);

  const startUpgrade = async () => {
    setUpgrading(true);
    setUpgradeSuccess(null);
    setUpgradeOutput('');
    try {
      await apiClient.post('/system/hermes-upgrade');
    } catch {
      setUpgrading(false);
      setUpgradeSuccess(false);
    }
  };

  const loadTokenData = useCallback(async () => {
    setTokenLoading(true);
    try {
      const results = await Promise.allSettled(
        profiles.map(async (profile) => {
          const res = await apiClient.get<TokenDashboardData>('/tokens/dashboard', { params: { profile } });
          return { profile, data: res.data } as ProfileTokenData;
        }),
      );
      const tokenData: ProfileTokenData[] = [];
      for (const result of results) {
        if (result.status === 'fulfilled') {
          tokenData.push(result.value);
        }
      }
      setProfileTokenData(tokenData);
    } catch {
      // ignore
    } finally {
      setTokenLoading(false);
    }
  }, [profiles]);

  const loadGatewayStatus = useCallback(async () => {
    setGatewayLoading(true);
    try {
      const res = await apiClient.get<{ statuses: GatewayStatus[] }>('/gateway/status');
      setGatewayStatuses(res.data.statuses || []);
      return res.data.statuses || [];
    } catch {
      return [];
    } finally {
      setGatewayLoading(false);
    }
  }, []);

  // 静默刷新状态（不触发全局 loading，用于轮询）
  const refreshGatewayStatusSilently = useCallback(async () => {
    try {
      const res = await apiClient.get<{ statuses: GatewayStatus[] }>('/gateway/status');
      setGatewayStatuses(res.data.statuses || []);
      return res.data.statuses || [];
    } catch {
      return [];
    }
  }, []);

  // 轮询指定 profile 的网关状态，直到达到期望的 running 状态或超时
  const pollGatewayStatus = useCallback(
    async (profile: string, expectRunning: boolean) => {
      const maxAttempts = 10;
      for (let i = 0; i < maxAttempts; i++) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const statuses = await refreshGatewayStatusSilently();
        const gw = statuses.find((s) => s.profile === profile);
        if ((gw?.running ?? false) === expectRunning) {
          return;
        }
      }
    },
    [refreshGatewayStatusSilently],
  );

  const handleGatewayStart = useCallback(async (profile: string) => {
    setGatewayActionLoading(profile);
    try {
      await apiClient.post('/gateway/start', { profile }, { timeout: 60000 });
      await pollGatewayStatus(profile, true);
    } catch (error) {
      console.error('Failed to start gateway:', error);
      await loadGatewayStatus();
    } finally {
      setGatewayActionLoading(null);
    }
  }, [pollGatewayStatus, loadGatewayStatus]);

  const handleGatewayStop = useCallback(async (profile: string) => {
    setGatewayActionLoading(profile);
    try {
      await apiClient.post('/gateway/stop', { profile }, { timeout: 60000 });
      await pollGatewayStatus(profile, false);
    } catch (error) {
      console.error('Failed to stop gateway:', error);
      await loadGatewayStatus();
    } finally {
      setGatewayActionLoading(null);
    }
  }, [pollGatewayStatus, loadGatewayStatus]);

  const handleGatewayRestart = useCallback(async (profile: string) => {
    setGatewayActionLoading(profile);
    try {
      await apiClient.post('/gateway/restart', { profile }, { timeout: 60000 });
      await pollGatewayStatus(profile, true);
    } catch (error) {
      console.error('Failed to restart gateway:', error);
      await loadGatewayStatus();
    } finally {
      setGatewayActionLoading(null);
    }
  }, [pollGatewayStatus, loadGatewayStatus]);

  useEffect(() => {
    loadTokenData();
  }, [loadTokenData]);

  useEffect(() => {
    loadGatewayStatus();
  }, [loadGatewayStatus]);

  const handleRefresh = () => {
    execute();
    loadTokenData();
    loadGatewayStatus();
    checkForUpdates();
  };

  const profileColumns = [
    {
      title: 'Profile',
      dataIndex: 'name',
      width: '12%',
      minWidth: 80,
      render: (name: string) => (
        <span
          style={{
            fontWeight: 600,
            padding: '3px 10px',
            borderRadius: 6,
            background: getProfileColor(name),
            color: '#fff',
            whiteSpace: 'nowrap',
          }}
        >
          {name}
        </span>
      ),
    },
    {
      title: '路径',
      dataIndex: 'path',
      width: '35%',
      minWidth: 160,
      ellipsis: { showTitle: false },
      render: (path: string) => (
        <Tooltip title={path}>
          <span style={{ fontFamily: 'monospace', fontSize: 12 }}>{path}</span>
        </Tooltip>
      ),
    },
    {
      title: '网关状态',
      width: '28%',
      minWidth: 200,
      render: (_: unknown, record: ProfileInfo) => {
        const gw = gatewayStatuses.find(s => s.profile === record.name);
        const isRunning = gw?.running ?? false;
        const isLoading = gatewayActionLoading === record.name;
        
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Tag color={isRunning ? 'success' : 'default'}>
              {isRunning ? '运行中' : '已停止'}
            </Tag>
            {isRunning ? (
              <>
                <Button
                  size="small"
                  loading={isLoading}
                  onClick={() => handleGatewayRestart(record.name)}
                >
                  重启
                </Button>
                <Button
                  size="small"
                  danger
                  loading={isLoading}
                  onClick={() => handleGatewayStop(record.name)}
                >
                  停止
                </Button>
              </>
            ) : (
              <Button
                size="small"
                type="primary"
                loading={isLoading}
                onClick={() => handleGatewayStart(record.name)}
              >
                启动
              </Button>
            )}
          </div>
        );
      },
    },
    {
      title: '会话数',
      width: '12%',
      minWidth: 80,
      render: (_: unknown, record: ProfileInfo) => record.db_stats?.session_count ?? '—',
    },
    {
      title: '数据库',
      width: '13%',
      minWidth: 80,
      render: (_: unknown, record: ProfileInfo) => record.db_stats?.size_formatted ?? '—',
    },
  ];

  if (error) {
    return (
      <>
        <PageHeader title="仪表盘" />
        <EmptyState text={error} />
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="仪表盘"
        extra={
          <>
            {isAdmin && updateInfo?.has_update && (
              <Button type="primary" onClick={() => setUpdateModalVisible(true)}>
                新版本：{updateInfo.latest_version} ({(() => { const d = new Date(updateInfo.published_at); return `${d.getFullYear()}.${d.getMonth() + 1}.${d.getDate()}`; })()})
              </Button>
            )}
            <a onClick={handleRefresh} style={{ cursor: 'pointer', color: '#0f766e' }}>
              刷新
            </a>
          </>
        }
      />
      <Spin spinning={loading || tokenLoading || gatewayLoading}>
        <Row gutter={[16, 16]}>
          {/* System Versions as GitHub Badges */}
          <Col span={24}>
            <Card title="系统组件" size="small">
              {data?.versions && Object.keys(data.versions).length > 0 ? (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                  {Object.entries(data.versions).map(([key, value]) => (
                    <GitHubBadge key={key} label={versionLabels[key] ?? key} version={value} color={badgeColors[key] ?? '#555'} />
                  ))}
                </div>
              ) : (
                <EmptyState text="暂无版本信息" />
              )}
            </Card>
          </Col>

          {/* Profiles Table */}
          <Col span={24}>
            <Card title="Profiles" size="small">
              {data?.profiles && data.profiles.length > 0 ? (
                <Table<ProfileInfo>
                  rowKey="name"
                  dataSource={data.profiles}
                  columns={profileColumns}
                  pagination={false}
                  size="small"
                />
              ) : (
                <EmptyState text="暂无 Profile" />
              )}
            </Card>
          </Col>
        </Row>

        {/* Token Statistics by Profile */}
        {profileTokenData.length > 0 ? (
          profileTokenData.map((item) => (
            <ProfileTokenSection key={item.profile} profile={item.profile} data={item.data} />
          ))
        ) : (
          !tokenLoading && <EmptyState text="暂无 Token 数据" />
        )}
      </Spin>

      {/* Hermes Update Modal */}
      {isAdmin && updateInfo && (
        <Modal
          title={`Hermes 新版本: ${updateInfo.latest_version}`}
          open={updateModalVisible}
          onCancel={() => { if (!upgrading) setUpdateModalVisible(false); }}
          maskClosable={!upgrading}
          footer={upgradeSuccess === true ? [
            <Button key="close" type="primary" onClick={() => { setUpdateModalVisible(false); setUpgradeSuccess(null); }}>
              完成
            </Button>,
          ] : [
            <Button key="close" onClick={() => setUpdateModalVisible(false)} disabled={upgrading}>
              关闭
            </Button>,
            <Button
              key="download"
              href={updateInfo.release_url}
              target="_blank"
              disabled={upgrading}
            >
              查看 Release
            </Button>,
            <Button
              key="upgrade"
              type="primary"
              danger
              onClick={startUpgrade}
              loading={upgrading}
              disabled={upgrading}
            >
              {upgrading ? '升级中…' : '升级 Hermes'}
            </Button>,
          ]}
          width="80vw"
          style={{ maxWidth: 1000, top: 40 }}
          styles={{
            wrapper: { left: 224 },
            body: { maxHeight: 'calc(100vh - 240px)', overflow: 'auto' },
          }}
        >
          <div style={{ marginBottom: 16 }}>
            <Alert
              message={`当前版本: ${updateInfo.current_version} → 最新版本: ${updateInfo.latest_version}`}
              type="info"
              showIcon
            />
          </div>
          <div style={{ marginBottom: 8 }}>
            <strong>发布时间:</strong> {new Date(updateInfo.published_at).toLocaleString()}
          </div>

          {/* Upgrade progress */}
          {upgradeSuccess === true && (
            <Alert
              type="success"
              message="升级完成！请刷新页面以加载新版本。"
              style={{ marginTop: 12 }}
              showIcon
            />
          )}
          {upgradeSuccess === false && (
            <Alert
              type="error"
              message="升级失败，请查看下方日志了解详情。"
              style={{ marginTop: 12 }}
              showIcon
            />
          )}
          {(upgrading || upgradeOutput) && (
            <div style={{ marginTop: 12 }}>
              <strong>升级日志:</strong>
              <div style={{
                marginTop: 8,
                padding: 12,
                background: '#1e1e1e',
                color: '#d4d4d4',
                borderRadius: 4,
                maxHeight: 250,
                overflow: 'auto',
                fontFamily: 'monospace',
                fontSize: 12,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-all',
              }}>
                {upgradeOutput || (upgrading && '等待输出…')}
              </div>
            </div>
          )}

          <div style={{ marginTop: 16 }}>
            <strong>更新内容:</strong>
            <div style={{
              marginTop: 8,
              padding: 12,
              background: '#f5f5f5',
              borderRadius: 4,
            }}>
              {updateInfo.release_notes ? (
                <div className="markdown-body">
                  <ReactMarkdown>{updateInfo.release_notes}</ReactMarkdown>
                </div>
              ) : (
                <div style={{ color: '#999' }}>无更新说明</div>
              )}
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}
