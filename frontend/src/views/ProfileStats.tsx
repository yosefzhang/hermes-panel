import { useCallback } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
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
  profile_name: string;
  path: string | null;
  session_count: number;
  total_tokens: number;
  total_input_tokens: number;
  total_output_tokens: number;
  cache_hit_rate: number;
  daily_tokens: DailyToken[];
  updated_at: number;
  source: 'local' | 'remote';
  panel_name: string | null;
}

interface ProfileStatsData {
  profiles: ProfileStat[];
}

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

export default function ProfileStats() {
  const fetchStats = useCallback(() => api.profileStats(), []);
  const { data, loading, error, execute: refresh } = useApi<ProfileStatsData>(fetchStats, []);
  const handleRefresh = useCallback(() => api.refreshProfileStats(), []);
  const { loading: refreshing, execute: executeRefresh } = useApi<ProfileStatsData>(
    handleRefresh,
    [],
    { immediate: false },
  );

  const refreshStats = useCallback(async () => {
    await executeRefresh(true);
    await refresh(true);
  }, [executeRefresh, refresh]);

  return (
    <PageContainer>
      <PageHeader
        extra={
          <Button variant="outline" size="sm" onClick={refreshStats} disabled={refreshing || loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? '刷新中…' : '刷新'}
          </Button>
        }
      />
      {loading && <Loading className="py-12" />}
      {!loading && error && <ErrorAlert message={error} />}
      {!loading && data && (
        <Card className="overflow-hidden">
          <CardContent className="p-0">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">Profile</TableHead>
                    <TableHead className="whitespace-nowrap">来源</TableHead>
                    <TableHead className="whitespace-nowrap">路径</TableHead>
                    <TableHead className="whitespace-nowrap text-right">会话数</TableHead>
                    <TableHead className="whitespace-nowrap text-right">总Token</TableHead>
                    <TableHead className="whitespace-nowrap text-right">输入Token</TableHead>
                    <TableHead className="whitespace-nowrap text-right">输出Token</TableHead>
                    <TableHead className="whitespace-nowrap text-right">缓存命中率</TableHead>
                    <TableHead className="whitespace-nowrap text-right">今日Token</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.profiles.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={9} className="text-center py-12 text-muted-foreground">
                        暂无 Profile 统计数据
                      </TableCell>
                    </TableRow>
                  ) : (
                    data.profiles.map((stat) => (
                      <TableRow key={stat.id}>
                        <TableCell className="font-medium whitespace-nowrap">{stat.profile_name}</TableCell>
                        <TableCell className="whitespace-nowrap">
                          {stat.source === 'remote' ? (
                            <Badge variant="outline">{stat.panel_name || '远程'}</Badge>
                          ) : (
                            <Badge variant="secondary">本机</Badge>
                          )}
                        </TableCell>
                        <TableCell className="text-xs text-muted-foreground break-all" title={stat.path ?? ''}>
                          {stat.path ?? '—'}
                        </TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.session_count)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.total_tokens)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.total_input_tokens)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatNumber(stat.total_output_tokens)}</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{stat.cache_hit_rate.toFixed(1)}%</TableCell>
                        <TableCell className="text-right whitespace-nowrap">{formatNumber(getTodayTokens(stat.daily_tokens))}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      )}
    </PageContainer>
  );
}