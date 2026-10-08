// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { ContextMenuModel, ContextMenuSession } from "@/app/store/contextmenu";
import { atoms, getApi, getBlockComponentModel, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMenuGesture } from "./menu-gesture";
import { captureMenuFocus, menuHasRoles, menuPoint, runMenuSelection } from "./menu-model";
import { MenuSurface } from "./menu-surface";

type PresentedMenu = {
    session: ContextMenuSession;
    point: { x: number; y: number };
    restore: () => void;
    target: string;
};
export function MenuHost() {
    const [menu, setMenu] = useState<PresentedMenu>(null);
    const layerRef = useRef<HTMLDivElement>(null);
    const current = useRef<PresentedMenu>(null);
    const selecting = useRef(false);
    const gesture = useMenuGesture(() => current.current?.session.cancel());
    const { draining, active: drain } = gesture;
    useLayoutEffect(() => {
        const layer = layerRef.current;
        if ((menu || draining) && !layer.matches(":popover-open")) layer.showPopover();
        if (!menu && !draining && layer.matches(":popover-open")) layer.hidePopover();
    }, [menu, draining]);
    useEffect(() => {
        const model = ContextMenuModel.getInstance();
        return model.registerPresenter(
            (session) => {
                if (!session) {
                    if (!selecting.current && current.current?.target)
                        getApi().revokeContextMenuTarget?.(current.current.target);
                    const imageToken = (current.current?.session.event as any)?.contextMenuImageToken;
                    if (!selecting.current && imageToken) getApi().revokeContextMenuTarget?.(imageToken);
                    if (current.current && document.hasFocus() && layerRef.current.contains(document.activeElement))
                        current.current.restore();
                    current.current = null;
                    setMenu(null);
                    return;
                }
                if (drain.current) {
                    session.cancel();
                    return;
                }
                const guestId = (session.event as any).contextMenuGuestId;
                const presented: PresentedMenu = {
                    session,
                    point: menuPoint(session.event),
                    restore: captureMenuFocus(),
                    target: menuHasRoles(session.menu) ? getApi().captureContextMenuTarget?.(guestId) : null,
                };
                current.current = presented;
                setMenu(presented);
            },
            () => globalStore.get(getSettingsKeyAtom("app:nativecontextmenu")) === true
        );
    }, []);
    useEffect(() => {
        const cancel = () => {
            if (selecting.current) return;
            current.current?.session.cancel();
            gesture.reset();
        };
        const keydown = (event: KeyboardEvent) => {
            if (current.current) {
                // Keys dispatched outside the layer must not reach xterm or app shortcuts.
                if (!layerRef.current.contains(event.target as Node)) {
                    event.preventDefault();
                    event.stopImmediatePropagation();
                    if (event.key === "Escape") cancel();
                }
                return;
            }
            if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
            const target = document.activeElement as HTMLElement;
            if (event.key === "F10" && target?.closest(".view-term")) {
                const blockId = target.closest("[data-blockid]")?.getAttribute("data-blockid");
                const viewModel = getBlockComponentModel(blockId)?.viewModel as any;
                if (viewModel?.termRef?.current?.terminal?.buffer?.active?.type === "alternate") return;
            }
            event.preventDefault();
            event.stopImmediatePropagation();
            const rect = target?.getBoundingClientRect();
            target?.dispatchEvent(
                new MouseEvent("contextmenu", {
                    bubbles: true,
                    cancelable: true,
                    clientX: rect?.left ?? 8,
                    clientY: rect?.bottom ?? 8,
                })
            );
        };
        window.addEventListener("keydown", keydown, true);
        document.addEventListener("visibilitychange", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("resize", cancel);
        const unsubscribe = globalStore.sub(atoms.workspaceId, cancel);
        return () => {
            window.removeEventListener("keydown", keydown, true);
            document.removeEventListener("visibilitychange", cancel);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("resize", cancel);
            unsubscribe();
            gesture.reset();
        };
    }, []);
    const cancel = () => {
        current.current?.session.cancel();
    };
    const select = (item: ContextMenuItem) => {
        const opened = current.current;
        if (!opened) return;
        runMenuSelection(
            selecting,
            opened.restore,
            () => opened.session.select(item, () => getApi().executeContextMenuRole?.(opened.target, item.role)),
            () => {
                if (opened.target) getApi().revokeContextMenuTarget?.(opened.target);
                const imageToken = (opened.session.event as any)?.contextMenuImageToken;
                if (imageToken) getApi().revokeContextMenuTarget?.(imageToken);
            }
        );
    };
    return (
        <div
            ref={layerRef}
            popover="manual"
            className="molten-menu-layer"
            {...gesture.handlers}
            onKeyDown={(event) => event.stopPropagation()}
            onKeyUp={(event) => event.stopPropagation()}
        >
            {menu && (
                <MenuSurface
                    key={menu.session.token}
                    items={menu.session.menu}
                    point={menu.point}
                    onSelect={select}
                    onCancel={cancel}
                    portalRoot={layerRef.current}
                />
            )}
        </div>
    );
}
