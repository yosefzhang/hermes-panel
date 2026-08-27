import { useCallback, useState } from 'react';
import { Save, FileText } from 'lucide-react';
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

interface Props {
  title: string;
  description: string;
  endpoint: string;
  readonlyList?: boolean;
  showProfileName?: boolean;
}

export default function SectionPage({ title, description, endpoint, readonlyList = false, showProfileName = false }: Props) {
  const { toast } = useToast();
  const { activeProfile } = useConfigStore();
  const [text, setText] = useState('{}');
  const [saving, setSaving] = useState(false);

  const fetchSection = useCallback(
    () =>
      apiClient.get(endpoint, { params: { profile: activeProfile } }).then((res) => {
        setText(JSON.stringify(res.data, null, 2));
        return res.data;
      }),
    [activeProfile, endpoint],
  );

  const { loading, error } = useApi(fetchSection, [activeProfile, endpoint]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const parsed = JSON.parse(text);
      await apiClient.put(endpoint, parsed, { params: { profile: activeProfile } });
      toast({
        title: '保存成功',
        description: '配置已更新',
      });
    } catch (e) {
      if (e instanceof SyntaxError) {
        toast({
          variant: 'destructive',
          title: 'JSON 格式错误',
          description: '请检查 JSON 格式是否正确',
        });
      } else {
        toast({
          variant: 'destructive',
          title: '保存失败',
          description: '请稍后重试',
        });
      }
    } finally {
      setSaving(false);
    }
  };

  const displayTitle = showProfileName ? `Profile: ${activeProfile} ${title}` : title;
  const displayDescription = showProfileName ? description : undefined;

  return (
    <PageContainer>
      <PageHeader />

      {error && <ErrorAlert message={error} />}

      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {loading ? (
            <Loading className="py-12" />
          ) : (
            <>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={22}
                className="font-mono text-sm"
              />
              {!readonlyList && (
                <Button onClick={handleSave} disabled={saving}>
                  <Save className="mr-2 h-4 w-4" />
                  {saving ? '保存中...' : '保存'}
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </PageContainer>
  );
}
