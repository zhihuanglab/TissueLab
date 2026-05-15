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
    PUBLIC_CTRL_SERVICE_API_ENDPOINT: process.env.PUBLIC_CTRL_SERVICE_API_ENDPOINT,
    DEBUG_ENV: process.env.DEBUG_ENV,
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
