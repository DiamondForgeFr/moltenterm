// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The workspace sidebar's line glyphs, from the #1181 prototype (24 px grid, 1.8 px stroke).

const Paths = {
    sidebar: (
        <>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M9 4v16" />
        </>
    ),
    branch: (
        <>
            <circle cx="6" cy="6" r="2.5" />
            <circle cx="6" cy="18" r="2.5" />
            <circle cx="18" cy="12" r="2.5" />
            <path d="M6 8.5v7M8.5 6h4a3 3 0 0 1 3 3v.5" />
        </>
    ),
    chev: <path d="m6 9 6 6 6-6" />,
    plus: <path d="M12 5v14M5 12h14" />,
    more: (
        <>
            <circle cx="5" cy="12" r="1.3" />
            <circle cx="12" cy="12" r="1.3" />
            <circle cx="19" cy="12" r="1.3" />
        </>
    ),
    lib: <path d="M4 5h4v15H4zM10 5h4v15h-4zM16 6l3.5-1 3 14-3.5 1z" />,
    x: <path d="M6 6l12 12M18 6 6 18" />,
    pin: <path d="M9 4h6l-1 5 3 3v2H7v-2l3-3zM12 14v6" />,
    undo: (
        <>
            <path d="M9 14 4 9l5-5" />
            <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
        </>
    ),
    search: (
        <>
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
        </>
    ),
    globe: (
        <>
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18" />
        </>
    ),
};

export type SidebarGlyphName = keyof typeof Paths;

export function SidebarGlyph({ name, size = 16 }: { name: SidebarGlyphName; size?: number }) {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
        >
            {Paths[name]}
        </svg>
    );
}
