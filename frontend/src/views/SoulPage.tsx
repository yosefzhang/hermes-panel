import { useCallback, useState } from 'react';
import { Edit2, Save, FileText } from 'lucide-react';
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

export default function SoulPage() {
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [content, setContent] = useState('');

  const fetchFiles = useCallback(async () => {
    const { data } = await apiClient.get<{ files: Array<{ name: string; content: string; exists?: boolean }> }>(
      '/profile-files',
      { params: { profile: activeProfile } },
    );
    const soulFile = data.files.find((f) => f.name === 'SOUL.md');
    const text = soulFile?.content || '';
    setContent(text);
    return data;
  }, [activeProfile]);

  const { loading, error, execute: reload } = useApi(fetchFiles, [activeProfile]);

  const handleSave = async () => {
    setSaving(true);
    try {
      await apiClient.put('/profile-files', { name: 'SOUL.md', content }, { params: { profile: activeProfile } });
      toast({
        title: '保存成功',
        description: 'SOUL.md 已更新',
      });
      setEditing(false);
      reload();
    } catch {
      toast({
        variant: 'destructive',
        title: '保存失败',
        description: '请稍后重试',
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <PageContainer>
      <PageHeader />

      {error && <ErrorAlert message={error} />}

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-muted-foreground" />
            <CardTitle>SOUL.md</CardTitle>
          </div>
          {!editing ? (
            <Button onClick={() => setEditing(true)}>
              <Edit2 className="mr-2 h-4 w-4" />
              编辑
            </Button>
          ) : (
            <div className="flex items-center gap-2">
              <Button variant="outline" onClick={() => setEditing(false)}>
                取消
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                <Save className="mr-2 h-4 w-4" />
                {saving ? '保存中...' : '保存'}
              </Button>
            </div>
          )}
        </CardHeader>
        <CardContent>
          {loading ? (
            <Loading className="py-12" />
          ) : editing ? (
            <Textarea
              value={content}
              onChange={(e) => setContent(e.target.value)}
              rows={24}
              className="font-mono text-sm"
              placeholder="在此输入 SOUL.md 内容..."
            />
          ) : (
            <div className="whitespace-pre-wrap font-mono text-sm min-h-[300px] p-4 rounded-md bg-muted/50">
              {content || <span className="text-muted-foreground">暂无内容</span>}
            </div>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
