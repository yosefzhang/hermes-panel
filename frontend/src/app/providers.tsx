'use client';

import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { ToastProvider, Toaster } from '@/components/ui/toast';
import ErrorBoundary from '@/components/ErrorBoundary';

export default function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#4f46e5',
          borderRadius: 10,
          fontFamily:
            '"Maoken Assorted Sans", "猫啃杂黑体", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
          colorBgContainer: '#ffffff',
          colorBorder: 'hsl(220 16% 90%)',
        },
      }}
    >
      <AntApp>
        <ErrorBoundary>
          <ToastProvider>
            {children}
            <Toaster />
          </ToastProvider>
        </ErrorBoundary>
      </AntApp>
    </ConfigProvider>
  );
}