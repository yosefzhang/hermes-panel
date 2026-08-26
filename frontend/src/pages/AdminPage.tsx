import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownUp,
  Brain,
  ChevronDown,
  ChevronUp,
  Cpu,
  FileText,
  Play,
  RotateCw,
  Server,
  ShieldCheck,
  Square,
  Star,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { useToast } from '@/hooks/use-toast';
import { api, apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';

type TabKey = 'gateway' | 'models' | 'soul';

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
}

type RunBatch = (label: string, fn: () => Promise<BatchResult[]>) => Promise<void>;

// 辅助模型子模块（与 Hermes CLI 完整清单对齐，中文(英文)）
const AUX_LABELS: Record<string, string> = {
  vision: '视觉分析(Vision)',
  compression: '上下文压缩(Compression)',
  web_extract: '网页提取(Web Extract)',
  approval: '命令审批(Approval)',
  mcp: 'MCP 管理(MCP)',
  title_generation: '标题生成(Title Generation)',
  memory_query_rewrite: '记忆查询重写(Memory Query Rewrite)',
  tts_audio_tags: 'TTS 标签(TTS Audio Tags)',
  skills_hub: '技能中心(Skills Hub)',
  triage_specifier: '看板分诊指定(Triage Specifier)',
  kanban_decomposer: '看板任务分解(Kanban Decomposer)',
  profile_describer: 'Profile 描述(Profile Describer)',
  curator: '后台维护(Curator)',
};

const AUX_KEYS = Object.keys(AUX_LABELS);

// ── Profile 多选 chip ────────────────────────────────────────────────────

function ProfilePicker({
  profiles,
  selected,
  onChange,
}: {
  profiles: string[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const toggle = (p: string) => {
    onChange(selected.includes(p) ? selected.filter((x) => x !== p) : [...selected, p]);
  };
  const allSelected = profiles.length > 0 && selected.length === profiles.length;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          已选 {selected.length} / {profiles.length} 个 profile
        </span>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(allSelected ? [] : [...profiles])}
        >
          {allSelected ? '清空' : '全选'}
        </Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {profiles.map((p) => {
          const active = selected.includes(p);
          return (
            <button
              key={p}
              type="button"
              onClick={() => toggle(p)}
              className={[
                'px-3 py-1.5 rounded-full text-xs font-medium border transition-all duration-150',
                active
                  ? 'bg-violet-600 text-white border-violet-600 shadow-sm'
                  : 'bg-card text-muted-foreground border-border hover:border-violet-300 hover:text-foreground',
              ].join(' ')}
            >
              {p}
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── 结果表 ───────────────────────────────────────────────────────────────

function ResultTable({ results }: { results: BatchResult[] }) {
  if (results.length === 0) return null;
  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Profile</TableHead>
            <TableHead>状态</TableHead>
            <TableHead>说明</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {results.map((r) => (
            <TableRow key={r.profile}>
              <TableCell className="font-mono text-xs">{r.profile}</TableCell>
              <TableCell>
                {r.success ? (
                  <Badge className="bg-green-100 text-green-700">成功</Badge>
                ) : (
                  <Badge className="bg-red-100 text-red-700">失败</Badge>
                )}
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{r.message}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

// ── 主组件 ───────────────────────────────────────────────────────────────

export default function AdminPage() {
  const { toast } = useToast();
  const { profiles, loadProfiles } = useConfigStore();
  const [tab, setTab] = useState<TabKey>('gateway');
  const [selected, setSelected] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<BatchResult[]>([]);

  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);

  const runBatch: RunBatch = useCallback(
    async (label, fn) => {
      if (selected.length === 0) {
        toast({ variant: 'destructive', title: '未选择 profile', description: '请先勾选目标 profile' });
        return;
      }
      setRunning(true);
      setResults([]);
      try {
        const res = await fn();
        setResults(res);
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
    [selected, toast],
  );

  const TABS: Array<{ key: TabKey; label: string; icon: typeof Cpu }> = [
    { key: 'gateway', label: 'Gateway', icon: Play },
    { key: 'models', label: '模型配置', icon: Cpu },
    { key: 'soul', label: 'SOUL.md', icon: FileText },
  ];

  return (
    <PageContainer>
      <div className="flex items-center gap-2 mb-1">
        <ShieldCheck className="h-5 w-5 text-violet-600" />
        <h2 className="text-xl font-semibold tracking-tight">控制台 · 批量管理</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-6">
        对多个 profile 批量执行统一操作。所有操作写入审计日志，SOUL.md 写入前自动备份。
      </p>

      {/* Tab 切换 */}
      <div className="flex gap-2 mb-6">
        {TABS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            onClick={() => setTab(key)}
            className={[
              'flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-all duration-150 border',
              tab === key
                ? 'bg-violet-600 text-white border-violet-600 shadow-sm'
                : 'bg-card text-muted-foreground border-border hover:text-foreground hover:border-violet-300',
            ].join(' ')}
          >
            <Icon className="h-4 w-4" />
            {label}
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>目标 Profile</CardTitle>
        </CardHeader>
        <CardContent>
          <ProfilePicker profiles={profiles} selected={selected} onChange={setSelected} />
        </CardContent>
      </Card>

      <div className="mt-4">
        {tab === 'gateway' && (
          <GatewayTab
            selected={selected}
            running={running}
            onRun={runBatch}
            results={results}
          />
        )}
        {tab === 'models' && (
          <ModelsTab
            profiles={profiles}
            selected={selected}
            running={running}
            onRun={runBatch}
            results={results}
          />
        )}
        {tab === 'soul' && (
          <SoulTab
            profiles={profiles}
            selected={selected}
            running={running}
            onRun={runBatch}
            results={results}
          />
        )}
      </div>
    </PageContainer>
  );
}

// ── Gateway Tab ──────────────────────────────────────────────────────────

function GatewayTab({
  selected,
  running,
  onRun,
  results,
}: {
  selected: string[];
  running: boolean;
  onRun: RunBatch;
  results: BatchResult[];
}) {
  const [statuses, setStatuses] = useState<GatewayStatus[]>([]);
  const [loading, setLoading] = useState(false);

  const loadStatus = useCallback(async () => {
    setLoading(true);
    try {
      const all = await api.gatewayStatus();
      setStatuses(all.filter((s) => selected.includes(s.profile)));
    } catch {
      setStatuses([]);
    } finally {
      setLoading(false);
    }
  }, [selected]);

  useEffect(() => {
    loadStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const doAction = async (action: 'start' | 'stop' | 'restart', label: string) => {
    await onRun(label, () => api.adminGatewayBatch(action, selected));
    await loadStatus();
  };

  const doSingle = async (profile: string, action: 'start' | 'stop' | 'restart') => {
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
              已选 {selected.length} 个 · {runningCount} 个运行中
            </span>
          </CardTitle>
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction('start', '全部启动')}
              disabled={running || selected.length === 0}
              className="text-green-600 border-green-300 hover:bg-green-50"
            >
              <Play className="mr-1 h-3.5 w-3.5" /> 全部启动
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction('stop', '全部停止')}
              disabled={running || selected.length === 0}
              className="text-red-600 border-red-300 hover:bg-red-50"
            >
              <Square className="mr-1 h-3.5 w-3.5" /> 全部停止
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => doAction('restart', '全部重启')}
              disabled={running || selected.length === 0}
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
                    <TableHead className="text-right">操作</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {statuses.map((s) => (
                    <TableRow key={s.profile}>
                      <TableCell className="font-mono text-xs">{s.profile}</TableCell>
                      <TableCell>
                        {s.running ? (
                          <Badge className="bg-green-100 text-green-700">运行中</Badge>
                        ) : (
                          <Badge className="bg-gray-100 text-gray-600">已停止</Badge>
                        )}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-muted-foreground">
                        {s.pid ?? '-'}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {s.running ? (
                            <Button
                              size="sm"
                              onClick={() => doSingle(s.profile, 'stop')}
                              disabled={running}
                              className="bg-red-600 hover:bg-red-700 text-white"
                            >
                              <Square className="mr-1 h-3.5 w-3.5" /> 停止
                            </Button>
                          ) : (
                            <Button
                              size="sm"
                              onClick={() => doSingle(s.profile, 'start')}
                              disabled={running}
                              className="bg-green-600 hover:bg-green-700 text-white"
                            >
                              <Play className="mr-1 h-3.5 w-3.5" /> 启动
                            </Button>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => doSingle(s.profile, 'restart')}
                            disabled={running}
                          >
                            <RotateCw className="mr-1 h-3.5 w-3.5" /> 重启
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                  {statuses.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="text-center text-muted-foreground py-8">
                        未选择 profile
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
      <ResultTable results={results} />
    </div>
  );
}

// ── 模型配置 Tab ─────────────────────────────────────────────────────────

interface ProviderOpt {
  label: string;
  value: string;
}

function ModelsTab({
  profiles,
  selected,
  running,
  onRun,
  results,
}: {
  profiles: string[];
  selected: string[];
  running: boolean;
  onRun: RunBatch;
  results: BatchResult[];
}) {
  const { toast } = useToast();
  const [providers, setProviders] = useState<ProviderOpt[]>([]);
  // 参考 profile（用于加载 provider 下拉列表）
  const refProfile = selected[0] || 'default';

  // 各子项展开状态
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  // 主模型
  const [mainProvider, setMainProvider] = useState('');
  const [mainModel, setMainModel] = useState('');
  const [mainContext, setMainContext] = useState('');
  // 供应商（JSON）
  const [providersJson, setProvidersJson] = useState('');
  // 辅助模型
  const [auxForm, setAuxForm] = useState<Record<string, { provider: string; model: string }>>({});
  // 回退模型
  const [fallbackItems, setFallbackItems] = useState<Array<{ key: string; provider: string; model: string }>>([]);
  // 多智能体（JSON）
  const [moaJson, setMoaJson] = useState('');

  const loadProviders = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ providers: Array<{ name: string; display_name?: string; source: string }> }>(
        '/models/providers',
        { params: { profile: refProfile } },
      );
      setProviders(
        (data.providers ?? []).map((p) => ({
          label: p.display_name || p.name,
          value: p.source === 'custom' ? `custom:${p.name}` : p.name,
        })),
      );
    } catch {
      setProviders([]);
    }
  }, [refProfile]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const toggleExpand = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const updateAux = (key: string, patch: Partial<{ provider: string; model: string }>) => {
    setAuxForm((prev) => {
      const existing = prev[key] ?? { provider: '', model: '' };
      return { ...prev, [key]: { ...existing, ...patch } };
    });
  };

  const addFallbackRow = () => {
    setFallbackItems((prev) => [...prev, { key: `fb-${Date.now()}-${prev.length}`, provider: '', model: '' }]);
  };
  const removeFallbackRow = (key: string) => {
    setFallbackItems((prev) => prev.filter((r) => r.key !== key));
  };
  const updateFallbackRow = (key: string, patch: Partial<{ provider: string; model: string }>) => {
    setFallbackItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const ProviderSelect = ({ value, onChange, placeholder = '选择供应商' }: { value: string; onChange: (v: string) => void; placeholder?: string }) => (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger className="h-8">
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent>
        {providers.map((opt) => (
          <SelectItem key={opt.value} value={opt.value}>
            {opt.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );

  const handleApply = () => {
    const values: Record<string, unknown> = {};

    // 主模型
    if (mainProvider || mainModel) {
      values.model = {
        provider: mainProvider || undefined,
        default: mainModel || undefined,
        context_length: mainContext ? Number(mainContext) || undefined : undefined,
      };
    }
    // 供应商
    if (providersJson.trim()) {
      try {
        values.custom_providers = JSON.parse(providersJson);
      } catch {
        toast({ variant: 'destructive', title: '供应商 JSON 格式错误' });
        return;
      }
    }
    // 辅助模型
    const auxEntries = Object.entries(auxForm).filter(([, v]) => v.provider || v.model);
    if (auxEntries.length > 0) {
      const aux: Record<string, unknown> = {};
      auxEntries.forEach(([k, v]) => {
        aux[k] = { provider: v.provider || undefined, model: v.model || undefined };
      });
      values.auxiliary = aux;
    }
    // 回退模型
    const fb = fallbackItems.filter((r) => r.provider || r.model).map((r) => ({ provider: r.provider, model: r.model }));
    if (fb.length > 0) {
      values.fallback_providers = fb;
    }
    // 多智能体
    if (moaJson.trim()) {
      try {
        values.moa = JSON.parse(moaJson);
      } catch {
        toast({ variant: 'destructive', title: '多智能体 JSON 格式错误' });
        return;
      }
    }

    if (Object.keys(values).length === 0) {
      toast({ variant: 'destructive', title: '未配置任何子项', description: '请至少配置一个子项后再应用' });
      return;
    }

    onRun('批量应用模型配置', () => api.adminModelsSet(selected, values));
  };

  // 每个子项：图标 + 标题 + 摘要 + 展开按钮
  const SectionRow = ({
    icon: Icon,
    title,
    summary,
    itemKey,
  }: {
    icon: typeof Star;
    title: string;
    summary: string;
    itemKey: string;
  }) => (
    <button
      type="button"
      onClick={() => toggleExpand(itemKey)}
      className="w-full flex items-center justify-between gap-3 px-3 py-2 bg-muted/20 border border-border/50 rounded-lg text-left hover:bg-muted/30 transition-colors"
    >
      <div className="flex items-center gap-2 min-w-0">
        <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium">{title}</span>
        <span className="text-xs font-mono text-muted-foreground truncate">{summary || '(未配置)'}</span>
      </div>
      {expanded[itemKey] ? (
        <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground" />
      ) : (
        <ChevronDown className="h-4 w-4 shrink-0 text-muted-foreground" />
      )}
    </button>
  );

  const mainSummary = [mainProvider, mainModel].filter(Boolean).join(' · ');
  const auxSummary = `${Object.values(auxForm).filter((v) => v.provider || v.model).length}/${AUX_KEYS.length} 个子模块`;
  const fbSummary = `${fallbackItems.filter((r) => r.provider || r.model).length} 条回退`;
  const provSummary = providersJson.trim() ? '已填写 JSON' : '';
  const moaSummary = moaJson.trim() ? '已填写 JSON' : '';

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2">
            <Cpu className="h-4 w-4 text-muted-foreground" />
            Model Settings
            <span className="text-xs font-normal text-muted-foreground">配置后一键应用到选中 profile</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 pt-3">
          {/* 主模型 */}
          <SectionRow icon={Star} title="主模型" summary={mainSummary} itemKey="main" />
          {expanded.main && (
            <div className="grid gap-3 px-3 py-3 border border-border/50 rounded-lg bg-background">
              <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                <Label className="text-xs">供应商</Label>
                <ProviderSelect value={mainProvider} onChange={setMainProvider} />
              </div>
              <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                <Label className="text-xs">模型</Label>
                <Input
                  className="h-8 font-mono text-sm"
                  value={mainModel}
                  onChange={(e) => setMainModel(e.target.value)}
                  placeholder="例如：deepseek-v4-flash"
                />
              </div>
              <div className="grid grid-cols-[120px_1fr] items-center gap-2">
                <Label className="text-xs">上下文长度</Label>
                <Input
                  className="h-8 font-mono text-sm"
                  value={mainContext}
                  onChange={(e) => setMainContext(e.target.value)}
                  placeholder="例如：1000000（可选）"
                />
              </div>
            </div>
          )}

          {/* 供应商 */}
          <SectionRow icon={Server} title="供应商" summary={provSummary} itemKey="providers" />
          {expanded.providers && (
            <div className="grid gap-3 px-3 py-3 border border-border/50 rounded-lg bg-background">
              <Label className="text-xs">供应商列表（JSON，custom_providers 结构）</Label>
              <Textarea
                className="font-mono text-xs"
                rows={8}
                value={providersJson}
                onChange={(e) => setProvidersJson(e.target.value)}
                placeholder={'[\n  { "name": "MyProvider", "base_url": "https://...", "key_env": "MY_API_KEY" }\n]'}
              />
            </div>
          )}

          {/* 辅助模型 */}
          <SectionRow icon={Cpu} title="辅助模型" summary={auxSummary} itemKey="aux" />
          {expanded.aux && (
            <div className="grid gap-2 px-3 py-3 border border-border/50 rounded-lg bg-background">
              {AUX_KEYS.map((key) => {
                const item = auxForm[key] || { provider: '', model: '' };
                return (
                  <div key={key} className="grid grid-cols-[180px_1fr_1fr] items-center gap-2">
                    <span className="text-xs text-muted-foreground">{AUX_LABELS[key]}</span>
                    <ProviderSelect
                      value={item.provider}
                      onChange={(v) => updateAux(key, { provider: v })}
                    />
                    <Input
                      className="h-8 font-mono text-sm"
                      value={item.model}
                      onChange={(e) => updateAux(key, { model: e.target.value })}
                      placeholder="模型名（留空则用 provider 默认）"
                    />
                  </div>
                );
              })}
            </div>
          )}

          {/* 回退模型 */}
          <SectionRow icon={ArrowDownUp} title="回退模型" summary={fbSummary} itemKey="fallback" />
          {expanded.fallback && (
            <div className="grid gap-3 px-3 py-3 border border-border/50 rounded-lg bg-background">
              <div className="flex justify-end">
                <Button variant="outline" size="sm" onClick={addFallbackRow}>
                  新增一行
                </Button>
              </div>
              {fallbackItems.map((row) => (
                <div key={row.key} className="grid grid-cols-[1fr_1fr_40px] items-center gap-2">
                  <ProviderSelect
                    value={row.provider}
                    onChange={(v) => updateFallbackRow(row.key, { provider: v })}
                  />
                  <Input
                    className="h-8 font-mono text-sm"
                    value={row.model}
                    onChange={(e) => updateFallbackRow(row.key, { model: e.target.value })}
                    placeholder="模型名"
                  />
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeFallbackRow(row.key)}
                    className="text-red-500"
                  >
                    ✕
                  </Button>
                </div>
              ))}
              {fallbackItems.length === 0 && (
                <div className="text-xs text-muted-foreground text-center py-4">暂无回退模型，点击"新增一行"添加</div>
              )}
            </div>
          )}

          {/* 多智能体 */}
          <SectionRow icon={Brain} title="多智能体" summary={moaSummary} itemKey="moa" />
          {expanded.moa && (
            <div className="grid gap-3 px-3 py-3 border border-border/50 rounded-lg bg-background">
              <Label className="text-xs">MoA 配置（JSON，moa 结构）</Label>
              <Textarea
                className="font-mono text-xs"
                rows={8}
                value={moaJson}
                onChange={(e) => setMoaJson(e.target.value)}
                placeholder={'{\n  "default_preset": "...",\n  "presets": { ... }\n}'}
              />
            </div>
          )}

          {/* 一键应用 */}
          <div className="flex justify-end pt-2">
            <Button onClick={handleApply} disabled={running || selected.length === 0} size="lg">
              一键应用到 {selected.length} 个 profile
            </Button>
          </div>
        </CardContent>
      </Card>
      <ResultTable results={results} />
    </div>
  );
}

// ── SOUL Tab ─────────────────────────────────────────────────────────────

function SoulTab({
  profiles,
  selected,
  running,
  onRun,
  results,
}: {
  profiles: string[];
  selected: string[];
  running: boolean;
  onRun: RunBatch;
  results: BatchResult[];
}) {
  const { toast } = useToast();
  const [content, setContent] = useState('');
  const [loadFrom, setLoadFrom] = useState<string>('');
  const [loadingSoul, setLoadingSoul] = useState(false);

  const loadSoul = async (profile: string) => {
    if (!profile) return;
    setLoadingSoul(true);
    try {
      const { data } = await apiClient.get<{ files: Array<{ name: string; content: string }> }>(
        '/profile-files',
        { params: { profile } },
      );
      const soul = data.files.find((f) => f.name === 'SOUL.md');
      setContent(soul?.content || '');
      toast({ title: '已载入', description: `${profile} 的 SOUL.md 内容已填入编辑器` });
    } catch {
      toast({ variant: 'destructive', title: '载入失败', description: '请稍后重试' });
    } finally {
      setLoadingSoul(false);
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>SOUL.md 批量覆盖</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div>
            <div className="text-sm font-medium mb-2">从 Profile 载入现有内容（可选）</div>
            <div className="flex flex-wrap items-center gap-2">
              {profiles.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => setLoadFrom(p)}
                  className={[
                    'px-3 py-1.5 rounded-full text-xs font-medium border transition-all',
                    loadFrom === p
                      ? 'bg-violet-600 text-white border-violet-600'
                      : 'bg-card text-muted-foreground border-border hover:border-violet-300',
                  ].join(' ')}
                >
                  {p}
                </button>
              ))}
              <Button
                variant="outline"
                size="sm"
                onClick={() => loadSoul(loadFrom)}
                disabled={!loadFrom || loadingSoul}
              >
                载入
              </Button>
            </div>
          </div>

          <div>
            <div className="text-sm font-medium mb-2">SOUL.md 内容</div>
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={20}
              className="font-mono text-sm"
              placeholder="在此输入新的 SOUL.md 内容，将覆盖所有选中 profile 的 SOUL.md..."
            />
          </div>

          <Button
            onClick={() => onRun('批量更新 SOUL.md', () => api.adminSoulBatch(selected, content))}
            disabled={running || selected.length === 0 || !content}
          >
            <FileText className="mr-2 h-4 w-4" />
            覆盖到 {selected.length} 个 profile
          </Button>
        </CardContent>
      </Card>
      <ResultTable results={results} />
    </div>
  );
}
