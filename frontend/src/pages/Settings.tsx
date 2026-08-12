import { useCallback, useEffect, useState } from 'react';
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
  const [targetHost, setTargetHost] = useState('');
  const [targetPort, setTargetPort] = useState('8650');
  const [token, setToken] = useState('');
  const [interval, setInterval] = useState(60);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [sendOpen, setSendOpen] = useState(false);
  const [sendStatus, setSendStatus] = useState<'idle' | 'ok' | 'error'>('idle');
  const [sendStatusText, setSendStatusText] = useState('未验证');

  const fetchSettings = useCallback(() => api.syncSettings(), []);
  const { data, loading, error, execute: reload } = useApi(fetchSettings, []);

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
    }
  }, [data]);

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

  if (loading) return <Loading className="py-8" />;

  return (
    <div className="grid gap-4">
      {error && <ErrorAlert message={error} />}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
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

          {enabled && (
            <div
              className="rounded-md bg-muted/50 p-3 space-y-1 text-sm cursor-pointer hover:bg-muted/70 transition-colors"
              onClick={() => setSendOpen(true)}
              title="点击编辑配置"
            >
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">目标地址</span>
                <span className="font-medium truncate" title={targetUrl || '未配置'}>
                  {targetUrl || '未配置'}
                </span>
              </div>
              <div className="flex justify-between gap-2">
                <span className="text-muted-foreground">同步间隔</span>
                <span className="font-medium">{interval} 秒</span>
              </div>
            </div>
          )}

          <div className="flex justify-end gap-2">
            {enabled && (
              <>
                <StatusBadge status={sendStatus} text={sendStatusText} />
                <Button variant="outline" size="sm" onClick={handleVerify} disabled={verifying}>
                  {verifying ? '验证中...' : '验证连接'}
                </Button>
              </>
            )}
          </div>

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
              />
            </DialogContent>
          </Dialog>
        </CardContent>
      </Card>

      <Card>
        <CardContent className="p-5">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <h3 className="text-sm font-semibold">接收数据同步</h3>
                <StatusBadge
                  status={receiveEnabled ? 'ok' : 'disabled'}
                  text={receiveEnabled ? '已启用' : '未启用'}
                />
              </div>
              <p className="text-sm text-muted-foreground">
                允许其他 hermes-panel 将数据同步到本机
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              disabled={saving}
              onClick={() => handleSave({ receiveEnabled: !receiveEnabled })}
            >
              {receiveEnabled ? '禁用' : '启用'}
            </Button>
          </div>
        </CardContent>
      </Card>
      </div>
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
}: {
  initialHost: string;
  initialPort: string;
  initialToken: string;
  initialInterval: number;
  onSave: (updates: {
    targetHost: string;
    targetPort: string;
    token: string;
    interval: number;
  }) => void;
  saving: boolean;
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
        <Button onClick={() => onSave({ targetHost: host, targetPort: port, token, interval })} disabled={saving}>
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
