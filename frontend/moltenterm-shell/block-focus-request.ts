// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A block's request to take the focus (#1750). Two layout effects of BlockFull settle it: the first turns a change of
// the layout's focus into a request, the second carries the request out, giving the block's view the keyboard and,
// for a click, the layout's focus too.

import { useCallback, useLayoutEffect, useRef, useState } from "react";

// "click": the user clicked the block. "focused": the layout focused the block, which still has to take the keyboard.
export type BlockFocusRequest = "click" | "focused";

export type FocusRequestStep = {
    // The request is consumed: the block gives its view the keyboard.
    apply: boolean;
    // The block also asks the layout for the focus.
    takeLayoutFocus: boolean;
};

export function requestOnFocusChange(isFocused: boolean): BlockFocusRequest {
    return isFocused ? "focused" : null;
}

export function stepFocusRequest(request: BlockFocusRequest, isFocused: boolean): FocusRequestStep {
    if (request == null) {
        return null;
    }
    // The layout focused the block, then focused another one before this request ran (a click elsewhere, a page
    // taking the focus, a restore, all in one commit). Taking the focus back would make that other block take it back
    // in turn, forever: the update loop that blanked the view (React error #185). Only a click asks the layout.
    if (request === "focused" && !isFocused) {
        return null;
    }
    return { apply: true, takeLayoutFocus: !isFocused };
}

// Returns the click handler's request. `apply` runs when a request is carried out; `takeLayoutFocus` says whether it
// must also focus the block's layout node.
export function useBlockFocusRequest(
    isFocused: boolean,
    apply: (takeLayoutFocus: boolean) => void
): () => void {
    const [request, setRequest] = useState<BlockFocusRequest>(null);
    const applyRef = useRef(apply);
    applyRef.current = apply;

    useLayoutEffect(() => {
        setRequest(requestOnFocusChange(isFocused));
    }, [isFocused]);

    useLayoutEffect(() => {
        if (request == null) {
            return;
        }
        setRequest(null);
        const step = stepFocusRequest(request, isFocused);
        if (step == null || !step.apply) {
            return;
        }
        applyRef.current(step.takeLayoutFocus);
    }, [request, isFocused]);

    return useCallback(() => setRequest("click"), []);
}
