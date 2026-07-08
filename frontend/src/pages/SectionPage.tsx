import { useCallback, useState } from 'react';
import { Alert, Button, Card, App as AntApp } from 'antd';
import PageHeader from '../components/PageHeader';
import JsonEditor from '../components/JsonEditor';
import { apiClient } from '../api/client';
import { useApi } from '../hooks/useApi';
import { useConfigStore } from '../store/configStore';

interface Props {
  title: string;
  description: string;
  endpoint: string;
  readonlyList?: boolean;
  showProfileName?: boolean;
}

export default function SectionPage({ title, description, endpoint, readonlyList = false, showProfileName = false }: Props) {
  const { message } = AntApp.useApp();
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
      message.success('已保存');
    } catch (e) {
      if (e instanceof SyntaxError) {
        message.error('JSON 格式不正确');
      } else {
        message.error('保存失败');
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        title={showProfileName ? `Profile: ${activeProfile} ${title}` : title}
        profileName={showProfileName ? description : undefined}
        description={showProfileName ? undefined : description}
      />
      {error && <Alert message={error} type="error" showIcon closable style={{ marginBottom: 16 }} />}
      <Card loading={loading}>
        <JsonEditor value={text} onChange={setText} rows={22} />
        {!readonlyList && (
          <Button className="form-actions" type="primary" loading={saving} onClick={handleSave}>
            保存
          </Button>
        )}
      </Card>
    </>
  );
}
