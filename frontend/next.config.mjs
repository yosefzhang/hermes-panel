/** @type {import('next').NextConfig} */
const nextConfig = {
  // 独立输出模式：`next build` 额外生成 .next/standalone，
  // 便于 Docker 等场景下只复制最小运行时即可启动。
  output: 'standalone',
  eslint: {
    // 项目未引入 ESLint，构建时跳过，避免阻塞
    ignoreDuringBuilds: true,
  },
  async rewrites() {
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:8650/api/:path*',
      },
    ];
  },
};

export default nextConfig;