// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// UI transport locations and presentation/startup flags only. Credentials and arbitrary environment
// access are never part of the renderer contract. Home/config/data paths have separate guarded APIs.
export const RendererEnvironmentNames = [
    "WAVE_SERVER_WEB_ENDPOINT",
    "WAVE_SERVER_WS_ENDPOINT",
    "WAVETERM_DEV",
    "WAVETERM_DEV_VITE",
    "MOLTENTERM_CHANNEL",
    "MOLTENTERM_SAFE_MODE",
    // A test instance's local release feed (#1806, #1860): the renderer only learns that the build looks for releases;
    // Electron main alone decides whether the override is honoured (moltenterm-release-feed.ts).
    "MOLTENTERM_RELEASE_FEED_URL",
    // The workspace switch's kill switch (#2375, #2407): 0 restores the switch before the picture, "picture" the one
    // before the remembered layout. Main reads it for the picture, the renderer for the layout.
    "MOLTENTERM_SWITCHPICTURE",
] as const;
const rendererEnvironmentNames = new Set<string>(RendererEnvironmentNames);

export function readRendererEnvironment(name: unknown, environment: NodeJS.ProcessEnv = process.env): string | null {
    if (typeof name !== "string" || !rendererEnvironmentNames.has(name)) return null;
    return environment[name] ?? null;
}
