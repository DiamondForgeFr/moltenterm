// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The banner of connect mode (FR-MC-032-AC2, DS-SHELL-081): under the tab bar, centred over the content, it says what
// a click does and how to leave; a refused join or a failed group command shows its message in its place for a few
// seconds. #368 drew a hint beside the target, over the panel header next to the rail (#399).

import { useAtomValue } from "jotai";
import { useLayoutEffect, useState } from "react";
import { RailConnectModel, railConnectHint } from "./rail-connect";

type Place = { top: number; left: number };

// Below the rail's top edge, which is the tab bar's bottom, and centred over what lies right of the rail.
function bannerPlace(nav: HTMLElement): Place {
    const rect = nav?.getBoundingClientRect();
    if (rect == null) {
        return null;
    }
    return { top: rect.top + 8, left: rect.right + (window.innerWidth - rect.right) / 2 };
}

export function RailConnectBanner({ navRef, name }: { navRef: React.RefObject<HTMLElement>; name: string }) {
    const model = RailConnectModel.getInstance();
    const target = useAtomValue(model.targetAtom);
    const message = useAtomValue(model.messageAtom);
    const [place, setPlace] = useState<Place>(null);
    const text = message?.text ?? (target != null ? railConnectHint(name) : null);
    const shown = text != null;
    useLayoutEffect(() => {
        if (!shown) {
            setPlace(null);
            return;
        }
        const update = () => setPlace(bannerPlace(navRef.current));
        update();
        window.addEventListener("resize", update);
        return () => window.removeEventListener("resize", update);
    }, [navRef, shown]);
    if (place == null || text == null) {
        return null;
    }
    return (
        <div
            // The polite live region already says it (RailConnectModel).
            aria-hidden
            data-testid="rail-connect-hint"
            className="molten-rail-connect-banner pointer-events-none fixed z-[9500] flex max-w-[32rem] -translate-x-1/2 items-center gap-2 rounded-10 border border-line-strong bg-surface-3 py-1.5 pr-1.5 pl-3 text-12 text-primary shadow-e2"
            style={{ top: place.top, left: place.left }}
        >
            <i
                className={
                    message != null
                        ? "fa fa-solid fa-circle-info text-icon-14 text-muted"
                        : "fa fa-solid fa-link text-icon-14 text-accent"
                }
                aria-hidden
            />
            <span className="min-w-0">{text}</span>
            {target != null ? (
                <button
                    type="button"
                    className="molten-btn-ghost pointer-events-auto cursor-pointer rounded-6 px-2 py-0.5 text-12"
                    onClick={() => model.end()}
                >
                    Cancel
                </button>
            ) : null}
        </div>
    );
}
