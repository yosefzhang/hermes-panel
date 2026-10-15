import { createContext, useContext, useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { motion, AnimatePresence } from 'framer-motion';
import {
  BarChart3,
  BookOpen,
  Brain,
  ChevronDown,
  ChevronRight,
  Command,
  Database,
  LayoutDashboard,
  LogOut,
  Menu,
  MessageCircle,
  Settings,
  ShieldCheck,
  Wrench,
} from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { useConfigStore } from '../store/configStore';
import { profileCategories } from '../config/profileCategories';
import { apiClient } from '../api/client';

interface HeaderContextValue {
  setExtra: (node: React.ReactNode) => void;
  setDescription: (text: string | null) => void;
}

const HeaderContext = createContext<HeaderContextValue | null>(null);

export function useHeaderExtra() {
  const ctx = useContext(HeaderContext);
  if (!ctx) {
    throw new Error('useHeaderExtra must be used within AppLayout');
  }
  return ctx.setExtra;
}

export function useHeaderDescription() {
  const ctx = useContext(HeaderContext);
  if (!ctx) {
    throw new Error('useHeaderDescription must be used within AppLayout');
  }
  return ctx.setDescription;
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
  memory: Database,
  soul: BookOpen,
};

function routeLabel(pathname: string): string {
  if (pathname === '/dashboard') return '仪表盘';
  if (pathname === '/profiles') return 'Profiles';
  if (pathname === '/settings') return '设置';
  if (pathname === '/admin') return '控制台';
  const m = pathname.match(/^\/([^/]+)\/([^/]+)/);
  if (m) {
    const cat = profileCategories.find((c) => c.key === m[2]);
    return cat ? `${m[1]} / ${cat.label}` : m[1];
  }
  return 'Hermes Panel';
}

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname() ?? '';
  const { user, logout } = useAuthStore();
  const { profiles, loadProfiles } = useConfigStore();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [expandedProfiles, setExpandedProfiles] = useState<Set<string>>(new Set());
  const [headerExtra, setHeaderExtra] = useState<React.ReactNode>(null);
  const [headerDescription, setHeaderDescription] = useState<string | null>(null);
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    loadProfiles().catch(() => undefined);
  }, [loadProfiles]);

  useEffect(() => {
    apiClient
      .get<{ status: string; version?: string }>('/system/health')
      .then((res) => setVersion(res.data.version ?? null))
      .catch(() => undefined);
  }, []);

  const isGlobalActive = (path: string) => pathname === path;
  const pathMatch = pathname.match(/^\/([^/]+)\/([^/]+)/);
  const currentProfile = pathMatch?.[1] ?? null;
  const currentCategory = pathMatch?.[2] ?? null;

  // Auto-expand the active profile
  useEffect(() => {
    if (currentProfile) {
      setExpandedProfiles((prev) => new Set(prev).add(currentProfile));
    }
  }, [currentProfile]);

  const toggleProfile = (profile: string) => {
    setExpandedProfiles((prev) => {
      const next = new Set(prev);
      if (next.has(profile)) next.delete(profile);
      else next.add(profile);
      return next;
    });
  };

  const handleNavClick = (path: string) => {
    router.push(path);
    setMobileOpen(false);
  };

  const sidebarContent = (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-5 h-16 shrink-0">
        <div className="h-9 w-9 rounded-xl gradient-primary flex items-center justify-center text-white shadow-soft">
          <Command className="h-5 w-5" />
        </div>
        <div className="min-w-0">
          <div className="font-bold text-lg tracking-tight text-foreground leading-tight">Hermes Panel</div>
          {version && <div className="text-[10px] text-muted-foreground">v{version}</div>}
        </div>
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
                    'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-200',
                    active
                      ? 'bg-primary/10 text-primary shadow-sm'
                      : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
                  ].join(' ')}
              >
                <Icon className="h-[18px] w-[18px] shrink-0" />
                {label}
              </button>
            );
          })}
          {user?.role === 'admin' && (
            <button
              onClick={() => handleNavClick('/admin')}
              className={[
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-colors duration-200',
                isGlobalActive('/admin')
                  ? 'bg-primary/10 text-primary shadow-sm'
                  : 'text-muted-foreground hover:bg-card/60 hover:text-foreground',
              ].join(' ')}
            >
              <ShieldCheck className="h-[18px] w-[18px] shrink-0" />
              控制台
            </button>
          )}
        </nav>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-4">
        <div className="space-y-1">
          {profiles.map((profile) => {
            const isActiveProfile = currentProfile === profile;
            const isExpandedProfile = expandedProfiles.has(profile);
            return (
              <div key={profile}>
                <button
                  onClick={() => toggleProfile(profile)}
                  className={[
                    'w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors duration-200',
                    isActiveProfile && !currentCategory
                      ? 'bg-primary/10 text-primary font-medium shadow-sm'
                      : 'text-muted-foreground hover:bg-card/50 hover:text-foreground',
                  ].join(' ')}
                >
                  <span className="flex-1 text-left truncate">{profile}</span>
                  {isExpandedProfile ? (
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
                <AnimatePresence initial={false}>
                  {isExpandedProfile && (
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
                                'w-full flex items-center gap-2 px-3 py-1.5 rounded-md text-xs transition-colors duration-200',
                                active
                                  ? 'bg-primary/10 text-primary font-medium shadow-sm'
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
      </div>

      <div className="p-4 border-t border-border/60">
        <div className="glass rounded-xl px-3 py-2.5 flex items-center gap-3">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-blue-400 flex items-center justify-center text-primary-foreground text-xs font-bold">
            {user?.username?.[0]?.toUpperCase() ?? 'U'}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium text-foreground truncate">{user?.username ?? 'User'}</div>
          </div>
          <button
            onClick={() => {
              logout();
              router.push('/login');
            }}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-xs text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
            aria-label="退出登录"
          >
            <LogOut className="h-3.5 w-3.5" />
            退出登录
          </button>
        </div>
      </div>
    </div>
  );

  return (
    <HeaderContext.Provider value={{ setExtra: setHeaderExtra, setDescription: setHeaderDescription }}>
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
              <div className="flex flex-col gap-0.5 min-w-0">
                <h1 className="text-lg sm:text-xl font-semibold text-foreground tracking-tight leading-tight">
                  {routeLabel(pathname)}
                </h1>
                {headerDescription && (
                  <p className="text-xs text-muted-foreground truncate">{headerDescription}</p>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">{headerExtra}</div>
          </header>

          {/* Page content with transitions */}
          <main className="flex-1 p-4 sm:p-6 lg:p-8 overflow-auto min-h-[calc(100vh-64px)]">
            <AnimatePresence mode="wait" initial={false}>
              <motion.div
                key={pathname}
                initial={{ opacity: 0, y: 12 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -12 }}
                transition={{ duration: 0.22, ease: 'easeOut' }}
              >
                {children}
              </motion.div>
            </AnimatePresence>
          </main>
        </div>
      </div>
    </HeaderContext.Provider>
  );
}
