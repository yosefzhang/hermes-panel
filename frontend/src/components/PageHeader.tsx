import { Space, Typography } from 'antd';
import { getProfileColor } from '../config/profileColors';

interface Props {
  title: string;
  description?: string;
  profileName?: string;
  profile?: string;
  extra?: React.ReactNode;
}

export default function PageHeader({ title, description, profileName, profile, extra }: Props) {
  return (
    <div className="page-header">
      <div>
        <Space size={8} align="baseline">
          <Typography.Title level={2}>{title}</Typography.Title>
          {profileName && <Typography.Text type="secondary" style={{ whiteSpace: 'nowrap' }}>{profileName}</Typography.Text>}
        </Space>
        {description && (
          <Typography.Text type="secondary" style={{ display: 'block', marginTop: 6 }}>
            {description}
          </Typography.Text>
        )}
      </div>
      <Space size={12}>
        {extra}
        {profile && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              height: 32,
              fontSize: 14,
              fontWeight: 600,
              padding: '0 14px',
              borderRadius: 6,
              background: getProfileColor(profile),
              color: '#fff',
              whiteSpace: 'nowrap',
            }}
          >
            {profile}
          </span>
        )}
      </Space>
    </div>
  );
}