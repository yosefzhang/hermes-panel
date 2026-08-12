import { createContext, useContext, useEffect, useMemo, useState } from 'react';
import { Outlet, useLocation, useNavigate } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart3,
  Brain,
  ChevronDown,
  ChevronRight,
  Command,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Puzzle,
  Server,
  Settings,
  Wrench,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { HostProfileGroup, useConfigStore } from '../store/configStore';
import { profileCategories } from '../config/profileCategories';

interface HeaderContextValue {
  setExtra: (node: React.ReactNode) => void;
}

const HeaderContext = createContext<HeaderContextValue | null>(null);

export function useHeaderExtra() {
  const ctx = useContext(HeaderContext);
  if (!ctx) {
    throw new Error('useHeaderExtra must be used within AppLayout');
  }
  return ctx.setExtra;
}

const SIDEBAR_WIDTH = 256;

const menuItems = [
  { key: '/dashboard', label: '仪表盘', icon: LayoutDashboard },
  { key: '/profiles', label: 'Profiles', icon: BarChart3 },
  { key: '/settings', label: '设置', icon: Settings },
];

const categoryIcons: Record<string, React.ElementType> = {
  env: Settings,
  models: Brain,
  channels: MessageCircle,
  skills: Wrench,
  plugins: Puzzle,
};

function routeLabel(pathname: string): string {
  if (pathname === '/dashboard') return '仪表盘';
  if (pathname === '/profiles') return 'Profiles';
  if (pathname === '/settings') return '设置';
  const m = pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (m) {
    const cat = profileCategories.find((c) => c.key === m[2]);
    return cat ? `${m[1]} / ${cat.label}` : m[1];
  }
  return 'Hermes Panel';
}

export default function AppLayout() {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuthStore();
  const { profiles, hostProfiles, loadProfiles, loadHostProfiles } = useConfigStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedHosts, setExpandedHosts] = useState<Set<string>>(new Set());
  const [expandedProfiles, setExpandedProfiles] = useState<Set<string>>(new Set());
  const [headerExtra, setHeaderExtra] = useState<React.ReactNode>(null);

  useEffect(() => {
    loadProfiles().catch(() => undefined);
    loadHostProfiles().catch(() => undefined);
  }, [loadProfiles, loadHostProfiles]);

  const isGlobalActive = (path: string) => location.pathname === path;
  const pathMatch = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
  const currentProfile = pathMatch?.[1] ?? null;
  const currentCategory = pathMatch?.[2] ?? null;

  const sidebarHosts = useMemo<HostProfileGroup[]>(() => {
    if (hostProfiles.length > 0) return hostProfiles;
    return [
      {
        id: '__local_fallback__',
        name: '本机',
        isLocal: true,
        online: true,
        profiles,
      },
    ];
  }, [hostProfiles, profiles]);

  const activeHost = useMemo(() => {
    if (!currentProfile) return null;
    const local = sidebarHosts.find((h) => h.isLocal && h.profiles.includes(currentProfile));
    if (local) return local;
    return sidebarHosts.find((h) => h.profiles.includes(currentProfile)) ?? null;
  }, [sidebarHosts, currentProfile]);

  // Auto-expand the active host/profile, and the local host by default
  useEffect(() => {
    if (activeHost) {
      setExpandedHosts((prev) => new Set(prev).add(activeHost.id));
    }
    if (currentProfile) {
      setExpandedProfiles((prev) => new Set(prev).add(currentProfile));
    }
    const localHost = hostProfiles.find((h) => h.isLocal);
    if (localHost) {
      setExpandedHosts((prev) => new Set(prev).add(localHost.id));
    }
  }, [activeHost, currentProfile, hostProfiles]);

  const toggleHost = (hostId: string) => {
    setExpandedHosts((prev) => {
      const next = new Set(prev);
      if (next.has(hostId)) next.delete(hostId);
      else next.add(hostId);
      return next;
    });
  };

  const toggleProfile = (profile: string) => {
    setExpandedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });
  };

  const handleNavClick = (path: string) => {
    navigate(path);
    setMobileOpen(false);
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 h-16 shrink-0">
        <div className="h-9 w-9 rounded-xl gradient-primary flex items-center justify-center text-white shadow-soft">
          <Command className="h-5 w-5" />
        </div>
        <span className="font-bold text-lg tracking-tight text-foreground">Hermes Panel</span>
      </div>

      <div className="px-5 py-3">
        <nav className="space-y-1">
          {menuItems.map(({ key, label, icon: Icon }) => {
            const active = isGlobalActive(key);
            return (
              <button
                key={key}
                onClick={() => handleNavClick(key)}
                className={[
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200',
                    active
                      ? 'bg-violet-100 text-violet-700 shadow-sm'
                      : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
                  ].join(' ')}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {label}
              </button>
            );
          })}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <div className="space-y-1">
          {sidebarHosts.map((host) => {
            const isExpandedHost = expandedHosts.has(host.id);
            const isActiveHost = activeHost?.id === host.id;
            return (
              <div key={host.id}>
                <button
                  onClick={() => toggleHost(host.id)}
                  className={[
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200',
                    isActiveHost && !currentProfile
                      ? 'bg-violet-100 text-violet-700 shadow-sm'
                      : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
                  ].join(' ')}
                >
                  <span
                    className={[
                      'h-2.5 w-2.5 rounded-full shrink-0',
                      host.online ? 'bg-green-500' : 'bg-red-500',
                    ].join(' ')}
                  />
                  <span className="flex-1 text-left truncate">{host.name}</span>
                  {host.isLocal && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-primary/10 text-primary">
                      本地
                    </span>
                  )}
                  {isExpandedHost ? (
                    <ChevronDown className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-4 w-4 text-muted-foreground" />
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {isExpandedHost && (
                    <motion.div
                      initial={{ height: 0, opacity: 0 }}
                      animate={{ height: 'auto', opacity: 1 }}
                      exit={{ height: 0, opacity: 0 }}
                      transition={{ duration: 0.2 }}
                      className="overflow-hidden"
                    >
                      <div className="ml-2 mt-1 space-y-1 border-l border-border pl-2">
                        {host.profiles.map((profile) => {
                          const isActiveProfile = currentProfile === profile && isActiveHost;
                          const isExpandedProfile = expandedProfiles.has(profile);
                          return (
                            <div key={profile}>
                              <button
                                onClick={() => host.isLocal && toggleProfile(profile)}
                                className={[
                                  'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-all duration-200',
                                  isActiveProfile && !currentCategory
                                    ? 'bg-violet-100 text-violet-700 font-medium shadow-sm'
                                    : host.isLocal
                                      ? 'text-muted-foreground hover:bg-card/50 hover:text-foreground'
                                      : 'text-muted-foreground/60 cursor-default',
                                ].join(' ')}
                              >
                                <span className="flex-1 text-left truncate">{profile}</span>
                                {host.isLocal && (
                                  isExpandedProfile ? (
                                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                                  ) : (
                                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                                  )
                                )}
                              </button>
                              <AnimatePresence initial={false}>
                                {host.isLocal && isExpandedProfile && (
                                  <motion.div
                                    initial={{ height: 0, opacity: 0 }}
                                    animate={{ height: 'auto', opacity: 1 }}
                                    exit={{ height: 0, opacity: 0 }}
                                    transition={{ duration: 0.2 }}
                                    className="overflow-hidden"
                                  >
                                    <div className="ml-2 mt-1 space-y-1 border-l border-border pl-2">
                                      {profileCategories.map((category) => {
                                        const active = isActiveProfile && currentCategory === category.key;
                                        const CatIcon = categoryIcons[category.key] ?? Settings;
                                        return (
                                          <button
                                            key={category.key}
                                            onClick={() => handleNavClick(`/${profile}/${category.key}`)}
                                            className={[
                                              'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-all duration-200',
                                              active
                                                ? 'bg-violet-100 text-violet-700 font-medium shadow-sm'
                                                : 'text-muted-foreground hover:bg-card/50 hover:text-foreground',
                                            ].join(' ')}
                                          >
                                            <CatIcon className="h-3.5 w-3.5 shrink-0" />
                                            {category.label}
                                          </button>
                                        );
                                      })}
                                    </div>
                                  </motion.div>
                                )}
                              </AnimatePresence>
                            </div>
                          );
                        })}
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </div>
            );
          })}
        </div>
      </div>

      <div className="p-4 border-t border-border/60">
        <div className="glass rounded-xl px-3 py-2.5 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-blue-400 flex items-center justify-center text-primary-foreground text-xs font-bold">
            {user?.username?.[0]?.toUpperCase() ?? 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">{user?.username ?? 'User'}</div>
            <div className="text-xs text-muted-foreground truncate">{user?.role ?? ''}</div>
          </div>
          <button
            onClick={() => {
              logout();
              navigate('/login');
            }}
            className="p-1.5 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            title="退出登录"
            aria-label="退出登录"
          >
            <LogOut className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <HeaderContext.Provider value={{ setExtra: setHeaderExtra }}>
      <div className="mesh-bg min-h-screen flex">
        {/* Desktop sidebar */}
        <aside
          className="hidden lg:flex fixed left-0 top-0 h-screen glass-strong border-r border-border/60 z-40 flex-col"
          style={{ width: SIDEBAR_WIDTH }}
        >
          {sidebarContent}
        </aside>

        {/* Mobile overlay */}
        <AnimatePresence>
          {mobileOpen && (
            <>
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/20 backdrop-blur-sm z-40 lg:hidden"
                onClick={() => setMobileOpen(false)}
              />
              <motion.aside
                initial={{ x: -SIDEBAR_WIDTH }}
                animate={{ x: 0 }}
                exit={{ x: -SIDEBAR_WIDTH }}
                transition={{ type: 'spring', damping: 25, stiffness: 220 }}
                className="fixed left-0 top-0 h-screen glass-strong border-r border-border/60 z-50 lg:hidden"
                style={{ width: SIDEBAR_WIDTH }}
              >
                {sidebarContent}
              </motion.aside>
            </>
          )}
        </AnimatePresence>

        <div className="flex-1 flex flex-col min-w-0 lg:ml-[256px]">
          {/* Topbar */}
          <header className="sticky top-0 z-30 glass border-b border-border/60 h-16 px-4 sm:px-6 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <button
                onClick={() => setMobileOpen(true)}
                className="lg:hidden p-2 rounded-lg text-muted-foreground hover:bg-card/60 transition-colors"
              >
                <Menu className="h-5 w-5" />
              </button>
              <h1 className="text-lg sm:text-xl font-semibold text-foreground tracking-tight">
                {routeLabel(location.pathname)}
              </h1>
            </div>
            <div className="flex items-center gap-2">{headerExtra}</div>
          </header>

          {/* Page content with transitions */}
          <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-auto min-h-[calc(100vh-64px)]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={location.pathname}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                <Outlet />
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </HeaderContext.Provider>
  );
}
