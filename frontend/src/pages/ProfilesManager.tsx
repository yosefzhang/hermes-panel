import { useEffect, useState } from 'react';
import { Card, Descriptions, Empty, List, Spin } from 'antd';
import PageHeader from '../components/PageHeader';
import { apiClient } from '../api/client';
import { useConfigStore } from '../store/configStore';
import type { ProfileDetail } from '../types';

export default function ProfilesManager() {
  const { profiles } = useConfigStore();
  const [details, setDetails] = useState<Record<string, ProfileDetail>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    const fetchAll = async () => {
      setLoading(true);
      const results = await Promise.allSettled(
        profiles.map(async (profile) => {
          const { data } = await apiClient.get<ProfileDetail>(`/profiles/${profile}`);
          return [profile, data] as const;
        }),
      );
      if (cancelled) return;
      const map: Record<string, ProfileDetail> = {};
      for (const result of results) {
        if (result.status === 'fulfilled') {
          const [profile, data] = result.value;
          map[profile] = data;
        }
      }
      setDetails(map);
      setLoading(false);
    };
    fetchAll();
    return () => {
      cancelled = true;
    };
  }, [profiles]);

  return (
    <>
      <PageHeader title="Profiles" description="从 ~/.hermes/profiles 发现可用配置。" />
      <Spin spinning={loading}>
        {profiles.length === 0 ? (
          <Card>
            <Empty description="未发现任何 Profile" />
          </Card>
        ) : (
          <List
            grid={{ gutter: 16, xs: 1, sm: 1, md: 2, lg: 2, xl: 3 }}
            dataSource={profiles}
            renderItem={(profile) => (
              <List.Item>
                <Card title={profile} size="small">
                  {details[profile] ? (
                    <Descriptions
                      column={1}
                      size="small"
                      items={Object.entries(details[profile]).map(([key, value]) => ({
                        key,
                        label: key,
                        children: String(value),
                      }))}
                    />
                  ) : (
                    <Spin size="small" />
                  )}
                </Card>
              </List.Item>
            )}
          />
        )}
      </Spin>
    </>
  );
}
