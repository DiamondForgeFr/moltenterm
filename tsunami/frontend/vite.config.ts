// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react-swc";
import { fileURLToPath } from "node:url"; // MOLTENTERM-PATCH (#2126)
import { defineConfig } from "vite";
import { moltentermBundledPackages } from "../../frontend/moltenterm-shell/build/bundled-packages"; // MOLTENTERM-PATCH (#2126)

export default defineConfig({
    // MOLTENTERM-PATCH (#2126): the npm packages this bundle ships, for the licence notices (the repository root is two folders up)
    plugins: [
        react(),
        tailwindcss(),
        moltentermBundledPackages("tsunami", { root: fileURLToPath(new URL("../..", import.meta.url)) }),
    ],
    resolve: {
        alias: {
            "@": "/src",
        },
    },
    server: {
        port: 12025,
        open: true,
        proxy: {
            "/api": {
                target: "http://localhost:12026",
                changeOrigin: true,
            },
            "/assets": {
                target: "http://localhost:12026",
                changeOrigin: true,
            },
        },
    },
    build: {
        outDir: "dist",
        minify: process.env.NODE_ENV === "development" ? false : "esbuild",
        sourcemap: process.env.NODE_ENV === "development" ? true : false,
    },
});
