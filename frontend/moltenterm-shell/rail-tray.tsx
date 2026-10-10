// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The rail's hover tray (FR-SHELL-045, DS-SHELL-080, DS-SHELL-081): the item's host listens to the pointer and the
// focus, the tray draws the name and the item's two buttons. The tray is anchored to its item and fixed
// (moltenterm-shell.css): the rail is 48 px wide and scrolls, so its box would clip a tray drawn inside it. It covers the
// item's own row only, so it never reaches the title bar, the tab bar or a panel header above or below the row.

import { ContextMenuModel } from "@/app/store/contextmenu";
import { globalStore } from "@/app/store/jotaiStore";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { escapeBelongsElsewhere } from "./rail-connect";
import { RailTrayModel, revealDelta, trayArrowIndex } from "./rail-tray-model";

// The rail's own scroll that brings a keyboard tray's item in: no reason to fold.
const RevealScrollMs = 300;

export type RailTrayAnchor = { top: number; left: number };

export type RailTrayPrimary = {
    kind: "edit" | "coffee";
    label: string;
    // The hover tooltip, when it says more than the label.
    tooltip?: string;
    // The coffee's state.
    pressed?: boolean;
    onActivate: (button: HTMLElement) => void;
};

const PrimaryGlyphs: Record<RailTrayPrimary["kind"], string> = {
    edit: "fa-pen",
    coffee: "fa-mug-hot",
};

// The gap between the tray and a tooltip of one of its buttons.
const TrayTooltipGapPx = 8;

function hostOf(key: string): HTMLElement {
    return document.querySelector<HTMLElement>(`[data-rail-tray-host="${CSS.escape(key)}"]`);
}

function itemOf(host: Element): HTMLElement {
    return host?.querySelector<HTMLElement>("[data-rail-nav]");
}

function trayButtonsOf(host: Element): HTMLElement[] {
    return Array.from(host?.querySelectorAll<HTMLElement>("[data-rail-tray-button]") ?? []);
}

// Focus once the tray is drawn open: a hidden button cannot take the focus.
function focusAfterOpen(element: HTMLElement) {
    requestAnimationFrame(() => element?.focus());
}

// The pointer, the focus and the arrows of an item's host. Off (enabled false) for an item without a tray.
export function useRailTrayHost(key: string, enabled: boolean) {
    const model = RailTrayModel.getInstance();
    const open = useAtomValue(model.openAtom);
    const isOpen = enabled && open?.key === key;
    if (!enabled) {
        return { isOpen: false, hostProps: {} };
    }
    const hostProps = {
        "data-rail-tray-host": key,
        "data-tray-open": isOpen ? "" : undefined,
        onPointerEnter: (e: React.PointerEvent) => {
            if (e.pointerType !== "touch") {
                model.pointerEnter(key);
            }
        },
        onPointerLeave: () => model.pointerLeave(key),
        onFocus: (e: React.FocusEvent) => {
            const target = e.target as HTMLElement;
            if (target.matches?.("[data-rail-nav]:focus-visible")) {
                model.focusEnter(key);
            }
        },
        onBlur: (e: React.FocusEvent<HTMLElement>) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                model.focusLeave(key);
            }
        },
        onKeyDown: (e: React.KeyboardEvent<HTMLElement>) => {
            if ((e.key !== "ArrowLeft" && e.key !== "ArrowRight") || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) {
                return;
            }
            const host = e.currentTarget;
            const stops = [itemOf(host), ...trayButtonsOf(host)];
            const index = stops.indexOf(e.target as HTMLElement);
            if (index < 0) {
                return;
            }
            const next = trayArrowIndex(index, e.key, stops.length - 1);
            e.preventDefault();
            if (next === index) {
                return;
            }
            if (!model.isOpen(key)) {
                model.open(key, "keyboard");
                focusAfterOpen(stops[next]);
                return;
            }
            stops[next]?.focus();
        },
    };
    return { isOpen, hostProps };
}

// More's menu (DS-SHELL-081) through MoltenTerm's menus (#371): from the More button, under it; from a right-click,
// at the pointer; from Shift+F10 or the Menu key (MenuHost dispatches a contextmenu event on the focused item), under
// the More button of the tray it opens. The tray stays open while its menu is.
export function showRailMenu(key: string, items: ContextMenuItem[], e: React.MouseEvent, from?: HTMLElement) {
    const model = RailTrayModel.getInstance();
    const host = hostOf(key);
    let event = e;
    const opener =
        from ?? (e?.nativeEvent?.isTrusted === false ? host?.querySelector<HTMLElement>("[data-rail-more]") : null);
    if (opener != null) {
        if (!model.isOpen(key)) {
            model.open(key, "keyboard");
        }
        const rect = opener.getBoundingClientRect();
        event = {
            clientX: rect.left,
            clientY: rect.bottom + 4,
            target: opener,
            stopPropagation: () => e?.stopPropagation(),
            preventDefault: () => e?.preventDefault(),
        } as unknown as React.MouseEvent;
    }
    model.pin(key);
    ContextMenuModel.getInstance().showContextMenu(items, event, {
        onClose: () => {
            model.unpin(key);
            // A tray opened by the pointer stays only under the pointer: the menu gives the focus back to More, which
            // would otherwise hold it open after the pointer left for the content.
            requestAnimationFrame(() => {
                const current = hostOf(key);
                const keep =
                    model.getOpen()?.via === "keyboard"
                        ? current?.contains(document.activeElement)
                        : current?.matches(":hover");
                if (keep) {
                    return;
                }
                model.fold(key);
            });
        },
    });
}

// The exits of the open tray, installed once by the rail: Escape (the focus goes back to the item when it was in the
// tray), a press outside the item and its tray, the rail's scroll and the window losing the focus.
export function installRailTrayExits(nav: HTMLElement): () => void {
    const model = RailTrayModel.getInstance();
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key !== "Escape" || model.getOpen() == null || escapeBelongsElsewhere(e)) {
            return;
        }
        const key = model.escape();
        if (key == null) {
            return;
        }
        const host = hostOf(key);
        if (host?.contains(document.activeElement)) {
            // Only an Escape meant for the rail: a terminal keeps its own while the pointer merely rests on the rail.
            e.preventDefault();
            e.stopPropagation();
            itemOf(host)?.focus();
        }
    };
    const onPointerDown = (e: PointerEvent) => {
        const open = model.getOpen();
        if (open == null) {
            return;
        }
        const target = e.target as Element;
        if (target?.closest?.(`[data-rail-tray-host="${CSS.escape(open.key)}"]`) != null) {
            return;
        }
        model.fold(open.key);
    };
    // The rail scrolling under a resting pointer folds its tray; a keyboard tray follows its item, which the focus
    // scrolled into view, and the rail's own reveal below is no scroll of the user's.
    let revealedAt = 0;
    const onScroll = () => {
        if (model.getOpen()?.via !== "pointer" || Date.now() - revealedAt < RevealScrollMs) {
            return;
        }
        model.closeAll();
    };
    // The tray covers its item's row only, and that row must lie inside the rail, never over the tab bar above it or
    // the status bar below it. A keyboard tray scrolls its item in; under the pointer, a partly hidden item opens no
    // tray (scrolling would slide another item under the resting pointer).
    const unsubscribe = globalStore.sub(model.openAtom, () => {
        const open = model.getOpen();
        const item = open != null ? itemOf(hostOf(open.key)) : null;
        if (item == null) {
            return;
        }
        const delta = revealDelta(item.getBoundingClientRect(), nav.getBoundingClientRect());
        if (delta === 0) {
            return;
        }
        if (open.via === "pointer") {
            model.fold(open.key);
            return;
        }
        revealedAt = Date.now();
        nav.scrollTop += delta;
    });
    const closeAll = () => model.closeAll();
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointerdown", onPointerDown, true);
    nav.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("blur", closeAll);
    return () => {
        unsubscribe();
        document.removeEventListener("keydown", onKeyDown, true);
        document.removeEventListener("pointerdown", onPointerDown, true);
        nav.removeEventListener("scroll", onScroll);
        window.removeEventListener("blur", closeAll);
        model.closeAll();
    };
}

function TrayButton({
    label,
    glyph,
    pressed,
    more,
    tooltip,
    onActivate,
    onTooltip,
}: {
    label: string;
    glyph: string;
    pressed?: boolean;
    more?: boolean;
    tooltip?: string;
    onActivate: (button: HTMLElement) => void;
    onTooltip: (label: string, anchor: RailTrayAnchor) => void;
}) {
    return (
        <button
            type="button"
            tabIndex={-1}
            aria-label={label}
            aria-pressed={pressed != null ? pressed : undefined}
            aria-haspopup={more ? "menu" : undefined}
            data-rail-tray-button=""
            data-rail-more={more ? "" : undefined}
            draggable={false}
            className={cn(
                "molten-rail-tray-button flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-6 text-icon-14 text-muted transition-colors duration-120 ease-mt hover:bg-hover hover:text-primary",
                pressed && "molten-rail-tray-coffee"
            )}
            onClick={(e) => {
                onTooltip(null, null);
                onActivate(e.currentTarget);
            }}
            onMouseEnter={(e) => {
                const tray = e.currentTarget.closest(".molten-rail-tray")?.getBoundingClientRect();
                const rect = e.currentTarget.getBoundingClientRect();
                onTooltip(tooltip ?? label, {
                    top: rect.top + rect.height / 2,
                    left: (tray?.right ?? rect.right) + TrayTooltipGapPx,
                });
            }}
            onMouseLeave={() => onTooltip(null, null)}
        >
            <i className={cn("fa fa-solid", glyph)} aria-hidden />
        </button>
    );
}

export type RailTrayNameProps = {
    onClick?: (e: React.MouseEvent) => void;
    onDoubleClick?: (e: React.MouseEvent) => void;
    onPointerDown?: (e: React.PointerEvent<HTMLElement>) => void;
};

// The tray of one item. The item's own button stays on top of the tray's first 36 px (lead), where its icon is; the
// name is part of the item too: a click there switches workspace and a press there drags it, as on the icon.
export function RailTray({
    open,
    name,
    detail,
    lead,
    dot,
    primary,
    moreLabel,
    onMore,
    nameProps,
    onTooltip,
}: {
    open: boolean;
    name: string;
    // A second, quieter text after the name (a group's member count).
    detail?: string;
    // The item's width, which the tray starts under.
    lead: number;
    // The 6 px state dot after the name: unread, or an agent waiting.
    dot?: { className: string; label: string };
    primary?: RailTrayPrimary;
    moreLabel?: string;
    onMore?: (button: HTMLElement) => void;
    nameProps?: RailTrayNameProps;
    onTooltip: (label: string, anchor: RailTrayAnchor) => void;
}) {
    return (
        <div
            className="molten-rail-tray"
            data-open={open ? "" : undefined}
            aria-hidden={open ? undefined : true}
            style={{ "--molten-rail-tray-lead": `${lead}px` } as React.CSSProperties}
        >
            <span
                className="molten-rail-tray-name flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 pr-1 pl-1"
                {...nameProps}
            >
                <span className="min-w-0 truncate text-12 font-medium text-primary">{name}</span>
                {detail ? <span className="shrink-0 text-11 text-muted">{detail}</span> : null}
                {dot != null ? (
                    <span
                        className={cn("molten-rail-tray-dot h-1.5 w-1.5 shrink-0 rounded-full", dot.className)}
                        role="img"
                        aria-label={dot.label}
                    />
                ) : null}
            </span>
            {primary != null ? (
                <TrayButton
                    label={primary.label}
                    tooltip={primary.tooltip}
                    glyph={PrimaryGlyphs[primary.kind]}
                    pressed={primary.kind === "coffee" ? !!primary.pressed : undefined}
                    onActivate={primary.onActivate}
                    onTooltip={onTooltip}
                />
            ) : null}
            {onMore != null ? (
                <TrayButton label={moreLabel} glyph="fa-ellipsis" more onActivate={onMore} onTooltip={onTooltip} />
            ) : null}
        </div>
    );
}
