import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Input, Segmented, Space, Tree, App as AntApp, Row, Col } from 'antd';
import PageHeader from '../components/PageHeader';
import JsonEditor from '../components/JsonEditor';
import { api, apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';

const CATEGORY_LABELS: Record<string, string> = {
  model: '模型配置',
  agent: '代理配置',
  gateway: '网关配置',
  terminal: '终端配置',
  display: '显示配置',
  memory: '记忆配置',
  compression: '压缩配置',
  security: '安全配置',
  browser: '浏览器配置',
  voice: '语音配置',
  tts: 'TTS 配置',
  stt: 'STT 配置',
  logging: '日志配置',
  discord: 'Discord 配置',
  auxiliary: '辅助配置',
  bedrock: 'Bedrock 配置',
  curator: '策展配置',
  kanban: '看板配置',
  model_catalog: '模型目录',
  openrouter: 'OpenRouter 配置',
  sessions: '会话配置',
  tool_loop_guardrails: '工具循环防护',
  tool_output: '工具输出配置',
  updates: '更新配置',
};

export default function ProfileConfig() {
  const { message } = AntApp.useApp();
  const { activeProfile } = useConfigStore();
  const [mode, setMode] = useState<'section' | 'raw'>('section');
  const [sections, setSections] = useState<string[]>([]);
  const [activeCategory, setActiveCategory] = useState<string>('');
  const [text, setText] = useState('{}');
  const [yamlText, setYamlText] = useState('');
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadSections = useCallback(async () => {
    try {
      const data = await apiClient.get<{ sections: string[] }>('/config/sections');
      setSections(data.data.sections || []);
      if (data.data.sections?.length > 0 && !activeCategory) {
        setActiveCategory(data.data.sections[0]);
      }
    } catch {
      message.error('加载配置分类失败');
    }
  }, [activeCategory, message]);

  const loadSectionData = useCallback(async () => {
    if (!activeCategory) return;
    try {
      const data = await api.section(activeProfile, activeCategory);
      setText(JSON.stringify(data, null, 2));
    } catch {
      setText('{}');
    }
  }, [activeProfile, activeCategory]);

  const loadRawConfig = useCallback(async () => {
    try {
      const content = await api.rawConfig(activeProfile);
      setYamlText(content);
    } catch {
      setYamlText('');
    }
  }, [activeProfile]);

  const loadData = useCallback(async () => {
    setLoading(true);
    try {
      await Promise.all([loadSections(), loadRawConfig()]);
    } finally {
      setLoading(false);
    }
  }, [loadSections, loadRawConfig]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  useEffect(() => {
    if (mode === 'section' && activeCategory) {
      loadSectionData();
    }
  }, [mode, activeCategory, loadSectionData]);

  const handleSave = async () => {
    setSaving(true);
    try {
      if (mode === 'raw') {
        await api.updateRawConfig(activeProfile, text);
        setYamlText(text);
      } else {
        const parsed = JSON.parse(text);
        await api.updateSection(activeProfile, activeCategory, parsed);
        await loadSectionData();
      }
      message.success('配置已保存，重启 Hermes 后生效');
    } catch (error) {
      message.error(error instanceof SyntaxError ? 'JSON 格式不正确' : '保存失败');
    } finally {
      setSaving(false);
    }
  };

  const handleReload = () => {
    loadData();
    message.info('配置已重新加载');
  };

  const treeData = sections.map(cat => ({
    key: cat,
    title: CATEGORY_LABELS[cat] || cat,
  }));

  const filteredCategories = searchQuery
    ? treeData.filter(item => 
        item.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
        item.key.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : treeData;

  return (
    <>
      <PageHeader
        title="配置管理"
        profile={activeProfile}
        profileName="管理 Hermes 配置文件（config.yaml）"
        extra={
          <Space>
            <Input
              placeholder="搜索配置项..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              style={{ width: 200 }}
              allowClear
            />
            <Segmented
              value={mode}
              onChange={(value) => setMode(value as 'section' | 'raw')}
              options={[
                { label: '分类模式', value: 'section' },
                { label: '原始 YAML', value: 'raw' },
              ]}
            />
            <Button onClick={handleReload} loading={loading}>
              刷新
            </Button>
          </Space>
        }
      />
      <Row gutter={16}>
        {mode === 'section' && (
          <Col span={6}>
            <Card title="配置分类" size="small">
              <Tree
                treeData={filteredCategories}
                selectedKeys={[activeCategory]}
                onSelect={(keys) => {
                  if (keys.length > 0) {
                    setActiveCategory(keys[0] as string);
                  }
                }}
                blockNode
              />
            </Card>
          </Col>
        )}
        <Col span={mode === 'section' ? 18 : 24}>
          <Card
            title={
              mode === 'section'
                ? `${CATEGORY_LABELS[activeCategory] || activeCategory} 配置`
                : '原始 YAML 配置'
            }
            extra={
              <Space>
                <Button type="primary" loading={saving} onClick={handleSave}>
                  保存
                </Button>
              </Space>
            }
          >
            <JsonEditor
              value={text}
              onChange={setText}
              rows={30}
            />
          </Card>
        </Col>
      </Row>
    </>
  );
}
