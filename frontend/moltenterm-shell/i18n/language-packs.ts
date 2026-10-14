// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The language packs in force (FR-I18N-002, DS-I18N-008). The mod host hands over the packs of its active data-only
// mods after each sync; one pack per language code is registered with the dictionaries (registerLanguage), the most
// recently enabled when two packs give the same code, and the other is reported. A pack whose content did not change
// stays registered, so a reload never flashes the shipped text. Without Jotai: Electron main keeps its own registry
// of the packs the renderer forwards, for the app menu and the native dialogs.

import { batchLanguageChanges, Dictionary, registerLanguage } from "./i18n-core";

export type LanguagePackInput = {
    modId: string;
    code: string;
    name: string;
    dict: Dictionary;
    // When the mod was enabled (ms since epoch; 0 when unknown): the most recent wins a shared code.
    enabledAt?: number;
    warnings?: string[];
};

export type ShadowedPack = { modId: string; code: string; by: string };

type Registration = { modId: string; name: string; signature: string; dispose: () => void };

function signature(pack: LanguagePackInput): string {
    return `${pack.name}\u0000${JSON.stringify(pack.dict)}`;
}

// The pack that gives a code: the most recently enabled, then the last mod id, so every view picks the same one.
function winner(packs: LanguagePackInput[]): LanguagePackInput {
    return [...packs].sort((a, b) => {
        const at = (b.enabledAt ?? 0) - (a.enabledAt ?? 0);
        if (at !== 0) return at;
        return a.modId < b.modId ? 1 : a.modId > b.modId ? -1 : 0;
    })[0];
}

export class LanguagePackRegistry {
    registrations = new Map<string, Registration>();
    packs: LanguagePackInput[] = [];
    shadowed: ShadowedPack[] = [];
    // Set once the packs were handed over at least once: a language named in app:language is then known or not.
    loaded = false;
    listeners = new Set<() => void>();

    apply(packs: LanguagePackInput[]): void {
        const byCode = new Map<string, LanguagePackInput[]>();
        for (const pack of packs ?? []) {
            byCode.set(pack.code, [...(byCode.get(pack.code) ?? []), pack]);
        }
        const shadowed: ShadowedPack[] = [];
        const chosen = new Map<string, LanguagePackInput>();
        for (const [code, list] of byCode) {
            const pick = winner(list);
            chosen.set(code, pick);
            for (const other of list) {
                if (other !== pick) shadowed.push({ modId: other.modId, code, by: pick.modId });
            }
        }
        batchLanguageChanges(() => {
            for (const [code, reg] of [...this.registrations]) {
                const next = chosen.get(code);
                if (next != null && next.modId === reg.modId && signature(next) === reg.signature) continue;
                reg.dispose();
                this.registrations.delete(code);
            }
            for (const [code, pack] of chosen) {
                if (this.registrations.has(code)) continue;
                const dispose = registerLanguage({ code, name: pack.name }, pack.dict);
                this.registrations.set(code, {
                    modId: pack.modId,
                    name: pack.name,
                    signature: signature(pack),
                    dispose,
                });
            }
        });
        this.packs = [...(packs ?? [])];
        this.shadowed = shadowed;
        this.loaded = true;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (e) {
                console.error("language pack listener", e);
            }
        }
    }

    // The mod whose pack gives a code, or null for a code no pack gives.
    sourceOf(code: string): string {
        return this.registrations.get(code)?.modId ?? null;
    }

    // The packs in force, for Electron main and `molten i18n status`.
    activePacks(): LanguagePackInput[] {
        return this.packs.filter((p) => this.registrations.get(p.code)?.modId === p.modId);
    }

    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
}

let registry: LanguagePackRegistry = null;

export function languagePacks(): LanguagePackRegistry {
    registry ??= new LanguagePackRegistry();
    return registry;
}

export function resetLanguagePacks(): void {
    registry?.apply([]);
    registry = null;
}
