import { useCallback, useState } from 'react';
import { Button, Card, Form, Input, Modal, Select, Space, Table, Tag, Alert, App as AntApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import PageHeader from '../components/PageHeader';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useAuthStore } from '../store/authStore';
import { useConfigStore } from '../store/configStore';
import type { User, UsersResponse } from '../types';

const ROLE_OPTIONS = [
  { value: 'admin', label: 'admin' },
  { value: 'user', label: 'user' },
];

export default function UserManagement() {
  const { message, modal } = AntApp.useApp();
  const navigate = useNavigate();
  const { user: currentUser, logout } = useAuthStore();
  const { profiles } = useConfigStore();
  const [modalOpen, setModalOpen] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [passwordUserId, setPasswordUserId] = useState<number | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [form] = Form.useForm();
  const [passwordForm] = Form.useForm();

  const fetchUsers = useCallback(
    () => apiClient.get<UsersResponse>('/users').then((res) => res.data.users),
    [],
  );

  const { data: users, loading, error, execute: reload } = useApi(fetchUsers, []);

  const handleCreate = async (values: { username: string; password: string; role: string; profiles: string[] }) => {
    setSubmitting(true);
    try {
      await apiClient.post('/users', values);
      message.success('用户已创建');
      setModalOpen(false);
      form.resetFields();
      reload();
    } catch {
      message.error('创建用户失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = (user: User) => {
    modal.confirm({
      title: '确认删除',
      content: `确定要删除用户 "${user.username}" 吗？`,
      okText: '删除',
      okType: 'danger',
      cancelText: '取消',
      onOk: async () => {
        try {
          await apiClient.delete(`/users/${user.id}`);
          message.success('已删除');
          reload();
        } catch {
          message.error('删除失败');
        }
      },
    });
  };

  const handleChangePassword = (user: User) => {
    setPasswordUserId(user.id);
    setPasswordModalOpen(true);
  };

  const handlePasswordSubmit = async (values: { new_password: string }) => {
    if (passwordUserId === null) return;
    setSubmitting(true);
    try {
      await apiClient.put(`/users/${passwordUserId}/password`, values);
      message.success('密码已修改');
      setPasswordModalOpen(false);
      passwordForm.resetFields();
    } catch {
      message.error('修改密码失败');
    } finally {
      setSubmitting(false);
    }
  };

  const isAdmin = currentUser?.role === 'admin';

  const columns = [
    { title: '用户名', dataIndex: 'username', width: '25%', minWidth: 100 },
    {
      title: '角色',
      dataIndex: 'role',
      width: '15%',
      minWidth: 80,
      render: (role: string) => <Tag color={role === 'admin' ? 'geekblue' : 'default'}>{role}</Tag>,
    },
    ...(isAdmin ? [{
      title: 'Profiles',
      dataIndex: 'profiles',
      width: '35%',
      minWidth: 120,
      render: (userProfiles: string[]) =>
        userProfiles?.map((p) => (
          <Tag key={p} style={{ marginBottom: 2 }}>
            {p}
          </Tag>
        )) ?? '—',
    }] : []),
    {
      title: '操作',
      width: isAdmin ? '25%' : '30%',
      minWidth: isAdmin ? 180 : 100,
      render: (_: unknown, row: User) => (
        <Space>
          <Button 
            size="small" 
            onClick={() => handleChangePassword(row)}
          >
            修改密码
          </Button>
          {isAdmin && (
            <Button 
              danger 
              size="small" 
              disabled={row.username === 'admin'} 
              onClick={() => handleDelete(row)}
            >
              删除
            </Button>
          )}
        </Space>
      ),
    },
  ];

  return (
    <>
      <PageHeader
        title="用户管理"
        description={isAdmin ? "Panel 用户独立于 Hermes profile，profile 访问通过分配控制。" : "管理您的账户信息。"}
        extra={
          <Space>
            {isAdmin && (
              <Button type="primary" onClick={() => setModalOpen(true)}>
                新建用户
              </Button>
            )}
            <Button onClick={() => { logout(); navigate('/login'); }}>
              退出登录
            </Button>
          </Space>
        }
      />
      <Alert
        message={
          <span>
            当前登录用户：<strong>{currentUser?.username}</strong>
            {currentUser?.role === 'admin' && <Tag color="geekblue" style={{ marginLeft: 8 }}>管理员</Tag>}
          </span>
        }
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
      />
      {error && <div style={{ color: '#dc2626', marginBottom: 16 }}>{error}</div>}
      <Card>
        <Table<User>
          rowKey="id"
          dataSource={users ?? []}
          columns={columns}
          loading={loading}
          pagination={false}
          size="middle"
        />
      </Card>
      <Modal
        title="新建用户"
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{ role: 'user', profiles: ['default'] }}
          onFinish={handleCreate}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
            <Input placeholder="输入用户名" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true, message: '请输入密码' }]}>
            <Input.Password placeholder="输入密码" />
          </Form.Item>
          <Form.Item name="role" label="角色">
            <Select options={ROLE_OPTIONS} />
          </Form.Item>
          <Form.Item name="profiles" label="Profiles">
            <Select
              mode="multiple"
              options={profiles.map((p) => ({ value: p, label: p }))}
              placeholder="选择可访问的 profiles"
            />
          </Form.Item>
        </Form>
      </Modal>
      <Modal
        title="修改密码"
        open={passwordModalOpen}
        onCancel={() => {
          setPasswordModalOpen(false);
          passwordForm.resetFields();
        }}
        onOk={() => passwordForm.submit()}
        confirmLoading={submitting}
        destroyOnHidden
      >
        <Form
          form={passwordForm}
          layout="vertical"
          onFinish={handlePasswordSubmit}
        >
          <Form.Item 
            name="new_password" 
            label="新密码" 
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 3, message: '密码至少 3 个字符' }
            ]}
          >
            <Input.Password placeholder="输入新密码" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
