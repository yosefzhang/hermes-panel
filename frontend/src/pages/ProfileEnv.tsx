import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useParams } from 'react-router-dom';
import {
  Button, Card, Form, Input, Modal, Space, Table,
  App as AntApp,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import PageHeader from '../components/PageHeader';
import { api } from '../api/client';

interface EnvRow {
  key: string;
  value: string;
}

interface EnvEditModalProps {
  open: boolean;
  onClose: () => void;
  activeProfile: string;
  editingKey?: string;
  editingValue?: string;
  onSaved: () => void;
}

function EnvEditModal({ open, onClose, activeProfile, editingKey, editingValue, onSaved }: EnvEditModalProps) {
  const { message } = AntApp.useApp();
  const [form] = Form.useForm();
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      form.setFieldsValue({
        key: editingKey || '',
        value: editingValue || '',
      });
    }
  }, [open, editingKey, editingValue, form]);

  const handleSubmit = async (values: { key: string; value: string }) => {
    if (!values.key.trim()) {
      message.error('请输入变量名');
      return;
    }
    setSaving(true);
    try {
      await api.updateEnv(activeProfile, values.key.trim(), values.value);
      message.success(editingKey ? `${editingKey} 已更新` : `${values.key} 已添加`);
      onClose();
      onSaved();
    } catch (e) {
      message.error(`保存失败: ${e}`);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={editingKey ? `编辑 ${editingKey}` : '添加环境变量'}
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
    >
      <Form form={form} onFinish={handleSubmit} layout="vertical">
        <Form.Item
          name="key"
          label="变量名"
          rules={[{ required: true, message: '请输入变量名' }]}
        >
          <Input placeholder="例如: OPENAI_API_KEY" disabled={!!editingKey} />
        </Form.Item>
        <Form.Item
          name="value"
          label="变量值"
          rules={[{ required: true, message: '请输入变量值' }]}
        >
          <Input.TextArea
            placeholder="输入变量值"
            rows={4}
            style={{ fontFamily: 'monospace' }}
          />
        </Form.Item>
        <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
          <Space>
            <Button onClick={onClose}>取消</Button>
            <Button type="primary" htmlType="submit" loading={saving}>
              保存
            </Button>
          </Space>
        </Form.Item>
      </Form>
    </Modal>
  );
}

export default function ProfileEnv() {
  const { message, modal } = AntApp.useApp();
  const { profile } = useParams<{ profile: string }>();
  const activeProfile = profile || 'default';

  const [rows, setRows] = useState<EnvRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [deletingKey, setDeletingKey] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [editingKey, setEditingKey] = useState<string | undefined>();
  const [editingValue, setEditingValue] = useState<string | undefined>();

  const loadEnv = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.envPlain(activeProfile);
      const nextRows = Object.entries(data)
        .map(([key, value]) => ({ key, value }))
        .sort((a, b) => a.key.localeCompare(b.key));
      setRows(nextRows);
    } catch {
      message.error('加载环境变量失败');
    } finally {
      setLoading(false);
    }
  }, [activeProfile, message]);

  useEffect(() => {
    loadEnv();
  }, [loadEnv]);

  const handleAdd = () => {
    setEditingKey(undefined);
    setEditingValue(undefined);
    setModalOpen(true);
  };

  const handleEdit = (key: string, value: string) => {
    setEditingKey(key);
    setEditingValue(value);
    setModalOpen(true);
  };

  const handleDelete = (key: string) => {
    modal.confirm({
      title: '确认删除',
      content: `确定要删除环境变量 ${key} 吗？`,
      okButtonProps: { danger: true },
      onOk: async () => {
        setDeletingKey(key);
        try {
          await api.deleteEnv(activeProfile, key);
          message.success(`${key} 已删除`);
          await loadEnv();
        } catch (e) {
          message.error(`删除失败: ${e}`);
        } finally {
          setDeletingKey(null);
        }
      },
    });
  };

  const handleSaved = () => {
    loadEnv();
  };

  const valueCellStyle: CSSProperties = {
    whiteSpace: 'normal',
    wordBreak: 'break-all',
    overflowWrap: 'anywhere',
  };

  const columns = useMemo<ColumnsType<EnvRow>>(() => ([
    {
      title: '环境变量名称',
      dataIndex: 'key',
      key: 'key',
      width: 280,
      render: (key: string) => key,
    },
    {
      title: '值',
      dataIndex: 'value',
      key: 'value',
      onCell: () => ({
        style: valueCellStyle,
      }),
      render: (value: string) => value || '-',
    },
    {
      title: '操作',
      key: 'actions',
      width: 180,
      render: (_: unknown, record: EnvRow) => (
        <Space>
          <Button
            size="small"
            onClick={() => handleEdit(record.key, record.value)}
          >
            编辑
          </Button>
          <Button
            size="small"
            danger
            onClick={() => handleDelete(record.key)}
            loading={deletingKey === record.key}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ]), [deletingKey]);

  return (
    <>
      <PageHeader
        title="环境变量"
        profile={activeProfile}
        profileName="从当前 Profile 的 .env 文件读取并管理环境变量"
        extra={
          <Button type="primary" onClick={handleAdd}>
            添加环境变量
          </Button>
        }
      />
      <Card loading={loading}>
        <Table
          rowKey="key"
          size="small"
          bordered
          tableLayout="fixed"
          dataSource={rows}
          columns={columns}
          pagination={{ pageSize: 20, showSizeChanger: false }}
          locale={{ emptyText: '当前 .env 暂无环境变量' }}
        />
      </Card>
      <EnvEditModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        activeProfile={activeProfile}
        editingKey={editingKey}
        editingValue={editingValue}
        onSaved={handleSaved}
      />
    </>
  );
}
