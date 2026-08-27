'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Spin } from 'antd';
import { useAuthStore } from '@/store/authStore';

export default function AuthGuard({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const { token, user, loading, initialized, restore } = useAuthStore();

  useEffect(() => {
    restore();
  }, [restore]);

  useEffect(() => {
    if (initialized && !loading && !token) {
      router.replace('/login');
    }
  }, [initialized, loading, token, router]);

  if (loading && token && !user) {
    return <div className="centered"><Spin /></div>;
  }

  if (!token) {
    return null;
  }

  return <>{children}</>;
}