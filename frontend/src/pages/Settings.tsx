import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useAuthStore } from '../store/authStore';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
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
import { Plus, Key, Trash2 } from 'lucide-react';
import PageContainer from '../components/PageContainer';
import PageHeader from '../components/PageHeader';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';
import ConfirmDialog from '../components/ConfirmDialog';
import type { User, UsersResponse } from '../types';

function SyncSettingsSection() {
  const { toast } = useToast();
  const [enabled, setEnabled] = useState(false);
  const [receiveEnabled, setReceiveEnabled] = useState(false);
  const [receiveRuntimeEnabled, setReceiveRuntimeEnabled] = useState(false);
  const [targetHost, setTargetHost] = useState('');
  const [targetPort, setTargetPort] = useState('8650');
  const [token, setToken] = useState('');
  const [interval, setInterval] = useState(60);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendStatus, setSendStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [sendStatusText, setSendStatusText] = useState('未验证');
  const [statusLoading, setStatusLoading] = useState(false);
  const [runtimeStatus, setRuntimeStatus] = useState<{
    enabled: boolean;
    enabled_at: number | null;
    uptime_seconds: number;
    last_received_at: number | null;
    last_profiles_count: number;
    last_hosts_count: number;
    total_payloads: number;
    receive_url: string;
    port: number;
    send: {
      enabled: boolean;
      enabled_at: number | null;
      uptime_seconds: number;
      last_push_at: number | null;
      last_push_ok: boolean | null;
      last_push_message: string | null;
      total_pushes: number;
      total_successes: number;
      total_failures: number;
    };
  } | null>(null);

  const receiveEnabledRef = useRef(receiveEnabled);
  useEffect(() => {
    receiveEnabledRef.current = receiveEnabled;
  }, [receiveEnabled]);

  const fetchSettings = useCallback(() => api.syncSettings(), []);
  const { data, loading, error, execute: reload } = useApi(fetchSettings, []);

  const fetchStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const status = await api.syncStatus();
      setRuntimeStatus(status);
      setReceiveRuntimeEnabled(status.enabled);
    } catch {
      setRuntimeStatus(null);
      // 如果运行时状态接口失败，回退到当前配置状态，避免显示不一致
      setReceiveRuntimeEnabled(receiveEnabledRef.current);
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (data) {
      setEnabled(data.enabled);
      setReceiveEnabled(data.receive_enabled);
      const parsed = parseTargetUrl(data.target_url || '');
      setTargetHost(parsed.host);
      setTargetPort(parsed.port);
      setToken(data.token || '');
      setInterval(data.interval);
      setSendStatus('idle');
      setSendStatusText('未验证');
      fetchStatus();
    }
  }, [data, fetchStatus]);

  const targetUrl = buildTargetUrl(targetHost, targetPort);

  const handleSave = async (updates: {
    enabled?: boolean;
    receiveEnabled?: boolean;
    targetHost?: string;
    targetPort?: string;
    token?: string;
    interval?: number;
  }) => {
    const nextEnabled = updates.enabled ?? enabled;
    const nextReceiveEnabled = updates.receiveEnabled ?? receiveEnabled;
    const nextHost = updates.targetHost ?? targetHost;
    const nextPort = updates.targetPort ?? targetPort;
    const nextToken = updates.token ?? token;
    const nextInterval = updates.interval ?? interval;
    const nextTargetUrl = buildTargetUrl(nextHost, nextPort);

    setSaving(true);
    try {
      await api.updateSyncSettings({
        enabled: nextEnabled,
        receive_enabled: nextReceiveEnabled,
        target_url: nextTargetUrl || null,
        token: nextToken || null,
        interval: nextInterval,
      });
      setEnabled(nextEnabled);
      setReceiveEnabled(nextReceiveEnabled);
      setTargetHost(nextHost);
      setTargetPort(nextPort);
      setToken(nextToken);
      setInterval(nextInterval);
      setSendOpen(false);
      toast({ title: '成功', description: '同步配置已保存' });
      // Refresh runtime status after saving to reflect actual process state
      fetchStatus();
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '保存失败' });
    } finally {
      setSaving(false);
    }
  };

  const handleVerify = async () => {
    if (!targetUrl) {
      toast({ variant: 'destructive', title: '错误', description: '请先配置目标地址和端口' });
      return;
    }
    setVerifying(true);
    try {
      await api.verifySyncTarget(targetUrl, token);
      setSendStatus('ok');
      setSendStatusText('连接正常');
      toast({ title: '验证成功', description: '目标面板可正常连接' });
    } catch (err: unknown) {
      setSendStatus('error');
      const message =
        (err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined) || '目标面板无法连接';
      setSendStatusText(`连接失败：${message}`);
      toast({ variant: 'destructive', title: '验证失败', description: message });
    } finally {
      setVerifying(false);
    }
  };

  const [pushing, setPushing] = useState(false);

  const handlePush = async () => {
    setPushing(true);
    try {
      const result = await api.triggerSyncPush();
      toast({ title: '同步成功', description: '数据已推送到目标面板' });
      fetchStatus();
    } catch (err: unknown) {
      const message =
        (err && typeof err === 'object' && 'response' in err
          ? (err as { response?: { data?: { detail?: string } } }).response?.data?.detail
          : undefined) || '推送失败';
      toast({ variant: 'destructive', title: '同步失败', description: message });
    } finally {
      setPushing(false);
    }
  };

  if (loading) return <Loading className="py-8" />;

  return (
    <div className="grid gap-4">
      {error && <ErrorAlert message={error} />}

      {/* 发送数据同步 */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">发送数据同步</h3>
                <StatusBadge status={enabled ? 'ok' : 'disabled'} text={enabled ? '已启用' : '未启用'} />
              </div>
              <p className="text-sm text-muted-foreground">
                将本机 profiles 数据同步到远程 hermes-panel
              </p>
            </div>
            <div className="flex items-center gap-2">
              {enabled && (
                <Button variant="outline" size="sm" onClick={handlePush} disabled={pushing}>
                  {pushing ? '同步中...' : '同步一次'}
                </Button>
              )}
              {enabled && (
                <Button variant="outline" size="sm" onClick={() => setSendOpen(true)}>
                  编辑配置
                </Button>
              )}
              {enabled && (
                <Button variant="outline" size="sm" onClick={fetchStatus} disabled={statusLoading}>
                  {statusLoading ? '刷新中...' : '刷新'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => {
                  if (enabled) {
                    handleSave({ enabled: false });
                  } else {
                    setSendOpen(true);
                  }
                }}
              >
                {enabled ? '禁用' : '启用'}
              </Button>
            </div>
          </div>

          {enabled && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">推送端点</TableHead>
                    <TableHead className="whitespace-nowrap">同步间隔</TableHead>
                    <TableHead className="whitespace-nowrap">运行时长</TableHead>
                    <TableHead className="whitespace-nowrap text-right">累计推送</TableHead>
                    <TableHead className="whitespace-nowrap text-right">成功</TableHead>
                    <TableHead className="whitespace-nowrap text-right">失败</TableHead>
                    <TableHead className="whitespace-nowrap">最近推送时间</TableHead>
                    {runtimeStatus?.send?.last_push_ok === false && (
                      <TableHead className="whitespace-nowrap">最近错误</TableHead>
                    )}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-mono text-xs break-all whitespace-normal max-w-[280px]">
                      {targetUrl ? `${targetUrl}/api/v1/sync/` : '未配置'}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{interval} 秒</TableCell>
                    <TableCell className="whitespace-nowrap">
                      {statusLoading ? '...' : formatUptime(runtimeStatus?.send?.uptime_seconds ?? 0)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {statusLoading ? '...' : (runtimeStatus?.send?.total_pushes ?? 0)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap text-emerald-600">
                      {statusLoading ? '...' : (runtimeStatus?.send?.total_successes ?? 0)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap text-red-500">
                      {statusLoading ? '...' : (runtimeStatus?.send?.total_failures ?? 0)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {statusLoading ? '...' : (runtimeStatus?.send?.last_push_at ? new Date(runtimeStatus.send.last_push_at * 1000).toLocaleString() : '暂无')}
                    </TableCell>
                    {runtimeStatus?.send?.last_push_ok === false && (
                      <TableCell className="text-xs text-red-500 break-all whitespace-normal max-w-[200px]">
                        {runtimeStatus?.send?.last_push_message || ''}
                      </TableCell>
                    )}
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}

          <Dialog open={sendOpen} onOpenChange={setSendOpen}>
            <DialogContent>
              <DialogHeader>
                <DialogTitle>发送数据同步配置</DialogTitle>
                <DialogDescription>配置目标面板地址、Token 和同步间隔</DialogDescription>
              </DialogHeader>
              <SendSyncDialogForm
                initialHost={targetHost}
                initialPort={targetPort}
                initialToken={token}
                initialInterval={interval}
                onSave={handleSave}
                saving={saving}
                onVerify={handleVerify}
                verifying={verifying}
              />
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      {/* 接收数据同步 */}
      <Card>
        <CardContent className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">接收数据同步</h3>
                <StatusBadge
                  status={receiveEnabled ? 'ok' : 'disabled'}
                  text={receiveEnabled ? (receiveRuntimeEnabled ? '运行中' : '启动中...') : '未启用'}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                允许其他 hermes-panel 将数据同步到本机
              </p>
            </div>
            <div className="flex items-center gap-2">
              {receiveEnabled && (
                <Button variant="outline" size="sm" onClick={fetchStatus} disabled={statusLoading}>
                  {statusLoading ? '刷新中...' : '刷新'}
                </Button>
              )}
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => handleSave({ receiveEnabled: !receiveEnabled })}
              >
                {receiveEnabled ? '禁用' : '启用'}
              </Button>
            </div>
          </div>

          {receiveEnabled && (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="whitespace-nowrap">接收端点</TableHead>
                    <TableHead className="whitespace-nowrap">运行时长</TableHead>
                    <TableHead className="whitespace-nowrap text-right">累计接收</TableHead>
                    <TableHead className="whitespace-nowrap">最近接收时间</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  <TableRow>
                    <TableCell className="font-mono text-xs break-all whitespace-normal max-w-[280px]">
                      {statusLoading ? '...' : (runtimeStatus?.receive_url || '—')}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">
                      {statusLoading ? '...' : formatUptime(runtimeStatus?.uptime_seconds ?? 0)}
                    </TableCell>
                    <TableCell className="text-right whitespace-nowrap">
                      {statusLoading ? '...' : (runtimeStatus?.total_payloads ?? 0)}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {statusLoading ? '...' : (runtimeStatus?.last_received_at ? new Date(runtimeStatus.last_received_at * 1000).toLocaleString() : '暂无')}
                    </TableCell>
                  </TableRow>
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SendSyncDialogForm({
  initialHost,
  initialPort,
  initialToken,
  initialInterval,
  onSave,
  saving,
  onVerify,
  verifying,
}: {
  initialHost: string;
  initialPort: string;
  initialToken: string;
  initialInterval: number;
  onSave: (updates: {
    enabled: boolean;
    targetHost: string;
    targetPort: string;
    token: string;
    interval: number;
  }) => void;
  saving: boolean;
  onVerify: () => void;
  verifying: boolean;
}) {
  const [host, setHost] = useState(initialHost);
  const [port, setPort] = useState(initialPort);
  const [token, setToken] = useState(initialToken);
  const [interval, setInterval] = useState(initialInterval);

  return (
    <div className="grid gap-4 py-4">
      <div className="grid grid-cols-[1fr_auto] gap-3">
        <div className="grid gap-2">
          <Label htmlFor="sync-target-host">目标面板地址</Label>
          <Input
            id="sync-target-host"
            placeholder="http://10.0.0.10"
            value={host}
            onChange={(e) => setHost(e.target.value)}
          />
        </div>
        <div className="grid gap-2 w-24">
          <Label htmlFor="sync-target-port">端口</Label>
          <Input
            id="sync-target-port"
            placeholder="8650"
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ''))}
          />
        </div>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="sync-token">同步 Token（发送与接收共用）</Label>
        <Input
          id="sync-token"
          type="password"
          placeholder="与目标面板配置的 SYNC_TOKEN 一致"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </div>
      <div className="grid gap-2">
        <Label htmlFor="sync-interval">同步间隔（秒）</Label>
        <Input
          id="sync-interval"
          type="number"
          min={10}
          value={interval}
          onChange={(e) => setInterval(parseInt(e.target.value || '60', 10))}
        />
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onVerify} disabled={verifying || saving}>
          {verifying ? '验证中...' : '验证连接'}
        </Button>
        <Button onClick={() => onSave({ enabled: true, targetHost: host, targetPort: port, token, interval })} disabled={saving}>
          {saving ? '保存中...' : '保存配置'}
        </Button>
      </DialogFooter>
    </div>
  );
}

function StatusBadge({ status, text }: { status: 'idle' | 'ok' | 'error' | 'disabled'; text: string }) {
  const base = 'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium';
  if (status === 'ok') {
    return <span className={`${base} bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300`}>{text}</span>;
  }
  if (status === 'error') {
    return <span className={`${base} bg-red-100 text-red-700 dark:bg-red-900 dark:text-red-300`}>{text}</span>;
  }
  if (status === 'disabled') {
    return <span className={`${base} bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400`}>{text}</span>;
  }
  return <span className={`${base} bg-muted text-muted-foreground`}>{text}</span>;
}

function parseTargetUrl(url: string): { host: string; port: string } {
  if (!url) return { host: '', port: '8650' };
  try {
    const parsed = new URL(url);
    return {
      host: `${parsed.protocol}//${parsed.hostname}`,
      port: parsed.port || (parsed.protocol === 'https:' ? '443' : '80'),
    };
  } catch {
    try {
      const parsed = new URL(`http://${url}`);
      return {
        host: `http://${parsed.hostname}`,
        port: parsed.port || '8650',
      };
    } catch {
      return { host: url, port: '8650' };
    }
  }
}

function buildTargetUrl(host: string, port: string): string {
  const h = host.trim().replace(/\/$/, '');
  const p = port.trim();
  if (!h) return '';
  const normalized = /^https?:\/\//i.test(h) ? h : `http://${h}`;
  if (!p) return normalized;
  return `${normalized}:${p}`;
}

function formatUptime(seconds: number): string {
  if (seconds <= 0) return '0 秒';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hours > 0) {
    return `${hours} 小时 ${minutes} 分 ${secs} 秒`;
  }
  if (minutes > 0) {
    return `${minutes} 分 ${secs} 秒`;
  }
  return `${secs} 秒`;
}

function UserSettingsSection() {
  const { toast } = useToast();
  const { user: currentUser } = useAuthStore();
  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [passwordDialogOpen, setPasswordDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [selectedUser, setSelectedUser] = useState<User | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [newUsername, setNewUsername] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [newRole, setNewRole] = useState('user');
  const [newProfiles, setNewProfiles] = useState<string[]>(['default']);
  const [newPasswordValue, setNewPasswordValue] = useState('');

  const fetchUsers = useCallback(
    () => apiClient.get<UsersResponse>('/users').then((res) => res.data.users),
    [],
  );
  const { data: users, loading, error, execute: reload } = useApi(fetchUsers, []);

  const handleCreate = async () => {
    if (!newUsername || !newPassword) {
      toast({ variant: 'destructive', title: '错误', description: '用户名和密码不能为空' });
      return;
    }
    setSubmitting(true);
    try {
      await apiClient.post('/users', {
        username: newUsername,
        password: newPassword,
        role: newRole,
        profiles: newProfiles,
      });
      toast({ title: '成功', description: '用户已创建' });
      setCreateDialogOpen(false);
      setNewUsername('');
      setNewPassword('');
      setNewRole('user');
      setNewProfiles(['default']);
      reload();
    } catch {
      toast({ variant: 'destructive', title: '错误', description: '创建用户失败' });
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = () => {
    if (!selectedUser) return;
    apiClient
      .delete(`/users/${selectedUser.id}`)
      .then(() => {
        toast({ title: '成功', description: '用户已删除' });
        setDeleteDialogOpen(false);
        setSelectedUser(null);
        reload();
      })
      .catch(() => {
        toast({ variant: 'destructive', title: '错误', description: '删除失败' });
      });
  };

  const handleChangePassword = () => {
    if (!selectedUser || !newPasswordValue) {
      toast({ variant: 'destructive', title: '错误', description: '请输入新密码' });
      return;
    }
    if (newPasswordValue.length < 3) {
      toast({ variant: 'destructive', title: '错误', description: '密码至少 3 个字符' });
      return;
    }
    setSubmitting(true);
    apiClient
      .put(`/users/${selectedUser.id}/password`, { new_password: newPasswordValue })
      .then(() => {
        toast({ title: '成功', description: '密码已修改' });
        setPasswordDialogOpen(false);
        setSelectedUser(null);
        setNewPasswordValue('');
      })
      .catch(() => {
        toast({ variant: 'destructive', title: '错误', description: '修改密码失败' });
      })
      .finally(() => {
        setSubmitting(false);
      });
  };

  const isAdmin = currentUser?.role === 'admin';

  return (
    <Card>
      <CardContent className="space-y-4 pt-5">
        <div className="flex items-center justify-between mt-2">
          <div className="space-y-1">
            <h3 className="text-sm font-semibold">用户管理</h3>
            <p className="text-sm text-muted-foreground">管理可登录 Panel 的用户账户</p>
          </div>
          {isAdmin && (
            <Button size="sm" onClick={() => setCreateDialogOpen(true)}>
              <Plus className="mr-2 h-4 w-4" />
              新建用户
            </Button>
          )}
        </div>

        {error && <ErrorAlert message={error} />}

        {loading ? (
          <Loading className="py-12" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[25%]">用户名</TableHead>
                <TableHead className="w-[15%]">角色</TableHead>
                {isAdmin && <TableHead className="w-[35%]">Profiles</TableHead>}
                <TableHead className={isAdmin ? 'w-[25%]' : 'w-[30%]'}>操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {users && users.length > 0 ? (
                users.map((user) => (
                  <TableRow key={user.id}>
                    <TableCell className="font-medium">{user.username}</TableCell>
                    <TableCell className="font-medium">
                      {user.role}
                    </TableCell>
                    {isAdmin && (
                      <TableCell>
                        <div className="flex flex-wrap gap-1">
                          {user.profiles?.map((p) => (
                            <span key={p} className="text-sm">{p}</span>
                          )) ?? '—'}
                        </div>
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => {
                            setSelectedUser(user);
                            setPasswordDialogOpen(true);
                          }}
                        >
                          <Key className="mr-1 h-3 w-3" />
                          修改密码
                        </Button>
                        {isAdmin && (
                          <Button
                            variant="outline"
                            size="sm"
                            disabled={user.username === 'admin'}
                            onClick={() => {
                              setSelectedUser(user);
                              setDeleteDialogOpen(true);
                            }}
                          >
                            <Trash2 className="mr-1 h-3 w-3" />
                            删除
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              ) : (
                <TableRow>
                  <TableCell
                    colSpan={isAdmin ? 4 : 3}
                    className="text-center py-12 text-muted-foreground"
                  >
                    暂无用户数据
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        )}

        <Dialog open={createDialogOpen} onOpenChange={setCreateDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>新建用户</DialogTitle>
              <DialogDescription>创建一个新的 Panel 用户账户</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="username">用户名</Label>
                <Input
                  id="username"
                  placeholder="输入用户名"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="password">密码</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="输入密码"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                />
              </div>
              <div className="grid gap-2">
                <Label htmlFor="role">角色</Label>
                <Select value={newRole} onValueChange={setNewRole}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="user">user</SelectItem>
                    <SelectItem value="admin">admin</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setCreateDialogOpen(false)}>
                取消
              </Button>
              <Button onClick={handleCreate} disabled={submitting}>
                {submitting ? '创建中...' : '创建'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <Dialog open={passwordDialogOpen} onOpenChange={setPasswordDialogOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>修改密码</DialogTitle>
              <DialogDescription>为 {selectedUser?.username} 设置新密码</DialogDescription>
            </DialogHeader>
            <div className="grid gap-4 py-4">
              <div className="grid gap-2">
                <Label htmlFor="new-password">新密码</Label>
                <Input
                  id="new-password"
                  type="password"
                  placeholder="输入新密码"
                  value={newPasswordValue}
                  onChange={(e) => setNewPasswordValue(e.target.value)}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setPasswordDialogOpen(false)}>
                取消
              </Button>
              <Button onClick={handleChangePassword} disabled={submitting}>
                {submitting ? '修改中...' : '确认修改'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        <ConfirmDialog
          open={deleteDialogOpen}
          onOpenChange={setDeleteDialogOpen}
          title="确认删除"
          description={<>确定要删除用户 &quot;{selectedUser?.username}&quot; 吗？此操作不可撤销。</>}
          variant="destructive"
          onConfirm={handleDelete}
        />
      </CardContent>
    </Card>
  );
}

export default function Settings() {
  const { user: currentUser } = useAuthStore();
  const isAdmin = currentUser?.role === 'admin';

  return (
    <PageContainer>
      <PageHeader />
      <div className="space-y-6">
        {isAdmin && <SyncSettingsSection />}
        <UserSettingsSection />
      </div>
    </PageContainer>
  );
}
