// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The arranging mode's session (FR-SHELL-018, #2395, #2459, #2467): the layout drafted while the mode lasts, saved once
// when it is left, however it is left (Done, Escape, a click on the ground, the Arrange tool, the pane closing), and the
// sentence the screen reader hears after each change. The dashboard keeps its own blocks while the mode lasts, so the
// session lives beside them rather than in a component of its own: the draft is what the flow, the main agent's block and
// the drag all read.

import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import { makeLayoutCommit } from "./companion-arrange-model";
import type { UsageWindowChoice } from "./companion-gauges-model";
import { CompanionLayout, normalizeLayout } from "./companion-layout";

// A zero-width space: appended to a sentence, it makes the live region's text new without changing what is read.
const InvisibleMark = String.fromCharCode(0x200b);

export type ArrangeSession = {
    // The layout to draw: the draft while arranging, the saved layout otherwise.
    layout: CompanionLayout;
    // The latest draft, which a drag reads between two renders.
    draftRef: React.RefObject<CompanionLayout>;
    setDraft: (next: CompanionLayout) => void;
    // Saves the draft and leaves the mode.
    leave: () => void;
    note: string;
    announce: (text: string) => void;
    // The usage windows its provider reports, heard from the usage as the dashboard draws it.
    windows: UsageWindowChoice[];
    setWindows: (windows: UsageWindowChoice[]) => void;
};

export function useArrangeSession(
    saved: CompanionLayout,
    arranging: boolean,
    onSave: (layout: CompanionLayout) => void,
    onLeave: () => void
): ArrangeSession {
    const normalized = useMemo(() => normalizeLayout(saved), [saved]);
    const [drafted, setDrafted] = useState<CompanionLayout>(null);
    const layout = arranging ? (drafted ?? normalized) : normalized;
    const draftRef = useRef(layout);
    draftRef.current = layout;
    // The draft the mode ends with, which the render after it no longer holds.
    const kept = useRef(layout);
    if (arranging) {
        kept.current = layout;
    }
    const saveRef = useRef(onSave);
    saveRef.current = onSave;
    const leaveRef = useRef(onLeave);
    leaveRef.current = onLeave;
    const commit = useRef<(draft: CompanionLayout) => boolean>(null);
    // Before the first paint after the mode ended, so that the saved layout is what the next frame draws.
    useLayoutEffect(() => {
        if (!arranging) {
            return;
        }
        commit.current = makeLayoutCommit(kept.current, (next) => saveRef.current(next));
        return () => {
            commit.current?.(kept.current);
            commit.current = null;
            setDrafted(null);
        };
    }, [arranging]);
    const setDraft = useCallback((next: CompanionLayout) => {
        draftRef.current = next;
        kept.current = next;
        setDrafted(next);
    }, []);
    const leave = useCallback(() => {
        commit.current?.(kept.current);
        leaveRef.current();
    }, []);
    const [note, setNote] = useState("");
    const announced = useRef(false);
    const announce = useCallback((text: string) => {
        announced.current = !announced.current;
        setNote(announced.current ? `${text}${InvisibleMark}` : text);
    }, []);
    const [windows, setWindows] = useState<UsageWindowChoice[]>([]);
    return { layout, draftRef, setDraft, leave, note, announce, windows, setWindows };
}
