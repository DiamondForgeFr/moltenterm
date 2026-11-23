// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The menu of ribbons (FR-SHELL-159, #2476): choosing your ribbon is choosing your context. One ribbon per context
// (emblem and name, in the colour of the workspace a click would land on) with its hint on the right, then "Open a
// context in a new window…" and "Manage contexts…". It opens upward from the sidebar's ribbon and downward from the
// collapsed one. The arrows, Home and End move through it, Escape closes it and gives the focus back to the ribbon.

import { autoUpdate, FloatingPortal, offset, shift, type Placement } from "@floating-ui/react";
import { cn } from "@/util/util";
import { useEffect, useState } from "react";
import { useFloatingInPlace } from "../floating-in-place";
import { useT, useTCount } from "../i18n/i18n";
import type { ContextRibbon } from "./context-model";
import { RibbonFace } from "./ribbon";
import { hintText, menuKeyTarget, ribbonPaint } from "./ribbon-model";

type MenuMode = "choose" | "window";

function menuItems(root: HTMLElement): HTMLElement[] {
    return Array.from(root?.querySelectorAll<HTMLElement>("[data-ribbon-item]") ?? []);
}

export type RibbonMenuProps = {
    anchor: HTMLElement;
    placement: Extract<Placement, "top-start" | "bottom-start">;
    ribbons: ContextRibbon[];
    onChoose: (ribbon: ContextRibbon) => void;
    onOpenInWindow: (ribbon: ContextRibbon) => void;
    onManage: () => void;
    // restoreFocus: the menu was closed by the keyboard, and the ribbon takes the focus back.
    onClose: (restoreFocus: boolean) => void;
};

function RibbonRow({
    ribbon,
    mode,
    onPick,
}: {
    ribbon: ContextRibbon;
    mode: MenuMode;
    onPick: (ribbon: ContextRibbon) => void;
}) {
    const t = useT();
    const tc = useTCount();
    const { paint, ink } = ribbonPaint(ribbon.landing?.color ?? "");
    const here = ribbon.here && mode === "choose";
    return (
        <button
            type="button"
            role={mode === "choose" ? "menuitemradio" : "menuitem"}
            aria-checked={mode === "choose" ? ribbon.here : undefined}
            className={cn("mt-ribbon-row", here && "mt-selected", ribbon.landing == null && "is-empty")}
            data-ribbon-item
            data-testid="context-ribbon-row"
            data-context-id={ribbon.context.id}
            onClick={() => onPick(ribbon)}
        >
            <RibbonFace emblem={ribbon.emblem} name={ribbon.name} paint={paint} ink={ink} />
            <span className={cn("mt-ribbon-hint", ribbon.hint.kind === "waiting" && "is-waiting")}>
                {hintText(ribbon.hint, t, tc)}
            </span>
        </button>
    );
}

export function RibbonMenu({
    anchor,
    placement,
    ribbons,
    onChoose,
    onOpenInWindow,
    onManage,
    onClose,
}: RibbonMenuProps) {
    const t = useT();
    const [mode, setMode] = useState<MenuMode>("choose");
    // The menu is drawn in a portal that mounts after this component does: its element is state, so the effects below
    // run once it exists.
    const [menu, setMenu] = useState<HTMLDivElement>(null);
    const { refs, floatingStyles, isPositioned } = useFloatingInPlace({
        open: true,
        placement,
        elements: { reference: anchor },
        middleware: [offset(6), shift({ padding: 8 })],
        whileElementsMounted: autoUpdate,
    });

    // The menu opens on the row of the window's own context; the second page, and a return to the first, start on a row.
    // A surface that is not visible yet takes no focus: it is placed first.
    useEffect(() => {
        if (!isPositioned) {
            return;
        }
        const rows = menuItems(menu);
        const own = mode === "choose" ? rows.find((r) => r.getAttribute("aria-checked") === "true") : null;
        (own ?? rows[0])?.focus();
    }, [menu, mode, isPositioned]);

    useEffect(() => {
        const onPointerDown = (e: PointerEvent) => {
            const target = e.target as Node;
            if (menu?.contains(target) || anchor.contains(target)) {
                return;
            }
            onClose(false);
        };
        document.addEventListener("pointerdown", onPointerDown, true);
        return () => document.removeEventListener("pointerdown", onPointerDown, true);
    }, [anchor, menu, onClose]);

    const onKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            onClose(true);
            return;
        }
        if (e.key === "Tab") {
            onClose(false);
            return;
        }
        const rows = menuItems(menu);
        const target = menuKeyTarget(e.key, rows.indexOf(document.activeElement as HTMLElement), rows.length);
        if (target == null) {
            return;
        }
        e.preventDefault();
        e.stopPropagation();
        rows[target].focus();
    };

    const opensWindow = mode === "window";
    return (
        <FloatingPortal>
            <div ref={refs.setFloating} style={floatingStyles} className="z-[1000]" data-testid="context-ribbon-menu">
                <div
                    ref={setMenu}
                    role="menu"
                    aria-label={t(opensWindow ? "contexts.menu.windowLabel" : "contexts.menu.label")}
                    className="mt-sb-pop mt-ribbon-menu rounded-4 py-1.5"
                    onKeyDown={onKeyDown}
                >
                    {opensWindow ? <div className="mt-sb-pop-head">{t("contexts.menu.windowHeading")}</div> : null}
                    {ribbons.map((ribbon) => (
                        <RibbonRow
                            key={ribbon.context.id}
                            ribbon={ribbon}
                            mode={mode}
                            onPick={opensWindow ? onOpenInWindow : onChoose}
                        />
                    ))}
                    <div className="mt-ribbon-rule" role="separator" />
                    {opensWindow ? (
                        <button
                            type="button"
                            role="menuitem"
                            className="mt-ribbon-action"
                            data-ribbon-item
                            onClick={() => setMode("choose")}
                        >
                            {t("contexts.menu.back")}
                        </button>
                    ) : (
                        <>
                            <button
                                type="button"
                                role="menuitem"
                                className="mt-ribbon-action"
                                data-ribbon-item
                                data-testid="context-new-window"
                                onClick={() => setMode("window")}
                            >
                                {t("contexts.menu.newWindow")}
                            </button>
                            <button
                                type="button"
                                role="menuitem"
                                className="mt-ribbon-action"
                                data-ribbon-item
                                data-testid="context-manage"
                                onClick={onManage}
                            >
                                {t("contexts.menu.manage")}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </FloatingPortal>
    );
}
