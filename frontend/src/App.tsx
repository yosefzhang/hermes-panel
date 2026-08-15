import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { Spin } from 'antd';
import AppLayout from './components/AppLayout';
import ErrorBoundary from './components/ErrorBoundary';
import { ToastProvider, ToastViewport } from '@/components/ui/toast';
import { useAuthStore } from './store/authStore';
import { useConfigStore } from './store/configStore';

const Login = lazy(() => import('./pages/Login'));
const Dashboard = lazy(() => import('./pages/Dashboard'));
const ProfileStats = lazy(() => import('./pages/ProfileStats'));
const Settings = lazy(() => import('./pages/Settings'));
const SkillsManager = lazy(() => import('./pages/SkillsManager'));
const PluginsManager = lazy(() => import('./pages/PluginsManager'));
const ModelsConfig = lazy(() => import('./pages/ModelsConfig'));
const ChannelsConfig = lazy(() => import('./pages/ChannelsConfig'));
const MemoryConfig = lazy(() => import('./pages/MemoryConfig'));
const SoulPage = lazy(() => import('./pages/SoulPage'));

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
  const setProfile = useConfigStore((s) => s.setProfile);
  const loadProfiles = useConfigStore((s) => s.loadProfiles);

  useEffect(() => {
    if (!profile) return;
    // Only hit the API when the profile is unknown to the store; this avoids
    // re-fetching (and re-rendering the whole tree) on every sub-page switch
    // under /:profile/*, which caused a visible flash on each navigation.
    // Read the profiles snapshot synchronously inside the effect so changes
    // to the profiles array don't retrigger this effect.
    const { profiles } = useConfigStore.getState();
    if (!profiles.includes(profile)) {
      loadProfiles().then(() => {
        if (useConfigStore.getState().profiles.includes(profile)) {
          setProfile(profile);
        }
      });
    } else {
      setProfile(profile);
    }
  }, [profile, setProfile, loadProfiles]);

  return <Outlet />;
}

export default function App() {
  return (
    <ToastProvider>
      <BrowserRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <ErrorBoundary>
          <Suspense fallback={<div className="centered"><Spin /></div>}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<RequireAuth><AppLayout /></RequireAuth>}>
                <Route index element={<Navigate to="/dashboard" replace />} />
                <Route path="dashboard" element={<Dashboard />} />
                <Route path="profiles" element={<ProfileStats />} />
                <Route path="settings" element={<Settings />} />
                <Route path=":profile" element={<ProfileRouteWrapper />}>
                  <Route path="models" element={<ModelsConfig />} />
                  <Route path="channels" element={<ChannelsConfig />} />
                  <Route path="skills" element={<SkillsManager />} />
                  <Route path="plugins" element={<PluginsManager />} />
                  <Route path="memory" element={<MemoryConfig />} />
                  <Route path="soul" element={<SoulPage />} />
                  <Route index element={<Navigate to="models" replace />} />
                </Route>
              </Route>
            </Routes>
          </Suspense>
        </ErrorBoundary>
      </BrowserRouter>
      <ToastViewport />
    </ToastProvider>
  );
}
