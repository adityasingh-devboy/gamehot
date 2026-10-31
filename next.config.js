/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: false, // Prevents duplicate socket connections in dev mode
  images: {
    unoptimized: true,
  },
}

module.exports = nextConfig

