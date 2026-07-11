/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Server-only / native deps: keep them out of the bundle so Next doesn't
  // try to trace or bundle native binaries and model files.
  serverExternalPackages: ["pg", "fastembed", "onnxruntime-node"],
};

module.exports = nextConfig;
