import React from 'react';
import ReactDOM from 'react-dom/client';
import { ConfigProvider, App as AntApp } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App';
import './index.css';
import './styles.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        token: {
          colorPrimary: '#4f46e5',
          borderRadius: 10,
          fontFamily: '"Maoken Assorted Sans", "猫啃杂黑体", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", sans-serif',
          colorBgContainer: '#ffffff',
          colorBorder: 'hsl(220 16% 90%)',
        },
      }}
    >
      <AntApp>
        <App />
      </AntApp>
    </ConfigProvider>
  </React.StrictMode>,
);