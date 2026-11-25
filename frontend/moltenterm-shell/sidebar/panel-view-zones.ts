// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What the sidebar draws while a panel is dragged over it (FR-SHELL-079, FR-SHELL-080, #2548): each section a drop can
// land on is lit on its own, the one under the pointer more, with a sentence that says where the view goes and a mark
// at the place it takes. The sections read this next to their own drags (sidebar-drag.ts), which stay as they are.

import { atoms, globalStore } from "@/app/store/global";
import { useAtomValue } from "jotai";
import { MotionClass } from "../molten-motion";
import { destinationOfHit, PanelHit, PanelZone } from "./panel-view-model";
import { captionText, freshViewsAtom, PanelViewDrag, panelViewDragAtom } from "./panel-view-store";
import "./panel-view.css";
import { currentProjectId, readProjects } from "./workspace-projects";

export type PanelZoneState = {
    // A panel is dragged: every drop zone is lit.
    active: boolean;
    // The pointer is on this one.
    over: boolean;
    hit: PanelHit;
    // The sentence the zone shows: where the new view goes.
    caption: string;
    // The sentence of the folder's row the pointer is on, which rings it; the zone keeps its own.
    folderCaption: string;
};

function destinationFor(hit: PanelHit, zone: PanelZone) {
    const ws = globalStore.get(atoms.workspace);
    const probe: PanelHit = hit?.zone === zone ? hit : { zone, before: null };
    return destinationOfHit(probe, currentProjectId(ws) ?? "", readProjects(ws).length > 1);
}

export function usePanelZone(zone: "top" | "tiles" | "temporary"): PanelZoneState {
    const drag = useAtomValue(panelViewDragAtom);
    const active = drag != null;
    const over = active && drag.hit?.zone === zone;
    if (!active) {
        return { active, over, hit: null, caption: "", folderCaption: "" };
    }
    const hit = drag.hit;
    const inFolder = over && hit.folderId != null;
    const dest = destinationFor(inFolder ? { ...hit, folderId: undefined } : hit, zone);
    const folderDest = inFolder ? destinationFor(hit, zone) : null;
    return {
        active,
        over,
        hit: over ? hit : null,
        caption: dest == null ? "" : captionText(dest),
        folderCaption: folderDest == null ? "" : captionText(folderDest),
    };
}

// The mark of the place a view would take beside a block of the top row or the tiles: the same bar a reorder shows.
export function panelSideClass(drag: PanelViewDrag, zone: "top" | "tiles", key: string): string {
    const hit = drag?.hit;
    if (hit == null || hit.zone !== zone || hit.key !== key) {
        return null;
    }
    const side = hit.after ? "mt-sb-dropa" : "mt-sb-dropb";
    return hit.stacked ? `${side} mt-sb-dropy` : side;
}

// A tile, a block or a row that a view made from a panel just made: it flows in.
export function useFreshClass(id: string): string {
    const fresh = useAtomValue(freshViewsAtom);
    return id && fresh.includes(id) ? MotionClass.flowIn : "";
}

export function usePanelDrag(): PanelViewDrag {
    return useAtomValue(panelViewDragAtom);
}
