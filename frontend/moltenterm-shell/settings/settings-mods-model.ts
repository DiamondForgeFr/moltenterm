// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The revoke action of Settings > Mods (FR-MORPH-004, #1880). One click withdraws the user's trust in a mod, and the
// row says what happened, inline. Nothing asks first: the click is the user's own word, and trusting the mod again is
// one `molten mod enable` away.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import { MoltenHost, MoltenModStatus } from "../../molten/molten-host";

export type ModRevokeNote = { kind: "done" } | { kind: "failed"; message: string };

export type ModRevokeRow = {
    busy: boolean;
    note?: ModRevokeNote;
};

const IdleRow: ModRevokeRow = { busy: false };

export class ModsRevokeModel {
    private static instance: ModsRevokeModel = null;

    rowsAtom = atom<Record<string, ModRevokeRow>>({}) as PrimitiveAtom<Record<string, ModRevokeRow>>;

    private constructor() {}

    static getInstance(): ModsRevokeModel {
        if (!ModsRevokeModel.instance) {
            ModsRevokeModel.instance = new ModsRevokeModel();
        }
        return ModsRevokeModel.instance;
    }

    static resetInstance(): void {
        ModsRevokeModel.instance = null;
    }

    row(id: string): ModRevokeRow {
        return globalStore.get(this.rowsAtom)[id] ?? IdleRow;
    }

    setRow(id: string, row: ModRevokeRow): void {
        globalStore.set(this.rowsAtom, { ...globalStore.get(this.rowsAtom), [id]: row });
    }

    async revoke(id: string): Promise<void> {
        if (this.row(id).busy) {
            return;
        }
        this.setRow(id, { busy: true });
        try {
            await MoltenHost.getInstance().revokeTrust(id);
        } catch (e) {
            this.setRow(id, {
                busy: false,
                note: { kind: "failed", message: e instanceof Error ? e.message : String(e) },
            });
            return;
        }
        this.setRow(id, { busy: false, note: { kind: "done" } });
    }

    dismiss(id: string): void {
        this.setRow(id, { busy: this.row(id).busy });
    }

    // The confirmation of a revoke is out of date once the user trusts the mod again: it must not come back if the
    // trust is withdrawn another way, such as `molten mod untrust`.
    forgetOutdated(mods: MoltenModStatus[]): void {
        const rows = globalStore.get(this.rowsAtom);
        let next = rows;
        for (const mod of mods) {
            const row = rows[mod.id];
            if (mod.trusted === true && row?.note?.kind === "done") {
                next = { ...next, [mod.id]: { busy: row.busy } };
            }
        }
        if (next !== rows) {
            globalStore.set(this.rowsAtom, next);
        }
    }
}
