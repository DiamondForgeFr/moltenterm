// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The add-panel slot at an end of the carpet (#1836, FR-SHELL-065 AC15, DS-SHELL-152): where no peek is drawn, a slim
// bar with a "+" in the gutter, which adds a panel at that end through the same path as the tab strip's "+"
// (carpet-add.ts). It sits in the gutter like a peek: it takes no room from the places and never covers a panel.

import type { LayoutModel } from "@/layout/lib/layoutModel";
import { fireAndForget } from "@/util/util";
import { CSSProperties, memo } from "react";
import { useT } from "../i18n/i18n";
import { addCarpetPanel } from "./carpet-add";
import { CarpetLayout } from "./carpet-model";
import { carpetEndOfSide, endSlotRect, PeekSide } from "./carpet-peeks";
import "./view360-endslot.css";

type EndSlotProps = { layoutModel: LayoutModel; layout: CarpetLayout; side: PeekSide; halfGap: number };

// The slot on the carpet's start side (left) adds before its first column, the one on the end side (right) after its last.
export function addAtSlot(layoutModel: LayoutModel, side: PeekSide): Promise<string> {
    return addCarpetPanel(layoutModel, carpetEndOfSide(side));
}

export const CarpetEndSlot = memo(({ layoutModel, layout, side, halfGap }: EndSlotProps) => {
    const t = useT();
    const rect = endSlotRect(layout, side, halfGap);
    const style: CSSProperties = {
        transform: `translate3d(${rect.left}px, ${rect.top}px, 0)`,
        width: rect.width,
        height: rect.height,
    };
    const label = t("view360.endSlot.add");
    return (
        <button
            type="button"
            className="mt-endslot cursor-pointer"
            style={style}
            data-side={side}
            data-testid="mt-carpet-end-slot"
            aria-label={label}
            title={label}
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => fireAndForget(() => addAtSlot(layoutModel, side))}
        >
            <span className="mt-endslot-light" aria-hidden="true" />
            <span className="mt-endslot-plus" aria-hidden="true" />
        </button>
    );
});
CarpetEndSlot.displayName = "CarpetEndSlot";
