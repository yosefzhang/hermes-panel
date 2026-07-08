import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Spin } from 'antd';
import AppLayout from './components/AppLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { useAuthStore } from './store/authStore';
import { useConfigStore } from './store/configStore';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ProfileEnv = lazy(() => import('./pages/ProfileEnv'));
const SkillsManager = lazy(() => import('./pages/SkillsManager'));
const PluginsManager = lazy(() => import('./pages/PluginsManager'));
const ProfilesManager = lazy(() => import('./pages/ProfilesManager'));
const ModelsConfig = lazy(() => import('./pages/ModelsConfig'));
const ChannelsConfig = lazy(() => import('./pages/ChannelsConfig'));
const MemoryConfig = lazy(() => import('./pages/MemoryConfig'));
const UserManagement = lazy(() => import('./pages/UserManagement'));

function RequireAuth({ children }: { children: JSX.Element }) {
  const location = useLocation();
  const { token, user, loading, restore } = useAuthStore();

  useEffect(() => {
    restore();
  }, [restore]);

  if (loading && token && !user) {
    return <div className="centered"><Spin /></div>;
  }

  if (!token) {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return children;
}

function ProfileRouteWrapper() {
  const { profile } = useParams<{ profile: string }>();
  const { setProfile, loadProfiles } = useConfigStore();

  useEffect(() => {
    loadProfiles().then(() => {
      const { profiles } = useConfigStore.getState();
      if (profile && profiles.includes(profile)) {
        setProfile(profile);
      }
    });
  }, [profile, setProfile, loadProfiles]);

  return <Outlet />;
}

export default function App() {
  return (
    <BrowserRouter>
      <ErrorBoundary>
        <Suspense fallback={<div className="centered"><Spin /></div>}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<RequireAuth><AppLayout /></RequireAuth>}>
              <Route index element={<Navigate to="/dashboard" replace />} />
              <Route path="dashboard" element={<Dashboard />} />
              <Route path="profiles" element={<ProfilesManager />} />
              <Route path="users" element={<UserManagement />} />
              <Route path=":profile" element={<ProfileRouteWrapper />}>
                <Route path="env" element={<ProfileEnv />} />
                <Route path="skills" element={<SkillsManager />} />
                <Route path="plugins" element={<PluginsManager />} />
                <Route path="models" element={<ModelsConfig />} />
                <Route path="channels" element={<ChannelsConfig />} />
                <Route path="memory" element={<MemoryConfig />} />
                <Route index element={<Navigate to="env" replace />} />
              </Route>
            </Route>
          </Routes>
        </Suspense>
      </ErrorBoundary>
    </BrowserRouter>
  );
}
