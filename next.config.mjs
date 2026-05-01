/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  experimental: {
    serverComponentsExternalPackages: [
      '@anthropic-ai/sdk',
      '@azure/search-documents',
      'jwks-rsa',
      'jsonwebtoken',
      'applicationinsights',
      '@azure/monitor-opentelemetry'
    ]
  }
};

export default nextConfig;
