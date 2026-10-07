// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { HoldToConfirmButton } from "./hold-to-confirm";

export const RailEditHint = "Hold to edit";

export function railEditLabel(name: string): string {
    return `Edit ${name}, hold to confirm`;
}

// The pencil of a rail item (FR-SHELL-030-AC1, DS-SHELL-035): a sibling of the item's button, so it is its own tab stop
// right after it, shown while the item is hovered or holds the focus. Bottom-left, because the agent's state dot holds
// the bottom-right corner and the unread dot the top-right. Its 24 px target (NFR-SHELL-014) reaches past the item's
// corner into the rail's gutter; the visible badge is 16 px.
// #354 (DS-SHELL-058): that target catches clicks meant for the item, so the sheet opens only after a press-and-hold,
// the gesture of the tab close button. The double-click, the context menu, the palette and the app menu stay immediate.
export function RailEditButton({
    name,
    onEdit,
    onHover,
    onLeave,
}: {
    name: string;
    onEdit: (opener: HTMLElement) => void;
    onHover: (opener: HTMLElement) => void;
    onLeave: () => void;
}) {
    // The badge's edge is an inset ring rather than a border, so the progress ring is concentric with the 16 px disc.
    return (
        <HoldToConfirmButton
            label={railEditLabel(name)}
            hint={RailEditHint}
            plainLabel={`Edit ${name}`}
            dataRole="rail-edit"
            onConfirm={(_, button) => onEdit(button)}
            onMouseEnter={(e) => onHover(e.currentTarget)}
            onMouseLeave={onLeave}
            className="molten-rail-edit absolute -bottom-1 -left-1 z-[1] flex h-6 w-6 cursor-pointer items-center justify-center rounded-full opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 motion-reduce:transition-none"
            discClassName="bg-modalbg text-[8px] text-secondary ring-1 ring-border ring-inset hover:text-primary"
            glyph={<i className="molten-hold-glyph fa fa-solid fa-pencil relative" aria-hidden />}
        />
    );
}
