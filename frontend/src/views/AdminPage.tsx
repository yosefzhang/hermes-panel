import { useCallback, useEffect, useState } from 'react';
import {
  Cpu,
  FileText,
  Play,
  RotateCw,
  Square,
  Upload,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Select } from 'antd';
import { useToast } from '@/hooks/use-toast';
import { api, apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import Loading from '../components/Loading';

type TabKey = 'gateway' | 'models' | 'soul' | 'update';

interface BatchResult {
  profile: string;
  success: boolean;
  message: string;
}

interface GatewayStatus {
  profile: string;
  running: boolean;
  pid: number | null;
  state: string | null;
  started_at: number | null;
}

type RunBatch = (label: string, fn: () => Promise<BatchResult[]>) => Promise<void>;

// 模型配置同步时复制的 section（与后端 MODEL_SECTIONS 对齐）
const MODEL_COPY_SECTIONS = [
  'model',
  'auxiliary',
  'fallback_providers',
  'custom_providers',
  'providers',
  'models',
  'model_catalog',
  'moa',
];

// 模型配置「同步范围」选项
const MODELS_SCOPE: Array<{ label: string; sections: string[] }> = [
  { label: '全部模型配置', sections: MODEL_COPY_SECTIONS },
  { label: '主模型', sections: ['model'] },
  { label: '辅助模型', sections: ['auxiliary'] },
  { label: '回退模型', sections: ['fallback_providers'] },
  { label: '供应商', sections: ['custom_providers', 'providers'] },
  { label: '多智能体', sections: ['moa'] },
];

// ── 主组件 ───────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { toast } = useToast();
  const { profiles, loadProfiles } = useConfigStore();
  const [tab, setTab] = useState<TabKey>('gateway');
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);

  const runBatch: RunBatch = useCallback(
    async (label, fn) => {
      setRunning(true);
      try {
        const res = await fn();
        const ok = res.filter((r) => r.success).length;
        toast({
          title: label,
          description: `成功 ${ok} / ${res.length} 个 profile`,
        });
      } catch (error: any) {
        toast({
          variant: 'destructive',
          title: `${label}失败`,
          description: error?.response?.data?.detail || error?.message || '请稍后重试',
        });
      } finally {
        setRunning(false);
      }
    },
    [toast],
  );

  const TABS: Array<{ key: TabKey; label: string }> = [
    { key: 'gateway', label: 'Gateway' },
    { key: 'models', label: '模型配置' },
    { key: 'soul', label: 'SOUL.md' },
    { key: 'update', label: 'Hermes 更新' },
  ];

  return (
    <PageContainer>
      <PageHeader description="对多个 profile 批量执行统一操作。所有操作写入审计日志，SOUL.md 写入前自动备份。" />

      {/* Tab 切换 */}
      <div className="flex gap-2 border-b mb-6">
        {TABS.map(({ key, label }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
              tab === key
                ? 'tab-active'
                : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="mt-4">
        {tab === 'gateway' && (
          <GatewayTab
            onRun={runBatch}
          />
        )}
        {tab === 'models' && (
          <ModelsTab
            profiles={profiles}
            selected={selected}
            setSelected={setSelected}
            running={running}
            onRun={runBatch}
          />
        )}
        {tab === 'soul' && (
          <SoulTab
            profiles={profiles}
            selected={selected}
            setSelected={setSelected}
            running={running}
            onRun={runBatch}
          />
        )}
        {tab === 'update' && <UpdateTab />}
      </div>
    </PageContainer>
  );
}

// ── Gateway Tab ──────────────────────────────────────────────────────────

function formatUptime(startedAt: number | null): string {
  if (!startedAt) return '-';
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - startedAt));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时 ${minutes % 60} 分`;
  const days = Math.floor(hours / 24);
  return `${days} 天 ${hours % 24} 小时`;
}

const ACTION_IN_PROGRESS: Record<'start' | 'stop' | 'restart', string> = {
  start: '正在启动',
  stop: '正在停止',
  restart: '正在重启',
};

function GatewayTab({
  onRun,
}: {
  onRun: RunBatch;
}) {
  const [statuses, setStatuses] = useState<GatewayStatus[]>([]);
  const [loading, setLoading] = useState(false);
  const [operating, setOperating] = useState<Record<string, 'start' | 'stop' | 'restart'>>({});

  const markOperating = (profiles: string[], action: 'start' | 'stop' | 'restart') => {
    setOperating((prev) => {
      const next = { ...prev };
      for (const p of profiles) next[p] = action;
      return next;
    });
  };
  const clearOperating = (profiles: string[]) => {
    setOperating((prev) => {
      const next = { ...prev };
      for (const p of profiles) delete next[p];
      return next;
    });
  };

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.gatewayStatus();
      setStatuses(all);
    } catch {
      setStatuses([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doAction = async (action: 'start' | 'stop' | 'restart', label: string) => {
    const profiles = statuses.map((s) => s.profile);
    markOperating(profiles, action);
    try {
      await onRun(label, () => api.adminGatewayBatch(action, profiles));
    } finally {
      clearOperating(profiles);
    }
    await loadStatus();
  };

  const doSingle = async (profile: string, action: 'start' | 'stop' | 'restart') => {
    markOperating([profile], action);
    try {
      await onRun(`Profile ${profile} ${action === 'start' ? '启动' : action === 'stop' ? '停止' : '重启'}`, async () => {
        if (action === 'start') {
          await api.gatewayStart(profile);
        } else if (action === 'stop') {
          await api.gatewayStop(profile);
        } else {
          await api.gatewayRestart(profile);
        }
        return [{ profile, success: true, message: '完成' }];
      });
    } finally {
      clearOperating([profile]);
    }
    await loadStatus();
  };

  const runningCount = statuses.filter((s) => s.running).length;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <Play className="h-4 w-4 text-muted-foreground" />
            Gateway 状态
            <span className="text-xs font-normal text-muted-foreground">
              共 {statuses.length} 个 · {runningCount} 个运行中
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction('start', '全部启动')}
              disabled={Object.keys(operating).length > 0 || statuses.length === 0}
              className="text-success border-success/30 hover:bg-success/10"
            >
              <Play className="mr-1 h-3.5 w-3.5" /> 全部启动
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction('stop', '全部停止')}
              disabled={Object.keys(operating).length > 0 || statuses.length === 0}
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
            >
              <Square className="mr-1 h-3.5 w-3.5" /> 全部停止
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction('restart', '全部重启')}
              disabled={Object.keys(operating).length > 0 || statuses.length === 0}
            >
              <RotateCw className="mr-1 h-3.5 w-3.5" /> 全部重启
            </Button>
            <Button variant="ghost" size="sm" onClick={loadStatus} disabled={loading}>
              <RotateCw className="mr-1 h-3.5 w-3.5" /> 刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loading className="py-8" />
          ) : (
            <div className="rounded-lg border border-border overflow-hidden">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Profile</TableHead>
                    <TableHead>状态</TableHead>
                    <TableHead>PID</TableHead>
                    <TableHead>运行时间</TableHead>
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statuses.map((s) => (
                    <TableRow key={s.profile}>
                      <TableCell className="font-mono text-xs">{s.profile}</TableCell>
                      <TableCell>
                        {operating[s.profile] ? (
                          <Badge variant="outline" className="border-transparent bg-primary/10 text-primary">
                            <RotateCw className="mr-1 h-3 w-3 animate-spin" />
                            {ACTION_IN_PROGRESS[operating[s.profile]]}
                          </Badge>
                        ) : s.running ? (
                          <Badge variant="outline" className="status-success border-transparent">运行中</Badge>
                        ) : (
                          <Badge variant="outline" className="status-destructive border-transparent">已停止</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {s.pid ?? '-'}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {formatUptime(s.started_at)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {s.running ? (
                            <Button
                              size="sm"
                              onClick={() => doSingle(s.profile, 'stop')}
                              disabled={Boolean(operating[s.profile])}
                              className="bg-destructive hover:bg-destructive/90 text-destructive-foreground"
                            >
                              <Square className="mr-1 h-3.5 w-3.5" /> 停止
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => doSingle(s.profile, 'start')}
                              disabled={Boolean(operating[s.profile])}
                              className="bg-success hover:bg-success/90 text-success-foreground"
                            >
                              <Play className="mr-1 h-3.5 w-3.5" /> 启动
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => doSingle(s.profile, 'restart')}
                            disabled={Boolean(operating[s.profile])}
                          >
                            <RotateCw className="mr-1 h-3.5 w-3.5" /> 重启
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {statuses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                        暂无数据
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── 模型配置 Tab ─────────────────────────────────────────────────────────

function ModelsTab({
  profiles,
  selected,
  setSelected,
  running,
  onRun,
}: {
  profiles: string[];
  selected: string[];
  setSelected: (next: string[]) => void;
  running: boolean;
  onRun: RunBatch;
}) {
  const { toast } = useToast();
  const [source, setSource] = useState('');
  const [scope, setScope] = useState('全部模型配置');

  useEffect(() => {
    if (!source && profiles.length > 0) {
      setSource(profiles[0]);
    }
  }, [profiles, source]);

  const profileOptions = profiles.map((p) => ({ label: p, value: p }));

  const handleSync = () => {
    if (!source) {
      toast({ variant: 'destructive', title: '未选择源 profile' });
      return;
    }
    if (selected.length === 0) {
      toast({ variant: 'destructive', title: '未选择目标 profile', description: '请先选择要覆盖的 profile' });
      return;
    }
    const sections = MODELS_SCOPE.find((o) => o.label === scope)?.sections ?? MODEL_COPY_SECTIONS;
    onRun('同步模型配置', () => api.adminModelsCopy(selected, source, sections));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            模型配置
            <span className="text-xs font-normal text-muted-foreground">将源 profile 的模型配置复制到目标 profile</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-3">
          <div className="grid gap-2">
            <span className="text-sm text-muted-foreground">源 Profile</span>
            <Select
              value={source}
              onChange={(v) => setSource(v as string)}
              options={profileOptions}
              style={{ width: '100%' }}
              placeholder="选择源 profile"
            />
          </div>

          <div className="grid gap-2">
            <span className="text-sm text-muted-foreground">目标 Profile</span>
            <Select
              mode="multiple"
              value={selected}
              onChange={(v) => setSelected(v as string[])}
              options={profileOptions}
              style={{ width: '100%' }}
              placeholder="选择目标 profile"
              allowClear
            />
          </div>

          <div className="grid gap-2">
            <span className="text-sm text-muted-foreground">同步范围</span>
            <Select
              value={scope}
              onChange={(v) => setScope(v as string)}
              options={MODELS_SCOPE.map((o) => ({ label: o.label, value: o.label }))}
              style={{ width: '100%' }}
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSync} disabled={running || !source || selected.length === 0} size="lg">
              <Cpu className="mr-2 h-4 w-4" />
              同步到 {selected.length} 个 profile
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── SOUL Tab ─────────────────────────────────────────────────────────────

function SoulTab({
  profiles,
  selected,
  setSelected,
  running,
  onRun,
}: {
  profiles: string[];
  selected: string[];
  setSelected: (next: string[]) => void;
  running: boolean;
  onRun: RunBatch;
}) {
  const { toast } = useToast();
  const [source, setSource] = useState('');
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (!source && profiles.length > 0) {
      setSource(profiles[0]);
    }
  }, [profiles, source]);

  const profileOptions = profiles.map((p) => ({ label: p, value: p }));

  const handleSync = async () => {
    if (!source) {
      toast({ variant: 'destructive', title: '未选择源 profile' });
      return;
    }
    if (selected.length === 0) {
      toast({ variant: 'destructive', title: '未选择目标 profile', description: '请先选择要覆盖的 profile' });
      return;
    }
    setSyncing(true);
    try {
      const { data } = await apiClient.get<{ files: Array<{ name: string; content: string }> }>(
        '/profile-files',
        { params: { profile: source } },
      );
      const soul = data.files.find((f) => f.name === 'SOUL.md');
      if (!soul?.content) {
        toast({ variant: 'destructive', title: '源 profile 无 SOUL.md 内容' });
        return;
      }
      await onRun('同步 SOUL.md', () => api.adminSoulBatch(selected, soul.content));
    } catch {
      toast({ variant: 'destructive', title: '载入失败', description: '请稍后重试' });
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <FileText className="h-4 w-4 text-muted-foreground" />
            SOUL.md
            <span className="text-xs font-normal text-muted-foreground">将源 profile 的 SOUL.md 覆盖到目标 profile</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-3">
          <div className="grid gap-2">
            <span className="text-sm text-muted-foreground">源 Profile</span>
            <Select
              value={source}
              onChange={(v) => setSource(v as string)}
              options={profileOptions}
              style={{ width: '100%' }}
              placeholder="选择源 profile"
            />
          </div>

          <div className="grid gap-2">
            <span className="text-sm text-muted-foreground">目标 Profile</span>
            <Select
              mode="multiple"
              value={selected}
              onChange={(v) => setSelected(v as string[])}
              options={profileOptions}
              style={{ width: '100%' }}
              placeholder="选择目标 profile"
              allowClear
            />
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSync} disabled={running || syncing || !source || selected.length === 0} size="lg">
              <FileText className="mr-2 h-4 w-4" />
              同步到 {selected.length} 个 profile
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

// ── Hermes 更新 Tab ──────────────────────────────────────────────────────

interface UpdateInfo {
  current_version: string;
  latest_version: string | null;
  latest_version_tag?: string;
  release_notes?: string;
  published_at?: string;
  release_url?: string;
  check_output?: string;
  has_update: boolean;
  error?: string;
}

interface UpgradeStatus {
  running: boolean;
  success: boolean | null;
  started_at: number | null;
  finished_at: number | null;
  output: string;
}

function UpdateTab() {
  const { toast } = useToast();
  const [checking, setChecking] = useState(false);
  const [info, setInfo] = useState<UpdateInfo | null>(null);
  const [polling, setPolling] = useState(false);
  const [status, setStatus] = useState<UpgradeStatus | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    try {
      const data = await api.checkHermesUpdate();
      setInfo(data);
    } catch (error: any) {
      toast({ variant: 'destructive', title: '检查更新失败', description: error?.message || '请稍后重试' });
    } finally {
      setChecking(false);
    }
  }, [toast]);

  useEffect(() => {
    check();
  }, [check]);

  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(async () => {
      try {
        const s = await api.hermesUpgradeStatus();
        setStatus(s);
        if (!s.running) {
          setPolling(false);
          if (s.success) {
            toast({ title: '升级完成', description: 'Hermes 已更新到最新版本' });
          } else {
            toast({ variant: 'destructive', title: '升级失败', description: '请查看下方日志排查' });
          }
          check();
        }
      } catch {
        // 轮询失败忽略，下一次继续
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [polling, toast, check]);

  const upgrade = async () => {
    try {
      const res = await api.startHermesUpgrade();
      if (!res.success) {
        toast({ variant: 'destructive', title: '升级未启动', description: res.message });
        return;
      }
      toast({ title: '升级', description: res.message });
      setStatus({ running: true, success: null, started_at: Date.now() / 1000, finished_at: null, output: '' });
      setPolling(true);
    } catch (error: any) {
      toast({ variant: 'destructive', title: '升级失败', description: error?.message || '请稍后重试' });
    }
  };

  const inProgress = polling || Boolean(status?.running);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Upload className="h-4 w-4 text-muted-foreground" />
            Hermes 版本
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4 pt-3">
          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs text-muted-foreground mb-1">当前版本</div>
              <div className="text-lg font-semibold font-mono">{info?.current_version ?? '—'}</div>
            </div>
            <div className="rounded-lg border border-border p-4">
              <div className="text-xs text-muted-foreground mb-1">最新版本</div>
              <div className="text-lg font-semibold font-mono">{info?.latest_version ?? '—'}</div>
            </div>
          </div>

          {info && !info.error && (
            <div className="flex items-center gap-2">
              {info.has_update ? (
                <Badge variant="outline" className="border-transparent bg-primary/10 text-primary">有可用更新</Badge>
              ) : (
                <Badge variant="outline" className="border-transparent bg-success/15 text-success">已是最新版本</Badge>
              )}
              {info.release_url && (
                <a href={info.release_url} target="_blank" rel="noreferrer" className="text-xs text-primary hover:underline">
                  查看 Release
                </a>
              )}
            </div>
          )}

          {info?.error && (
            <Badge variant="outline" className="border-transparent bg-destructive/15 text-destructive">{info.error}</Badge>
          )}

          {info?.release_notes && (
            <div className="rounded-lg border border-border p-4 max-h-48 overflow-auto">
              <pre className="whitespace-pre-wrap text-xs text-muted-foreground">{info.release_notes}</pre>
            </div>
          )}

          <div className="flex gap-2">
            <Button variant="outline" onClick={check} disabled={checking || inProgress}>
              <RotateCw className={`mr-2 h-4 w-4 ${checking ? 'animate-spin' : ''}`} />
              检查更新
            </Button>
            <Button onClick={upgrade} disabled={!info?.has_update || inProgress}>
              <Upload className="mr-2 h-4 w-4" />
              {inProgress ? '升级中…' : '升级到最新版'}
            </Button>
          </div>
        </CardContent>
      </Card>

      {(inProgress || status?.output) && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm flex items-center gap-2">
              <RotateCw className={`h-4 w-4 text-muted-foreground ${inProgress ? 'animate-spin' : ''}`} />
              升级日志
            </CardTitle>
          </CardHeader>
          <CardContent className="pt-3">
            <div className="rounded-lg bg-black/90 p-4 max-h-96 overflow-auto">
              <pre className="text-xs text-green-400 whitespace-pre-wrap font-mono">
                {status?.output || (inProgress ? '升级中，正在拉取更新…' : '')}
              </pre>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
