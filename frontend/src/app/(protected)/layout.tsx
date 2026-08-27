'use client';

import AuthGuard from '@/components/AuthGuard';
import AppLayout from '@/components/AppLayout';

export default function ProtectedLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGuard>
      <AppLayout>{children}</AppLayout>
    </AuthGuard>
  );
}