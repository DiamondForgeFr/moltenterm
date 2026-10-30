// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

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
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { useRestoreFocus } from "../busy-close";
import { t, tCount, useLocale, useT, useTCount } from "../i18n/i18n";
import { formatShortcutById } from "../shortcuts/format";
import { ReadableCarpetColumnPx } from "./carpet-model";
import { PlaceOption } from "./carpet-places";
import { PinText } from "./pin-text";
import { makeRadarFactsAtom } from "./radar-store";
import { CarpetIcon } from "./view360-icon";
import type { PanelPlacement, View360Model } from "./view360-model";
import { isPinned } from "./view360-pin";
import "./view360.css";

const ChooserWidthPx = 372;
const EdgeGapPx = 8;
const NoRoles = atom({} as Record<string, PanelPlacement>);
const NoPlaces = atom(null as number);
const NoActive = atom(false);

// Which panel's chooser is open, and the button it hangs from: one at a time per window.
export type PlacesChooserState = {
    blockId: string;
    // The button that opened it: a panel can be drawn twice (its header and a copy), the chooser opens once.
    owner: string;
    anchor: { left: number; right: number; bottom: number };
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

function shareKey(n: number): string {
    return `view360.places.share${n}`;
}

// The tile's caption: its share and what it stores, or why it cannot apply.
export function optionCaption(option: PlaceOption): string {
    if (option.reason === "nothing") {
        return t("view360.places.nothing");
    }
    if (option.reason === "narrow") {
        return t("view360.places.narrow");
    }
    return t("view360.places.shareStored", {
        share: t(shareKey(option.n)),
        stored: tCount("view360.places.stored", option.stored),
    });
}

// The line under the numbers: why the first greyed number cannot apply.
export function optionsWhy(options: PlaceOption[]): string {
    const greyed = options.find((o) => !o.offered);
    if (greyed == null) {
        return null;
    }
    if (greyed.reason === "narrow") {
        return tCount("view360.places.whyNarrow", greyed.n, { min: ReadableCarpetColumnPx });
    }
    return tCount("view360.places.whyNothing", greyed.n);
}

function PlacesDiagram({ option, active }: { option: PlaceOption; active: boolean }) {
    return (
        <span className="mt-places-dia" aria-hidden="true">
            <i className="mt-places-dia-fixed" />
            {Array.from({ length: option.n }, (_, i) => (
                <i key={i} className={cn("mt-places-dia-place", i === 0 && active && "is-me")} />
            ))}
            {option.stored > 0 && <i className="mt-places-dia-stored" />}
        </span>
    );
}

type ChooserProps = { view360: View360Model; state: PlacesChooserState };

function PlacesChooser({ view360, state }: ChooserProps) {
    const t = useT();
    const tc = useTCount();
    const boxRef = useRef<HTMLDivElement>(null);
    const firstRef = useRef<HTMLButtonElement>(null);
    const [pos, setPos] = useState<{ left: number; top: number }>(null);
    const [hover, setHover] = useState<number>(null);
    const active = useAtomValue(view360.activeAtom);
    const placements = useAtomValue(view360.placementsAtom);
    const shown = useAtomValue(view360.shownPlacesAtom);
    const roles = useAtomValue(view360.rolesAtom);
    const blockId = state.blockId;
    const firstBlockId = Object.keys(roles).find((id) => roles[id] === "first") ?? null;
    const factsAtom = useMemo(
        () => makeRadarFactsAtom([blockId, firstBlockId].filter((id) => id != null)),
        [blockId, firstBlockId]
    );
    const facts = useAtomValue(factsAtom);
    // Computed each time the chooser opens (AC3).
    const [options] = useState(() => view360.placeOptions());
    const [pinnedCount] = useState(() => view360.pinnedColumnCount());
    const placement = active ? placements[blockId] : "carpet";
    useRestoreFocus();

    const apply = (n: number) => {
        const option = options.find((o) => o.n === n);
        if (option == null || !option.offered) {
            return;
        }
        closePlacesChooser();
        view360.applyPlaces(blockId, n);
    };
    const run = (fn: () => void) => {
        closePlacesChooser();
        fn();
    };

    useLayoutEffect(() => {
        const box = boxRef.current?.getBoundingClientRect();
        if (box == null) {
            return;
        }
        const left = Math.max(EdgeGapPx, Math.min(state.anchor.right - box.width, window.innerWidth - box.width - EdgeGapPx));
        const below = state.anchor.bottom + 4;
        const top = Math.max(EdgeGapPx, Math.min(below, window.innerHeight - box.height - EdgeGapPx));
        setPos({ left, top });
    }, [state]);
    useEffect(() => {
        const target = boxRef.current?.querySelector<HTMLButtonElement>("[data-offered='true']") ?? firstRef.current;
        target?.focus();
    }, []);
    useEffect(() => {
        const onDown = (e: MouseEvent) => {
            if (!boxRef.current?.contains(e.target as Node)) {
                closePlacesChooser();
            }
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.metaKey || e.ctrlKey || e.altKey) {
                return;
            }
            if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closePlacesChooser();
                return;
            }
            const n = Number(e.key);
            if (n >= 1 && n <= 3) {
                e.preventDefault();
                e.stopPropagation();
                apply(n);
            }
        };
        document.addEventListener("mousedown", onDown, true);
        document.addEventListener("keydown", onKey, true);
        return () => {
            document.removeEventListener("mousedown", onDown, true);
            document.removeEventListener("keydown", onKey, true);
        };
    }, []);

    const agent = facts[firstBlockId]?.title || t("view360.places.fallbackAgent");
    const panel = facts[blockId]?.title || t("view360.places.fallbackPanel");
    const why = optionsWhy(options);
    const offeredKeys = options.filter((o) => o.offered).map((o) => String(o.n));
    const pinShortcut = formatShortcutById("pin-panel");
    const style: CSSProperties = {
        width: ChooserWidthPx,
        left: pos?.left ?? state.anchor.right - ChooserWidthPx,
        top: pos?.top ?? state.anchor.bottom + 4,
        visibility: pos == null ? "hidden" : "visible",
    };
    return createPortal(
        <div
            ref={boxRef}
            role="dialog"
            aria-label={t("view360.places.title")}
            className="mt-places-pop"
            style={style}
            data-testid="mt-places-chooser"
            onMouseDown={(e) => e.stopPropagation()}
        >
            <div className="mt-places-head">
                <CarpetIcon />
                <span>{t("view360.places.title")}</span>
            </div>
            <p className="mt-places-intro">{t("view360.places.intro", { agent, panel })}</p>
            <div className="mt-places-label" id="mt-places-label">
                {t("view360.places.label")}
            </div>
            <div className="mt-places-counts" role="group" aria-labelledby="mt-places-label">
                {options.map((option, i) => {
                    const caption = optionCaption(option);
                    const current = shown === option.n;
                    return (
                        <button
                            key={option.n}
                            ref={i === 0 ? firstRef : undefined}
                            type="button"
                            className={cn(
                                "mt-places-count",
                                option.offered ? "cursor-pointer" : "is-off",
                                hover === option.n && option.offered && "is-hover",
                                current && "is-current"
                            )}
                            aria-disabled={!option.offered}
                            aria-pressed={current}
                            aria-label={`${option.n} · ${t("view360.places.mark", { count: option.n })} · ${caption}`}
                            data-testid={`mt-places-${option.n}`}
                            data-offered={option.offered ? "true" : "false"}
                            data-reason={option.reason ?? ""}
                            onMouseEnter={() => setHover(option.n)}
                            onMouseLeave={() => setHover((h) => (h === option.n ? null : h))}
                            onFocus={() => setHover(option.n)}
                            onBlur={() => setHover((h) => (h === option.n ? null : h))}
                            onClick={() => apply(option.n)}
                        >
                            <PlacesDiagram option={option} active={option.offered && hover === option.n} />
                            <span className="mt-places-n">
                                {option.n}
                                <small>{t("view360.places.mark", { count: option.n })}</small>
                                {current && <em>{t("view360.places.current")}</em>}
                            </span>
                            <span className="mt-places-caption">{caption}</span>
                        </button>
                    );
                })}
            </div>
            {why != null && (
                <div className="mt-places-why" data-testid="mt-places-why">
                    <i className="fa fa-solid fa-circle-info" aria-hidden="true" />
                    <span>{why}</span>
                </div>
            )}
            {pinnedCount > 0 && (
                <div className="mt-places-why" data-testid="mt-places-pinned">
                    <i className="fa fa-solid fa-thumbtack" aria-hidden="true" />
                    <span>{tc("view360.places.pinned", pinnedCount)}</span>
                </div>
            )}
            {active && placement != null && placement !== "first" && (
                <>
                    <div className="mt-places-label mt-places-section">{t("view360.places.already")}</div>
                    {placement !== "beside" && (
                        <button
                            type="button"
                            className="mt-places-row cursor-pointer"
                            data-testid="mt-places-pin-beside"
                            onClick={() => run(() => view360.pin(blockId, "beside"))}
                        >
                            <i className="fa fa-solid fa-thumbtack" aria-hidden="true" />
                            <span>{t("view360.places.pinBeside")}</span>
                            {pinShortcut && placement === "carpet" && <span className="mt-places-kbd">{pinShortcut}</span>}
                        </button>
                    )}
                    {placement !== "stacked" && (
                        <button
                            type="button"
                            className="mt-places-row cursor-pointer"
                            data-testid="mt-places-pin-stacked"
                            onClick={() => run(() => view360.pin(blockId, "stacked"))}
                        >
                            <i className="fa fa-solid fa-layer-group" aria-hidden="true" />
                            <span>{t("view360.places.pinStacked")}</span>
                        </button>
                    )}
                    <button
                        type="button"
                        className="mt-places-row cursor-pointer"
                        data-testid="mt-places-leave"
                        onClick={() => run(() => view360.requestLeave())}
                    >
                        <CarpetIcon />
                        <span>{t("view360.places.leave")}</span>
                    </button>
                </>
            )}
            <div className="mt-places-foot">
                <span>{t("view360.places.undoFor")}</span>
                <span className="mt-places-keys">
                    {offeredKeys.map((k) => (
                        <span key={k} className="mt-places-kbd">
                            {k}
                        </span>
                    ))}
                    <span className="mt-places-kbd">{t("view360.places.escape")}</span>
                </span>
            </div>
        </div>,
        document.body
    );
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
            const rect = button?.closest?.("button")?.getBoundingClientRect();
            const anchor =
                rect == null
                    ? { left: window.innerWidth / 2, right: window.innerWidth / 2 + ChooserWidthPx / 2, bottom: 80 }
                    : { left: rect.left, right: rect.right, bottom: rect.bottom };
            globalStore.set(placesChooserAtom, { blockId, owner, anchor });
        },
    };
    return (
        <>
            <IconButton decl={decl} className={cn("mt-carpet-button", open && "is-open")} />
            {open && <PlacesChooser view360={view360} state={chooser} />}
        </>
    );
});
CarpetHeaderButton.displayName = "CarpetHeaderButton";
