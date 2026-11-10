// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The owners filter's funnel (FR-REV-034 AC12, #2207): an outline like the header's other icons, with a quarter fill
// while a filter is on. It takes the button's colour.
export function OwnersFilterIcon({ filled }: { filled: boolean }) {
    return (
        <svg
            className="mt-owners-icon"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill={filled ? "currentColor" : "none"}
            fillOpacity={0.25}
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            <path data-part="funnel" d="M3 5h18l-7 8v6l-4-2v-4z" />
        </svg>
    );
}
