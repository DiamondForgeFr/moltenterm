// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The neighbour's sidebar that comes in with a swipe (FR-SHELL-082, DS-SHELL-130, #1248). Each workspace lives in its
// own tab view, so the view on screen draws a light likeness of the next one from the objects in its store: its name
// in its colour, its pinned blocks and its views. It sits parked beside the page, outside the clipped viewport, so
// the swipe only moves it (transform) and never mounts anything mid-gesture.

import { makeORef, useWaveObjectValue } from "@/app/store/wos";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { visibleTabIds } from "../hidden-tabs";
import { useT } from "../i18n/i18n";
import { ProjectTabMetaKey } from "../project/project-model";
import { workspaceShownName } from "../workspace-default-name";
import { isPinnedTab, TileGridColumns } from "./sidebar-model";
import { ViewGlyph, viewGlyphAtom } from "./view-glyph";
import { GlobalPinMetaKey, PinMetaKey } from "./view-pins-model";

const GhostPinKeys = [ProjectTabMetaKey, PinMetaKey];

function GhostTab({ tabId, tiles }: { tabId: string; tiles: boolean }) {
    const [tab] = useWaveObjectValue<Tab>(makeORef("tab", tabId));
    const glyph = useAtomValue(viewGlyphAtom(tabId));
    if (tab == null || (tab.meta as Record<string, any>)?.[GlobalPinMetaKey]) {
        return null;
    }
    if (isPinnedTab(tab, GhostPinKeys) !== tiles) {
        return null;
    }
    if (tiles) {
        return (
            <div className="mt-sb-tile flex h-[52px] min-w-0 flex-col items-center justify-center gap-[5px] rounded-6 bg-white/[0.09] px-1 text-11 text-primary">
                <ViewGlyph icons={glyph} />
                <span className="max-w-full truncate">{tab.name}</span>
            </div>
        );
    }
    return (
        <div className="flex h-7 min-w-0 items-center gap-2 rounded-6 px-2 text-12 text-secondary">
            <ViewGlyph icons={glyph} small />
            <span className="truncate">{tab.name}</span>
        </div>
    );
}

// side: where it waits (-1 left, 1 right); the controller moves it by its inline transform.
export const SidebarGhost = memo(function SidebarGhost({
    workspaceId,
    side,
    ghostRef,
    accent,
}: {
    workspaceId: string;
    side: -1 | 1;
    ghostRef: React.RefObject<HTMLDivElement>;
    // The neighbour's first colour stop, for its name as its own header draws it.
    accent: string;
}) {
    const t = useT();
    const [ws] = useWaveObjectValue<Workspace>(makeORef("workspace", workspaceId ?? ""));
    const tabIds = ws != null ? visibleTabIds(ws) : [];
    const name = workspaceShownName(ws?.name, t) || t("rail.unsavedWorkspace");
    return (
        <div
            ref={ghostRef}
            className={cn("mt-sb-ghost flex flex-col gap-2", side < 0 ? "is-prev" : "is-next")}
            style={{ "--mt-ghost-accent": accent || "var(--mt-accent)" } as React.CSSProperties}
            aria-hidden
            data-testid={side < 0 ? "sidebar-ghost-prev" : "sidebar-ghost-next"}
            data-workspace-id={workspaceId ?? ""}
        >
            {workspaceId ? (
                <>
                    <div className="flex shrink-0 items-center border-t border-white/10 px-0.5 pt-1.5">
                        <span className="mt-sb-ghost-name max-w-[80%] truncate text-11 font-semibold tracking-[0.08em] uppercase">
                            {name}
                        </span>
                    </div>
                    <div
                        className="grid shrink-0 gap-1.5 px-1 pt-[7px]"
                        style={{ gridTemplateColumns: TileGridColumns }}
                    >
                        {tabIds.map((id) => (
                            <GhostTab key={id} tabId={id} tiles />
                        ))}
                    </div>
                    <div className="flex flex-col gap-0.5 px-0.5">
                        {tabIds.map((id) => (
                            <GhostTab key={id} tabId={id} tiles={false} />
                        ))}
                    </div>
                </>
            ) : null}
        </div>
    );
});
SidebarGhost.displayName = "SidebarGhost";
