// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The pencil of a rail item (FR-SHELL-030-AC1, DS-SHELL-035): a sibling of the item's button, so it is its own tab stop
// right after it, shown while the item is hovered or holds the focus. Bottom-left, because the agent's state dot holds
// the bottom-right corner and the unread dot the top-right. Its 24 px target (NFR-SHELL-014) reaches past the item's
// corner into the rail's gutter; the visible badge is 16 px.
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
    return (
        <button
            type="button"
            aria-label={`Edit ${name}`}
            data-role="rail-edit"
            onClick={(e) => onEdit(e.currentTarget)}
            onMouseEnter={(e) => onHover(e.currentTarget)}
            onMouseLeave={onLeave}
            className="molten-rail-edit absolute -bottom-1 -left-1 z-[1] flex h-6 w-6 cursor-pointer items-center justify-center rounded-full opacity-0 transition-opacity outline-none group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-primary motion-reduce:transition-none"
        >
            <span className="flex h-4 w-4 items-center justify-center rounded-full border border-border bg-modalbg text-[8px] text-secondary hover:text-primary">
                <i className="fa fa-solid fa-pencil" aria-hidden />
            </span>
        </button>
    );
}
