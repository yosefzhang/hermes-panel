import { useCallback, useEffect, useState } from 'react';
import { Cpu, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select } from 'antd';
import { useToast } from '@/hooks/use-toast';
import { api, apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';

type TabKey = 'models' | 'soul';

interface BatchResult {
  profile: string;
  success: boolean;
  message: string;
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
  const [tab, setTab] = useState<TabKey>('models');
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
    { key: 'models', label: '模型配置' },
    { key: 'soul', label: 'SOUL.md' },
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
      </div>
    </PageContainer>
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
  const [scope, setScope] = useState<string[]>(['全部模型配置']);

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
    const scopes = MODELS_SCOPE.filter((o) => scope.includes(o.label));
    const sections = [...new Set(scopes.flatMap((o) => o.sections))];
    if (sections.length === 0) {
      toast({ variant: 'destructive', title: '未选择同步范围', description: '请至少选择一个同步范围' });
      return;
    }
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
            <span className="text-sm text-muted-foreground">同步范围（可多选）</span>
            <Select
              mode="multiple"
              value={scope}
              onChange={(v) => setScope(v as string[])}
              options={MODELS_SCOPE.map((o) => ({ label: o.label, value: o.label }))}
              style={{ width: '100%' }}
              allowClear
              placeholder="选择要同步的配置范围"
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