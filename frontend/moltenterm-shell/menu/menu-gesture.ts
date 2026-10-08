// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

export function useMenuGesture(onOutside: () => void) {
    const [draining, setDraining] = useState(false);
    const active = useRef(false);
    const timer = useRef<ReturnType<typeof setTimeout>>(null);
    const outside = useRef(onOutside);
    outside.current = onOutside;
    const reset = useCallback(() => {
        if (timer.current) clearTimeout(timer.current);
        active.current = false;
        setDraining(false);
    }, []);
    const release = () => {
        if (timer.current) clearTimeout(timer.current);
        // Chromium finishes mouseup/click/auxclick in the same input task. A contextmenu may precede pointerup
        // on macOS, including Control+left-click, so no button or contextmenu event may release the layer early.
        timer.current = setTimeout(reset, 0);
    };
    useEffect(
        () => () => {
            if (timer.current) clearTimeout(timer.current);
        },
        []
    );
    const swallow = (event: React.SyntheticEvent) => {
        event.preventDefault();
        event.stopPropagation();
    };
    const complete = (event: React.SyntheticEvent) => {
        if (active.current) {
            swallow(event);
            release();
        }
    };
    return {
        draining,
        active,
        reset,
        handlers: {
            onPointerDownCapture(event: React.PointerEvent<HTMLDivElement>) {
                if ((event.target as HTMLElement).closest(".molten-menu")) return;
                swallow(event);
                active.current = true;
                setDraining(true);
                try {
                    event.currentTarget.setPointerCapture(event.pointerId);
                } catch {
                    /* A lost pointer can already be cancelled. */
                }
                outside.current();
            },
            onPointerUpCapture: complete,
            onMouseUpCapture(event: React.MouseEvent) {
                if (active.current) swallow(event);
            },
            onClickCapture: complete,
            onAuxClickCapture: complete,
            onPointerCancelCapture: complete,
            onContextMenuCapture(event: React.MouseEvent) {
                swallow(event);
            },
        },
    };
}
