import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { RefreshCw, Save, Search, SlidersHorizontal } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { api, apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';

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
  const { toast } = useToast();
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
      toast({
        variant: 'destructive',
        title: '加载失败',
        description: '加载配置分类失败',
      });
    }
  }, [activeCategory, toast]);

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
      toast({
        title: '保存成功',
        description: '配置已保存，重启 Hermes 后生效',
      });
    } catch (error) {
      toast({
        variant: 'destructive',
        title: '保存失败',
        description: error instanceof SyntaxError ? 'JSON 格式不正确' : '保存失败',
      });
    } finally {
      setSaving(false);
    }
  };

  const handleReload = () => {
    loadData();
    toast({
      title: '已刷新',
      description: '配置已重新加载',
    });
  };

  const filteredCategories = searchQuery
    ? sections.filter(cat => 
        cat.toLowerCase().includes(searchQuery.toLowerCase()) ||
        (CATEGORY_LABELS[cat] || '').toLowerCase().includes(searchQuery.toLowerCase())
      )
    : sections;

  return (
    <PageContainer>
      <PageHeader
        extra={
          <div className="flex items-center gap-2">
            <div className="relative">
              <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="搜索配置项..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="pl-8 w-[200px]"
              />
            </div>
            <Tabs value={mode} onValueChange={(v) => setMode(v as 'section' | 'raw')}>
            <TabsList>
              <TabsTrigger value="section">分类模式</TabsTrigger>
              <TabsTrigger value="raw">原始 YAML</TabsTrigger>
            </TabsList>
          </Tabs>
          <Button variant="outline" onClick={handleReload} disabled={loading}>
            <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
            刷新
          </Button>
        </div>
      }
    />

      <div className="grid gap-4 md:grid-cols-12">
        {mode === 'section' && (
          <Card className="md:col-span-3">
            <CardHeader>
              <CardTitle>配置分类</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-1">
                {filteredCategories.map((cat) => (
                  <button
                    key={cat}
                    onClick={() => setActiveCategory(cat)}
                    className={`w-full text-left px-3 py-2 rounded-md text-sm transition-colors ${
                      activeCategory === cat
                        ? 'bg-primary text-primary-foreground'
                        : 'hover:bg-accent hover:text-accent-foreground'
                    }`}
                  >
                    {CATEGORY_LABELS[cat] || cat}
                  </button>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <Card className={mode === 'section' ? 'md:col-span-9' : 'md:col-span-12'}>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle>
              {mode === 'section'
                ? `${CATEGORY_LABELS[activeCategory] || activeCategory} 配置`
                : '原始 YAML 配置'}
            </CardTitle>
            <Button onClick={handleSave} disabled={saving}>
              <Save className="mr-2 h-4 w-4" />
              {saving ? '保存中...' : '保存'}
            </Button>
          </CardHeader>
          <CardContent>
            {loading ? (
              <Loading className="py-12" />
            ) : (
              <textarea
                value={mode === 'raw' ? yamlText : text}
                onChange={(e) => mode === 'raw' ? setYamlText(e.target.value) : setText(e.target.value)}
                className="w-full h-[600px] font-mono text-sm p-4 border rounded-md bg-background"
                spellCheck={false}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}
