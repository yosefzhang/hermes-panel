import { useEffect, useState } from 'react';
import { Button, Form, Input, Modal, Select, Space } from 'antd';
import type { ProviderPreset } from '../pages/ModelsConfig';

interface Props {
  open: boolean;
  isEditing: boolean;
  editIndex: number | null;
  initialData?: {
    name: string;
    base_url: string;
    key_env?: string;
    api_key?: string;
    api_mode?: string;
    default_model?: string;
    context_length?: number;
    rate_limit_delay?: number;
  };
  presets: ProviderPreset[];
  presetsLoading: boolean;
  onCancel: () => void;
  onSubmit: (values: {
    name: string;
    base_url: string;
    key_env?: string;
    api_key?: string;
    api_mode?: string;
    default_model?: string;
    context_length?: number;
    rate_limit_delay?: number;
  }) => void;
}

const API_MODE_OPTIONS = [
  { value: 'chat_completions', label: 'chat_completions' },
  { value: 'anthropic_messages', label: 'anthropic_messages' },
  { value: 'codex_responses', label: 'codex_responses' },
  { value: 'bedrock_converse', label: 'bedrock_converse' },
  { value: 'codex_app_server', label: 'codex_app_server' },
];

export default function ProviderEditModal({
  open,
  isEditing,
  editIndex,
  initialData,
  presets,
  presetsLoading,
  onCancel,
  onSubmit,
}: Props) {
  const [form] = Form.useForm();
  const [editMode, setEditMode] = useState<'preset' | 'custom'>('preset');

  useEffect(() => {
    if (!open) return;
    if (isEditing && initialData) {
      form.resetFields();
      form.setFieldsValue({
        name: initialData.name,
        base_url: initialData.base_url,
        key_env: initialData.key_env,
        api_key: initialData.api_key,
        api_mode: initialData.api_mode,
        default_model: initialData.default_model,
        context_length: initialData.context_length,
        rate_limit_delay: initialData.rate_limit_delay,
      });
    } else if (!isEditing) {
      form.resetFields();
    }
  }, [open, isEditing, initialData, form]);

  return (
    <Modal
      title={isEditing ? '编辑 Provider' : '添加 Provider'}
      open={open}
      onCancel={onCancel}
      onOk={() => form.submit()}
      confirmLoading={false}
      okText={isEditing ? '保存' : '添加'}
      cancelText="取消"
      width={520}
      destroyOnHidden
      styles={{
        footer: {
          textAlign: 'right',
        },
      }}
    >
      {!isEditing ? (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            onSubmit({
              name: values.name?.trim() || '',
              base_url: values.base_url?.trim() || '',
              key_env: values.key_env?.trim() || '',
              api_key: values.api_key || '',
              api_mode: values.api_mode?.trim() || '',
              default_model: values.default_model?.trim() || '',
              context_length:
                values.context_length === '' || values.context_length == null
                  ? undefined
                  : Number(values.context_length) || undefined,
              rate_limit_delay:
                values.rate_limit_delay === '' || values.rate_limit_delay == null
                  ? undefined
                  : Number(values.rate_limit_delay) || undefined,
            });
          }}
          style={{ marginTop: 8 }}
        >
          <Form.Item label="Provider 类型">
            <Space>
              <Button
                type={editMode === 'preset' ? 'primary' : 'default'}
                onClick={() => {
                  setEditMode('preset');
                  form.setFieldsValue({ name: '', base_url: '', key_env: '', api_key: '', default_model: '', context_length: '', rate_limit_delay: '' });
                }}
                style={{ borderRadius: 4 }}
              >
                预设
              </Button>
              <Button
                type={editMode === 'custom' ? 'primary' : 'default'}
                onClick={() => {
                  setEditMode('custom');
                  form.setFieldsValue({ name: '', base_url: '', key_env: '', api_key: '', default_model: '', context_length: '', rate_limit_delay: '' });
                }}
                style={{ borderRadius: 4 }}
              >
                自定义
              </Button>
            </Space>
          </Form.Item>

          {editMode === 'preset' ? (
            <Form.Item name="name" label="选择 Provider *" rules={[{ required: true, message: '请选择 Provider' }]}>
              <Select
                placeholder="选择一个 provider..."
                showSearch
                allowClear
                loading={presetsLoading}
                options={presets.map((p) => ({ label: p.name, value: p.id }))}
                onChange={(value) => {
                  const preset = presets.find((p) => p.id === value);
                  if (preset) {
                    form.setFieldsValue({
                      name: preset.id,
                      base_url: preset.base_url,
                      key_env: preset.key_env,
                    });
                  }
                }}
              />
            </Form.Item>
          ) : (
            <Form.Item name="name" label="Provider 名称 *" rules={[{ required: true, message: '请输入 Provider 名称' }]}>
              <Input placeholder="例如 my-custom-provider" />
            </Form.Item>
          )}

          <Form.Item name="base_url" label="Base URL *" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="例如 https://api.example.com/v1" />
          </Form.Item>

          <Form.Item name="key_env" label="环境变量名称" rules={[{ required: true, message: '请输入环境变量名称' }]}>
            <Input
              placeholder="例如 OPENROUTER_API_KEY"
            />
          </Form.Item>

          <Form.Item name="api_key" label="API Key *" rules={[{ required: true, message: '请输入 API Key' }]}>
            <Input.Password
              placeholder="sk-..."
              visibilityToggle
            />
          </Form.Item>

          <Form.Item name="api_mode" label="API Mode">
            <Select
              options={API_MODE_OPTIONS}
              placeholder="选择 API Mode（可选）"
              allowClear
            />
          </Form.Item>

          <Form.Item name="default_model" label="默认模型">
            <Input placeholder="例如 gpt-4o（可选）" />
          </Form.Item>

          <Form.Item name="context_length" label="上下文长度">
            <Input type="number" min={0} placeholder="例如 128000（可选）" />
          </Form.Item>

          <Form.Item name="rate_limit_delay" label="限流延迟（秒）">
            <Input type="number" min={0} step="0.1" placeholder="例如 0.5（可选）" />
          </Form.Item>
        </Form>
      ) : (
        <Form
          form={form}
          layout="vertical"
          onFinish={(values) => {
            onSubmit({
              name: values.name?.trim() || '',
              base_url: values.base_url?.trim() || '',
              key_env: values.key_env?.trim() || '',
              api_key: values.api_key || '',
              api_mode: values.api_mode?.trim() || '',
              default_model: values.default_model?.trim() || '',
              context_length:
                values.context_length === '' || values.context_length == null
                  ? undefined
                  : Number(values.context_length) || undefined,
              rate_limit_delay:
                values.rate_limit_delay === '' || values.rate_limit_delay == null
                  ? undefined
                  : Number(values.rate_limit_delay) || undefined,
            });
          }}
          style={{ marginTop: 8 }}
        >
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="openrouter-custom" />
          </Form.Item>
          <Form.Item name="base_url" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="https://openrouter.ai/api/v1" />
          </Form.Item>
          <Form.Item name="key_env" label="Key Env 变量名">
            <Input placeholder="OPENROUTER_API_KEY" />
          </Form.Item>
          <Form.Item name="api_key" label="API Key">
            <Input.Password placeholder="可直接输入 API Key，或通过环境变量配置" />
          </Form.Item>
          <Form.Item name="api_mode" label="API Mode">
            <Select
              options={API_MODE_OPTIONS}
              placeholder="选择 API Mode（可选）"
              allowClear
            />
          </Form.Item>
          <Form.Item name="default_model" label="默认模型">
            <Input placeholder="例如 gpt-4o（可选）" />
          </Form.Item>
          <Form.Item name="context_length" label="上下文长度">
            <Input type="number" min={0} placeholder="例如 128000（可选）" />
          </Form.Item>
          <Form.Item name="rate_limit_delay" label="限流延迟（秒）">
            <Input type="number" min={0} step="0.1" placeholder="例如 0.5（可选）" />
          </Form.Item>
        </Form>
      )}
    </Modal>
  );
}