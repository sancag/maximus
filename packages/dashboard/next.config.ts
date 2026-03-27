import type { NextConfig } from "next";

const nextConfig: NextConfig = {
	output: "export",
	transpilePackages: ["@maximus/shared"],
};

export default nextConfig;
