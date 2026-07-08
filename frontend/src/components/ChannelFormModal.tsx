import { useEffect, useState } from 'react';
import { Form, Input, InputNumber, Modal, Select, Switch, Button, Space } from 'antd';
import { CHANNEL_TYPES, type ChannelTypeDef, getNestedValue, setNestedValue } from '../config/channelDefs';

interface Props {
  open: boolean;
  editingType: string | null;  // null = 新建，需先选类型
  initialData: Record<string, unknown> | null;
  disabledTypes?: string[];
  onCancel: () => void;
  onSubmit: (type: string, data: Record<string, unknown>) => Promise<void>;
}

export default function ChannelFormModal({ open, editingType, initialData, disabledTypes = [], onCancel, onSubmit }: Props) {
  const [form] = Form.useForm<Record<string, unknown>>();
  const [selectedType, setSelectedType] = useState<string | null>(editingType);
  const [saving, setSaving] = useState(false);
  const [channelPrompts, setChannelPrompts] = useState<[string, string][]>([]);

  const typeDef: ChannelTypeDef | undefined = selectedType
    ? CHANNEL_TYPES.find((c) => c.type === selectedType)
    : undefined;

  useEffect(() => {
    if (open) {
      setSelectedType(editingType ?? null);
      if (editingType && initialData) {
        const def = CHANNEL_TYPES.find((c) => c.type === editingType);
        const initial: Record<string, unknown> = {};
        if (def) {
          for (const f of def.fields) {
            const val = getNestedValue(initialData, f.key);
            if (val !== undefined) {
              setNestedValue(initial, f.key, val);
            } else if (f.defaultValue !== undefined) {
              setNestedValue(initial, f.key, f.defaultValue);
            }
          }
        }
        // 也保留原始数据中不在 schema 里的字段
        for (const [k, v] of Object.entries(initialData)) {
          if (!(k in initial)) initial[k] = v;
        }
        queueMicrotask(() => (form as any).setFieldsValue(initial));

        // channel_prompts 特殊处理
        const prompts = initialData.channel_prompts as Record<string, string> | undefined;
        if (prompts && typeof prompts === 'object') {
          setChannelPrompts(Object.entries(prompts));
        } else {
          setChannelPrompts([]);
        }
      } else {
        form.resetFields();
        setChannelPrompts([]);
      }
    }
  }, [open, editingType, initialData, form]);

  useEffect(() => {
    if (!open || !selectedType || editingType) return;
    form.resetFields();
    const def = CHANNEL_TYPES.find((c) => c.type === selectedType);
    if (!def) return;
    const defaults: Record<string, unknown> = {};
    for (const f of def.fields) {
      if (f.defaultValue !== undefined) {
        setNestedValue(defaults, f.key, f.defaultValue);
      }
    }
    queueMicrotask(() => (form as any).setFieldsValue(defaults));
  }, [open, selectedType, editingType, form]);

  const handleFinish = async (values: Record<string, unknown>) => {
    if (!selectedType) return;
    setSaving(true);
    try {
      // 合并 channel_prompts
      if (channelPrompts.length > 0) {
        const prompts: Record<string, string> = {};
        for (const [k, v] of channelPrompts) {
          if (k) prompts[k] = v;
        }
        values.channel_prompts = prompts;
      }
      await onSubmit(selectedType, values);
      form.resetFields();
      setChannelPrompts([]);
    } finally {
      setSaving(false);
    }
  };

  const renderField = (field: ChannelTypeDef['fields'][0]) => {
    const common = { style: { width: '100%' } };
    const namePath = field.key.split('.');

    switch (field.type) {
      case 'boolean':
        return (
          <Form.Item key={field.key} name={namePath} label={field.label} valuePropName="checked" tooltip={field.tooltip}>
            <Switch />
          </Form.Item>
        );
      case 'number':
        return (
          <Form.Item key={field.key} name={namePath} label={field.label} tooltip={field.tooltip}>
            <InputNumber {...common} placeholder={field.placeholder} />
          </Form.Item>
        );
      case 'password':
        return (
          <Form.Item key={field.key} name={namePath} label={field.label} tooltip={field.tooltip}>
            <Input.Password {...common} placeholder={field.placeholder} />
          </Form.Item>
        );
      case 'textarea':
        return (
          <Form.Item key={field.key} name={namePath} label={field.label} tooltip={field.tooltip}>
            <Input.TextArea {...common} placeholder={field.placeholder} rows={3} />
          </Form.Item>
        );
      default:
        return (
          <Form.Item key={field.key} name={namePath} label={field.label} tooltip={field.tooltip} rules={field.required ? [{ required: true, message: `请输入${field.label}` }] : undefined}>
            <Input {...common} placeholder={field.placeholder} />
          </Form.Item>
        );
    }
  };

  const addPrompt = () => setChannelPrompts([...channelPrompts, ['', '']]);
  const removePrompt = (i: number) => setChannelPrompts(channelPrompts.filter((_, idx) => idx !== i));
  const updatePrompt = (i: number, key: string, value: string) => {
    const next = [...channelPrompts];
    next[i] = [key, value];
    setChannelPrompts(next);
  };

  const channelOptions = CHANNEL_TYPES.map((c) => ({
    value: c.type,
    label: c.label,
    disabled: !editingType && disabledTypes.includes(c.type),
  }));

  const modalTitle = editingType ? `编辑渠道: ${typeDef?.label ?? ''}` : '新增消息渠道';

  return (
    <Modal
      title={modalTitle}
      open={open}
      onCancel={onCancel}
      onOk={selectedType ? () => form.submit() : undefined}
      confirmLoading={saving}
      okText={editingType ? '保存' : '创建'}
      cancelText="取消"
      width={640}
      destroyOnHidden
    >
      <Form form={form} layout="vertical" onFinish={handleFinish} style={{ marginTop: 8 }}>
        <Form.Item label="渠道类型" required>
          <Select
            value={selectedType ?? undefined}
            placeholder="请选择消息渠道类型"
            disabled={Boolean(editingType)}
            onChange={(val) => {
              setSelectedType(val);
              setChannelPrompts([]);
            }}
            options={channelOptions}
          />
        </Form.Item>

        {selectedType && typeDef && (
          <>
            <div style={{ marginBottom: 12, color: '#666' }}>{typeDef.description}</div>
            {typeDef.fields.map(renderField)}

            {/* channel_prompts 特殊处理：仅 telegram 和 discord */}
            {(selectedType === 'telegram' || selectedType === 'discord') && (
              <div style={{ marginBottom: 16 }}>
                <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                  <span style={{ fontWeight: 500 }}>频道提示词</span>
                  <Button size="small" onClick={addPrompt}>添加</Button>
                </div>
                {channelPrompts.map(([key, val], i) => (
                  <Space key={i} style={{ display: 'flex', marginBottom: 8 }} align="start">
                    <Input
                      style={{ width: 180 }}
                      placeholder="频道名称/ID"
                      value={key}
                      onChange={(e) => updatePrompt(i, e.target.value, val)}
                    />
                    <Input
                      style={{ width: 280 }}
                      placeholder="提示词内容"
                      value={val}
                      onChange={(e) => updatePrompt(i, key, e.target.value)}
                    />
                    <Button size="small" danger onClick={() => removePrompt(i)}>删除</Button>
                  </Space>
                ))}
                {channelPrompts.length === 0 && (
                  <div style={{ color: '#999', fontSize: 12 }}>暂无频道提示词，点击"添加"按钮配置。</div>
                )}
              </div>
            )}
          </>
        )}
      </Form>
    </Modal>
  );
}
