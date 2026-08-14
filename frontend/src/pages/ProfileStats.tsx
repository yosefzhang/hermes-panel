import { useCallback } from 'react';
import { Check, X, Box, Server, Zap } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { useApi } from '../hooks/useApi';
import { api } from '../api/client';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';

interface DailyToken {
  day: string;
  total_tokens: number;
}

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
  daily_tokens: DailyToken[];
  current_config_version: number | null;
  latest_config_version: number | null;
  memory_available: boolean | null;
  memory_provider: string | null;
  updated_at: number;
}

interface Server {
  id: string;
  name: string;
  host: string | null;
  username: string | null;
  ip: string | null;
  hermes_version: string | null;
  components: Record<string, string>;
  is_local: boolean;
  online: boolean;
  profiles: ProfileStat[];
}

interface ProfileStatsData {
  servers: Server[];
}

const versionLabels: Record<string, string> = {
  python: 'Python',
  node: 'Node.js',
  npm: 'npm',
  git: 'Git',
  hermes: 'Hermes',
};

const versionIcons: Record<string, React.ElementType> = {
  python: Box,
  node: Box,
  npm: Box,
  git: Box,
  hermes: Zap,
};

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function getTodayTokens(daily: DailyToken[]): number {
  const today = new Date().toISOString().slice(0, 10);
  const found = daily.find((d) => d.day === today);
  return found ? found.total_tokens : 0;
}

function GatewayBadge({ status }: { status: string | null }) {
  const running = status === 'running';
  return (
    <Badge variant="outline" className={running ? 'status-success border-transparent' : 'status-destructive border-transparent'}>
      {running ? '运行中' : '已停止'}
    </Badge>
  );
}

function ConfigVersionBadge({ current, latest }: { current: number | null; latest: number | null }) {
  // 当 current 缺失（config.yaml 无 _config_version 键）记为 legacy。
  const display = current ?? 0;
  const isLegacy = current == null;
  const outdated = latest != null && display < latest;
  if (!latest) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  return (
    <Badge
      variant="outline"
      className={
        `font-normal ` +
        (outdated
          ? 'border-amber-200 bg-amber-50 text-amber-700'
          : 'border-emerald-200 bg-emerald-50 text-emerald-700')
      }
      title={isLegacy ? 'config.yaml 未写入 _config_version' : undefined}
    >
      {isLegacy ? `legacy → ${latest}` : `${current} → ${latest}`}
    </Badge>
  );
}

function MemoryBadge({ available, provider }: { available: boolean | null; provider: string | null }) {
  if (!available) {
    return (
      <span className="inline-flex items-center gap-1 text-xs">
        <X className="h-3 w-3 text-red-500" />
        未启用
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-xs">
      <Check className="h-3 w-3 text-emerald-500" />
      {provider || '已启用'}
    </span>
  );
}

function ServerSection({ server }: { server: Server }) {
  const componentEntries = Object.entries(server.components || {});

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-semibold">
          <span className="rounded-lg bg-primary/10 p-1.5 text-primary">
            <Server className="h-4 w-4" />
          </span>
          {server.name}
          {server.is_local && (
            <Badge variant="outline" className="border-transparent bg-muted text-muted-foreground">
              本地
            </Badge>
          )}
          <Badge variant="outline" className={server.online ? 'text-emerald-600 border-emerald-200 bg-emerald-50' : 'text-red-500 border-red-200 bg-red-50'}>
            {server.online ? '在线' : '离线'}
          </Badge>
        </CardTitle>
        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="font-mono">{server.id}</span>
          {server.hermes_version && (
            <span className="inline-flex items-center gap-1">
              <Zap className="h-3 w-3" />
              Hermes {server.hermes_version}
            </span>
          )}
          {componentEntries.length > 0 &&
            componentEntries.map(([key, value]) => {
              const Icon = versionIcons[key] || Box;
              return (
                <span key={key} className="inline-flex items-center gap-1">
                  <Icon className="h-3 w-3" />
                  {versionLabels[key] || key}: {value}
                </span>
              );
            })}
        </div>
      </CardHeader>
      <CardContent className="p-0">
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="whitespace-nowrap">Profile</TableHead>
                <TableHead className="whitespace-nowrap">主机</TableHead>
                <TableHead className="whitespace-nowrap">路径</TableHead>
                <TableHead className="whitespace-nowrap">配置版本</TableHead>
                <TableHead className="whitespace-nowrap">记忆体</TableHead>
                <TableHead className="whitespace-nowrap">网关状态</TableHead>
                <TableHead className="whitespace-nowrap text-right">会话数</TableHead>
                <TableHead className="whitespace-nowrap text-right">总Token</TableHead>
                <TableHead className="whitespace-nowrap text-right">输入Token</TableHead>
                <TableHead className="whitespace-nowrap text-right">输出Token</TableHead>
                <TableHead className="whitespace-nowrap text-right">缓存命中率</TableHead>
                <TableHead className="whitespace-nowrap text-right">今日Token</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {server.profiles.map((stat) => (
                <TableRow key={`${stat.server_id}-${stat.profile_name}`}>
                  <TableCell className="font-medium whitespace-nowrap">{stat.profile_name}</TableCell>
                  <TableCell className="text-xs text-muted-foreground whitespace-nowrap">{stat.host ?? '—'}</TableCell>
                  <TableCell className="text-xs text-muted-foreground break-all" title={stat.path ?? ''}>
                    {stat.path ?? '—'}
                  </TableCell>
                  <TableCell>
                    <ConfigVersionBadge
                      current={stat.current_config_version}
                      latest={stat.latest_config_version}
                    />
                  </TableCell>
                  <TableCell>
                    <MemoryBadge
                      available={stat.memory_available}
                      provider={stat.memory_provider}
                    />
                  </TableCell>
                  <TableCell>
                    <GatewayBadge status={stat.gateway_status} />
                  </TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.session_count)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.total_tokens)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.total_input_tokens)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.total_output_tokens)}</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{stat.cache_hit_rate.toFixed(1)}%</TableCell>
                  <TableCell className="text-right whitespace-nowrap">{formatNumber(getTodayTokens(stat.daily_tokens))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}

export default function ProfileStats() {
  const fetchStats = useCallback(() => api.profileStats(), []);
  const { data, loading, error } = useApi<ProfileStatsData>(fetchStats, []);

  return (
    <PageContainer>
      <PageHeader />
      {loading && <Loading className="py-12" />}
      {!loading && error && <ErrorAlert message={error} />}
      {!loading && data && (
        <div className="space-y-6">
          {data.servers.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-12">暂无 Profile 统计数据</p>
          ) : (
            data.servers.map((server) => <ServerSection key={server.id} server={server} />)
          )}
        </div>
      )}
    </PageContainer>
  );
}
