import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Form, Input, InputNumber, Popconfirm, Space, Switch, Tabs, App as AntApp } from 'antd';
import PageHeader from '../components/PageHeader';
import ChannelFormModal from '../components/ChannelFormModal';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';
import { CHANNEL_TYPES, getNestedValue, setNestedValue } from '../config/channelDefs';

type ChannelsData = Record<string, Record<string, unknown>>;
type ChannelRow = {
  key: string;
  type: string;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  configuredVia?: string;
};

// ── Env field definitions per channel ──────────────────

const ENV_FIELDS: Record<string, Array<{ key: string; label: string; password?: boolean }>> = {
  feishu: [
    { key: 'FEISHU_APP_ID', label: 'App ID' },
    { key: 'FEISHU_APP_SECRET', label: 'App Secret', password: true },
  ],
  weixin: [
    { key: 'WEIXIN_ACCOUNT_ID', label: 'Account ID' },
    { key: 'WEIXIN_TOKEN', label: 'Token' },
  ],
};

// ── Page ───────────────────────────────────────────────

export default function ChannelsConfig() {
  const { message, modal } = AntApp.useApp();
  const { activeProfile } = useConfigStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [editingData, setEditingData] = useState<Record<string, unknown> | null>(null);
  const [activeKey, setActiveKey] = useState<string | undefined>(undefined);
  const [savingMap, setSavingMap] = useState<Record<string, boolean>>({});

  // Env inline editing state: { channelType: { FIELD: value, ... } }
  const [envValues, setEnvValues] = useState<Record<string, Record<string, string>>>({});
  const [envLoading, setEnvLoading] = useState<Record<string, boolean>>({});
  const [envSaving, setEnvSaving] = useState<Record<string, boolean>>({});

  const fetchChannels = useCallback(
    () => apiClient.get<ChannelsData>('/channels', { params: { profile: activeProfile } }).then((res) => res.data),
    [activeProfile],
  );

  const { data: channels, loading, error, execute: reload } = useApi(fetchChannels, [activeProfile]);

  // Load env values for all env channels
  useEffect(() => {
    if (!channels) return;
    for (const [type, config] of Object.entries(channels)) {
      if (config.configured_via === 'env' && ENV_FIELDS[type]) {
        setEnvLoading((prev) => ({ ...prev, [type]: true }));
        apiClient
          .get<{ fields: Record<string, string> }>(`/channels/${type}/env`, { params: { profile: activeProfile } })
          .then(({ data }) => {
            setEnvValues((prev) => ({ ...prev, [type]: data.fields }));
          })
          .catch(() => {})
          .finally(() => setEnvLoading((prev) => ({ ...prev, [type]: false })));
      }
    }
  }, [channels, activeProfile]);

  const channelEntries = Object.entries(channels ?? {});
  const configuredTypes = new Set(Object.keys(channels ?? {}));
  const availableTypes = CHANNEL_TYPES.filter((c) => !configuredTypes.has(c.type));

  // 默认选中第一个已配置渠道；若当前选中项被删除则回退
  useEffect(() => {
    const keys = Object.keys(channels ?? {});
    if (keys.length === 0) {
      setActiveKey(undefined);
    } else if (!activeKey || !keys.includes(activeKey)) {
      setActiveKey(keys[0]);
    }
  }, [channels, activeKey]);

  const handleAdd = () => {
    if (availableTypes.length === 0) {
      message.info('所有预定义消息渠道都已配置');
      return;
    }
    setEditingChannel(null);
    setEditingData(null);
    setModalOpen(true);
  };

  const handleEdit = (type: string) => {
    setEditingChannel(type);
    setEditingData(channels?.[type] ?? {});
    setModalOpen(true);
  };

  const handleDelete = async (type: string) => {
    try {
      await apiClient.delete(`/channels/${type}`, { params: { profile: activeProfile } });
      message.success(`已删除 ${type} 渠道配置`);
      reload();
    } catch {
      message.error('删除失败');
    }
  };

  const handleSubmit = async (type: string, formData: Record<string, unknown>) => {
    try {
      const cleanData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formData)) {
        if (v !== undefined && v !== null && v !== '' && v !== false) {
          cleanData[k] = v;
        } else if (typeof v === 'number' && v === 0) {
          cleanData[k] = v;
        }
      }
      await apiClient.put(`/channels/${type}`, cleanData, { params: { profile: activeProfile } });
      message.success(editingChannel ? `已更新 ${type} 渠道配置` : `已创建 ${type} 渠道配置`);
      setModalOpen(false);
      reload();
    } catch {
      message.error('保存失败');
    }
  };

  // Env save
  const handleEnvSave = async (type: string) => {
    const values = envValues[type];
    if (!values) return;
    setEnvSaving((prev) => ({ ...prev, [type]: true }));
    try {
      await apiClient.put(`/channels/${type}/env`, values, { params: { profile: activeProfile } });
      message.success(`${type} 环境变量已保存`);
      reload();
    } catch {
      message.error('保存失败');
    } finally {
      setEnvSaving((prev) => ({ ...prev, [type]: false }));
    }
  };

  // Env delete
  const handleEnvDelete = async (type: string) => {
    const fields = ENV_FIELDS[type]?.map((f) => f.key) ?? [];
    const payload: Record<string, null> = {};
    for (const f of fields) payload[f] = null;
    try {
      await apiClient.put(`/channels/${type}/env`, payload, { params: { profile: activeProfile } });
      message.success(`${type} 环境变量已清除`);
      reload();
    } catch {
      message.error('删除失败');
    }
  };

  const updateEnvValue = (type: string, field: string, value: string) => {
    setEnvValues((prev) => ({
      ...prev,
      [type]: { ...(prev[type] ?? {}), [field]: value },
    }));
  };

  const rows: ChannelRow[] = channelEntries.map(([type, config]) => {
    const def = CHANNEL_TYPES.find((c) => c.type === type);
    const configuredVia = config.configured_via as string | undefined;
    return {
      key: type,
      type,
      label: def?.label ?? type,
      enabled: Boolean(getNestedValue(config, 'enabled') ?? true),
      config,
      configuredVia,
    };
  });

  const handleInlineSave = async (type: string, values: Record<string, unknown>) => {
    setSavingMap((prev) => ({ ...prev, [type]: true }));
    try {
      const cleanData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(values)) {
        if (value !== undefined && value !== null && value !== '') {
          cleanData[key] = value;
        } else if (typeof value === 'boolean' || typeof value === 'number') {
          cleanData[key] = value;
        }
      }
      await apiClient.put(`/channels/${type}`, cleanData, { params: { profile: activeProfile } });
      message.success(`${type} 配置已保存`);
      reload();
    } catch {
      message.error('保存失败');
    } finally {
      setSavingMap((prev) => ({ ...prev, [type]: false }));
    }
  };

  const tabItems = useMemo(() => rows.map((row) => {
    const def = CHANNEL_TYPES.find((c) => c.type === row.type);
    const fields = def?.fields ?? [];

    const label = <span style={{ fontWeight: 600 }}>{row.label}</span>;

    let children: React.ReactNode;

    if (row.configuredVia === 'env') {
      const envFields = ENV_FIELDS[row.type] ?? [];
      children = (
        <Card title={row.label}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            {envFields.map((f) => (
              <div key={f.key} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <div style={{ width: 140, color: '#666' }}>{f.label}</div>
                <div style={{ flex: 1 }}>
                  {f.password ? (
                    <Input.Password
                      value={envValues[row.type]?.[f.key] ?? ''}
                      placeholder={envLoading[row.type] ? '加载中...' : ''}
                      onChange={(e) => updateEnvValue(row.type, f.key, e.target.value)}
                    />
                  ) : (
                    <Input
                      value={envValues[row.type]?.[f.key] ?? ''}
                      placeholder={envLoading[row.type] ? '加载中...' : ''}
                      onChange={(e) => updateEnvValue(row.type, f.key, e.target.value)}
                    />
                  )}
                </div>
              </div>
            ))}
            <Space>
              <Button
                type="primary"
                loading={envSaving[row.type]}
                onClick={() => {
                  modal.confirm({
                    title: `保存 ${row.label} 环境变量`,
                    content: '确定要将新的环境变量写入 .env 文件吗？',
                    okText: '保存',
                    cancelText: '取消',
                    onOk: () => handleEnvSave(row.type),
                  });
                }}
              >
                保存
              </Button>
              <Popconfirm
                title={`确定要清除 ${row.label} 的环境变量配置吗？`}
                description="此操作会将相关环境变量设为空值"
                onConfirm={() => handleEnvDelete(row.type)}
                okText="删除"
                cancelText="取消"
                okType="danger"
              >
                <Button danger>删除</Button>
              </Popconfirm>
            </Space>
          </div>
        </Card>
      );
    } else {
      const initialValues: Record<string, unknown> = {};
      for (const field of fields) {
        const value = getNestedValue(row.config, field.key);
        if (value !== undefined) {
          setNestedValue(initialValues, field.key, value);
        }
      }

      children = (
        <Card title={row.label}>
          <Form
            layout="vertical"
            initialValues={initialValues}
            onFinish={(values) => handleInlineSave(row.type, values)}
          >
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {fields.map((field) => {
                const namePath = field.key.split('.');
                return (
                  <div key={field.key} style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                    <div style={{ width: 160, paddingTop: 6, color: '#666' }}>{field.label}</div>
                    <div style={{ flex: 1 }}>
                      {field.type === 'boolean' ? (
                        <Form.Item name={namePath} valuePropName="checked" style={{ marginBottom: 0 }}>
                          <Switch />
                        </Form.Item>
                      ) : field.type === 'number' ? (
                        <Form.Item name={namePath} style={{ marginBottom: 0 }}>
                          <InputNumber style={{ width: '100%' }} placeholder={field.placeholder} />
                        </Form.Item>
                      ) : field.type === 'password' ? (
                        <Form.Item name={namePath} style={{ marginBottom: 0 }}>
                          <Input.Password placeholder={field.placeholder} />
                        </Form.Item>
                      ) : field.type === 'textarea' ? (
                        <Form.Item name={namePath} style={{ marginBottom: 0 }}>
                          <Input.TextArea placeholder={field.placeholder} rows={3} />
                        </Form.Item>
                      ) : (
                        <Form.Item name={namePath} style={{ marginBottom: 0 }}>
                          <Input placeholder={field.placeholder} />
                        </Form.Item>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <Space style={{ marginTop: 16 }}>
              <Button type="primary" htmlType="submit" loading={savingMap[row.type]}>
                保存
              </Button>
              <Button onClick={() => handleEdit(row.type)}>
                高级编辑
              </Button>
              <Popconfirm
                title={`确定要删除 ${row.label} 的配置吗？`}
                onConfirm={() => handleDelete(row.type)}
                okText="删除"
                cancelText="取消"
              >
                <Button danger>删除</Button>
              </Popconfirm>
            </Space>
          </Form>
        </Card>
      );
    }

    return {
      key: row.key,
      label,
      children,
    };
  }), [rows, envValues, envLoading, envSaving, savingMap, activeProfile]);

  return (
    <>
      <PageHeader
        title="消息渠道"
        profile={activeProfile}
        profileName="配置和管理当前 Profile 的消息平台接入。"
        extra={
          <Button type="primary" onClick={handleAdd} disabled={availableTypes.length === 0}>
            新增渠道
          </Button>
        }
      />

      {error && <Alert message={error} type="error" showIcon closable style={{ marginBottom: 16 }} />}

      {rows.length === 0 ? (
        <Card>
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无消息渠道配置">
            <Button type="primary" onClick={handleAdd}>
              新增渠道
            </Button>
          </Empty>
        </Card>
      ) : (
        <Tabs
          activeKey={activeKey}
          onChange={setActiveKey}
          type="card"
          items={tabItems}
        />
      )}

      <ChannelFormModal
        open={modalOpen}
        editingType={editingChannel}
        initialData={editingData}
        disabledTypes={Object.keys(channels ?? {})}
        onCancel={() => setModalOpen(false)}
        onSubmit={handleSubmit}
      />
    </>
  );
}
