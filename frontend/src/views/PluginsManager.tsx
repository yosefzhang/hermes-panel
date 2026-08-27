import { useCallback, useEffect, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { AlertCircle, RefreshCw, Trash2, Power, PowerOff, Plug } from 'lucide-react';
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
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();

  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [pluginToDelete, setPluginToDelete] = useState<{ key: string; name: string } | null>(null);

  const fetchPlugins = useCallback(
    (force?: boolean) =>
      apiClient
        .get<PluginsResponse>('/plugins', {
          params: { profile: activeProfile },
          ...(force ? { refresh: true } : {}),
        })
        .then((res) => {
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

  // 分类排序
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
      toast({
        title: '成功',
        description: action === 'enable' ? '已启用' : '已停用',
      });
      reload(true);
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: '错误',
        description: err?.response?.data?.error || err?.message || '操作失败',
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = (key: string, name: string) => {
    setPluginToDelete({ key, name });
    setDeleteDialogOpen(true);
  };

  const confirmDelete = async () => {
    if (!pluginToDelete) return;
    try {
      const { data } = await apiClient.delete<{ ok: boolean; error?: string }>(
        `/plugins/${pluginToDelete.name}`,
        { params: { profile: activeProfile } },
      );
      if (!data.ok) {
        throw new Error(data.error || '删除失败');
      }
      toast({
        title: '成功',
        description: `${pluginToDelete.name} 已删除`,
      });
      reload(true);
    } catch (err: any) {
      toast({
        variant: 'destructive',
        title: '错误',
        description: err?.response?.data?.error || err?.message || '删除失败',
      });
    } finally {
      setDeleteDialogOpen(false);
      setPluginToDelete(null);
    }
  };

  const handleRescan = async () => {
    await reload(true);
    toast({
      title: '成功',
      description: '插件列表已重新扫描',
    });
  };

  const getStatusBadge = (status: string) => {
    const classes: Record<string, string> = {
      enabled: 'status-success border-transparent',
      disabled: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400 border-transparent',
    };
    const variants: Record<string, 'secondary' | 'outline'> = {
      'not enabled': 'secondary',
    };
    const labels: Record<string, string> = {
      enabled: '已启用',
      disabled: '未启用',
      'not enabled': '未启用',
    };
    return <Badge variant={variants[status] || 'outline'} className={classes[status] || ''}>{labels[status] || status}</Badge>;
  };

  const getSourceBadge = (source: string) => {
    const variants: Record<string, 'default' | 'secondary' | 'outline'> = {
      bundled: 'default',
      user: 'secondary',
      git: 'outline',
    };
    const labels: Record<string, string> = {
      bundled: '内置',
      user: '用户',
      git: 'Git',
    };
    return <Badge variant={variants[source] || 'outline'}>{labels[source] || source}</Badge>;
  };

  return (
    <PageContainer>
      <PageHeader
        extra={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Input
                placeholder="搜索当前分类下的插件..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-[260px]"
              />
            </div>
            <Button variant="outline" onClick={handleRescan} disabled={loading}>
              <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
              重新扫描
            </Button>
          </div>
        }
      />

      {/* Error message */}
      {error && <ErrorAlert message={error} />}

      {/* Categories and table */}
      {sortedCategories.length === 0 && !loading ? (
        <EmptyState text="暂无插件" />
      ) : (
        <div className="space-y-4">
          {/* Category tabs */}
          <div className="flex gap-2 border-b overflow-x-auto">
            {sortedCategories.map((cat) => {
              const isActive = activeCategory === cat;
              return (
                <button
                  key={cat}
                  onClick={() => setActiveCategory(cat)}
                  className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px whitespace-nowrap ${
                    isActive
                      ? 'tab-active'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60'
                  }`}
                >
                  {cat}
                </button>
              );
            })}
          </div>

          {/* Plugin table */}
          <Card>
            <CardHeader>
              <CardTitle>{activeCategory}</CardTitle>
            </CardHeader>
            <CardContent>
              {loading ? (
                <Loading className="py-12" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[20%]">插件名称</TableHead>
                      <TableHead className="w-[12%]">状态</TableHead>
                      <TableHead className="w-[8%]">版本</TableHead>
                      <TableHead className="w-[8%]">来源</TableHead>
                      <TableHead className="w-[40%]">描述</TableHead>
                      <TableHead className="w-[12%]">操作</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {filtered.length > 0 ? (
                      filtered.map((plugin) => (
                        <TableRow key={plugin.key}>
                          <TableCell className="font-medium">{plugin.name}</TableCell>
                          <TableCell>{getStatusBadge(plugin.status)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {plugin.version || '—'}
                          </TableCell>
                          <TableCell>{getSourceBadge(plugin.source)}</TableCell>
                          <TableCell className="text-muted-foreground">
                            {plugin.description || '—'}
                          </TableCell>
                          <TableCell>
                            <div className="flex gap-2">
                              <Button
                                variant="outline"
                                size="sm"
                                disabled={actionLoading === `toggle:${plugin.key}`}
                                onClick={() =>
                                  togglePlugin(plugin.key, plugin.name, plugin.enabled ? 'disable' : 'enable')
                                }
                              >
                                {plugin.enabled ? (
                                  <>
                                    <PowerOff className="mr-1 h-3 w-3" />
                                    停用
                                  </>
                                ) : (
                                  <>
                                    <Power className="mr-1 h-3 w-3" />
                                    启用
                                  </>
                                )}
                              </Button>
                              <Button
                                variant="outline"
                                size="sm"
                                onClick={() => handleDelete(plugin.key, plugin.name)}
                              >
                                <Trash2 className="mr-1 h-3 w-3" />
                                删除
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))
                    ) : (
                      <TableRow>
                        <TableCell colSpan={6} className="text-center py-12 text-muted-foreground">
                          {search ? '没有匹配的插件' : '该分类下暂无插件'}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </div>
      )}

      {/* Delete confirmation dialog */}
      <ConfirmDialog
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        title="删除插件"
        description={<>确认删除插件 "{pluginToDelete?.name}" 吗？此操作不可撤销。</>}
        variant="destructive"
        onConfirm={confirmDelete}
      />
    </PageContainer>
  );
}
