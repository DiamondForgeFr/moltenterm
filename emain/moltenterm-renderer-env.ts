// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// UI transport locations and presentation/startup flags only. Credentials and arbitrary environment
// access are never part of the renderer contract. Home/config/data paths have separate guarded APIs.
export const RendererEnvironmentNames = [
    "WAVE_SERVER_WEB_ENDPOINT",
    "WAVE_SERVER_WS_ENDPOINT",
    "WAVETERM_DEV",
    "WAVETERM_DEV_VITE",
    "MOLTENTERM_CHANNEL",
    "MOLTENTERM_SAFE_MODE",
] as const;
const rendererEnvironmentNames = new Set<string>(RendererEnvironmentNames);

export function readRendererEnvironment(name: unknown, environment: NodeJS.ProcessEnv = process.env): string | null {
    if (typeof name !== "string" || !rendererEnvironmentNames.has(name)) return null;
    return environment[name] ?? null;
}
