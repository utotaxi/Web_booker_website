/** @type {import('next').NextConfig} */
const nextConfig = {
  // Produce a minimal self-contained server bundle for container deployment.
  // The Dockerfile copies .next/standalone + .next/static + public.
  output: "standalone",
};

export default nextConfig;
