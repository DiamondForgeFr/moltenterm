// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// "Store on the carpet" (FR-SHELL-123, DS-SHELL-136): the button in the header of every panel outside the fixed zone,
// in the place of the pin button and always there, so the header keeps its shape. It opens the chooser "Visible
// panels on the right" 1 · 2 · 3: a click (or the keys 1, 2, 3) applies at once, a number that cannot apply stays
// greyed with its reason, and in 360 view the same chooser holds the pins and Leave. A pinned panel shows its filled
// pin instead, which unpins it in one click, with its badge.

import { globalStore } from "@/app/store/jotaiStore";
import { IconButton } from "@/element/iconbutton";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { cn } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { lazy, memo, Suspense, useId } from "react";
import { t, useLocale } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import { PinText } from "./pin-text";
import { CarpetIcon } from "./view360-icon";
import type { PanelPlacement, View360Model } from "./view360-model";
import { isPinned } from "./view360-pin";
import "./view360.css";

// The chooser loads the first time a button opens it, not with the window (NFR-PERF-003).
const PlacesChooser = lazy(() => import("./view360-places-chooser").then((m) => ({ default: m.PlacesChooser })));

export const ChooserWidthPx = 372;
const NoRoles = atom({} as Record<string, PanelPlacement>);
const NoPlaces = atom(null as number);
const NoActive = atom(false);

// Which panel's chooser is open, and the button it hangs from: one at a time per window.
export type PlacesChooserState = {
    blockId: string;
    // The button that opened it: a panel can be drawn twice (its header and a copy), the chooser opens once.
    owner: string;
    anchor: { left: number; right: number; bottom: number };
    // The button itself: the chooser hangs from it and its own press is not an outside press.
    button?: Element;
};
export const placesChooserAtom = atom(null) as PrimitiveAtom<PlacesChooserState>;

function currentView360(): View360Model {
    return getLayoutModelForStaticTab()?.moltenView360 ?? null;
}

export function closePlacesChooser() {
    globalStore.set(placesChooserAtom, null);
}

// Where the panel's header button stands: on the carpet (or a column that would lie there), pinned, or nothing in the
// fixed zone and in a view holding one column. In 360 view what is drawn decides, otherwise the tree's columns.
export function headerPlacement(
    active: boolean,
    placements: Record<string, PanelPlacement>,
    roles: Record<string, PanelPlacement>,
    blockId: string
): PanelPlacement {
    if (active) {
        return placements?.[blockId] ?? null;
    }
    const role = roles?.[blockId];
    if (role == null || role === "first") {
        return role ?? null;
    }
    return "carpet";
}

export const CarpetHeaderButton = memo(({ blockId }: { blockId: string }) => {
    useLocale();
    const view360 = currentView360();
    const active = useAtomValue(view360?.activeAtom ?? NoActive);
    const placements = useAtomValue(view360?.placementsAtom ?? NoRoles);
    const roles = useAtomValue(view360?.rolesAtom ?? NoRoles);
    useAtomValue(view360?.placesAtom ?? NoPlaces);
    const chooser = useAtomValue(placesChooserAtom);
    const owner = useId();
    const placement = headerPlacement(active, placements, roles, blockId);
    if (view360 == null || placement == null || placement === "first") {
        return null;
    }
    if (isPinned(placement)) {
        const shortcut = formatShortcutById("pin-panel");
        const unpin: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "thumbtack",
            title: `${PinText.unpinButton}${shortcut ? ` (${shortcut})` : ""}`,
            click: (e) => {
                e?.stopPropagation();
                view360.unpin(blockId);
            },
        };
        return (
            <>
                <span className="mt-pinned-badge" data-testid="mt-pinned-badge">
                    {PinText.pinnedBadge}
                </span>
                <IconButton decl={unpin} className="mt-pin-button is-pinned" />
            </>
        );
    }
    const open = chooser?.blockId === blockId && chooser.owner === owner;
    const decl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: <CarpetIcon />,
        title: t("view360.places.buttonHint"),
        pressed: open,
        click: (e) => {
            e?.stopPropagation();
            if (open) {
                closePlacesChooser();
                return;
            }
            const button = (e?.currentTarget ?? e?.target) as Element;
            const element = button?.closest?.("button");
            const rect = element?.getBoundingClientRect();
            const anchor =
                rect == null
                    ? { left: window.innerWidth / 2, right: window.innerWidth / 2 + ChooserWidthPx / 2, bottom: 80 }
                    : { left: rect.left, right: rect.right, bottom: rect.bottom };
            globalStore.set(placesChooserAtom, { blockId, owner, anchor, button: element ?? undefined });
        },
    };
    // Pressing the button must not focus the panel: in a panel without focus the header then reflows and the button
    // moves from under the pointer before the click lands (#1544). The chooser takes the focus when it opens.
    return (
        <>
            <span className="contents" onMouseDown={(e) => e.preventDefault()}>
                <IconButton decl={decl} className={cn("mt-carpet-button", open && "is-open")} />
            </span>
            {open && (
                <Suspense fallback={null}>
                    <PlacesChooser view360={view360} state={chooser} />
                </Suspense>
            )}
        </>
    );
});
CarpetHeaderButton.displayName = "CarpetHeaderButton";
