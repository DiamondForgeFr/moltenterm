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
    // The library's navigation (FR-SHELL-088).
    spaces: (
        <>
            <rect x="3" y="5" width="5" height="14" rx="1.5" />
            <rect x="10" y="5" width="5" height="14" rx="1.5" />
            <rect x="17" y="5" width="4" height="14" rx="1.5" />
        </>
    ),
    panels: (
        <>
            <rect x="3" y="4" width="8" height="7" rx="1.5" />
            <rect x="13" y="4" width="8" height="7" rx="1.5" />
            <rect x="3" y="13" width="8" height="7" rx="1.5" />
            <rect x="13" y="13" width="8" height="7" rx="1.5" />
        </>
    ),
    ai: (
        <>
            <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
            <path d="M18 15l.8 2.2L21 18l-2.2.8L18 21l-.8-2.2L15 18l2.2-.8z" />
        </>
    ),
    archive: (
        <>
            <rect x="3" y="4" width="18" height="5" rx="1.5" />
            <path d="M5 9v10h14V9M10 13h4" />
        </>
    ),
    gear: (
        <>
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2.5v3M12 18.5v3M4.2 6.5l2.6 1.5M17.2 16l2.6 1.5M4.2 17.5 6.8 16M17.2 8l2.6-1.5" />
        </>
    ),
    back: <path d="m14 6-6 6 6 6" />,
    down: <path d="M12 5v14M6 13l6 6 6-6" />,
    share: (
        <>
            <path d="M12 4v11M8 8l4-4 4 4" />
            <path d="M5 13v6h14v-6" />
        </>
    ),
    link: (
        <>
            <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
            <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
        </>
    ),
    doc: (
        <>
            <path d="M5 4h10l4 4v12H5z" />
            <path d="M9 12h6M9 16h6" />
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
