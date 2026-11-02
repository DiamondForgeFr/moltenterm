// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One action at a time on a card (#952, FR-MC-016): from the click until the backend answered, the clicked button shows
// the domino loader and a short label, and no action of the card can be clicked. The gate is a plain object, not only a
// React state: a double click lands before React renders the disabled button, and the second click must send nothing.

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";

// How long a started step waits for the card's next read before its button comes back anyway: a card out of sight
// stops reading.
export const HoldBoundMs = 30000;

export class PendingGate {
    // The pending action's key, "" when none.
    held = "";
    // The action answered and the gate waits for the next revision.
    awaiting = false;
    bound: ReturnType<typeof setTimeout> = null;
    onChange: (pending: string) => void;
    boundMs: number;

    constructor(onChange: (pending: string) => void, boundMs = HoldBoundMs) {
        this.onChange = onChange;
        this.boundMs = boundMs;
    }

    // Runs fn unless an action is pending, and resolves false when it refused. fn's error is thrown again once the gate
    // is open. fn resolving to true while tracked keeps the gate shut until revised(): the step started, and the card
    // waits to read it running rather than offering the same click again.
    async run(key: string, fn: () => Promise<boolean | void>, tracked: boolean): Promise<boolean> {
        if (this.held !== "") {
            return false;
        }
        this.held = key;
        this.onChange(key);
        let hold = false;
        try {
            hold = (await fn()) === true && tracked;
        } catch (e) {
            this.release();
            throw e;
        }
        if (!hold) {
            this.release();
            return true;
        }
        this.awaiting = true;
        this.bound = setTimeout(() => this.release(), this.boundMs);
        return true;
    }

    revised() {
        if (this.awaiting) {
            this.release();
        }
    }

    release() {
        this.dispose();
        this.held = "";
        this.awaiting = false;
        this.onChange("");
    }

    dispose() {
        clearTimeout(this.bound);
        this.bound = null;
    }
}

export type PendingLock = {
    // The pending action's key, "" when none.
    pending: string;
    run: (key: string, fn: () => Promise<boolean | void>) => Promise<boolean>;
};

// revision: changes on each read of what the card shows. Without one, an action ends with the backend's answer.
export function usePendingLock(revision?: unknown): PendingLock {
    const [pending, setPending] = useState("");
    const gate = useRef<PendingGate>(null);
    if (gate.current == null) {
        gate.current = new PendingGate(setPending);
    }
    const tracked = revision !== undefined;
    useEffect(() => gate.current.revised(), [revision]);
    useEffect(() => () => gate.current.dispose(), []);
    const run = useCallback(
        (key: string, fn: () => Promise<boolean | void>) => gate.current.run(key, fn, tracked),
        [tracked]
    );
    return { pending, run };
}

// How a click ended (#1091), so that none ends with nothing said: refused (another action of the card holds it, nothing
// was sent), asked (the backend answered, but something must be answered first, such as the commands' trust) or done.
export type ActionOutcome = "refused" | "asked" | "done";

// fn resolving to false means it did not start: the gate reports it as answered, the outcome says asked.
export async function runAction(
    lock: PendingLock,
    key: string,
    fn: () => Promise<boolean | void>
): Promise<ActionOutcome> {
    let answer: boolean | void;
    const ran = await lock.run(key, async () => {
        answer = await fn();
        return answer;
    });
    if (!ran) {
        return "refused";
    }
    return answer === false ? "asked" : "done";
}

export const PendingLockContext = createContext<PendingLock>(null);

// The card's lock when the component sits in one, its own otherwise.
export function useCardLock(): PendingLock {
    const own = usePendingLock();
    return useContext(PendingLockContext) ?? own;
}
