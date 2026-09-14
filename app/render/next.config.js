 /** @type {import('next').NextConfig} */
const nextConfig = {
  devIndicators: false,
  reactStrictMode: false,
  output: 'standalone',
  outputFileTracingRoot: __dirname,
  trailingSlash: false,
  images: {
    unoptimized: true,
  },
  env: {
    PUBLIC_AI_SERVICE_SOCKET_ENDPOINT: process.env.PUBLIC_AI_SERVICE_SOCKET_ENDPOINT,
    PUBLIC_AI_SERVICE_API_ENDPOINT: process.env.PUBLIC_AI_SERVICE_API_ENDPOINT,
    // Hosted TissueLab community (Ctrl Service). Listed here because it does
    // not carry the NEXT_PUBLIC_ prefix and would otherwise be inlined as
    // `undefined` at build time.
    PUBLIC_COMMUNITY_API_ENDPOINT: process.env.PUBLIC_COMMUNITY_API_ENDPOINT,
    NEXT_PUBLIC_APP_VERSION: require('./package.json').version,
  },
  transpilePackages: [
    "antd",
    "@ant-design/icons",
    "@ant-design/cssinjs",
    "@rc-component/util",
    "@rc-component/mutate-observer",
    "@rc-component/tour",
    "@rc-component/trigger",
    "@annotorious/react"
  ],
};

module.exports = nextConfig;
