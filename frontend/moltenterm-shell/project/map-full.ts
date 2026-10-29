// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The line map's Full size in the Project panel (FR-SHELL-094): the map takes the whole panel and the panel is
// magnified, as ⌘M does, so the view's layout never changes and a pinned view stays as pinned. The same button or Esc
// restores the layout; ending the magnification by hand ends Full size too.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { globalStore } from "@/app/store/jotaiStore";
import { atom, Atom, useAtomValue } from "jotai";
import { useCallback, useEffect, useRef, useState } from "react";

const NotMagnified = atom(false) as Atom<boolean>;

export function useMapFull(nodeModel: BlockNodeModel): { mapFull: boolean; toggleMapFull: () => void } {
    const [mapFull, setMapFull] = useState(false);
    const magnified = useAtomValue(nodeModel?.isMagnified ?? NotMagnified);
    // Full size magnified the panel: leaving it un-magnifies; a panel magnified before stays so.
    const ours = useRef(false);
    const seenMagnified = useRef(false);

    const exit = useCallback(() => {
        setMapFull(false);
        if (ours.current && nodeModel != null && globalStore.get(nodeModel.isMagnified)) {
            nodeModel.toggleMagnify();
        }
        ours.current = false;
        seenMagnified.current = false;
    }, [nodeModel]);

    const toggleMapFull = useCallback(() => {
        if (mapFull) {
            exit();
            return;
        }
        setMapFull(true);
        if (nodeModel != null && !globalStore.get(nodeModel.isMagnified)) {
            ours.current = true;
            nodeModel.toggleMagnify();
        }
    }, [mapFull, exit, nodeModel]);

    useEffect(() => {
        if (magnified) {
            seenMagnified.current = true;
            return;
        }
        if (mapFull && ours.current && seenMagnified.current) {
            ours.current = false;
            seenMagnified.current = false;
            setMapFull(false);
        }
    }, [magnified, mapFull]);

    useEffect(() => {
        if (!mapFull) {
            return;
        }
        const onKey = (e: KeyboardEvent) => {
            if (e.key !== "Escape" || e.defaultPrevented) {
                return;
            }
            e.preventDefault();
            exit();
        };
        window.addEventListener("keydown", onKey);
        return () => window.removeEventListener("keydown", onKey);
    }, [mapFull, exit]);

    return { mapFull, toggleMapFull };
}
