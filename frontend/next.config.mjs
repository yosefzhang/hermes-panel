/** @type {import('next').NextConfig} */
const nextConfig = {
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