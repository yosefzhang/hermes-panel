import { useCallback, useEffect, useState } from 'react';
import ReactECharts from 'echarts-for-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Plus, Trash2, Pencil, Brain, ChevronDown, ChevronUp } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';

// 导出 ProviderPreset 接口供其他组件使用
export interface ProviderPreset {
  id: string;
  name: string;
  base_url: string;
  base_url_env_var: string;
  transport: string;
  auth_type: string;
  key_env: string;
}

interface ModelsData {
  model: {
    default?: string;
    provider?: string;
    base_url?: string;
    context_length?: number;
  };
  auxiliary: Record<string, any>;
  fallback_providers: Array<{ provider: string; model: string }>;
  custom_providers: Array<{
    name: string;
    base_url?: string;
    key_env?: string;
    api_key?: string;
    api_mode?: string;
    default_model?: string;
    model?: string;
    context_length?: number;
    rate_limit_delay?: number;
    models?: Record<string, { context_length?: number }>;
  }>;
  providers: Record<string, unknown>;
  models: Record<string, { context_length?: number }>;
  model_catalog: { enabled?: boolean; url?: string; ttl_hours?: number };
  moa: {
    default_preset?: string;
    save_traces?: boolean;
    trace_dir?: string;
    privacy_filter?: string;
    presets?: Record<string, any>;
  };
}

interface ProviderInfo {
  name: string;
  display_name?: string;
  source: 'main' | 'custom' | 'env';
  base_url: string;
  key_env: string;
  api_key?: string;
  api_mode?: string;
  default_model?: string;
  context_length?: number;
  rate_limit_delay?: number;
  has_key: boolean;
}

// api_mode 可选值（可留空，由 Hermes 自行处理）
const API_MODE_OPTIONS = [
  { value: 'chat_completions', label: 'chat_completions' },
  { value: 'anthropic_messages', label: 'anthropic_messages' },
  { value: 'codex_responses', label: 'codex_responses' },
  { value: 'bedrock_converse', label: 'bedrock_converse' },
  { value: 'codex_app_server', label: 'codex_app_server' },
];

const AUX_LABELS: Record<string, string> = {
  vision: '视觉分析',
  compression: '上下文压缩',
  web_extract: '网页提取',
  approval: '命令审批',
  mcp: 'MCP 管理',
  skills_hub: '技能中心',
  title_generation: '标题生成',
  tts_audio_tags: 'TTS 标签',
  curator: '后台维护',
};

function ProvidersTab({
  activeProfile,
  onReload,
  modelsData,
}: {
  activeProfile: string;
  onReload: () => void;
  modelsData?: ModelsData | null;
}) {
  const { toast } = useToast();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [customItems, setCustomItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editData, setEditData] = useState<any>(null);
  // ── 新增流程（预设 / 自定义） ──
  const [createOpen, setCreateOpen] = useState(false);
  const [createMode, setCreateMode] = useState<'preset' | 'custom'>('preset');
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [createData, setCreateData] = useState<any>({
    provider_name: '',   // 预设模式下选的 provider
    name: '',
    key_env_var: '',
    key_value: '',
    base_url: '',
    api_mode: '',
    default_model: '',
    context_length: '',
    rate_limit_delay: '',
  });
  const [savingCreate, setSavingCreate] = useState(false);
  // ── 独立 Model List 卡片（按供应商分别获取）──
  const [providerModels, setProviderModels] = useState<Record<string, Array<{
    id: string;
    name?: string;
    owned_by?: string;
    context_length?: number | null;
    output_length?: number | null;
    created?: number | null;
    multimodal?: boolean;
    provider: string;
  }>>>({});
  const [providerModelErrors, setProviderModelErrors] = useState<Record<string, string>>({});
  const [providerLoadingModels, setProviderLoadingModels] = useState<Record<string, boolean>>({});
  const [providerExpanded, setProviderExpanded] = useState<Record<string, boolean>>({});
  const [allModelsLoading, setAllModelsLoading] = useState(false);

  const loadData = useCallback(
    async (force = false) => {
      setLoading(true);
      try {
        const [{ data: provData }, { data: presetData }] = await Promise.all([
          apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
            params: { profile: activeProfile },
            ...(force ? { refresh: true } : {}),
          }),
          apiClient.get<{ presets: ProviderPreset[] }>(
            '/models/provider-presets',
            force ? { refresh: true } : undefined,
          ),
        ]);
        setProviders(provData.providers ?? []);
        setPresets(presetData.presets ?? []);
        // 复用父组件已获取的 /models 数据；未传入时才回退自行请求
        const resolved =
          modelsData ??
          (await apiClient.get<ModelsData>('/models', {
            params: { profile: activeProfile },
            ...(force ? { refresh: true } : {}),
          })).data;
        setCustomItems((resolved.custom_providers ?? []).map((p) => ({
          ...p,
          name: p.name ?? '',
          base_url: p.base_url ?? '',
          key_env: p.key_env ?? '',
          api_key: p.api_key ?? '',
          api_mode: p.api_mode ?? '',
          default_model: p.default_model ?? p.model ?? '',
          model: p.model ?? '',
          context_length: p.context_length ?? undefined,
          rate_limit_delay: p.rate_limit_delay ?? undefined,
        })));
      } catch {
        toast({
          variant: 'destructive',
          title: '错误',
          description: '加载失败',
        });
      } finally {
        setLoading(false);
      }
    },
    [activeProfile, modelsData, toast],
  );

  useEffect(() => {
    loadData();
  }, [loadData]);

  const saveCustomProviders = async (items: any[]) => {
    try {
      const clean = items
        .filter((item) => item.name && item.base_url)
        .map((item) => ({
          ...item,
          name: item.name?.trim() || '',
          base_url: item.base_url?.trim() || '',
          key_env: item.key_env?.trim() || '',
          api_key: item.api_key || '',
          api_mode: item.api_mode?.trim() || '',
          default_model: item.default_model?.trim() || '',
          model: item.model ?? '',
          context_length:
            item.context_length === '' || item.context_length == null
              ? undefined
              : Number(item.context_length) || undefined,
          rate_limit_delay:
            item.rate_limit_delay === '' || item.rate_limit_delay == null
              ? undefined
              : Number(item.rate_limit_delay) || undefined,
        }));
      await apiClient.put('/models/custom_providers', clean, { params: { profile: activeProfile } });
      toast({
        title: '成功',
        description: '已保存',
      });
      loadData(true);
    } catch {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '保存失败',
      });
    }
  };

  const openCreate = () => {
    setEditIndex(null);
    setCreateMode('preset');
    setCreateData({
      provider_name: '',
      name: '',
      key_env_var: '',
      key_value: '',
      base_url: '',
      api_mode: '',
      default_model: '',
      context_length: '',
      rate_limit_delay: '',
    });
    setCreateOpen(true);
  };

  const openEdit = (row: ProviderInfo) => {
    const idx = customItems.findIndex((c) => c.name === row.name);
    setEditIndex(idx >= 0 ? idx : null);
    setEditData(idx >= 0 ? customItems[idx] : {
      name: row.name,
      base_url: row.base_url,
      key_env: row.key_env,
      api_key: row.api_key ?? '',
      api_mode: row.api_mode || '',
      default_model: row.default_model ?? '',
      context_length: row.context_length ?? '',
      rate_limit_delay: row.rate_limit_delay ?? '',
    });
    setEditOpen(true);
  };

  const handleDelete = async (row: ProviderInfo) => {
    try {
      await apiClient.delete(`/models/providers/${encodeURIComponent(row.name)}`, {
        params: { profile: activeProfile },
      });
      toast({
        title: '成功',
        description: `${row.name} 已删除`,
      });
      await loadData(true);
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: '错误',
        description: error?.response?.data?.detail || '删除失败',
      });
    }
  };

  const handleEditSubmit = async () => {
    if (!editData.name || !editData.base_url) {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '名称和基础地址必填',
      });
      return;
    }

    const next = [...customItems];
    if (editIndex == null) {
      const existingIdx = next.findIndex((item) => item.name === editData.name);
      if (existingIdx >= 0) {
        next[existingIdx] = { ...next[existingIdx], ...editData };
      } else {
        next.push(editData);
      }
    } else {
      next[editIndex] = { ...next[editIndex], ...editData };
    }
    await saveCustomProviders(next);
    setEditOpen(false);
  };

  const handleCreateSubmit = async () => {
    if (createMode === 'preset') {
      if (!createData.provider_name) {
        toast({ variant: 'destructive', title: '错误', description: '请选择供应商预设' });
        return;
      }
    } else {
      if (!createData.name?.trim()) {
        toast({ variant: 'destructive', title: '错误', description: '名称不能为空' });
        return;
      }
      if (!createData.key_env_var?.trim()) {
        toast({ variant: 'destructive', title: '错误', description: '环境变量名不能为空' });
        return;
      }
      if (!createData.base_url?.trim()) {
        toast({ variant: 'destructive', title: '错误', description: '基础地址不能为空' });
        return;
      }
    }

    const payload: any = {
      mode: createMode,
      key_value: createData.key_value || '',
    };
    if (createMode === 'preset') {
      payload.provider_name = createData.provider_name;
      payload.key_env_var = createData.key_env_var || ''; // 预设模式下锁定不可改，后端以 registry 默认为主
      payload.base_url = createData.base_url?.trim() || '';
    } else {
      payload.name = createData.name?.trim() || '';
      payload.key_env_var = createData.key_env_var?.trim() || '';
      payload.base_url = createData.base_url?.trim() || '';
      payload.api_mode = createData.api_mode?.trim() || null;
      payload.default_model = createData.default_model?.trim() || null;
      payload.context_length =
        createData.context_length === '' || createData.context_length == null
          ? null
          : Number(createData.context_length) || null;
      payload.rate_limit_delay =
        createData.rate_limit_delay === '' || createData.rate_limit_delay == null
          ? null
          : Number(createData.rate_limit_delay) || null;
    }

    setSavingCreate(true);
    try {
      await apiClient.post('/models/providers', payload, { params: { profile: activeProfile } });
      toast({ title: '成功', description: '供应商已新增' });
      setCreateOpen(false);
      loadData(true);
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: '错误',
        description: error?.response?.data?.detail || '新增失败',
      });
    } finally {
      setSavingCreate(false);
    }
  };

  const loadModelListForProvider = useCallback(async (providerName: string) => {
    setProviderLoadingModels((prev) => ({ ...prev, [providerName]: true }));
    setProviderModelErrors((prev) => ({ ...prev, [providerName]: '' }));
    setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
    try {
      const { data } = await apiClient.get<{
        models: Array<{
          id: string;
          name?: string;
          owned_by?: string;
          context_length?: number | null;
          output_length?: number | null;
          created?: number | null;
          multimodal?: boolean;
        }>;
        error?: string;
      }>(
        `/models/providers/${encodeURIComponent(providerName)}/models`,
        { params: { profile: activeProfile } },
      );
      const models = (data.models ?? []).map((m) => ({ ...m, provider: providerName }));
      setProviderModels((prev) => ({ ...prev, [providerName]: models }));
      if (data.error) {
        setProviderModelErrors((prev) => ({ ...prev, [providerName]: String(data.error) }));
      }
    } catch (error: any) {
      setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
      const errMsg = error?.response?.data?.detail || '加载失败';
      setProviderModelErrors((prev) => ({ ...prev, [providerName]: errMsg }));
    } finally {
      setProviderLoadingModels((prev) => ({ ...prev, [providerName]: false }));
    }
  }, [activeProfile, toast]);

  const loadAllProviderModels = useCallback(async () => {
    if (providers.length === 0) {
      toast({ variant: 'destructive', title: '错误', description: '暂无可用供应商' });
      return;
    }
    setAllModelsLoading(true);
    setProviderModelErrors({});
    setProviderModels({});
    try {
      const results = await Promise.allSettled(
        providers.map(async (p) => {
          const { data } = await apiClient.get<{
            models: Array<{
              id: string;
              name?: string;
              owned_by?: string;
              context_length?: number | null;
              output_length?: number | null;
              created?: number | null;
              multimodal?: boolean;
            }>;
            error?: string;
          }>(
            `/models/providers/${encodeURIComponent(p.name)}/models`,
            { params: { profile: activeProfile } },
          );
          return { provider: p.display_name || p.name, models: data.models ?? [], error: data.error };
        }),
      );

      const nextModels: Record<string, Array<any>> = {};
      const errs: Record<string, string> = {};
      results.forEach((result, idx) => {
        const providerName = providers[idx].display_name || providers[idx].name;
        if (result.status === 'fulfilled') {
          const { models, error } = result.value;
          nextModels[providerName] = (models ?? []).map((m) => ({ ...m, provider: providerName }));
          if (error) errs[providerName] = error;
        } else {
          errs[providerName] = '请求失败';
          nextModels[providerName] = [];
        }
      });
      setProviderModels(nextModels);
      setProviderModelErrors(errs);
    } catch (error: any) {
      setProviderModels({});
      const errMsg = error?.response?.data?.detail || '加载失败';
      setProviderModelErrors({ 请求: errMsg });
    } finally {
      setAllModelsLoading(false);
    }
  }, [activeProfile, providers, toast]);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>供应商列表</CardTitle>
          <Button onClick={openCreate}>
            <Plus className="mr-2 h-4 w-4" />
            新增供应商
          </Button>
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loading className="py-12" />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>供应商</TableHead>
                  <TableHead>基础地址</TableHead>
                  <TableHead>密钥</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {providers.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                      暂无供应商配置
                    </TableCell>
                  </TableRow>
                ) : (
                  providers.map((row) => (
                    <TableRow key={row.name}>
                      <TableCell className="font-medium">{row.display_name || row.name}</TableCell>
                      <TableCell title={row.base_url || (row.source === 'env' ? '(默认地址)' : '—')}>
                        {row.base_url || (row.source === 'env' ? '(默认地址)' : '—')}
                      </TableCell>
                      <TableCell>{row.has_key ? (row.key_env || '已配置') : '未配置'}</TableCell>
                      <TableCell>
                        <div className="flex gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(row)}>
                            <Pencil className="mr-1 h-3 w-3" />
                            编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => loadModelListForProvider(row.name)}
                            disabled={providerLoadingModels[row.name]}
                          >
                            {providerLoadingModels[row.name] ? '获取中...' : '获取模型列表'}
                          </Button>
                          <Button variant="outline" size="sm" onClick={() => handleDelete(row)}>
                            <Trash2 className="mr-1 h-3 w-3" />
                            删除
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {(() => {
        const providerNames = Object.keys(providerModels);
        const errorProviders = Object.keys(providerModelErrors);
        const errorOnlyProviders = errorProviders.filter((p) => providerModelErrors[p] && !providerModels[p]?.length);

        if (providerNames.length === 0 && errorOnlyProviders.length === 0) {
          return null;
        }

        return (
          <div className="space-y-3">
            {errorOnlyProviders.map((providerName) => (
              <Card key={`err-${providerName}`} className="border-red-300/60">
                <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold">{providerName}</span>
                    <Badge variant="destructive" className="text-xs">获取失败</Badge>
                  </div>
                </CardHeader>
                <CardContent className="pt-0 px-4 pb-4">
                  <p className="text-sm text-red-600">{providerModelErrors[providerName]}</p>
                </CardContent>
              </Card>
            ))}

            {providerNames.map((providerName) => {
              if (errorOnlyProviders.includes(providerName)) return null;
              const models = providerModels[providerName] ?? [];
              const loading = !!providerLoadingModels[providerName];
              const isExpanded = !!providerExpanded[providerName];
              const visibleModels = isExpanded ? models : models.slice(0, 3);
              const hasMore = models.length > 3;
              const hasError = !!providerModelErrors[providerName];

              return (
                <Card key={providerName} className={hasError ? 'border-amber-300/60' : ''}>
                  <CardHeader className="flex flex-row items-center justify-between py-3 px-4">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{providerName}</span>
                      {loading ? (
                        <Badge variant="outline" className="text-xs">加载中</Badge>
                      ) : (
                        <Badge variant="secondary" className="text-xs">{models.length} 个模型</Badge>
                      )}
                      {hasError && !loading && (
                        <Badge variant="outline" className="text-xs text-amber-700 border-amber-300">
                          获取失败
                        </Badge>
                      )}
                    </div>
                    {!loading && hasMore && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setProviderExpanded((prev) => ({ ...prev, [providerName]: !prev[providerName] }))
                        }
                      >
                        {isExpanded ? (
                          <>收起 <ChevronUp className="ml-1 h-4 w-4" /></>
                        ) : (
                          <>展开全部 ({models.length}) <ChevronDown className="ml-1 h-4 w-4" /></>
                        )}
                      </Button>
                    )}
                  </CardHeader>
                  <CardContent className="pt-0 px-4 pb-4 space-y-2">
                    {hasError && !loading && (
                      <p className="text-sm text-amber-600">警告: {providerModelErrors[providerName]}</p>
                    )}
                    {loading ? (
                      <div className="py-8 text-center text-sm text-muted-foreground">模型列表加载中...</div>
                    ) : (
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>模型 ID</TableHead>
                            <TableHead>上下文窗口</TableHead>
                            <TableHead>输出窗口</TableHead>
                            <TableHead>多模态</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {visibleModels.map((m, idx) => (
                            <TableRow key={`${m.id}-${idx}`}>
                              <TableCell className="font-mono">{m.id}</TableCell>
                              <TableCell>
                                {m.context_length ? m.context_length.toLocaleString() : '—'}
                              </TableCell>
                              <TableCell>
                                {m.output_length ? m.output_length.toLocaleString() : '—'}
                              </TableCell>
                              <TableCell>
                                {m.multimodal ? (
                                  <Badge variant="secondary" className="text-xs">支持</Badge>
                                ) : (
                                  <span className="text-muted-foreground text-xs">—</span>
                                )}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    )}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        );
      })()}

      {/* Edit Dialog */}
      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{editIndex !== null ? '编辑供应商' : '新增供应商'}</DialogTitle>
            <DialogDescription>
              {editIndex !== null ? '修改供应商配置' : '添加新的自定义供应商'}
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label htmlFor="name">名称</Label>
              <Input
                id="name"
                value={editData?.name || ''}
                onChange={(e) => setEditData({ ...editData, name: e.target.value })}
                placeholder="例如：my-provider"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="base_url">基础地址</Label>
              <Input
                id="base_url"
                value={editData?.base_url || ''}
                onChange={(e) => setEditData({ ...editData, base_url: e.target.value })}
                placeholder="例如：https://api.example.com/v1"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="key_env">密钥环境变量</Label>
              <Input
                id="key_env"
                value={editData?.key_env || ''}
                onChange={(e) => setEditData({ ...editData, key_env: e.target.value })}
                placeholder="例如：MY_API_KEY"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="api_key">API 密钥（可选）</Label>
              <Input
                id="api_key"
                type="password"
                value={editData?.api_key || ''}
                onChange={(e) => setEditData({ ...editData, api_key: e.target.value })}
                placeholder="直接填写 API 密钥"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="default_model">默认模型</Label>
              <Input
                id="default_model"
                value={editData?.default_model || ''}
                onChange={(e) => setEditData({ ...editData, default_model: e.target.value })}
                placeholder="例如：gpt-4o（可选）"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="context_length">上下文长度</Label>
              <Input
                id="context_length"
                type="number"
                min={0}
                value={editData?.context_length ?? ''}
                onChange={(e) => setEditData({ ...editData, context_length: e.target.value })}
                placeholder="例如：128000（可选）"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rate_limit_delay">限流延迟（秒）</Label>
              <Input
                id="rate_limit_delay"
                type="number"
                min={0}
                step="0.1"
                value={editData?.rate_limit_delay ?? ''}
                onChange={(e) => setEditData({ ...editData, rate_limit_delay: e.target.value })}
                placeholder="例如：0.5（可选）"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleEditSubmit}>
              保存
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Create Dialog */}
      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>新增供应商</DialogTitle>
            <DialogDescription>支持从预设快速添加，或完全自定义。</DialogDescription>
          </DialogHeader>
          <div className="flex gap-2 border-b">
            <button
              type="button"
              onClick={() => {
                setCreateMode('preset');
                setCreateData({
                  provider_name: '', name: '', key_env_var: '', key_value: '',
                  base_url: '', api_mode: '', default_model: '', context_length: '', rate_limit_delay: '',
                });
              }}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                createMode === 'preset' ? 'tab-active' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              新增预设
            </button>
            <button
              type="button"
              onClick={() => {
                setCreateMode('custom');
                setCreateData({
                  provider_name: '', name: '', key_env_var: '', key_value: '',
                  base_url: '', api_mode: '', default_model: '', context_length: '', rate_limit_delay: '',
                });
              }}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                createMode === 'custom' ? 'tab-active' : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              新增自定义
            </button>
          </div>
          <div className="grid gap-4 py-4">
            {createMode === 'preset' ? (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="provider_name">供应商预设</Label>
                  <Select
                    value={createData.provider_name}
                    onValueChange={(value) => {
                      const preset = presets.find((p) => p.id === value);
                      setCreateData({
                        ...createData,
                        provider_name: value,
                        key_env_var: preset?.key_env ?? '',
                        base_url: preset?.base_url ?? '',
                      });
                    }}
                  >
                    <SelectTrigger id="provider_name">
                      <SelectValue placeholder="请选择供应商" />
                    </SelectTrigger>
                    <SelectContent>
                      {presets.map((preset) => (
                        <SelectItem key={preset.id} value={preset.id}>
                          {preset.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="preset_base_url">基础地址</Label>
                  <Input
                    id="preset_base_url"
                    value={createData.base_url}
                    onChange={(e) => setCreateData({ ...createData, base_url: e.target.value })}
                    placeholder="可按需覆盖预设默认地址"
                  />
                  <p className="text-xs text-muted-foreground">默认值来自预设，可编辑覆盖。</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="key_value">API 密钥</Label>
                  <Input
                    id="key_value"
                    type="password"
                    value={createData.key_value}
                    onChange={(e) => setCreateData({ ...createData, key_value: e.target.value })}
                    placeholder="填写该供应商的 API 密钥"
                  />
                </div>
              </>
            ) : (
              <>
                <div className="grid gap-2">
                  <Label htmlFor="name">名称</Label>
                  <Input
                    id="name"
                    value={createData.name}
                    onChange={(e) => setCreateData({ ...createData, name: e.target.value })}
                    placeholder="例如：my-provider"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="key_env_var">环境变量名</Label>
                  <Input
                    id="key_env_var"
                    value={createData.key_env_var}
                    onChange={(e) => setCreateData({ ...createData, key_env_var: e.target.value })}
                    placeholder="例如：MY_API_KEY"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="key_value">API 密钥</Label>
                  <Input
                    id="key_value"
                    type="password"
                    value={createData.key_value}
                    onChange={(e) => setCreateData({ ...createData, key_value: e.target.value })}
                    placeholder="填写 API 密钥"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="base_url">基础地址</Label>
                  <Input
                    id="base_url"
                    value={createData.base_url}
                    onChange={(e) => setCreateData({ ...createData, base_url: e.target.value })}
                    placeholder="例如：https://api.example.com/v1"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="default_model">默认模型（可选）</Label>
                  <Input
                    id="default_model"
                    value={createData.default_model}
                    onChange={(e) => setCreateData({ ...createData, default_model: e.target.value })}
                    placeholder="例如：gpt-4o"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="context_length">上下文长度（可选）</Label>
                  <Input
                    id="context_length"
                    type="number"
                    min={0}
                    value={createData.context_length}
                    onChange={(e) => setCreateData({ ...createData, context_length: e.target.value })}
                    placeholder="例如：128000"
                  />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="rate_limit_delay">限流延迟（秒，可选）</Label>
                  <Input
                    id="rate_limit_delay"
                    type="number"
                    min={0}
                    step="0.1"
                    value={createData.rate_limit_delay}
                    onChange={(e) => setCreateData({ ...createData, rate_limit_delay: e.target.value })}
                    placeholder="例如：0.5"
                  />
                </div>
              </>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              取消
            </Button>
            <Button onClick={handleCreateSubmit} disabled={savingCreate}>
              {savingCreate ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MainModelTab({
  modelData,
  activeProfile,
  onSave,
}: {
  modelData: any;
  activeProfile: string;
  onSave: (values: any) => Promise<void>;
}) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [saving, setSaving] = useState(false);
  const [modelOptions, setModelOptions] = useState<string[]>([]);
  const [modelLoading, setModelLoading] = useState(false);
  const [modelError, setModelError] = useState('');
  const [formData, setFormData] = useState({
    provider: '',
    model: '',
    context_length: 0,
  });

  const loadProviders = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(data.providers ?? []);
    } catch {
      setProviders([]);
    }
  }, [activeProfile]);

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // 选择 Provider 后同步刷新该 Provider 的模型列表
  const loadModelList = useCallback(
    async (providerValue: string) => {
      if (!providerValue) {
        setModelOptions([]);
        setModelError('');
        return;
      }
      // 自定义 Provider 的 value 带 custom: 前缀，调用接口时需去掉
      const name = providerValue.startsWith('custom:') ? providerValue.slice('custom:'.length) : providerValue;
      setModelLoading(true);
      setModelError('');
      try {
        const { data } = await apiClient.get<{ models: Array<{ id: string }>; error?: string }>(
          `/models/providers/${encodeURIComponent(name)}/models`,
          { params: { profile: activeProfile } },
        );
        setModelOptions((data.models ?? []).map((m) => m.id));
        if (data.error) setModelError(data.error);
      } catch (error: any) {
        setModelOptions([]);
        setModelError(error?.response?.data?.detail || '模型列表加载失败');
      } finally {
        setModelLoading(false);
      }
    },
    [activeProfile],
  );

  useEffect(() => {
    loadModelList(formData.provider);
  }, [formData.provider, loadModelList]);

  const openEdit = () => {
    setFormData({
      provider: modelData.provider || '',
      model: modelData.default || '',
      context_length: modelData.context_length || 0,
    });
    setEditOpen(true);
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave({
        provider: formData.provider || undefined,
        default: formData.model || undefined,
        context_length: formData.context_length || undefined,
      });
      toast({
        title: '成功',
        description: '主模型已保存',
      });
      setEditOpen(false);
    } catch {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = providers.map((p) => ({
    label: p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
  }));

  const selectedProvider = providerOptions.find((p) => p.value === modelData.provider);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>主模型</CardTitle>
        <Button onClick={openEdit}>
          <Pencil className="mr-2 h-4 w-4" />
          编辑
        </Button>
      </CardHeader>
      <CardContent>
        <Table>
          <TableBody>
            <TableRow>
              <TableCell className="font-medium w-[160px]">供应商</TableCell>
              <TableCell>{modelData.provider || '—'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">模型</TableCell>
              <TableCell>{modelData.default || '—'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">基础地址</TableCell>
              <TableCell>{selectedProvider?.value || modelData.base_url || '—'}</TableCell>
            </TableRow>
            <TableRow>
              <TableCell className="font-medium">上下文长度</TableCell>
              <TableCell>{modelData.context_length || '—'}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </CardContent>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑主模型</DialogTitle>
            <DialogDescription>配置主模型的供应商和参数</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>供应商</Label>
              <Select
                value={formData.provider}
                onValueChange={(value) => setFormData({ ...formData, provider: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择供应商" />
                </SelectTrigger>
                <SelectContent>
                  {providerOptions.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>模型</Label>
              <Select
                value={formData.model}
                onValueChange={(value) => setFormData({ ...formData, model: value })}
                disabled={modelLoading || modelOptions.length === 0}
              >
                <SelectTrigger>
                  <SelectValue placeholder={modelLoading ? '模型加载中…' : '从供应商模型列表选择'} />
                </SelectTrigger>
                <SelectContent>
                  {modelOptions.map((m) => (
                    <SelectItem key={m} value={m}>
                      {m}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {modelError && <p className="text-xs text-amber-600">{modelError}</p>}
            </div>
            <div className="grid gap-2">
              <Label>上下文长度</Label>
              <Input
                type="number"
                value={formData.context_length}
                onChange={(e) => setFormData({ ...formData, context_length: parseInt(e.target.value) || 0 })}
                placeholder="例如：128000（可选）"
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AuxTab({
  data,
  activeProfile,
  onReload,
}: {
  data: Record<string, any>;
  activeProfile: string;
  onReload: () => void;
}) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [fullData, setFullData] = useState<Record<string, any>>({});
  const [saving, setSaving] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [modelOptionsMap, setModelOptionsMap] = useState<Record<string, string[]>>({});
  const [modelLoadingMap, setModelLoadingMap] = useState<Record<string, boolean>>({});
  const [modelErrorMap, setModelErrorMap] = useState<Record<string, string>>({});
  const [formData, setFormData] = useState<Record<string, { provider: string; model: string; timeout?: number }>>({});

  const loadProviders = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(data.providers ?? []);
    } catch {
      setProviders([]);
    }
  }, [activeProfile]);

  const loadModelList = useCallback(
    async (submodule: string, providerValue: string) => {
      if (!providerValue) {
        setModelOptionsMap((prev) => ({ ...prev, [submodule]: [] }));
        setModelErrorMap((prev) => ({ ...prev, [submodule]: '' }));
        return;
      }
      const name = providerValue.startsWith('custom:') ? providerValue.slice('custom:'.length) : providerValue;
      setModelLoadingMap((prev) => ({ ...prev, [submodule]: true }));
      setModelErrorMap((prev) => ({ ...prev, [submodule]: '' }));
      try {
        const { data } = await apiClient.get<{ models: Array<{ id: string }>; error?: string }>(
          `/models/providers/${encodeURIComponent(name)}/models`,
          { params: { profile: activeProfile } },
        );
        setModelOptionsMap((prev) => ({ ...prev, [submodule]: (data.models ?? []).map((m) => m.id) }));
        if (data.error) setModelErrorMap((prev) => ({ ...prev, [submodule]: data.error || '' }));
      } catch (error: any) {
        setModelOptionsMap((prev) => ({ ...prev, [submodule]: [] }));
        setModelErrorMap((prev) => ({ ...prev, [submodule]: error?.response?.data?.detail || '模型列表加载失败' }));
      } finally {
        setModelLoadingMap((prev) => ({ ...prev, [submodule]: false }));
      }
    },
    [activeProfile],
  );

  const openEditor = async () => {
    let auxData: Record<string, any> = {};
    try {
      const { data: fullData } = await apiClient.get('/config/sections/auxiliary', { params: { profile: activeProfile } });
      auxData = (fullData || {}) as Record<string, any>;
    } catch {
      auxData = data ?? {};
    }
    setFullData(auxData);
    const initialForm: Record<string, { provider: string; model: string; timeout?: number }> = {};
    Object.keys(AUX_LABELS).forEach((key) => {
      const item = auxData?.[key] ?? data?.[key] ?? {};
      initialForm[key] = {
        provider: item.provider || '',
        model: item.model || '',
        timeout: item.timeout ?? undefined,
      };
    });
    setFormData(initialForm);
    setModelOptionsMap({});
    setModelLoadingMap({});
    setModelErrorMap({});
    setEditOpen(true);
    Object.entries(initialForm).forEach(([key, value]) => {
      if (value.provider) loadModelList(key, value.provider);
    });
  };

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  const providerOptions = providers.map((p) => ({
    label: p.display_name || p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
  }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const aux = { ...fullData } as Record<string, any>;
      Object.entries(formData).forEach(([key, value]) => {
        const merged = { ...(aux[key] ?? {}), provider: value.provider, model: value.model };
        if (value.timeout !== undefined) {
          merged.timeout = value.timeout;
        }
        aux[key] = merged;
      });
      await apiClient.put('/models/auxiliary', aux, { params: { profile: activeProfile } });
      toast({
        title: '成功',
        description: '已保存',
      });
      setEditOpen(false);
      onReload();
    } catch {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  const rows = Object.entries(AUX_LABELS).map(([name, label]) => ({
    name,
    label,
    ...(data?.[name] || {}),
  }));

  const hasExisting = rows.some((r: any) => r.provider);

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>辅助模型</CardTitle>
          <Button onClick={() => openEditor()}>
            <Pencil className="mr-2 h-4 w-4" />
            {hasExisting ? '编辑' : '添加'}
          </Button>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[20%]">子模块</TableHead>
                <TableHead className="w-[20%]">供应商</TableHead>
                <TableHead className="w-[45%]">模型</TableHead>
                <TableHead className="w-[15%]">超时(秒)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="text-center py-12 text-muted-foreground">
                    暂无辅助模型配置
                  </TableCell>
                </TableRow>
              ) : (
                rows.map((row: any) => (
                  <TableRow key={row.name}>
                    <TableCell className="font-medium">{row.label || row.name}</TableCell>
                    <TableCell>{row.provider || '—'}</TableCell>
                    <TableCell className="truncate">{row.model || '—'}</TableCell>
                    <TableCell>{row.timeout ?? '—'}</TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑辅助模型</DialogTitle>
            <DialogDescription>为每个子模块配置供应商、模型和超时时间</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 py-4">
            <div className="grid grid-cols-12 gap-3 text-xs text-muted-foreground font-medium px-1">
              <div className="col-span-2">子模块</div>
              <div className="col-span-3">供应商</div>
              <div className="col-span-4">模型</div>
              <div className="col-span-3">超时(秒)</div>
            </div>
            {Object.entries(AUX_LABELS).map(([key, label]) => {
              const item = formData[key] || { provider: '', model: '', timeout: undefined };
              const isLoading = modelLoadingMap[key];
              const options = modelOptionsMap[key] || [];
              const error = modelErrorMap[key];
              return (
                <div key={key} className="grid grid-cols-12 gap-3 items-end">
                  <div className="col-span-2">
                    <div className="text-sm font-medium py-2">{label}</div>
                  </div>
                  <div className="col-span-3">
                    <Select
                      value={item.provider}
                      onValueChange={(value) => {
                        setFormData((prev) => ({
                          ...prev,
                          [key]: { ...item, provider: value, model: '' },
                        }));
                        loadModelList(key, value);
                      }}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="请选择供应商" />
                      </SelectTrigger>
                      <SelectContent>
                        {providerOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="col-span-4">
                    <Select
                      value={item.model}
                      onValueChange={(value) =>
                        setFormData((prev) => ({
                          ...prev,
                          [key]: { ...item, model: value },
                        }))
                      }
                      disabled={isLoading || options.length === 0}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder={isLoading ? '模型加载中…' : '请选择模型'} />
                      </SelectTrigger>
                      <SelectContent>
                        {options.map((m: string) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    {error && <p className="text-xs text-amber-600">{error}</p>}
                  </div>
                  <div className="col-span-3">
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      value={item.timeout ?? ''}
                      onChange={(e) =>
                        setFormData((prev) => ({
                          ...prev,
                          [key]: { ...item, timeout: e.target.value ? parseFloat(e.target.value) : undefined },
                        }))
                      }
                      placeholder="空=默认"
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FallbackTab({
  data,
  activeProfile,
  onReload,
}: {
  data: Array<{ provider: string; model: string }>;
  activeProfile: string;
  onReload: () => void;
}) {
  const { toast } = useToast();
  const [items, setItems] = useState<Array<{ key: string; provider: string; model: string }>>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editItems, setEditItems] = useState<Array<{ key: string; provider: string; model: string }>>([]);
  const [saving, setSaving] = useState(false);
  const [providerOptions, setProviderOptions] = useState<Array<{ label: string; value: string }>>([]);
  const [modelsByProvider, setModelsByProvider] = useState<Record<string, { models: string[]; loading: boolean }>>({});

  const loadProviders = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      const list = data.providers ?? [];
      setProviderOptions(list.map((p) => ({
        label: p.display_name || p.name,
        value: p.source === 'custom' ? `custom:${p.name}` : p.name,
      })));
    } catch {
      setProviderOptions([]);
    }
  }, [activeProfile]);

  const loadModelListFor = useCallback(
    async (providerValue: string) => {
      if (!providerValue) {
        setModelsByProvider((prev) => ({ ...prev, [providerValue]: { models: [], loading: false } }));
        return;
      }
      setModelsByProvider((prev) => ({ ...prev, [providerValue]: { models: [], loading: true } }));
      try {
        const name = providerValue.startsWith('custom:') ? providerValue.slice('custom:'.length) : providerValue;
        const { data } = await apiClient.get<{ models: Array<{ id: string }>; error?: string }>(
          `/models/providers/${encodeURIComponent(name)}/models`,
          { params: { profile: activeProfile } },
        );
        setModelsByProvider((prev) => ({
          ...prev,
          [providerValue]: { models: (data.models ?? []).map((m) => m.id), loading: false },
        }));
      } catch {
        setModelsByProvider((prev) => ({ ...prev, [providerValue]: { models: [], loading: false } }));
      }
    },
    [activeProfile],
  );

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  useEffect(() => {
    editItems.forEach((row) => {
      if (row.provider && !modelsByProvider[row.provider]) {
        loadModelListFor(row.provider);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editItems.map((r) => r.provider).join('|'), loadModelListFor]);

  useEffect(() => {
    setItems((data || []).map((item, i) => ({ key: `${item.provider || 'p'}-${i}`, ...item })));
  }, [data]);

  const openEdit = () => {
    const cloned = items.map((i) => ({ ...i }));
    setEditItems(cloned.length ? cloned : [{ key: `new-${Date.now()}`, provider: '', model: '' }]);
    setEditOpen(true);
  };

  const addEditRow = () => {
    setEditItems((prev) => [...prev, { key: `new-${Date.now()}-${prev.length}`, provider: '', model: '' }]);
  };

  const removeEditRow = (key: string) => {
    setEditItems((prev) => prev.filter((r) => r.key !== key));
  };

  const updateEditRow = (key: string, patch: Partial<{ provider: string; model: string }>) => {
    setEditItems((prev) => prev.map((r) => {
      if (r.key !== key) return r;
      const merged = { ...r, ...patch };
      if (patch.provider !== undefined && patch.provider !== r.provider) {
        // Reset model when provider changes
        merged.model = '';
        loadModelListFor(patch.provider);
      }
      return merged;
    }));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = editItems
        .map((r) => ({ provider: r.provider || '', model: r.model || '' }))
        .filter((i) => i.provider || i.model);
      await apiClient.put('/models/fallback_providers', payload, { params: { profile: activeProfile } });
      toast({
        title: '成功',
        description: '已保存',
      });
      setEditOpen(false);
      onReload();
    } catch {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>回退模型</CardTitle>
          <Button onClick={openEdit}>
            <Pencil className="mr-2 h-4 w-4" />
            编辑
          </Button>
        </CardHeader>
        <CardContent>
          {items.length === 0 ? (
            <div className="text-center py-12 text-muted-foreground">
              暂未配置回退模型
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>供应商</TableHead>
                  <TableHead>模型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.map((item) => (
                  <TableRow key={item.key}>
                    <TableCell>{item.provider || '—'}</TableCell>
                    <TableCell>{item.model || '—'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>编辑回退模型</DialogTitle>
            <DialogDescription>配置多个回退模型，按顺序依次尝试</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="flex justify-end items-center">
              <Button variant="outline" size="sm" onClick={addEditRow}>
                <Plus className="mr-1 h-3 w-3" />
                新增一行
              </Button>
            </div>

            <div className="grid grid-cols-[240px_1fr_64px] gap-2 px-3">
              <Label className="text-muted-foreground">供应商</Label>
              <Label className="text-muted-foreground">模型</Label>
              <Label className="text-muted-foreground text-center">操作</Label>
            </div>

            {editItems.map((row) => {
              const providerState = modelsByProvider[row.provider];
              const rowModelOptions = providerState?.models ?? [];
              const rowModelLoading = providerState?.loading ?? false;
              return (
                <div
                  key={row.key}
                  className="grid grid-cols-[240px_1fr_64px] gap-2 items-center border rounded-lg p-3 bg-muted/50"
                >
                  <Select
                    value={row.provider}
                    onValueChange={(value) => updateEditRow(row.key, { provider: value })}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="请选择供应商" />
                    </SelectTrigger>
                    <SelectContent>
                      {providerOptions.map((opt) => (
                        <SelectItem key={opt.value} value={opt.value}>
                          {opt.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Select
                    value={row.model}
                    onValueChange={(value) => updateEditRow(row.key, { model: value })}
                    disabled={rowModelLoading || rowModelOptions.length === 0}
                  >
                    <SelectTrigger>
                      <SelectValue placeholder={rowModelLoading ? '加载中…' : '请选择模型'} />
                    </SelectTrigger>
                    <SelectContent>
                      {rowModelOptions.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => removeEditRow(row.key)}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              );
            })}

            {editItems.length === 0 && (
              <div className="border-2 border-dashed rounded-lg p-8 text-center text-muted-foreground">
                暂无配置，点击"新增一行"添加。
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function MoATab({
  data,
  activeProfile,
  onReload,
}: {
  data: any;
  activeProfile: string;
  onReload: () => void;
}) {
  const { toast } = useToast();
  const [editOpen, setEditOpen] = useState(false);
  const [editPreset, setEditPreset] = useState<string>('');
  const [presetFormName, setPresetFormName] = useState('');
  const [saving, setSaving] = useState(false);
  const presets = data?.presets || {};
  const presetNames = Object.keys(presets);
  const activePresetName = data?.default_preset || 'default';
  const saveTraces = data?.save_traces ?? false;
  const traceDir = data?.trace_dir || '';
  const privacyFilter = data?.privacy_filter || '';

  const [topEditOpen, setTopEditOpen] = useState(false);
  const [topSaving, setTopSaving] = useState(false);
  const [topForm, setTopForm] = useState({
    default_preset: activePresetName,
    save_traces: saveTraces,
    trace_dir: traceDir,
    privacy_filter: privacyFilter,
  });
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [aggregatorModelOptions, setAggregatorModelOptions] = useState<string[]>([]);
  const [aggregatorModelLoading, setAggregatorModelLoading] = useState(false);
  const [refModelOptionsMap, setRefModelOptionsMap] = useState<Record<number, string[]>>({});
  const [refModelsLoadingMap, setRefModelsLoadingMap] = useState<Record<number, boolean>>({});
  const [formData, setFormData] = useState({
    enabled: true,
    aggregator: { provider: '', model: '' },
    reference_models: [] as Array<{ provider: string; model: string; enabled: boolean }>,
    reference_temperature: 0.6,
    aggregator_temperature: 0.4,
    reference_timeout: 0,
    degraded_reference_policy: 'loud',
    max_tokens: 4096,
    reference_max_tokens: 0,
    fanout: 'user_turn',
  });

  const handleChangeDefaultPreset = async (name: string) => {
    try {
      await apiClient.put(
        '/models/moa',
        { ...data, default_preset: name },
        { params: { profile: activeProfile } },
      );
      toast({ title: '成功', description: `默认预设已切换为 ${name}` });
      onReload();
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '切换默认预设失败' });
    }
  };

  const openTopEdit = () => {
    setTopForm({
      default_preset: activePresetName,
      save_traces: saveTraces,
      trace_dir: traceDir,
      privacy_filter: privacyFilter,
    });
    setTopEditOpen(true);
  };

  const handleSaveTop = async () => {
    setTopSaving(true);
    try {
      await apiClient.put(
        '/models/moa',
        {
          ...data,
          default_preset: topForm.default_preset,
          save_traces: topForm.save_traces,
          trace_dir: topForm.trace_dir,
          privacy_filter: topForm.privacy_filter,
        },
        { params: { profile: activeProfile } },
      );
      toast({ title: '成功', description: 'MoA 顶层配置已保存' });
      setTopEditOpen(false);
      onReload();
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '保存顶层配置失败' });
    } finally {
      setTopSaving(false);
    }
  };

  const loadProviders = useCallback(async () => {
    try {
      const { data } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(data.providers ?? []);
    } catch {
      setProviders([]);
    }
  }, [activeProfile]);

  const loadModelList = useCallback(
    async (providerValue: string): Promise<string[]> => {
      if (!providerValue) return [];
      const name = providerValue.startsWith('custom:') ? providerValue.slice('custom:'.length) : providerValue;
      try {
        const { data } = await apiClient.get<{ models: Array<{ id: string }>; error?: string }>(
          `/models/providers/${encodeURIComponent(name)}/models`,
          { params: { profile: activeProfile } },
        );
        return (data.models ?? []).map((m) => m.id);
      } catch {
        return [];
      }
    },
    [activeProfile],
  );

  const providerOptions = providers.map((p) => ({
    label: p.display_name || p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
  }));

  useEffect(() => {
    loadProviders();
  }, [loadProviders]);

  // Load aggregator model list when its provider changes
  useEffect(() => {
    if (!editOpen) return;
    const provider = formData.aggregator.provider;
    if (!provider) {
      setAggregatorModelOptions([]);
      return;
    }
    setAggregatorModelLoading(true);
    loadModelList(provider).then((opts) => {
      setAggregatorModelOptions(opts);
      setAggregatorModelLoading(false);
    });
  }, [formData.aggregator.provider, editOpen, loadModelList]);

  // Load reference model lists when providers change
  useEffect(() => {
    if (!editOpen) return;
    formData.reference_models.forEach((ref, idx) => {
      if (!ref.provider) return;
      setRefModelsLoadingMap((prev) => ({ ...prev, [idx]: true }));
      loadModelList(ref.provider).then((opts) => {
        setRefModelOptionsMap((prev) => ({ ...prev, [idx]: opts }));
        setRefModelsLoadingMap((prev) => ({ ...prev, [idx]: false }));
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [formData.reference_models.map((r) => r.provider).join('|'), editOpen, loadModelList]);

  const openEdit = (presetName: string) => {
    setEditPreset(presetName);
    setPresetFormName(presetName);
    const preset = data?.presets?.[presetName] || {};
    setFormData({
      enabled: preset.enabled ?? true,
      aggregator: {
        provider: preset.aggregator?.provider || '',
        model: preset.aggregator?.model || '',
      },
      reference_models: (preset.reference_models || []).map((r: any) => ({
        provider: r.provider || '',
        model: r.model || '',
        enabled: r.enabled ?? true,
      })),
      reference_temperature: preset.reference_temperature ?? 0.6,
      aggregator_temperature: preset.aggregator_temperature ?? 0.4,
      reference_timeout: preset.reference_timeout ?? 0,
      degraded_reference_policy: preset.degraded_reference_policy || 'loud',
      max_tokens: preset.max_tokens ?? 4096,
      reference_max_tokens: preset.reference_max_tokens || 0,
      fanout: preset.fanout || 'user_turn',
    });
    setRefModelOptionsMap({});
    setEditOpen(true);
  };

  const updateRefModel = (idx: number, patch: Partial<{ provider: string; model: string; enabled?: boolean }>) => {
    setFormData((prev) => {
      const newRefs = [...prev.reference_models];
      const merged = { ...newRefs[idx], ...patch };
      if (patch.provider !== undefined && patch.provider !== newRefs[idx].provider) {
        merged.model = '';
        setRefModelOptionsMap((prevMap) => ({ ...prevMap, [idx]: [] }));
        setRefModelsLoadingMap((prev) => ({ ...prev, [idx]: true }));
        loadModelList(patch.provider).then((opts) => {
          setRefModelOptionsMap((prevMap) => ({ ...prevMap, [idx]: opts }));
          setRefModelsLoadingMap((prev) => ({ ...prev, [idx]: false }));
        });
      }
      newRefs[idx] = merged;
      return { ...prev, reference_models: newRefs };
    });
  };

  const getRefModelOptions = (idx: number) => refModelOptionsMap[idx] ?? [];
  const isRefLoading = (idx: number) => refModelsLoadingMap[idx] ?? false;

  const handleSave = async () => {
    setSaving(true);
    try {
      const targetName = editPreset || presetFormName.trim();
      if (!targetName) {
        toast({
          variant: 'destructive',
          title: '错误',
          description: 'preset 名称不能为空',
        });
        setSaving(false);
        return;
      }
      if (!editPreset && data?.presets?.[targetName]) {
        toast({
          variant: 'destructive',
          title: '错误',
          description: 'preset 名称已存在',
        });
        setSaving(false);
        return;
      }

      const updatedPresets = { ...data?.presets };
      const presetData: any = {
        enabled: formData.enabled,
        aggregator: formData.aggregator,
        reference_models: formData.reference_models,
        reference_temperature: formData.reference_temperature,
        aggregator_temperature: formData.aggregator_temperature,
        reference_timeout: formData.reference_timeout,
        degraded_reference_policy: formData.degraded_reference_policy,
        max_tokens: formData.max_tokens,
        reference_max_tokens: formData.reference_max_tokens,
        fanout: formData.fanout,
      };
      // Strip empty values
      Object.keys(presetData).forEach((k) => {
        const v = presetData[k];
        if (v === '' || v === null || v === undefined || (Array.isArray(v) && v.length === 0)) {
          delete presetData[k];
        }
      });
      updatedPresets[targetName] = {
        ...updatedPresets[targetName],
        ...presetData,
      };

      await apiClient.put('/models/moa', {
        ...data,
        presets: updatedPresets,
      }, { params: { profile: activeProfile } });

      toast({
        title: '成功',
        description: 'MoA 配置已保存',
      });
      setEditOpen(false);
      onReload();
    } catch {
      toast({
        variant: 'destructive',
        title: '错误',
        description: '保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  const renderPresetCard = (presetName: string) => {
    const preset = presets[presetName] || {};
    const refModels = (preset.reference_models || []) as Array<{ provider: string; model: string; enabled?: boolean }>;
    const aggregator = preset.aggregator || {};
    const enabled = preset.enabled ?? true;
    const refTemp = preset.reference_temperature;
    const aggTemp = preset.aggregator_temperature;
    const maxTokens = preset.max_tokens ?? 4096;
    const refMaxTokens = preset.reference_max_tokens;
    const refTimeout = preset.reference_timeout;
    const degradedPolicy = preset.degraded_reference_policy;
    const fanout = preset.fanout;

    return (
      <Card key={presetName}>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <CardTitle>{presetName}</CardTitle>
            <Badge variant={enabled ? 'default' : 'secondary'}>
              {enabled ? '已启用' : '未启用'}
            </Badge>
          </div>
          <Button size="sm" onClick={() => openEdit(presetName)}>
            <Pencil className="mr-2 h-3 w-3" />
            编辑
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* 模型配置 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80 border-b pb-1">
              模型配置
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[15%]">类型</TableHead>
                  <TableHead className="w-[12%]">启用</TableHead>
                  <TableHead className="w-[30%]">供应商</TableHead>
                  <TableHead className="w-[43%]">模型</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell>聚合模型</TableCell>
                  <TableCell>—</TableCell>
                  <TableCell className="font-medium">{aggregator.provider || '—'}</TableCell>
                  <TableCell>{aggregator.model || '—'}</TableCell>
                </TableRow>
                {refModels.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={4} className="text-center text-sm text-muted-foreground py-4">
                      未配置参考模型
                    </TableCell>
                  </TableRow>
                ) : (
                  refModels.map((ref: any, idx: number) => (
                    <TableRow key={`ref-${idx}`}>
                      <TableCell>参考模型</TableCell>
                      <TableCell>
                        <Badge variant={(ref.enabled ?? true) ? 'default' : 'secondary'} className="text-xs">
                          {(ref.enabled ?? true) ? '是' : '否'}
                        </Badge>
                      </TableCell>
                      <TableCell className="font-medium">{ref.provider || '—'}</TableCell>
                      <TableCell>{ref.model || '—'}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>

          {/* 参数配置 */}
          <div className="space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold text-foreground/80 border-b pb-1">
              参数配置
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>参考模型温度</TableHead>
                  <TableHead>聚合模型温度</TableHead>
                  <TableHead>聚合 Max Tokens</TableHead>
                  <TableHead>参考 Max Tokens</TableHead>
                  <TableHead>参考超时(秒)</TableHead>
                  <TableHead>失败策略</TableHead>
                  <TableHead>扇出节奏</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-mono">{refTemp ?? '默认'}</TableCell>
                  <TableCell className="font-mono">{aggTemp ?? '默认'}</TableCell>
                  <TableCell className="font-mono">{maxTokens ?? '默认'}</TableCell>
                  <TableCell className="font-mono">{refMaxTokens ?? '默认'}</TableCell>
                  <TableCell className="font-mono">{refTimeout ?? '默认'}</TableCell>
                  <TableCell className="font-mono">{degradedPolicy ?? '默认'}</TableCell>
                  <TableCell className="font-mono">{fanout ?? '默认'}</TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    );
  };

  return (
    <>
      <div className="space-y-4">
        {/* 默认预设卡片 */}
        <Card>
          <CardContent className="pt-5">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>当前默认</TableHead>
                  <TableHead>save_traces</TableHead>
                  <TableHead>trace_dir</TableHead>
                  <TableHead>privacy_filter</TableHead>
                  <TableHead>操作</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                <TableRow>
                  <TableCell className="font-mono">{activePresetName}</TableCell>
                  <TableCell className="font-mono">{saveTraces ? 'true' : 'false'}</TableCell>
                  <TableCell className="font-mono">{traceDir || '默认'}</TableCell>
                  <TableCell className="font-mono">{privacyFilter || '默认'}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Button variant="outline" size="sm" onClick={() => openTopEdit()}>
                        <Pencil className="mr-2 h-3 w-3" />
                        编辑
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => openEdit('')}
                      >
                        <Plus className="mr-2 h-3 w-3" />
                        新增 preset
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        {presetNames.length === 0 && (
          <Card>
            <CardContent className="text-sm text-muted-foreground p-6 text-center">
              暂无 MoA 预设配置
            </CardContent>
          </Card>
        )}
        {presetNames.map((name) => renderPresetCard(name))}
      </div>

      <Dialog open={editOpen} onOpenChange={setEditOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>
              {data?.presets?.[editPreset] ? '编辑多智能体预设' : '新增多智能体预设'}
            </DialogTitle>
            <DialogDescription>配置多智能体的聚合模型和参考模型</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="grid gap-2">
                <Label>preset 名称</Label>
                <Input
                  value={presetFormName}
                  onChange={(e) => setPresetFormName(e.target.value)}
                  disabled={!!editPreset}
                  placeholder="请输入 preset 名称"
                />
              </div>
              <div className="grid gap-2">
                <Label>是否启用</Label>
                <Select
                  value={formData.enabled ? 'true' : 'false'}
                  onValueChange={(value) =>
                    setFormData({ ...formData, enabled: value === 'true' })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="请选择是否启用" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="true">true</SelectItem>
                    <SelectItem value="false">false</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <Card>
              <CardHeader>
                <CardTitle>聚合模型</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>供应商</Label>
                    <Select
                      value={formData.aggregator.provider}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          aggregator: { ...formData.aggregator, provider: value, model: '' },
                        })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="请选择供应商" />
                      </SelectTrigger>
                      <SelectContent>
                        {providerOptions.map((opt) => (
                          <SelectItem key={opt.value} value={opt.value}>
                            {opt.label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>模型</Label>
                    <Select
                      value={formData.aggregator.model}
                      onValueChange={(value) =>
                        setFormData({
                          ...formData,
                          aggregator: { ...formData.aggregator, model: value },
                        })
                      }
                      disabled={aggregatorModelLoading || aggregatorModelOptions.length === 0}
                    >
                      <SelectTrigger>
                        <SelectValue
                          placeholder={aggregatorModelLoading ? '加载中…' : '请选择模型'}
                        />
                      </SelectTrigger>
                      <SelectContent>
                        {aggregatorModelOptions.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>参考模型</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-4">
                  {formData.reference_models.map((ref, idx) => (
                    <div key={idx} className="flex gap-2 items-start">
                      <div className="flex-1 grid gap-2">
                        <Label>供应商</Label>
                        <Select
                          value={ref.provider}
                          onValueChange={(value) => updateRefModel(idx, { provider: value })}
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="请选择供应商" />
                          </SelectTrigger>
                          <SelectContent>
                            {providerOptions.map((opt) => (
                              <SelectItem key={opt.value} value={opt.value}>
                                {opt.label}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex-1 grid gap-2">
                        <Label>模型</Label>
                        <Select
                          value={ref.model}
                          onValueChange={(value) => updateRefModel(idx, { model: value })}
                          disabled={isRefLoading(idx) || getRefModelOptions(idx).length === 0}
                        >
                          <SelectTrigger>
                            <SelectValue
                              placeholder={isRefLoading(idx) ? '加载中…' : '请选择模型'}
                            />
                          </SelectTrigger>
                          <SelectContent>
                            {getRefModelOptions(idx).map((m) => (
                              <SelectItem key={m} value={m}>
                                {m}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      </div>
                      <div className="flex-1 grid gap-2">
                        <Label>启用</Label>
                        <Select
                          value={(ref.enabled ?? true) ? 'true' : 'false'}
                          onValueChange={(value) =>
                            updateRefModel(idx, { enabled: value === 'true' })
                          }
                        >
                          <SelectTrigger>
                            <SelectValue placeholder="请选择是否启用" />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="true">true</SelectItem>
                            <SelectItem value="false">false</SelectItem>
                          </SelectContent>
                        </Select>
                      </div>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => {
                          setFormData((prev) => ({
                            ...prev,
                            reference_models: prev.reference_models.filter((_, i) => i !== idx),
                          }));
                          setRefModelOptionsMap((prev) => {
                            const next: Record<number, string[]> = {};
                            Object.keys(prev).forEach((k) => {
                              const key = parseInt(k);
                              if (key < idx) next[key] = prev[key];
                              else if (key > idx) next[key - 1] = prev[key];
                            });
                            return next;
                          });
                        }}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ))}
                </div>
                <Button
                  variant="outline"
                  onClick={() => {
                    setFormData((prev) => ({
                      ...prev,
                      reference_models: [
                        ...prev.reference_models,
                        { provider: '', model: '', enabled: true },
                      ],
                    }));
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  添加参考模型
                </Button>
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>参数配置</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div className="grid gap-2">
                    <Label>参考模型温度</Label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={formData.reference_temperature}
                      onChange={(e) =>
                        setFormData({ ...formData, reference_temperature: parseFloat(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>聚合模型温度</Label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      max="2"
                      value={formData.aggregator_temperature}
                      onChange={(e) =>
                        setFormData({ ...formData, aggregator_temperature: parseFloat(e.target.value) || 0 })
                      }
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>聚合 Max Tokens</Label>
                    <Input
                      type="number"
                      min="1"
                      value={formData.max_tokens}
                      onChange={(e) => setFormData({ ...formData, max_tokens: parseInt(e.target.value) || 0 })}
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>参考 Max Tokens</Label>
                    <Input
                      type="number"
                      min="1"
                      value={formData.reference_max_tokens}
                      onChange={(e) =>
                        setFormData({ ...formData, reference_max_tokens: parseInt(e.target.value) || 0 })
                      }
                      placeholder="0 表示无限制"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>参考模型超时(秒)</Label>
                    <Input
                      type="number"
                      step="0.1"
                      min="0"
                      value={formData.reference_timeout}
                      onChange={(e) =>
                        setFormData({ ...formData, reference_timeout: parseFloat(e.target.value) || 0 })
                      }
                      placeholder="空=不限制"
                    />
                  </div>
                  <div className="grid gap-2">
                    <Label>参考失败策略</Label>
                    <Select
                      value={formData.degraded_reference_policy}
                      onValueChange={(value) =>
                        setFormData({ ...formData, degraded_reference_policy: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="请选择策略" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="loud">loud</SelectItem>
                        <SelectItem value="silent">silent</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid gap-2">
                    <Label>扇出节奏</Label>
                    <Select
                      value={formData.fanout}
                      onValueChange={(value) =>
                        setFormData({ ...formData, fanout: value })
                      }
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="请选择扇出节奏" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="user_turn">user_turn</SelectItem>
                        <SelectItem value="per_iteration">per_iteration</SelectItem>
                        <SelectItem value="every_n:2">every_n:2</SelectItem>
                        <SelectItem value="every_n:3">every_n:3</SelectItem>
                        <SelectItem value="every_n:4">every_n:4</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSave} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={topEditOpen} onOpenChange={setTopEditOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>编辑 MoA 顶层配置</DialogTitle>
            <DialogDescription>修改 MoA 顶层配置项</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            <div className="grid gap-2">
              <Label>默认预设</Label>
              <Select
                value={topForm.default_preset}
                onValueChange={(value) => setTopForm({ ...topForm, default_preset: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择默认预设" />
                </SelectTrigger>
                <SelectContent>
                  {presetNames.map((name) => (
                    <SelectItem key={name} value={name}>
                      {name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>记录轨迹</Label>
              <Select
                value={topForm.save_traces ? 'true' : 'false'}
                onValueChange={(value) => setTopForm({ ...topForm, save_traces: value === 'true' })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择是否记录轨迹" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">true</SelectItem>
                  <SelectItem value="false">false</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label>轨迹目录</Label>
              <Input
                value={topForm.trace_dir}
                onChange={(e) => setTopForm({ ...topForm, trace_dir: e.target.value })}
                placeholder="空=<hermes_home>/moa-traces/"
              />
            </div>
            <div className="grid gap-2">
              <Label>隐私过滤</Label>
              <Select
                value={topForm.privacy_filter}
                onValueChange={(value) => setTopForm({ ...topForm, privacy_filter: value })}
              >
                <SelectTrigger>
                  <SelectValue placeholder="请选择隐私过滤级别" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="">关闭</SelectItem>
                  <SelectItem value="display">display</SelectItem>
                  <SelectItem value="full">full</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setTopEditOpen(false)}>
              取消
            </Button>
            <Button onClick={handleSaveTop} disabled={topSaving}>
              {topSaving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

    </>
  );
}

export default function ModelsConfig() {
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();
  const [activeTab, setActiveTab] = useState('providers');

  const fetchModels = useCallback(
    () => apiClient.get<ModelsData>('/models', { params: { profile: activeProfile } }).then((res) => res.data),
    [activeProfile],
  );

  const { data, loading, error, execute } = useApi(fetchModels, [activeProfile]);
  // 写操作后强制绕过前端 GET 缓存刷新，其它 Tab 通过 onReload 复用同一刷新逻辑
  const reload = useCallback(() => execute(true), [execute]);

  const handleSaveModel = async (values: any) => {
    await apiClient.put('/models/model', values, { params: { profile: activeProfile } });
    reload();
  };

  if (loading) {
    return (
      <PageContainer>
        <Loading className="py-12" />
      </PageContainer>
    );
  }

  return (
    <PageContainer>
      <PageHeader />

      {error && <ErrorAlert message={error} />}

      <div className="flex gap-2 border-b">
        {[
          { key: 'providers', label: '供应商' },
          { key: 'main', label: '主模型' },
          { key: 'aux', label: '辅助模型' },
          { key: 'fallback', label: '回退模型' },
          { key: 'moa', label: '多智能体' },
        ].map((tab) => {
          const isActive = activeTab === tab.key;
          return (
            <button
              key={tab.key}
              onClick={() => setActiveTab(tab.key)}
              className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                isActive
                  ? 'tab-active'
                  : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'providers' && (
        <ProvidersTab activeProfile={activeProfile} onReload={reload} modelsData={data} />
      )}
      {activeTab === 'main' && (
        <MainModelTab
          modelData={data?.model ?? {}}
          activeProfile={activeProfile}
          onSave={handleSaveModel}
        />
      )}
      {activeTab === 'aux' && (
        <AuxTab data={data?.auxiliary ?? {}} activeProfile={activeProfile} onReload={reload} />
      )}
      {activeTab === 'fallback' && (
        <FallbackTab data={data?.fallback_providers ?? []} activeProfile={activeProfile} onReload={reload} />
      )}
      {activeTab === 'moa' && (
        <MoATab data={data?.moa} activeProfile={activeProfile} onReload={reload} />
      )}
    </PageContainer>
  );
}

