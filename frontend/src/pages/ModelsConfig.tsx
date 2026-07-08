import { useCallback, useEffect, useState } from 'react';
import {
  Alert, AutoComplete, Button, Card, Form, Input, InputNumber, Modal, Select, Space, Spin, Table, Tag,
  App as AntApp, Tabs, Typography, Tooltip,
} from 'antd';
import PageHeader from '../components/PageHeader';
import ProviderEditModal from '../components/ProviderEditModal';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';

const { Text } = Typography;

// ── Types ──────────────────────────────────────────────

interface ModelConfig {
  default?: string;
  provider?: string;
  base_url?: string;
  context_length?: number;
}

interface ModelsData {
  model: ModelConfig;
  auxiliary: Record<string, any>;
  fallback_providers: Array<{ provider: string; model: string }>;
  custom_providers: Array<{
    name: string;
    base_url?: string;
    key_env?: string;
    api_key?: string;
    api_mode?: string;
    models?: Record<string, { context_length?: number; [key: string]: unknown }>;
    [key: string]: unknown;
  }>;
  providers: Record<string, unknown>;
  models: Record<string, { context_length?: number; [key: string]: unknown }>;
  model_catalog: { enabled?: boolean; url?: string; ttl_hours?: number; providers?: Record<string, unknown> };
  moa: {
    default_preset?: string;
    active_preset?: string;
    presets?: Record<string, any>;
    reference_models?: Array<{ provider: string; model: string }>;
    aggregator?: { provider: string; model: string };
    reference_temperature?: number;
    aggregator_temperature?: number;
    max_tokens?: number;
    reference_max_tokens?: number;
    enabled?: boolean;
  };
}

// ── Helpers ────────────────────────────────────────────

const AUX_LABELS: Record<string, string> = {
  vision: 'Vision', web_extract: 'Web Extract', compression: 'Compression',
  skills_hub: 'Skills Hub', approval: 'Approval', mcp: 'MCP',
  title_generation: 'Title Generation', tts_audio_tags: 'TTS Audio Tags',
};



// ── Provider 预设类型 ──────────────────────────────────

export interface ProviderPreset {
  id: string;
  name: string;
  base_url: string;
  base_url_env_var: string;
  transport: string;
  auth_type: string;
  key_env: string;
}

// ── Tab: Provider 列表 ────────────────────────────────

interface ProviderInfo {
  name: string;
  source: 'main' | 'custom' | 'env';
  base_url: string;
  key_env: string;
  api_mode?: string;
  has_key: boolean;
}

interface CustomProviderConfig {
  name: string;
  base_url: string;
  key_env: string;
  api_key: string;
  api_mode?: string;
  models?: Record<string, { context_length?: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export const PROVIDER_TEMPLATES: Array<{ name: string; baseUrl: string; keyEnv: string }> = [
  { name: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY' },
  { name: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', keyEnv: 'DEEPSEEK_API_KEY' },
  { name: 'groq', baseUrl: 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY' },
  { name: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY' },
  { name: 'google', baseUrl: 'https://generativelanguage.googleapis.com/v1', keyEnv: 'GOOGLE_API_KEY' },
  { name: 'azure', baseUrl: 'https://YOUR_REGION.openai.azure.com/openai/deployments/YOUR_DEPLOYMENT_NAME', keyEnv: 'AZURE_OPENAI_KEY' },
  { name: 'custom', baseUrl: '', keyEnv: '' },
];

function ProvidersTab({
  activeProfile, onReload, modelOptions,
}: {
  activeProfile: string;
  onReload: () => void;
  modelOptions: string[];
}) {
  const { message, modal } = AntApp.useApp();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [customItems, setCustomItems] = useState<CustomProviderConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, { loading: boolean; models: string[]; error?: string }>>({});
  const [editOpen, setEditOpen] = useState(false);
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [editInitialData, setEditInitialData] = useState<{ name: string; base_url: string; key_env?: string; api_key?: string; api_mode?: string } | undefined>();
  // 预设模式相关状态
  const [presets, setPresets] = useState<ProviderPreset[]>([]);
  const [presetsLoading, setPresetsLoading] = useState(false);
  const [editMode, setEditMode] = useState<'preset' | 'custom'>('preset');
  const [selectedPreset, setSelectedPreset] = useState<string | null>(null);

  // Load providers from API
  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      const [{ data: provData }, { data: modelsData }] = await Promise.all([
        apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', { params: { profile: activeProfile } }),
        apiClient.get<ModelsData>('/models', { params: { profile: activeProfile } }),
      ]);
      setProviders(provData.providers ?? []);
      setCustomItems((modelsData.custom_providers ?? []).map((p: any) => ({
        ...p,
        name: p.name ?? '',
        base_url: p.base_url ?? '',
        key_env: p.key_env ?? '',
        api_key: p.api_key ?? '',
        api_mode: p.api_mode ?? '',
      })));
    } catch { message.error('加载失败'); }
    finally { setLoading(false); }
  }, [activeProfile]);

  useEffect(() => { loadData(); }, [loadData]);

  // 加载预设列表
  const loadPresets = useCallback(async () => {
    console.log('loadPresets called, current presets length:', presets.length);
    if (presets.length > 0) return; // 已加载
    setPresetsLoading(true);
    try {
      const { data } = await apiClient.get<{ presets: ProviderPreset[] }>('/models/provider-presets');
      console.log('API response:', data);
      setPresets(data.presets ?? []);
      console.log('Presets set, new length:', data.presets?.length);
    } catch (err) {
      console.error('loadPresets failed:', err);
      // 加载失败时使用硬编码的预设
      setPresets(PROVIDER_TEMPLATES.filter(t => t.name !== 'custom').map(t => ({
        id: t.name,
        name: t.name,
        base_url: t.baseUrl,
        base_url_env_var: '',
        transport: 'openai_chat',
        auth_type: 'api_key',
        key_env: t.keyEnv,
      })));
    } finally {
      setPresetsLoading(false);
    }
  }, [presets.length]);

  const loadProviderModels = useCallback(async (providerName: string) => {
    setProviderModels((prev) => ({
      ...prev,
      [providerName]: { loading: true, models: prev[providerName]?.models ?? [], error: undefined },
    }));
    try {
      const { data } = await apiClient.get<{ models: string[]; error?: string }>(
        `/models/providers/${encodeURIComponent(providerName)}/models`,
        { params: { profile: activeProfile }, timeout: 30000 },
      );
      setProviderModels((prev) => ({
        ...prev,
        [providerName]: {
          loading: false,
          models: Array.isArray(data.models) ? data.models : [],
          error: data.error || undefined,
        },
      }));
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      const msg = err?.code === 'ECONNABORTED' ? '获取模型超时' : (detail || '请求失败');
      setProviderModels((prev) => ({
        ...prev,
        [providerName]: { loading: false, models: [], error: msg },
      }));
    }
  }, [activeProfile]);

  useEffect(() => {
    if (!providers.length) return;
    providers.forEach((p) => {
      if (!providerModels[p.name]) {
        loadProviderModels(p.name);
      }
    });
  }, [providers, providerModels, loadProviderModels]);

  const saveCustomProviders = async (items: CustomProviderConfig[]) => {
    setSaving(true);
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
        }));
      await apiClient.put('/models/custom_providers', clean, { params: { profile: activeProfile } });
      message.success('已保存');
      loadData();
    } catch { message.error('保存失败'); }
    finally { setSaving(false); }
  };

  const openCreate = () => {
    setEditIndex(null);
    setEditInitialData(undefined);
    setEditMode('preset');
    setSelectedPreset(null);
    setEditOpen(true);
    loadPresets();
  };

  const openEdit = (row: ProviderInfo) => {
    const idx = customItems.findIndex((c) => c.name === row.name);
    setEditIndex(idx >= 0 ? idx : null);
    setEditInitialData(idx >= 0 ? customItems[idx] : {
      name: row.name,
      base_url: row.base_url,
      key_env: row.key_env,
      api_key: '',
      api_mode: row.api_mode || '',
    });
    setEditOpen(true);
  };

  const handleDelete = (row: ProviderInfo) => {
    modal.confirm({
      title: `删除 Provider: ${row.name}`,
      content: '确认删除该 Provider 吗？这会移除对应的 Provider 配置、主模型绑定和相关环境变量。',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.delete(`/models/providers/${encodeURIComponent(row.name)}`, {
            params: { profile: activeProfile },
          });
          message.success(`${row.name} 已删除`);
          await loadData();
        } catch (error: any) {
          message.error(error?.response?.data?.detail || '删除失败');
        }
      },
    });
  };

  const handleEditSubmit = async (values: { name: string; base_url: string; key_env?: string; api_key?: string; api_mode?: string }) => {
    const payload: CustomProviderConfig = {
      name: values.name?.trim() || '',
      base_url: values.base_url?.trim() || '',
      key_env: values.key_env?.trim() || '',
      api_key: values.api_key || '',
      api_mode: values.api_mode?.trim() || '',
    };
    if (!payload.name || !payload.base_url) {
      message.warning('名称和 Base URL 必填');
      return;
    }

    const next = [...customItems];
    if (editIndex == null) {
      const existingIdx = next.findIndex((item) => item.name === payload.name);
      if (existingIdx >= 0) {
        next[existingIdx] = { ...next[existingIdx], ...payload };
      } else {
        next.push(payload);
      }
    } else {
      next[editIndex] = { ...next[editIndex], ...payload };
    }
    await saveCustomProviders(next);
    setEditOpen(false);
  };

  const sourceLabel = (s: string) =>
    s === 'main' ? '主 Provider' : s === 'custom' ? '自定义' : '已配置';

  const rows = providers;

  return (
    <Spin spinning={loading}>
      <Card
        title="Provider 列表"
        extra={<Button type="primary" onClick={openCreate}>新增 Provider</Button>}
      >
        <Table
          rowKey="name"
          size="small"
          pagination={false}
          dataSource={rows}
          locale={{ emptyText: '暂无 Provider 配置' }}
          columns={[
            {
              title: 'Provider',
              dataIndex: 'name',
              width: '12%',
              minWidth: 100,
              render: (v: string) => <Text>{v}</Text>,
            },
            {
              title: 'Base URL',
              dataIndex: 'base_url',
              width: '22%',
              minWidth: 160,
              ellipsis: { showTitle: false },
              render: (v: string, row: ProviderInfo) => (
                <Tooltip title={v || (row.source === 'env' ? '(默认地址)' : '—')}>
                  <Text>{v || (row.source === 'env' ? '(默认地址)' : '—')}</Text>
                </Tooltip>
              ),
            },
            {
              title: 'API Mode',
              dataIndex: 'api_mode',
              width: '10%',
              minWidth: 120,
              render: (v?: string) => <Text>{v || '—'}</Text>,
            },
            {
              title: 'Key',
              width: '12%',
              minWidth: 150,
              render: (_: unknown, row: ProviderInfo) => (
                <Text>{row.has_key ? (row.key_env || '已配置') : '未配置'}</Text>
              ),
            },
            {
              title: 'Model List',
              width: '30%',
              minWidth: 200,
              render: (_: unknown, row: ProviderInfo) => {
                const state = providerModels[row.name];
                if (!state || state.loading) {
                  return <Text>加载中...</Text>;
                }
                if (state.error) {
                  return <Text>{state.error}</Text>;
                }
                if (!state.models.length) {
                  return <Text>—</Text>;
                }
                return (
                  <Tooltip title={state.models.join(', ')}>
                    <Space wrap size={4}>
                      {state.models.slice(0, 10).map((model) => (
                        <Tag key={model}>{model}</Tag>
                      ))}
                      {state.models.length > 10 && (
                        <Tag color="default">+{state.models.length - 10}</Tag>
                      )}
                    </Space>
                  </Tooltip>
                );
              },
            },
            {
              title: '操作',
              width: '12%',
              minWidth: 120,
              render: (_: unknown, row: ProviderInfo) => (
                <Space>
                  <Button size="small" onClick={() => openEdit(row)}>编辑</Button>
                  <Button size="small" danger onClick={() => handleDelete(row)}>删除</Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <ProviderEditModal
        open={editOpen}
        isEditing={!!editInitialData}
        editIndex={editIndex}
        initialData={editInitialData}
        presets={presets}
        presetsLoading={presetsLoading}
        onCancel={() => {
          setEditOpen(false);
          setEditInitialData(undefined);
        }}
        onSubmit={handleEditSubmit}
      />
    </Spin>
  );
}

// ── Tab: 主模型配置 ────────────────────────────────────

function MainModelTab({
  modelData, modelOptions, activeProfile, onSave, saving,
}: {
  modelData: ModelConfig;
  modelOptions: string[];
  activeProfile: string;
  onSave: (values: ModelConfig) => Promise<void>;
  saving: boolean;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerModelOptions, setProviderModelOptions] = useState<string[]>([]);
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [form] = Form.useForm();

  const providerOptions = providers.map((p) => ({
    label: p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
    baseUrl: p.base_url || '',
  }));

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const { data } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(data.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const loadModelsForProvider = useCallback(async (providerValue: string | undefined) => {
    if (!providerValue) {
      setProviderModelOptions([]);
      return;
    }
    const providerName = providerValue.replace(/^custom:/, '');
    setProviderModelsLoading(true);
    try {
      const { data } = await apiClient.get<{ models: string[]; error?: string }>(
        `/models/providers/${encodeURIComponent(providerName)}/models`,
        { params: { profile: activeProfile } },
      );
      const list = Array.isArray(data.models) ? data.models : [];
      setProviderModelOptions(list);
    } catch {
      setProviderModelOptions([]);
    } finally {
      setProviderModelsLoading(false);
    }
  }, [activeProfile]);

  const openEdit = () => {
    const currentProvider = modelData.provider || undefined;
    form.setFieldsValue({
      provider: currentProvider,
      model: modelData.default || undefined,
      context_length: modelData.context_length ?? undefined,
    });
    setEditOpen(true);
    loadModelsForProvider(currentProvider);
  };

  const handleEditSave = async (values: { provider?: string; model?: string; context_length?: number }) => {
    const selected = providerOptions.find((o) => o.value === values.provider);
    await onSave({
      provider: values.provider || undefined,
      default: values.model || undefined,
      base_url: selected?.baseUrl || undefined,
      context_length: values.context_length ?? undefined,
    });
    setEditOpen(false);
  };

  const selectedProvider = providerOptions.find((p) => p.value === modelData.provider);
  const currentBaseUrl = selectedProvider?.baseUrl || modelData.base_url || '—';
  const mainModelOptions = (providerModelOptions.length > 0 ? providerModelOptions : modelOptions)
    .map((m) => ({ value: m }));

  const summaryRows = [
    { key: 'provider', label: 'Provider', value: modelData.provider || '—' },
    { key: 'model', label: 'Model', value: modelData.default || '—' },
    { key: 'base_url', label: 'Base URL', value: currentBaseUrl },
    { key: 'context_length', label: '上下文长度', value: modelData.context_length ?? '—' },
  ];

  return (
    <Card
      title="主模型"
      extra={<Button onClick={openEdit}>编辑</Button>}
    >
      <Table
        rowKey="key"
        size="small"
        bordered
        pagination={false}
        showHeader={false}
        dataSource={summaryRows}
        columns={[
          {
            dataIndex: 'label',
            width: 160,
            render: (v: string) => <Text>{v}</Text>,
          },
          {
            dataIndex: 'value',
            render: (v: string | number) => <Text>{v}</Text>,
          },
        ]}
      />

      <Modal
        title="编辑主模型"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="保存"
        destroyOnHidden
      >
        <Form form={form} layout="vertical" onFinish={handleEditSave} style={{ marginTop: 8 }}>
          <Form.Item name="provider" label="Provider" rules={[{ required: true, message: '请选择 Provider' }]}>
            <Select
              loading={providersLoading}
              options={providerOptions.map((o) => ({ label: o.label, value: o.value }))}
              placeholder="请选择 Provider"
              onChange={(v) => {
                form.setFieldValue('model', undefined);
                loadModelsForProvider(v);
              }}
            />
          </Form.Item>
          <Form.Item name="model" label="Model" rules={[{ required: true, message: '请输入或选择模型' }]}>
            <AutoComplete
              options={mainModelOptions}
              filterOption={(inputValue, option) =>
                String(option?.value || '').toLowerCase().includes(inputValue.toLowerCase())
              }
              placeholder={providerModelsLoading ? '加载模型列表中（也可手动输入）' : '可选择或手动输入模型名'}
            >
              <Input />
            </AutoComplete>
          </Form.Item>
          <Form.Item name="context_length" label="上下文长度">
            <InputNumber style={{ width: '100%' }} min={1} placeholder="256000" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}

// ── Tab: 辅助模型 ──────────────────────────────────────

function AuxTab({ data, activeProfile, onReload }: { data: Record<string, any>; activeProfile: string; onReload: () => void }) {
  const { message } = AntApp.useApp();
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState<string | null>(null);
  const [fullData, setFullData] = useState<Record<string, any>>({});
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm();

  const openEditor = async (name: string) => {
    try {
      const { data: fullData } = await apiClient.get('/config/sections/auxiliary', { params: { profile: activeProfile } });
      const auxData = (fullData || {}) as Record<string, any>;
      setFullData(auxData);
      setEditName(name);
      setEditOpen(true);
      form.setFieldsValue({ submodule: name, ...(auxData?.[name] ?? data[name] ?? {}) });
      const currentProvider = (auxData?.[name] ?? data[name] ?? {})?.provider;
      if (currentProvider) {
        loadModelsForProvider(currentProvider);
      }
    } catch {
      const fallbackData = data ?? {};
      setFullData(fallbackData);
      setEditName(name);
      setEditOpen(true);
      form.setFieldsValue({ submodule: name, ...(fallbackData?.[name] ?? {}) });
      const currentProvider = (fallbackData?.[name] ?? {})?.provider;
      if (currentProvider) {
        loadModelsForProvider(currentProvider);
      }
    }
  };

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const { data: res } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(res.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const loadModelsForProvider = useCallback(async (providerValue: string | undefined) => {
    if (!providerValue) {
      return;
    }
    const providerName = providerValue.replace(/^custom:/, '');
    if (providerModels[providerName]?.length) {
      return;
    }
    setProviderModelsLoading(true);
    try {
      const { data: res } = await apiClient.get<{ models: string[] }>(
        `/models/providers/${encodeURIComponent(providerName)}/models`,
        { params: { profile: activeProfile } },
      );
      setProviderModels((prev) => ({ ...prev, [providerName]: Array.isArray(res.models) ? res.models : [] }));
    } catch {
      setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
    } finally {
      setProviderModelsLoading(false);
    }
  }, [activeProfile, providerModels]);

  const handleSave = async (values: any) => {
    const targetName = values.submodule || editName;
    if (!targetName) return;
    setSaving(true);
    try {
      const aux = { ...fullData } as Record<string, any>;
      const merged = { ...(aux[targetName] ?? {}), ...values };
      delete merged.submodule;
      aux[targetName] = merged;
      await apiClient.put('/models/auxiliary', aux, { params: { profile: activeProfile } });
      message.success('已保存');
      setEditOpen(false);
      onReload();
    } catch { message.error('保存失败'); }
    finally { setSaving(false); }
  };

  const rows = Object.entries(data ?? {}).map(([name, cfg]: [string, any]) => ({ name, ...cfg }));
  const submoduleOptions = rows.map((row) => ({ label: AUX_LABELS[row.name] || row.name, value: row.name }));
  const providerOptions = providers.map((p) => ({
    label: p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
  }));
  const watchedProvider = Form.useWatch('provider', form);
  const watchedProviderName = (watchedProvider || '').replace(/^custom:/, '');
  const modelOptions = watchedProviderName ? (providerModels[watchedProviderName] || []) : [];

  return (
    <>
      <Card
        title="辅助模型"
        extra={<Button onClick={() => openEditor(rows[0]?.name || Object.keys(data ?? {})[0] || '')} disabled={!rows.length}>编辑</Button>}
      >
        <Table
          rowKey="name"
          dataSource={rows}
          pagination={false}
          size="small"
          bordered
          locale={{ emptyText: '暂无辅助模型配置' }}
          columns={[
            { title: '子模块', dataIndex: 'name', width: '20%', minWidth: 100, render: (v: string) => <Text>{AUX_LABELS[v] || v}</Text> },
            { title: 'Provider', dataIndex: 'provider', width: '20%', minWidth: 100, render: (v: string) => <Text>{v || '—'}</Text> },
            { title: 'Model', dataIndex: 'model', width: '45%', minWidth: 140, ellipsis: true, render: (v: string) => <Text>{v || '—'}</Text> },
            { title: '超时(秒)', dataIndex: 'timeout', width: '15%', minWidth: 80, render: (v: string | number) => <Text>{v ?? '—'}</Text> },
          ]}
        />
      </Card>
      <Modal
        title="编辑辅助模型"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="保存"
        width={680}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSave}
          style={{ marginTop: 8 }}
        >
          <Form.Item name="submodule" label="子模块" rules={[{ required: true, message: '请选择子模块' }]}>
            <Select
              placeholder="请选择子模块"
              options={submoduleOptions}
              onChange={(v) => {
                setEditName(v);
                const nextValues = { submodule: v, ...(fullData?.[v] ?? data?.[v] ?? {}) };
                form.setFieldsValue(nextValues);
                if (nextValues.provider) {
                  loadModelsForProvider(nextValues.provider);
                }
              }}
            />
          </Form.Item>
          <Form.Item name="provider" label="Provider" rules={[{ required: true, message: '请选择 Provider' }]}>
            <Select
              loading={providersLoading}
              placeholder="请选择 Provider"
              options={providerOptions}
              onChange={(v) => {
                form.setFieldValue('model', undefined);
                loadModelsForProvider(v);
              }}
            />
          </Form.Item>
          <Form.Item name="model" label="Model" rules={[{ required: true, message: '请选择模型' }]}>
            <Select
              showSearch
              loading={providerModelsLoading}
              placeholder="请选择模型"
              notFoundContent={watchedProviderName ? '暂无模型' : '先选 Provider'}
              options={modelOptions.map((m) => ({ label: m, value: m }))}
            />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

// ── Tab: Fallback ──────────────────────────────────────

function FallbackTab({ data, activeProfile, onReload }: { data: Array<{ provider: string; model: string }>; activeProfile: string; onReload: () => void }) {
  const { message } = AntApp.useApp();
  const [items, setItems] = useState<Array<{ key: string; provider: string; model: string }>>([]);
  const [editOpen, setEditOpen] = useState(false);
  const [editItems, setEditItems] = useState<Array<{ key: string; provider: string; model: string }>>([]);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setItems((data || []).map((item, i) => ({ key: `${item.provider || 'p'}-${i}`, ...item })));
  }, [data]);

  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const { data: res } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(res.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  const providerOptions = providers.map((p) => ({
    label: p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
  }));

  const loadModelsForProvider = useCallback(async (providerValue: string | undefined) => {
    if (!providerValue) {
      return;
    }
    const providerName = providerValue.replace(/^custom:/, '');
    if (providerModels[providerName]?.length) {
      return;
    }
    setProviderModelsLoading(true);
    try {
      const { data: res } = await apiClient.get<{ models: string[] }>(
        `/models/providers/${encodeURIComponent(providerName)}/models`,
        { params: { profile: activeProfile } },
      );
      setProviderModels((prev) => ({ ...prev, [providerName]: Array.isArray(res.models) ? res.models : [] }));
    } catch {
      setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
    } finally {
      setProviderModelsLoading(false);
    }
  }, [activeProfile, providerModels]);

  const openEdit = () => {
    const cloned = items.map((i) => ({ ...i }));
    setEditItems(cloned.length ? cloned : [{ key: `new-${Date.now()}`, provider: '', model: '' }]);
    setEditOpen(true);
    cloned.forEach((row) => {
      if (row.provider) loadModelsForProvider(row.provider);
    });
  };

  const addEditRow = () => {
    setEditItems((prev) => [...prev, { key: `new-${Date.now()}-${prev.length}`, provider: '', model: '' }]);
  };

  const removeEditRow = (key: string) => {
    setEditItems((prev) => prev.filter((r) => r.key !== key));
  };

  const updateEditRow = (key: string, patch: Partial<{ provider: string; model: string }>) => {
    setEditItems((prev) => prev.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = editItems
        .map((r) => ({ provider: r.provider || '', model: r.model || '' }))
        .filter((i) => i.provider || i.model);
      await apiClient.put('/models/fallback_providers', payload, { params: { profile: activeProfile } });
      message.success('已保存');
      setEditOpen(false);
      onReload();
    } catch {
      message.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Card
        title="Fallback Providers"
        extra={<Button onClick={openEdit}>编辑</Button>}
      >
        {items.length === 0 ? (
          <Text>暂未配置 Fallback Providers</Text>
        ) : (
          <Table
            rowKey="key"
            size="small"
            bordered
            pagination={false}
            dataSource={items}
            columns={[
              { title: 'Provider', dataIndex: 'provider', render: (v: string) => <Text>{v || '—'}</Text> },
              { title: 'Model', dataIndex: 'model', render: (v: string) => <Text>{v || '—'}</Text> },
            ]}
          />
        )}
      </Card>

      <Modal
        title="编辑 Fallback"
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={handleSave}
        confirmLoading={saving}
        okText="保存"
        width={760}
        destroyOnHidden
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Text style={{ fontSize: 13 }}>配置多个 Fallback Provider，按顺序依次尝试。</Text>
            <Button size="small" onClick={addEditRow}>新增一行</Button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '240px 1fr 64px',
              gap: 8,
              padding: '0 12px',
            }}
          >
            <Text type="secondary">Provider</Text>
            <Text type="secondary">Model</Text>
            <Text type="secondary" style={{ textAlign: 'center' }}>操作</Text>
          </div>

          {editItems.map((row) => {
            const providerName = (row.provider || '').replace(/^custom:/, '');
            const models = providerName ? (providerModels[providerName] || []) : [];
            return (
              <div
                key={row.key}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '240px 1fr 64px',
                  gap: 8,
                  alignItems: 'center',
                  border: '1px solid #f0f0f0',
                  borderRadius: 8,
                  padding: 10,
                  background: '#fafafa',
                }}
              >
                <Select
                  style={{ width: '100%' }}
                  loading={providersLoading}
                  placeholder="请选择 Provider"
                  value={row.provider || undefined}
                  options={providerOptions}
                  onChange={(v) => {
                    updateEditRow(row.key, { provider: v, model: '' });
                    loadModelsForProvider(v);
                  }}
                />
                <Select
                  style={{ width: '100%' }}
                  showSearch
                  loading={providerModelsLoading && providerName.length > 0}
                  placeholder="请选择模型"
                  value={row.model || undefined}
                  notFoundContent={providerName ? '暂无模型' : '先选 Provider'}
                  options={models.map((m) => ({ label: m, value: m }))}
                  onChange={(v) => updateEditRow(row.key, { model: v })}
                />
                <Button size="small" danger onClick={() => removeEditRow(row.key)} style={{ justifySelf: 'center' }}>删除</Button>
              </div>
            );
          })}
          {editItems.length === 0 && (
            <div style={{ border: '1px dashed #d9d9d9', borderRadius: 8, padding: 20, textAlign: 'center' }}>
              <Text type="secondary">暂无配置，点击“新增一行”添加。</Text>
            </div>
          )}
        </div>
      </Modal>
    </>
  );
}

// ── Tab: MoA (Mixture of Agents) ──────────────────────────────────────

function MoATab({ data, activeProfile, onReload }: { data: any; activeProfile: string; onReload: () => void }) {
  const { message } = AntApp.useApp();
  const [editOpen, setEditOpen] = useState(false);
  const [editPreset, setEditPreset] = useState<string>('default');
  const [form] = Form.useForm();
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const [providerModels, setProviderModels] = useState<Record<string, string[]>>({});
  const [providerModelsLoading, setProviderModelsLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  // 加载 providers
  const loadProviders = useCallback(async () => {
    setProvidersLoading(true);
    try {
      const { data: res } = await apiClient.get<{ providers: ProviderInfo[] }>('/models/providers', {
        params: { profile: activeProfile },
      });
      setProviders(res.providers ?? []);
    } catch {
      setProviders([]);
    } finally {
      setProvidersLoading(false);
    }
  }, [activeProfile]);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  // 加载指定 provider 的模型列表
  const loadModelsForProvider = useCallback(async (providerValue: string | undefined) => {
    if (!providerValue) return;
    const providerName = providerValue.replace(/^custom:/, '');
    if (providerModels[providerName]?.length) return;
    
    setProviderModelsLoading(true);
    try {
      const { data: res } = await apiClient.get<{ models: string[] }>(
        `/models/providers/${encodeURIComponent(providerName)}/models`,
        { params: { profile: activeProfile } },
      );
      setProviderModels((prev) => ({ ...prev, [providerName]: Array.isArray(res.models) ? res.models : [] }));
    } catch {
      setProviderModels((prev) => ({ ...prev, [providerName]: [] }));
    } finally {
      setProviderModelsLoading(false);
    }
  }, [activeProfile, providerModels]);

  // 获取当前激活的 preset
  const activePresetName = data?.active_preset || data?.default_preset || 'default';
  const activePreset = data?.presets?.[activePresetName] || {};
  
  // 显示信息
  const refModels = activePreset.reference_models || [];
  const aggregator = activePreset.aggregator || {};
  const refTemp = activePreset.reference_temperature ?? 0.6;
  const aggTemp = activePreset.aggregator_temperature ?? 0.4;
  const maxTokens = activePreset.max_tokens ?? 4096;
  const refMaxTokens = activePreset.reference_max_tokens;
  const enabled = activePreset.enabled ?? true;

  // 打开编辑弹窗
  const openEdit = (presetName: string) => {
    setEditPreset(presetName);
    const preset = data?.presets?.[presetName] || {};
    form.setFieldsValue({
      enabled: preset.enabled ?? true,
      aggregator: preset.aggregator || { provider: '', model: '' },
      reference_models: preset.reference_models || [],
      reference_temperature: preset.reference_temperature ?? 0.6,
      aggregator_temperature: preset.aggregator_temperature ?? 0.4,
      max_tokens: preset.max_tokens ?? 4096,
      reference_max_tokens: preset.reference_max_tokens,
    });
    setEditOpen(true);
    
    // 预加载已配置 provider 的模型列表
    if (preset.aggregator?.provider) {
      loadModelsForProvider(preset.aggregator.provider);
    }
    (preset.reference_models || []).forEach((ref: any) => {
      if (ref.provider) loadModelsForProvider(ref.provider);
    });
  };

  // 保存 MoA 配置
  const handleSave = async (values: any) => {
    setSaving(true);
    try {
      const updatedPresets = { ...data?.presets };
      updatedPresets[editPreset] = {
        ...updatedPresets[editPreset],
        enabled: values.enabled,
        aggregator: values.aggregator,
        reference_models: values.reference_models,
        reference_temperature: values.reference_temperature,
        aggregator_temperature: values.aggregator_temperature,
        max_tokens: values.max_tokens,
        reference_max_tokens: values.reference_max_tokens,
      };
      
      await apiClient.put('/models/moa', {
        ...data,
        presets: updatedPresets,
      }, { params: { profile: activeProfile } });
      
      message.success('MoA 配置已保存');
      setEditOpen(false);
      onReload();
    } catch {
      message.error('保存失败');
    } finally {
      setSaving(false);
    }
  };

  const providerOptions = providers.map((p) => ({
    label: p.name,
    value: p.source === 'custom' ? `custom:${p.name}` : p.name,
  }));

  return (
    <>
      <Card
        title="MoA (Mixture of Agents)"
        extra={
          <Space>
            <Tag color={enabled ? 'green' : 'default'}>{enabled ? '已启用' : '已禁用'}</Tag>
            <Button onClick={() => openEdit(activePresetName)}>
              编辑预设
            </Button>
          </Space>
        }
      >
        <Space direction="vertical" style={{ width: '100%' }} size="middle">
          <div>
            <Text strong>当前预设：</Text>
            <Tag color="blue">{activePresetName}</Tag>
          </div>
          
          <div>
            <Text strong>聚合模型 (Aggregator)：</Text>
            <div style={{ marginTop: 8 }}>
              <Tag color="purple">{aggregator.provider || '未配置'}</Tag>
              <Tag>{aggregator.model || '未配置'}</Tag>
            </div>
          </div>

          <div>
            <Text strong>参考模型 (Reference Models)：</Text>
            <div style={{ marginTop: 8 }}>
              {refModels.length === 0 ? (
                <Text type="secondary">未配置参考模型</Text>
              ) : (
                <Space wrap>
                  {refModels.map((ref: any, idx: number) => (
                    <Tag key={idx} color="cyan">
                      {ref.provider}: {ref.model}
                    </Tag>
                  ))}
                </Space>
              )}
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <div>
              <Text strong>参考模型温度：</Text>
              <div><Text code>{refTemp}</Text></div>
            </div>
            <div>
              <Text strong>聚合模型温度：</Text>
              <div><Text code>{aggTemp}</Text></div>
            </div>
            <div>
              <Text strong>聚合模型 Max Tokens：</Text>
              <div><Text code>{maxTokens}</Text></div>
            </div>
            <div>
              <Text strong>参考模型 Max Tokens：</Text>
              <div><Text code>{refMaxTokens ?? '无限制'}</Text></div>
            </div>
          </div>

          {data?.presets && Object.keys(data.presets).length > 1 && (
            <div>
              <Text strong>所有预设：</Text>
              <div style={{ marginTop: 8 }}>
                <Space wrap>
                  {Object.keys(data.presets).map((name) => (
                    <Tag
                      key={name}
                      color={name === activePresetName ? 'blue' : 'default'}
                      style={{ cursor: 'pointer' }}
                      onClick={() => openEdit(name)}
                    >
                      {name}
                    </Tag>
                  ))}
                </Space>
              </div>
            </div>
          )}
        </Space>
      </Card>

      <Modal
        title={`编辑 MoA 预设: ${editPreset}`}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={saving}
        okText="保存"
        width={800}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSave}
          style={{ marginTop: 16 }}
        >
          <Form.Item name="enabled" label="启用状态" valuePropName="checked">
            <Select
              options={[
                { label: '启用', value: true },
                { label: '禁用', value: false },
              ]}
            />
          </Form.Item>

          <Card size="small" title="聚合模型 (Aggregator)" style={{ marginBottom: 16 }}>
            <Form.Item name={['aggregator', 'provider']} label="Provider" rules={[{ required: true }]}>
              <Select
                loading={providersLoading}
                placeholder="请选择 Provider"
                options={providerOptions}
                onChange={(v) => {
                  form.setFieldValue(['aggregator', 'model'], undefined);
                  loadModelsForProvider(v);
                }}
              />
            </Form.Item>
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.aggregator?.provider !== cur.aggregator?.provider}>
              {({ getFieldValue }) => {
                const provider = getFieldValue(['aggregator', 'provider']);
                const providerName = (provider || '').replace(/^custom:/, '');
                const models = providerName ? (providerModels[providerName] || []) : [];
                return (
                  <Form.Item name={['aggregator', 'model']} label="Model" rules={[{ required: true }]}>
                    <Select
                      showSearch
                      loading={providerModelsLoading && providerName.length > 0}
                      placeholder="请选择模型"
                      notFoundContent={providerName ? '暂无模型' : '先选 Provider'}
                      options={models.map((m) => ({ label: m, value: m }))}
                    />
                  </Form.Item>
                );
              }}
            </Form.Item>
          </Card>

          <Card size="small" title="参考模型 (Reference Models)" style={{ marginBottom: 16 }}>
            <Form.List name="reference_models">
              {(fields, { add, remove }) => (
                <>
                  {fields.map(({ key, name, ...restField }) => (
                    <Space key={key} style={{ display: 'flex', marginBottom: 8 }} align="baseline">
                      <Form.Item
                        {...restField}
                        name={[name, 'provider']}
                        rules={[{ required: true, message: '请选择 Provider' }]}
                      >
                        <Select
                          style={{ width: 180 }}
                          loading={providersLoading}
                          placeholder="Provider"
                          options={providerOptions}
                          onChange={(v) => {
                            const refs = form.getFieldValue('reference_models') || [];
                            refs[name].model = undefined;
                            form.setFieldsValue({ reference_models: refs });
                            loadModelsForProvider(v);
                          }}
                        />
                      </Form.Item>
                      <Form.Item noStyle shouldUpdate={(prev, cur) => {
                        const prevRef = prev.reference_models?.[name];
                        const curRef = cur.reference_models?.[name];
                        return prevRef?.provider !== curRef?.provider;
                      }}>
                        {({ getFieldValue }) => {
                          const refs = getFieldValue('reference_models') || [];
                          const provider = refs[name]?.provider;
                          const providerName = (provider || '').replace(/^custom:/, '');
                          const models = providerName ? (providerModels[providerName] || []) : [];
                          return (
                            <Form.Item
                              {...restField}
                              name={[name, 'model']}
                              rules={[{ required: true, message: '请选择模型' }]}
                            >
                              <Select
                                showSearch
                                style={{ width: 240 }}
                                loading={providerModelsLoading && providerName.length > 0}
                                placeholder="Model"
                                notFoundContent={providerName ? '暂无模型' : '先选 Provider'}
                                options={models.map((m) => ({ label: m, value: m }))}
                              />
                            </Form.Item>
                          );
                        }}
                      </Form.Item>
                      <Button type="text" danger onClick={() => remove(name)}>删除</Button>
                    </Space>
                  ))}
                  <Form.Item>
                    <Button type="dashed" onClick={() => add()} block>
                      添加参考模型
                    </Button>
                  </Form.Item>
                </>
              )}
            </Form.List>
          </Card>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
            <Form.Item name="reference_temperature" label="参考模型温度" tooltip="参考模型的采样温度">
              <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="aggregator_temperature" label="聚合模型温度" tooltip="聚合模型的采样温度">
              <InputNumber min={0} max={2} step={0.1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="max_tokens" label="聚合模型 Max Tokens" tooltip="聚合模型的最大输出 token 数">
              <InputNumber min={1} style={{ width: '100%' }} />
            </Form.Item>
            <Form.Item name="reference_max_tokens" label="参考模型 Max Tokens" tooltip="参考模型的最大输出 token 数（可选）">
              <InputNumber min={1} style={{ width: '100%' }} placeholder="留空表示无限制" />
            </Form.Item>
          </div>
        </Form>
      </Modal>
    </>
  );
}

// ── Page ──────────────────────────────────────────────

export default function ModelsConfig() {
  const { message } = AntApp.useApp();
  const { activeProfile } = useConfigStore();
  const [saving, setSaving] = useState(false);

  const fetchModels = useCallback(
    () => apiClient.get<ModelsData>('/models', { params: { profile: activeProfile } }).then((res) => res.data),
    [activeProfile],
  );

  const { data, loading, error, execute: reload } = useApi(fetchModels, [activeProfile]);

  const modelOptions = Object.keys(data?.models ?? {}).sort();

  const handleSaveModel = async (values: ModelConfig) => {
    setSaving(true);
    try {
      await apiClient.put('/models/model', values, { params: { profile: activeProfile } });
      message.success('主模型已保存');
      reload();
    } catch { message.error('保存失败'); }
    finally { setSaving(false); }
  };

  return (
    <>
      <PageHeader title="模型配置" profile={activeProfile} profileName="管理模型与 Provider 配置" />
      {error && <Alert message={error} type="error" showIcon closable style={{ marginBottom: 16 }} />}
      <Spin spinning={loading}>
        <Tabs
          defaultActiveKey="providers"
          type="card"
          items={[
            {
              key: 'providers',
              label: 'Provider',
              children: (
                <ProvidersTab
                  activeProfile={activeProfile}
                  onReload={reload}
                  modelOptions={modelOptions}
                />
              ),
            },
            {
              key: 'main',
              label: '主模型',
              children: (
                <MainModelTab
                  modelData={data?.model ?? {}}
                  modelOptions={modelOptions}
                  activeProfile={activeProfile}
                  onSave={handleSaveModel}
                  saving={saving}
                />
              ),
            },
            {
              key: 'aux',
              label: '辅助模型',
              children: (
                <AuxTab data={data?.auxiliary ?? {}} activeProfile={activeProfile} onReload={reload} />
              ),
            },
            {
              key: 'fallback',
              label: 'Fallback',
              children: (
                <FallbackTab data={data?.fallback_providers ?? []} activeProfile={activeProfile} onReload={reload} />
              ),
            },
            {
              key: 'moa',
              label: 'MoA',
              children: (
                <MoATab data={data?.moa} activeProfile={activeProfile} onReload={reload} />
              ),
            },
          ]}
        />
      </Spin>
    </>
  );
}
