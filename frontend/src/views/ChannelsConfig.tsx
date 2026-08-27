import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Badge } from '@/components/ui/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Pencil, Plus, Trash2, Settings, MessageSquare } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';
import ConfirmDialog from '../components/ConfirmDialog';
import EmptyState from '../components/EmptyState';
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

export default function ChannelsConfig() {
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<string | null>(null);
  const [formValues, setFormValues] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ type: string; isEnv: boolean } | null>(null);

  const [envValues, setEnvValues] = useState<Record<string, Record<string, string>>>({});

  const fetchChannels = useCallback(
    (force?: boolean) =>
      apiClient
        .get<ChannelsData>('/channels', {
          params: { profile: activeProfile },
          ...(force ? { refresh: true } : {}),
        })
        .then((res) => res.data),
    [activeProfile],
  );

  const { data: channels, loading, error, execute: reload } = useApi(fetchChannels, [activeProfile]);

  // 一次性拉取所有 env 配置渠道的环境变量，避免逐渠道请求（N+1）
  useEffect(() => {
    if (!channels) return;
    const envTypes = Object.keys(ENV_FIELDS).filter((t) => channels[t]?.configured_via === 'env');
    if (envTypes.length === 0) return;
    apiClient
      .get<{ channels: Record<string, Record<string, string>> }>('/channels/env', {
        params: { profile: activeProfile },
      })
      .then(({ data }) => {
        setEnvValues(data.channels ?? {});
      })
      .catch(() => {});
  }, [channels, activeProfile]);

  const channelEntries = Object.entries(channels ?? {});
  const configuredTypes = new Set(Object.keys(channels ?? {}));
  const availableTypes = CHANNEL_TYPES.filter((c) => !configuredTypes.has(c.type));

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

  const handleAdd = () => {
    if (availableTypes.length === 0) {
      toast({ title: '提示', description: '所有预定义消息渠道都已配置' });
      return;
    }
    setEditingChannel(null);
    setFormValues({});
    setModalOpen(true);
  };

  const handleEdit = (type: string) => {
    const def = CHANNEL_TYPES.find((c) => c.type === type);
    const config = channels?.[type] ?? {};
    const initial: Record<string, unknown> = {};
    if (def) {
      for (const f of def.fields) {
        const v = getNestedValue(config, f.key);
        if (v !== undefined && v !== null) {
          setNestedValue(initial, f.key, v);
        } else if (f.defaultValue !== undefined) {
          setNestedValue(initial, f.key, f.defaultValue);
        }
      }
    }
    setEditingChannel(type);
    setFormValues(initial);
    setModalOpen(true);
  };

  const handleDelete = async (type: string) => {
    try {
      await apiClient.delete(`/channels/${type}`, { params: { profile: activeProfile } });
      toast({ title: '成功', description: `已删除 ${type} 渠道配置` });
      reload(true);
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '删除失败' });
    }
  };

  const handleSubmit = async () => {
    if (!editingChannel) return;
    setSaving(true);
    try {
      const cleanData: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(formValues)) {
        if (v !== undefined && v !== null && v !== '' && v !== false) {
          cleanData[k] = v;
        } else if (typeof v === 'number' && v === 0) {
          cleanData[k] = v;
        }
      }
      await apiClient.put(`/channels/${editingChannel}`, cleanData, { params: { profile: activeProfile } });
      toast({ title: '成功', description: editingChannel ? `已更新 ${editingChannel} 渠道配置` : `已创建 ${editingChannel} 渠道配置` });
      setModalOpen(false);
      reload(true);
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleEnvSave = async (type: string) => {
    const values = envValues[type];
    if (!values) return;
    try {
      await apiClient.put(`/channels/${type}/env`, values, { params: { profile: activeProfile } });
      toast({ title: '成功', description: `${type} 环境变量已保存` });
      reload(true);
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '保存失败' });
    }
  };

  const handleEnvDelete = async (type: string) => {
    const fields = ENV_FIELDS[type]?.map((f) => f.key) ?? [];
    const payload: Record<string, null> = {};
    for (const f of fields) payload[f] = null;
    try {
      await apiClient.put(`/channels/${type}/env`, payload, { params: { profile: activeProfile } });
      toast({ title: '成功', description: `${type} 环境变量已清除` });
      reload(true);
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '删除失败' });
    }
  };

  const updateFormValue = (key: string, value: unknown) => {
    setFormValues((prev) => {
      const next = { ...prev };
      setNestedValue(next, key, value);
      return next;
    });
  };

  const updateEnvValue = (type: string, field: string, value: string) => {
    setEnvValues((prev) => ({
      ...prev,
      [type]: { ...(prev[type] ?? {}), [field]: value },
    }));
  };

  const openDeleteDialog = (type: string, isEnv: boolean) => {
    setDeleteTarget({ type, isEnv });
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    if (deleteTarget.isEnv) {
      await handleEnvDelete(deleteTarget.type);
    } else {
      await handleDelete(deleteTarget.type);
    }
    setDeleteDialogOpen(false);
    setDeleteTarget(null);
  };

  const getFieldDisplayValue = (field: { key: string; label: string; type: string }, config: Record<string, unknown>): string => {
    const val = getNestedValue(config, field.key);
    if (val === undefined || val === null || val === '' || val === false) return '';
    if (field.type === 'boolean') return val ? '是' : '否';
    if (field.type === 'password') return '••••••••';
    return String(val);
  };

  const renderChannelCard = (row: ChannelRow) => {
    const def = CHANNEL_TYPES.find((c) => c.type === row.type);
    if (row.configuredVia === 'env') {
      const envFields = ENV_FIELDS[row.type] ?? [];
      return (
        <Card key={row.key} className="relative">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-4 w-4 text-muted-foreground" />
                {row.label}
                <Badge variant="secondary" className="text-xs font-normal">环境变量</Badge>
                {row.enabled ? (
                  <Badge variant="default" className="text-xs font-normal">已启用</Badge>
                ) : (
                  <Badge variant="outline" className="text-xs font-normal bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-transparent">未启用</Badge>
                )}
              </CardTitle>
              <CardDescription>{def?.description}</CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="sm" onClick={() => handleEdit(row.type)}>
                <Pencil className="h-4 w-4 mr-1" />
                编辑
              </Button>
              <Button variant="ghost" size="sm" onClick={() => openDeleteDialog(row.type, true)}>
                <Trash2 className="h-4 w-4 mr-1" />
                清除
              </Button>
            </div>
          </CardHeader>
          <CardContent className="pt-0">
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {envFields.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0">{f.label}：</span>
                  <span className="font-mono text-xs truncate">
                    {envValues[row.type]?.[f.key]
                      ? f.password
                        ? '••••••••'
                        : envValues[row.type][f.key]
                      : <span className="text-muted-foreground/50">未设置</span>}
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      );
    }

    const displayFields = def?.fields.filter((f) => {
      const val = getNestedValue(row.config, f.key);
      if (val === undefined || val === null || val === '' || val === false) return false;
      if (f.type === 'password') return false;
      return true;
    }) ?? [];

    return (
      <Card key={row.key} className="relative">
        <CardHeader className="flex flex-row items-center justify-between space-y-0">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4 text-muted-foreground" />
              {row.label}
              {row.enabled ? (
                <Badge variant="default" className="text-xs font-normal">已启用</Badge>
              ) : (
                <Badge variant="outline" className="text-xs font-normal bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-transparent">未启用</Badge>
              )}
            </CardTitle>
            <CardDescription>{def?.description}</CardDescription>
          </div>
          <div className="flex items-center gap-1">
            <Button variant="ghost" size="sm" onClick={() => handleEdit(row.type)}>
              <Pencil className="h-4 w-4 mr-1" />
              编辑
            </Button>
            <Button variant="ghost" size="sm" onClick={() => openDeleteDialog(row.type, false)}>
              <Trash2 className="h-4 w-4 mr-1" />
              删除
            </Button>
          </div>
        </CardHeader>
        <CardContent className="pt-0">
          {displayFields.length === 0 ? (
            <p className="text-sm text-muted-foreground">暂无详细配置</p>
          ) : (
            <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
              {displayFields.map((f) => (
                <div key={f.key} className="flex items-center gap-2">
                  <span className="text-muted-foreground shrink-0">{f.label}：</span>
                  <span className={f.type === 'boolean' ? '' : 'font-mono text-xs truncate'}>
                    {getFieldDisplayValue(f, row.config) || <span className="text-muted-foreground/50">未设置</span>}
                  </span>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    );
  };

  const renderEditDialog = () => {
    if (!editingChannel) return null;
    const def = CHANNEL_TYPES.find((c) => c.type === editingChannel);
    if (!def) return null;

    return (
      <Dialog open={modalOpen} onOpenChange={(open) => { if (!open) setModalOpen(false); }}>
        <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>编辑 {def.label} 渠道</DialogTitle>
            <DialogDescription>{def.description}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4 py-4">
            {def.fields.map((field) => {
              const value = getNestedValue(formValues, field.key);
              return (
                <div key={field.key} className="grid grid-cols-[140px_1fr] gap-3 items-start">
                  <Label className="text-muted-foreground pt-2">
                    {field.label}
                    {field.required && <span className="text-red-500 ml-1">*</span>}
                  </Label>
                  <div>
                    {field.type === 'boolean' ? (
                      <div className="flex items-center gap-2 pt-1">
                        <Switch
                          checked={Boolean(value)}
                          onCheckedChange={(v) => updateFormValue(field.key, v)}
                        />
                        <span className="text-sm text-muted-foreground">
                          {value ? '已启用' : '未启用'}
                        </span>
                      </div>
                    ) : field.type === 'number' ? (
                      <Input
                        type="number"
                        value={value !== undefined ? Number(value) : ''}
                        placeholder={field.placeholder}
                        onChange={(e) => updateFormValue(field.key, e.target.value ? Number(e.target.value) : undefined)}
                      />
                    ) : field.type === 'password' ? (
                      <Input
                        type="password"
                        value={(value as string) ?? ''}
                        placeholder={field.placeholder}
                        onChange={(e) => updateFormValue(field.key, e.target.value)}
                      />
                    ) : field.type === 'textarea' ? (
                      <textarea
                        value={(value as string) ?? ''}
                        placeholder={field.placeholder}
                        rows={3}
                        onChange={(e) => updateFormValue(field.key, e.target.value)}
                        className="flex w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50"
                      />
                    ) : (
                      <Input
                        value={(value as string) ?? ''}
                        placeholder={field.placeholder}
                        onChange={(e) => updateFormValue(field.key, e.target.value)}
                      />
                    )}
                  </div>
                </div>
              );
            })}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setModalOpen(false)}>取消</Button>
            <Button onClick={handleSubmit} disabled={saving}>
              {saving ? '保存中...' : '保存'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  };

  const renderAddDialog = () => (
    <Dialog open={modalOpen && !editingChannel} onOpenChange={(open) => { if (!open) setModalOpen(false); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>新增渠道</DialogTitle>
          <DialogDescription>选择渠道类型并配置参数</DialogDescription>
        </DialogHeader>
        <div className="grid gap-2 py-4">
          {availableTypes.map((type) => (
            <Button
              key={type.type}
              variant="outline"
              className="justify-start h-auto py-3 px-4"
              onClick={() => {
                setEditingChannel(type.type);
                setFormValues({});
                setModalOpen(true);
              }}
            >
              <div className="text-left">
                <div className="font-medium">{type.label}</div>
                <div className="text-xs text-muted-foreground">{type.description}</div>
              </div>
            </Button>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );

  return (
    <PageContainer>
      <PageHeader
        extra={
          <Button onClick={handleAdd} disabled={availableTypes.length === 0}>
            <Plus className="mr-2 h-4 w-4" />
            新增渠道
          </Button>
        }
      />

      {error && <ErrorAlert message={error} />}

      {rows.length === 0 && !loading ? (
        <EmptyState text="暂无消息渠道配置">
          <Button onClick={handleAdd}>
            <Plus className="mr-2 h-4 w-4" />
            新增渠道
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-4">
          {rows.map((row) => renderChannelCard(row))}
        </div>
      )}

      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title={deleteTarget?.isEnv ? '清除环境变量' : '删除配置'}
        description={
          deleteTarget?.isEnv
            ? `确定要清除 ${deleteTarget.type} 的环境变量配置吗？`
            : `确定要删除 ${deleteTarget?.type} 的配置吗？此操作不可撤销。`
        }
        variant="destructive"
        onConfirm={confirmDelete}
      />

      {renderAddDialog()}
      {renderEditDialog()}
    </PageContainer>
  );
}
