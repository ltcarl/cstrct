/** @type {import('next').NextConfig} */
const nextConfig = {
    experimental: {
      serverActions: { allowedOrigins: ["localhost:3000"] }
    },
    images: {
      remotePatterns: [
        { protocol: 'https', hostname: '**.amazonaws.com' }
      ]
    }
  }
  export default nextConfig