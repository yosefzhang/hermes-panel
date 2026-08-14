import { useCallback, useState } from 'react';
import { Edit2, FileText, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';
import PageHeader from '../components/PageHeader';
import PageContainer from '../components/PageContainer';
import Loading from '../components/Loading';
import ErrorAlert from '../components/ErrorAlert';

interface MemoryData {
  config: Record<string, any>;
  memories: Record<string, string>;
}

export default function MemoryConfig() {
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();
  const [activeTab, setActiveTab] = useState('memory');
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [memoryData, setMemoryData] = useState<MemoryData | null>(null);

  const fetchAll = useCallback(async () => {
    const { data: memData } = await apiClient.get<MemoryData>('/memory', { params: { profile: activeProfile } });
    setMemoryData(memData);
    return memData;
  }, [activeProfile]);

  const { loading, error, execute: reload } = useApi(fetchAll, [activeProfile]);

  const handleSave = async (fileName: 'MEMORY.md' | 'USER.md') => {
    const content = memoryData?.memories?.[fileName.replace('.md', '')] || '';
    setSaving(true);
    try {
      await apiClient.put('/profile-files', { name: fileName, content }, { params: { profile: activeProfile } });
      toast({ title: '保存成功', description: `${fileName} 已更新` });
      setEditing(false);
      reload();
    } catch {
      toast({ variant: 'destructive', title: '保存失败', description: '请稍后重试' });
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { key: 'memory', label: 'MEMORY.md' },
    { key: 'user', label: 'USER.md' },
  ];

  return (
    <PageContainer>
      <PageHeader />

      {error && <ErrorAlert message={error} />}

      {loading ? (
        <Loading className="py-12" />
      ) : (
        <>
          <div className="flex gap-2 border-b">
            {tabs.map((tab) => {
              const isActive = activeTab === tab.key;
              return (
                <button
                  key={tab.key}
                  onClick={() => setActiveTab(tab.key)}
                  className={`px-4 py-2 text-sm font-medium transition-colors border-b-2 -mb-px ${
                    isActive
                      ? 'tab-active'
                      : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-card/60'
                  }`}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>

          {activeTab === 'memory' && (
            <Card>
              <CardHeader className="flex flex-row items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <CardTitle>MEMORY.md</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setEditing((prev) => !prev)}
                >
                  <Edit2 className="mr-2 h-4 w-4" />
                  {editing ? '取消' : '编辑'}
                </Button>
                {editing && (
                  <Button size="sm" onClick={() => handleSave('MEMORY.md')} disabled={saving}>
                    <Save className="mr-2 h-4 w-4" />
                    {saving ? '保存中...' : '保存'}
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {editing ? (
                  <Textarea
                    value={memoryData?.memories?.MEMORY || ''}
                    onChange={(e) =>
                      setMemoryData((prev) =>
                        prev ? { ...prev, memories: { ...prev.memories, MEMORY: e.target.value } } : prev,
                      )
                    }
                    rows={18}
                    className="font-mono text-sm"
                  />
                ) : (
                  <div className="whitespace-pre-wrap font-mono text-sm p-4 rounded-md bg-muted/50 min-h-[300px]">
                    {memoryData?.memories?.MEMORY || <span className="text-muted-foreground">暂无内容</span>}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {activeTab === 'user' && (
            <Card>
              <CardHeader className="flex flex-row items-center gap-2">
                <FileText className="h-5 w-5 text-muted-foreground" />
                <CardTitle>USER.md</CardTitle>
                <Button
                  variant="outline"
                  size="sm"
                  className="ml-auto"
                  onClick={() => setEditing((prev) => !prev)}
                >
                  <Edit2 className="mr-2 h-4 w-4" />
                  {editing ? '取消' : '编辑'}
                </Button>
                {editing && (
                  <Button size="sm" onClick={() => handleSave('USER.md')} disabled={saving}>
                    <Save className="mr-2 h-4 w-4" />
                    {saving ? '保存中...' : '保存'}
                  </Button>
                )}
              </CardHeader>
              <CardContent>
                {editing ? (
                  <Textarea
                    value={memoryData?.memories?.USER || ''}
                    onChange={(e) =>
                      setMemoryData((prev) =>
                        prev ? { ...prev, memories: { ...prev.memories, USER: e.target.value } } : prev,
                      )
                    }
                    rows={18}
                    className="font-mono text-sm"
                  />
                ) : (
                  <div className="whitespace-pre-wrap font-mono text-sm p-4 rounded-md bg-muted/50 min-h-[300px]">
                    {memoryData?.memories?.USER || <span className="text-muted-foreground">暂无内容</span>}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </>
      )}
    </PageContainer>
  );
}
