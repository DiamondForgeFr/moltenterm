// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Morphterm ships no AI modes of its own: the Wave AI panel only runs modes
// that the user defines in waveai.json (their own provider or a local model).

export function isUserAIMode(modeName: string): boolean {
    return !modeName.startsWith("waveai@");
}

// The first user-defined mode by display:order, then by name, or null.
export function firstUserAIMode(configs: Record<string, AIModeConfigType> | null | undefined): string | null {
    if (configs == null) {
        return null;
    }
    const modes = Object.keys(configs).filter(isUserAIMode);
    modes.sort((a, b) => {
        const orderDiff = (configs[a]["display:order"] ?? 0) - (configs[b]["display:order"] ?? 0);
        return orderDiff !== 0 ? orderDiff : a.localeCompare(b);
    });
    return modes[0] ?? null;
}
