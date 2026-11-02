// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

export async function closeCarpetOthers(
    blockIds: string[],
    actions: {
        active: () => boolean;
        exists: (id: string) => boolean;
        confirm: (id: string) => Promise<boolean>;
        close: (id: string) => Promise<void>;
    }
): Promise<void> {
    for (const id of blockIds) {
        if (!actions.active()) return;
        if (!actions.exists(id)) continue;
        const approved = await actions.confirm(id);
        if (!actions.active()) return;
        if (!actions.exists(id)) continue;
        if (!approved) return;
        await actions.close(id);
    }
}
