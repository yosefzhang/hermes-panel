import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'framer-motion';
import { Command, Loader2 } from 'lucide-react';
import { useAuthStore } from '../store/authStore';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';

export default function Login() {
  const navigate = useNavigate();
  const { login, loading } = useAuthStore();
  const { toast } = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await login(username, password);
      navigate('/dashboard');
    } catch {
      toast({
        variant: 'destructive',
        title: '登录失败',
        description: '用户名或密码不正确',
      });
    }
  };

  return (
    <div className="min-h-screen mesh-bg flex items-center justify-center p-4 relative overflow-hidden">
      {/* Decorative blurred orbs */}
      <div className="absolute -top-20 -left-20 h-96 w-96 rounded-full bg-blue-400/20 blur-3xl pointer-events-none" />
      <div className="absolute top-1/3 -right-24 h-80 w-80 rounded-full bg-blue-400/20 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-24 left-1/3 h-96 w-96 rounded-full bg-blue-400/16 blur-3xl pointer-events-none" />

      <motion.div
        initial={{ opacity: 0, y: 24, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: 'easeOut' }}
        className="w-full max-w-md relative z-10"
      >
        <div className="glass-strong rounded-3xl shadow-float p-8 sm:p-10">
          <div className="flex flex-col items-center mb-8">
            <div className="h-14 w-14 rounded-2xl gradient-primary flex items-center justify-center text-white shadow-soft mb-5">
              <Command className="h-7 w-7" />
            </div>
            <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-foreground">
              Hermes Panel
            </h1>
            <p className="mt-2 text-sm text-muted-foreground text-center">
              配置、Profile 与运行状态控制台
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-5">
            <div className="space-y-2">
              <label htmlFor="username" className="text-sm font-medium text-foreground/80">
                用户名
              </label>
              <Input
                id="username"
                type="text"
                autoComplete="username"
                placeholder="admin"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                required
                className="h-11 bg-card/70 border-border/70 focus-visible:ring-primary"
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="password" className="text-sm font-medium text-foreground/80">
                密码
              </label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                placeholder="••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="h-11 bg-card/70 border-border/70 focus-visible:ring-primary"
              />
            </div>
            <Button
              type="submit"
              className="w-full h-11 gradient-primary hover:opacity-95 text-white font-semibold shadow-soft transition-all"
              disabled={loading}
            >
              {loading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  登录中…
                </>
              ) : (
                '登录'
              )}
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
