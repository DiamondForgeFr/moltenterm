// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The hello shows itself once (FR-BOSS-009, AC74, #2217): a greeting the developer must click to receive is not a
// greeting. When the folded avatar can be seen, outside quiet hours, with the group closed and no visit scene up, Brokk
// nods and his line stands beside the avatar for a few seconds. Nothing unfolds and no badge appears. The day is greeted
// when the line is on screen (afterShown), and the hello is gone once the bubble went (afterSeen).

import { globalStore } from "@/app/store/jotaiStore";
import { useAtomValue } from "jotai";
import { useEffect, useRef, useState } from "react";
import { useT } from "../i18n/i18n";
import { prefersReducedMotion } from "../molten-motion";
import { BossBubbleModel } from "./boss-store";
import { helloCue, Moment, momentLine } from "./brokk-colleague";
import { BrokkColleagueModel } from "./brokk-colleague-store";
import { BrokkExpressionsModel } from "./brokk-expressions";
import { BrokkHubModel } from "./brokk-hub-store";
import { inQuietHours, nextQuietChange } from "./brokk-mood";

// Long enough to read one short line.
export const HelloBubbleMs = 6000;

const MaxTimerMs = 2 ** 31 - 1;

export type HelloBubble = { id: string; text: string };

export type HelloShowDeps = {
    // Marks the hello on screen and returns it as it now is (its words may have changed with the part of the day), or
    // null when it is gone.
    shown: (id: string) => Moment;
    seen: (id: string) => void;
    nod: () => void;
    // Reduced motion keeps the bubble and drops the nod.
    motion: () => boolean;
    text: (moment: Moment) => string;
    onBubble: (bubble: HelloBubble) => void;
    setTimer: (run: () => void, ms: number) => unknown;
    clearTimer: (timer: unknown) => void;
};

// One avatar's showing of the hello, apart from React so that its rules are tested without a page.
export class HelloShow {
    deps: HelloShowDeps;
    bubble: HelloBubble = null;
    timer: unknown = null;

    constructor(deps: HelloShowDeps) {
        this.deps = deps;
    }

    // `cue`: the hello the avatar may show now (helloCue). `interrupted`: the group opened, a scene came or the avatar
    // went out of sight, which ends a bubble that is up: its line was on screen, so the hello is done.
    update(cue: Moment, interrupted: boolean): void {
        if (this.bubble != null) {
            if (interrupted) {
                this.end();
            }
            return;
        }
        if (cue == null || interrupted) {
            return;
        }
        const shown = this.deps.shown(cue.id);
        if (shown == null) {
            return;
        }
        this.bubble = { id: shown.id, text: this.deps.text(shown) };
        this.deps.onBubble(this.bubble);
        if (this.deps.motion()) {
            this.deps.nod();
        }
        this.timer = this.deps.setTimer(() => this.end(), HelloBubbleMs);
    }

    end(): void {
        if (this.timer != null) {
            this.deps.clearTimer(this.timer);
            this.timer = null;
        }
        if (this.bubble == null) {
            return;
        }
        const id = this.bubble.id;
        this.bubble = null;
        this.deps.onBubble(null);
        this.deps.seen(id);
    }
}

// Whether quiet hours hold now, read again when they begin or end.
function useQuietNow(): boolean {
    const settings = useAtomValue(BrokkHubModel.getInstance().settingsAtom, { store: globalStore });
    const [, redraw] = useState(0);
    const now = Date.now();
    const quiet = inQuietHours(settings.quiet, now);
    const change = nextQuietChange(settings.quiet, now);
    useEffect(() => {
        if (change == null) {
            return;
        }
        const wait = Math.min(Math.max(change - Date.now(), 0) + 1000, MaxTimerMs);
        const timer = setTimeout(() => redraw((n) => n + 1), wait);
        return () => clearTimeout(timer);
    }, [change]);
    return quiet;
}

// `visible`: this avatar can be seen (not the collapsed strip, in a view on screen). `sceneUp`: a visit stands in his
// place. Returns the bubble to draw beside the avatar, or null.
export function useBrokkHello(visible: boolean, sceneUp: boolean): HelloBubble {
    const t = useT();
    const colleague = BrokkColleagueModel.getInstance();
    const moments = useAtomValue(colleague.momentsAtom, { store: globalStore });
    const groupOpen = useAtomValue(BossBubbleModel.getInstance().cardOpenAtom, { store: globalStore });
    const quiet = useQuietNow();
    const [bubble, setBubble] = useState<HelloBubble>(null);
    const tRef = useRef(t);
    tRef.current = t;
    const show = useRef<HelloShow>(null);
    if (show.current == null) {
        show.current = new HelloShow({
            shown: (id) => {
                colleague.noteShown(id);
                return globalStore.get(colleague.momentsAtom).find((moment) => moment.id === id) ?? null;
            },
            seen: (id) => colleague.noteSeen(id),
            nod: () => BrokkExpressionsModel.getInstance().ask("nod"),
            motion: () => !prefersReducedMotion(),
            text: (moment) => {
                const line = momentLine(moment);
                return line.text ?? tRef.current(line.key);
            },
            onBubble: setBubble,
            setTimer: (run, ms) => setTimeout(run, ms),
            clearTimer: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
        });
    }
    const cue = helloCue(moments, { visible, quiet, groupOpen, sceneUp });
    const interrupted = groupOpen || sceneUp || !visible;

    useEffect(() => {
        show.current.update(cue, interrupted);
    }, [cue, interrupted]);

    // A face that leaves the page with its bubble up has shown it.
    useEffect(() => () => show.current.end(), []);

    return bubble;
}
