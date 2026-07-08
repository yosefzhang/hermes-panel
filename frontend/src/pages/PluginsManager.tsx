import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Input, Space, Tag, Table, Typography,
  App as AntApp, Empty, Tabs,
} from 'antd';
import PageHeader from '../components/PageHeader';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';

const { Text } = Typography;

interface PluginRecord {
  key: string;
  name: string;
  version: string;
  description: string;
  status: 'enabled' | 'disabled' | 'not enabled';
  source: 'bundled' | 'user' | 'git';
  category: string;
  enabled: boolean;
}

interface PluginsResponse {
  plugins: PluginRecord[];
  error?: string;
}

export default function PluginsManager() {
  const { message, modal } = AntApp.useApp();
  const { activeProfile } = useConfigStore();

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('');

  const fetchPlugins = useCallback(
    () =>
      apiClient.get<PluginsResponse>('/plugins', { params: { profile: activeProfile } }).then((res) => {
        if (res.data.error) {
          throw new Error(res.data.error);
        }
        const plugins = res.data.plugins || [];
        const nameCount: Record<string, number> = {};
        return plugins.map((plugin) => {
          const count = (nameCount[plugin.name] || 0) + 1;
          nameCount[plugin.name] = count;
          return {
            ...plugin,
            key: count > 1 ? `${plugin.name}-${count}` : plugin.name,
          };
        });
      }),
    [activeProfile],
  );

  const { data: rows, loading, error, execute: reload } = useApi(fetchPlugins, [activeProfile]);

  // 按分类分组
  const pluginsByCategory = useMemo(() => {
    if (!rows) return {};
    const groups: Record<string, PluginRecord[]> = {};
    rows.forEach((p) => {
      if (!groups[p.category]) {
        groups[p.category] = [];
      }
      groups[p.category].push(p);
    });
    return groups;
  }, [rows]);

  // 分类排序（按固定顺序：model-provider、platforms、web、自定义、其他）
  const sortedCategories = useMemo(() => {
    const TOP_LEVEL_ORDER = ['model-provider', 'platforms', 'web', '自定义', '其他'];
    const cats = Object.keys(pluginsByCategory);
    return TOP_LEVEL_ORDER.filter((c) => cats.includes(c));
  }, [pluginsByCategory]);

  // 默认选中第一个分类
  useEffect(() => {
    if (!activeCategory && sortedCategories.length > 0) {
      setActiveCategory(sortedCategories[0]);
    }
  }, [activeCategory, sortedCategories]);

  // 根据当前分类和搜索过滤
  const filtered = useMemo(() => {
    let result = activeCategory ? (pluginsByCategory[activeCategory] ?? []) : [];
    if (search) {
      const q = search.toLowerCase();
      result = result.filter((p) => p.name.toLowerCase().includes(q));
    }
    return result;
  }, [pluginsByCategory, activeCategory, search]);

  const togglePlugin = async (key: string, name: string, action: 'enable' | 'disable') => {
    setActionLoading(`toggle:${key}`);
    try {
      const { data } = await apiClient.post<{ ok: boolean; error?: string }>(
        `/plugins/${name}/${action}`,
        null,
        { params: { profile: activeProfile } },
      );
      if (!data.ok) {
        throw new Error(data.error || '操作失败');
      }
      message.success(action === 'enable' ? '已启用' : '已停用');
      reload();
    } catch (err: any) {
      message.error(err?.response?.data?.error || err?.message || '操作失败');
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = (key: string, name: string) => {
    modal.confirm({
      title: `删除插件: ${name}`,
      content: '确认删除该插件吗？',
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          const { data } = await apiClient.delete<{ ok: boolean; error?: string }>(
            `/plugins/${name}`,
            { params: { profile: activeProfile } },
          );
          if (!data.ok) {
            throw new Error(data.error || '删除失败');
          }
          message.success(`${name} 已删除`);
          reload();
        } catch (err: any) {
          message.error(err?.response?.data?.error || err?.message || '删除失败');
        }
      },
    });
  };

  const handleRescan = async () => {
    await reload();
    message.success('插件列表已重新扫描');
  };

  const columns = [
    {
      title: '插件名称',
      dataIndex: 'name',
      key: 'name',
      width: '20%',
      minWidth: 120,
      render: (name: string) => <Text strong>{name}</Text>,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: '12%',
      minWidth: 100,
      render: (status: string) => {
        const colors: Record<string, string> = {
          enabled: 'green',
          disabled: 'red',
          'not enabled': 'default',
        };
        const labels: Record<string, string> = {
          enabled: '已启用',
          disabled: '已禁用',
          'not enabled': '未启用',
        };
        return <Tag color={colors[status] || 'default'}>{labels[status] || status}</Tag>;
      },
    },
    {
      title: '版本',
      dataIndex: 'version',
      key: 'version',
      width: '8%',
      minWidth: 60,
      render: (version: string) => <Text type="secondary">{version || '—'}</Text>,
    },
    {
      title: '来源',
      dataIndex: 'source',
      key: 'source',
      width: '8%',
      minWidth: 70,
      render: (source: string) => {
        const colors: Record<string, string> = {
          bundled: 'blue',
          user: 'purple',
          git: 'cyan',
        };
        const labels: Record<string, string> = {
          bundled: '内置',
          user: '用户',
          git: 'Git',
        };
        return <Tag color={colors[source] || 'default'}>{labels[source] || source}</Tag>;
      },
    },
    {
      title: '描述',
      dataIndex: 'description',
      key: 'description',
      width: '40%',
      minWidth: 180,
      render: (description: string) => <Text type="secondary">{description || '—'}</Text>,
    },
    {
      title: '操作',
      key: 'action',
      width: '12%',
      minWidth: 160,
      render: (_: unknown, record: PluginRecord) => (
        <Space size={4}>
          <Button
            size="small"
            loading={actionLoading === `toggle:${record.key}`}
            onClick={() => togglePlugin(record.key, record.name, record.enabled ? 'disable' : 'enable')}
          >
            {record.enabled ? '停用' : '启用'}
          </Button>
          <Button
            size="small"
            danger
            onClick={() => handleDelete(record.key, record.name)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="插件"
        profile={activeProfile}
        profileName="展示已安装插件并管理启用状态"
        extra={
          <Space>
            <Input
              placeholder="搜索当前分类下的插件..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              allowClear
              style={{ width: 260 }}
            />
            <Button onClick={handleRescan} loading={loading}>
              重新扫描
            </Button>
          </Space>
        }
      />

      {error && <Alert message={error} type="error" showIcon closable style={{ marginBottom: 16 }} />}

      {sortedCategories.length === 0 && !loading ? (
        <Card>
          <Empty description="暂无插件" />
        </Card>
      ) : (
        <Tabs
          activeKey={activeCategory}
          onChange={setActiveCategory}
          type="card"
          items={sortedCategories.map((cat) => ({
            key: cat,
            label: cat,
            children: (
              <Card title={cat}>
                <Table
                  rowKey="key"
                  size="small"
                  pagination={false}
                  loading={loading}
                  dataSource={filtered}
                  columns={columns}
                  locale={{ emptyText: search ? '没有匹配的插件' : '该分类下暂无插件' }}
                />
              </Card>
            ),
          }))}
        />
      )}
    </>
  );
}
