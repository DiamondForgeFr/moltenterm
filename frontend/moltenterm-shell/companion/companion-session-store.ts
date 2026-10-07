// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The session each terminal's open companion shows (DS-SHELL-060): the terminal's agent label names it in its
// tooltip, so the terminal and its companion match at a glance. Only what a companion view already received.

import { globalStore } from "@/app/store/jotaiStore";
import { atom, PrimitiveAtom } from "jotai";
import type { CompanionSession } from "./companion-model";

export class CompanionSessions {
    private static instance: CompanionSessions = null;

    atoms = new Map<string, PrimitiveAtom<CompanionSession>>();

    private constructor() {}

    static getInstance(): CompanionSessions {
        if (CompanionSessions.instance == null) {
            CompanionSessions.instance = new CompanionSessions();
        }
        return CompanionSessions.instance;
    }

    static resetInstance(): void {
        CompanionSessions.instance = null;
    }

    sessionAtom(blockId: string): PrimitiveAtom<CompanionSession> {
        let a = this.atoms.get(blockId);
        if (a == null) {
            a = atom(null) as PrimitiveAtom<CompanionSession>;
            this.atoms.set(blockId, a);
        }
        return a;
    }

    set(blockId: string, session: CompanionSession) {
        if (!blockId) {
            return;
        }
        const a = this.sessionAtom(blockId);
        const current = globalStore.get(a);
        if (sameSession(current, session)) {
            return;
        }
        globalStore.set(a, session ?? null);
    }
}

function sameSession(a: CompanionSession, b: CompanionSession): boolean {
    if (a == null || b == null) {
        return a == b;
    }
    return (
        a.path === b.path &&
        a.title === b.title &&
        a.command === b.command &&
        a.started === b.started &&
        a.linkedby === b.linkedby
    );
}
