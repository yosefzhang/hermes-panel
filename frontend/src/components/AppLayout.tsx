import { useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { ConfigProvider, Layout, Menu } from 'antd';
import type { MenuProps } from 'antd';
import { useAuthStore } from '../store/authStore';
import { useConfigStore } from '../store/configStore';
import { profileCategories } from '../config/profileCategories';
import { getProfileColor } from '../config/profileColors';

const { Sider, Content } = Layout;

const baseItems = [
  { key: '/dashboard', label: '仪表盘' },
  { key: '/users', label: '用户' },
];

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user } = useAuthStore();
  const { activeProfile, profiles, setProfile, loadProfiles } = useConfigStore();
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);

  const menuItems = baseItems;
  const selectedKeys = [location.pathname];

  // 路径形如 /default/env → 计算 profile 菜单里对应的选中 key 与当前 profile
  const pathMatch = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
  const currentPathProfile = pathMatch ? pathMatch[1] : null;
  const profileSelectedKeys = pathMatch ? [`category:${pathMatch[1]}:${pathMatch[2]}`] : [];
  const selectedColor = currentPathProfile ? getProfileColor(currentPathProfile) : undefined;

  const profileMenuItems: MenuProps['items'] = useMemo(() => profiles.map((profile) => ({
    key: `profile:${profile}`,
    label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: getProfileColor(profile),
            flexShrink: 0,
          }}
        />
        {profile}
      </span>
    ),
    children: profileCategories.map((category) => ({
      key: `category:${profile}:${category.key}`,
      label: category.label,
    })),
  })), [profiles]);

  const navigationItems: MenuProps['items'] = useMemo(() => menuItems.map(({ key, label }) => ({ key, label })), [menuItems]);

  return (
    <Layout className="shell">
      <Sider width={224} className="sidebar">
        <div className="brand">
          <span>Hermes Panel</span>
        </div>
        <div className="sidebar-section-title">全局</div>
        <Menu
          mode="inline"
          theme="dark"
          selectedKeys={selectedKeys}
          items={navigationItems}
          onClick={({ key }) => navigate(key)}
        />
        <div className="sidebar-section-title">Profiles</div>
        <ConfigProvider
          theme={{
            components: {
              Menu: {
                darkItemSelectedBg: selectedColor,
                darkItemSelectedColor: '#fff',
              },
            },
          }}
        >
          <Menu
            mode="inline"
            theme="dark"
            selectedKeys={profileSelectedKeys}
            openKeys={openKeys}
            onOpenChange={setOpenKeys}
            items={profileMenuItems}
            onClick={({ key }) => {
              const [, profile, category] = String(key).split(':');
              if (profile) {
                setProfile(profile);
                if (category === 'models' || category === 'channels' || category === 'skills' || category === 'plugins') {
                  navigate(`/${profile}/${category}`);
                  return;
                }
                if (category === 'env') {
                  navigate(`/${profile}/env`);
                  return;
                }
                if (category === 'memory') {
                  navigate(`/${profile}/memory`);
                  return;
                }
                navigate(`/${profile}/env`);
              }
            }}
          />
        </ConfigProvider>
      </Sider>
      <Layout>
        <Content className="content">
          <Outlet />
        </Content>
      </Layout>
    </Layout>
  );
}
