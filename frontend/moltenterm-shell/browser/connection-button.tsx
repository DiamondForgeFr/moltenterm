// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The connection button beside a page's host (#1980, FR-BRW-023): a small grey lock for a secure page, a warning
// triangle with its word for a page that is not secure, only partly so, or a suspected lookalike (#2482). It is a
// sibling of the address button, never inside it: a click on the address opens the top field, a click here opens the
// site information. In a narrow row the word goes and the glyph stays (browser.css), and the name keeps the word. The
// popover loads the first time it opens, so it stays out of the JS every panel loads up front (NFR-PERF-003).

import { cn } from "@/util/util";
import { lazy, Suspense, useState } from "react";
import { useT } from "../i18n/i18n";
import type { ConnectionState } from "./connection-security";
import { connectionGlyph, ConnectionView, connectionWordKey, ViewSecure } from "./connection-store";
import type { LookalikeHold } from "./lookalike";

const ConnectionPopover = lazy(() => import("./connection-popover").then((m) => ({ default: m.ConnectionPopover })));

export function ConnectionButton({
    view,
    address,
    state,
    hold,
    onClearData,
}: {
    view: ConnectionView;
    // What the tab shows: the popover names its host.
    address: string;
    state: ConnectionState | null;
    hold: LookalikeHold | null;
    // Opens the confirmation that clears the page's cookies and data, or absent when the page has none to clear.
    onClearData?: () => void;
}) {
    const t = useT();
    const [anchor, setAnchor] = useState<HTMLElement>(null);
    if (view == null) {
        return null;
    }
    const label = t(`browser.connection.label.${view.kind}`);
    const word = view.kind === ViewSecure ? null : t(connectionWordKey(view.kind));
    return (
        <>
            <button
                type="button"
                aria-label={label}
                title={label}
                aria-haspopup="dialog"
                aria-expanded={anchor != null}
                data-testid="browser-connection"
                data-kind={view.kind}
                onClick={(e) => setAnchor(anchor == null ? e.currentTarget : null)}
                className={cn(
                    "molten-conn flex h-6 shrink-0 cursor-pointer items-center justify-center gap-1 rounded-4 text-11 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-(--mt-focus-ring)",
                    view.kind === ViewSecure ? "w-6 text-muted hover:bg-hover hover:text-primary" : "px-1.5 font-medium"
                )}
            >
                <i className={cn("fa fa-solid shrink-0 text-11", connectionGlyph(view.kind))} aria-hidden />
                {word != null ? (
                    <span className="molten-conn-word whitespace-nowrap" data-testid="browser-connection-word">
                        {word}
                    </span>
                ) : null}
            </button>
            {anchor != null ? (
                <Suspense fallback={null}>
                    <ConnectionPopover
                        anchor={anchor}
                        view={view}
                        address={address}
                        state={state}
                        hold={hold}
                        onClearData={onClearData}
                        onClose={() => setAnchor(null)}
                    />
                </Suspense>
            ) : null}
        </>
    );
}
