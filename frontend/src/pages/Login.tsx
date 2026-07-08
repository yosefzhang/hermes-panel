import { Button, Form, Input, Typography, App as AntApp } from 'antd';
import { useNavigate } from 'react-router-dom';
import { useAuthStore } from '../store/authStore';

export default function Login() {
  const navigate = useNavigate();
  const { message } = AntApp.useApp();
  const { login, loading } = useAuthStore();

  return (
    <div className="login-page">
      <div className="login-panel">
        <div className="login-title">
          <Typography.Title>Hermes Panel</Typography.Title>
          <Typography.Text type="secondary">配置、Profile 与运行状态控制台</Typography.Text>
        </div>
        <Form
          layout="vertical"
          onFinish={async (values) => {
            try {
              await login(values.username, values.password);
              navigate('/dashboard');
            } catch {
              message.error('用户名或密码不正确');
            }
          }}
        >
          <Form.Item name="username" label="用户名" rules={[{ required: true }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="密码" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>
            登录
          </Button>
        </Form>
      </div>
    </div>
  );
}