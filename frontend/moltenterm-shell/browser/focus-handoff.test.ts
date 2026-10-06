// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { readFileSync } from "fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { focusHandoffActive, FocusHandoffSettleMs, withFocusHandoff } from "./focus-handoff";

const RepoRoot = new URL("../../../", import.meta.url);

describe("focus hand-off (#268)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("is active from the click handler on, before the open resolves, so the block's own click handler sees it", async () => {
        let release: () => void;
        const open = withFocusHandoff(() => new Promise<void>((resolve) => (release = resolve)));
        // The block's click handler runs right after the link's handler returned, still synchronously.
        expect(focusHandoffActive()).toBe(true);
        release();
        await open;
        expect(focusHandoffActive()).toBe(true);
        vi.advanceTimersByTime(FocusHandoffSettleMs);
        expect(focusHandoffActive()).toBe(false);
    });

    it("outlasts a failed open by the settle time, then lets go", async () => {
        await expect(withFocusHandoff(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
        expect(focusHandoffActive()).toBe(true);
        vi.advanceTimersByTime(FocusHandoffSettleMs);
        expect(focusHandoffActive()).toBe(false);
    });

    it("stays active while any of several overlapping opens is settling", async () => {
        await withFocusHandoff(async () => {});
        vi.advanceTimersByTime(FocusHandoffSettleMs / 2);
        await withFocusHandoff(async () => {});
        vi.advanceTimersByTime(FocusHandoffSettleMs / 2);
        expect(focusHandoffActive()).toBe(true);
        vi.advanceTimersByTime(FocusHandoffSettleMs / 2);
        expect(focusHandoffActive()).toBe(false);
    });
});

// A render of Wave's block needs the whole store, so the wiring is pinned at the source: a click from inside a block
// (with an existing browser panel) must reach neither the block's click focus nor its child-focus hand-back.
describe("block click from inside a block with a browser panel (#268)", () => {
    const blockSource = readFileSync(new URL("frontend/app/block/block.tsx", RepoRoot), "utf8");
    const routingSource = readFileSync(
        new URL("frontend/moltenterm-shell/browser/browser-routing.ts", RepoRoot),
        "utf8"
    );

    it("opens every interface link through the hand-off", () => {
        expect(routingSource).toMatch(
            /export function openInBrowserPanel\(url: string\): Promise<void> \{\s*return withFocusHandoff\(/
        );
    });

    it("guards the click, the click-focus effect and the child-focus handlers of the block", () => {
        expect(blockSource.match(/focusHandoffActive\(\)/g)?.length).toBe(3);
        const click = blockSource.match(/const setBlockClickedTrue = useCallback\(\(\) => \{([\s\S]*?)\}, \[\]\)/)?.[1];
        expect(click).toMatch(/if \(focusHandoffActive\(\)\) \{\s*return;[^\n]*\n\s*\}\s*setBlockClicked\(true\)/);
        const child = blockSource.match(/const handleChildFocus = useCallback\(([\s\S]*?)\[isFocused\]/)?.[1];
        expect(child).toMatch(/focusHandoffActive\(\)[\s\S]*nodeModel\.focusNode\(\)/);
    });
});
