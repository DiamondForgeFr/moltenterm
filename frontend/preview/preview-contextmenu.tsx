// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// MOLTENTERM-PATCH (#371): preview adapter for the shared, Electron-independent surface.

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useMenuGesture } from "../moltenterm-shell/menu/menu-gesture";
import { captureMenuFocus, menuPoint } from "../moltenterm-shell/menu/menu-model";
import { MenuSurface } from "../moltenterm-shell/menu/menu-surface";

type PreviewMenu = { items: ContextMenuItem[]; point: { x: number; y: number }; restore: () => void };
let listener: (menu: PreviewMenu) => void;
export function showPreviewContextMenu(items: ContextMenuItem[], event: React.MouseEvent): void {
    event.stopPropagation();
    event.preventDefault();
    listener?.({ items, point: menuPoint(event), restore: captureMenuFocus() });
}
export const PreviewContextMenu = memo(() => {
    const [menu, setMenu] = useState<PreviewMenu>(null);
    const gesture = useMenuGesture(() => close());
    const { draining } = gesture;
    const layer = useRef<HTMLDivElement>(null);
    useEffect(() => {
        listener = setMenu;
        return () => {
            listener = null;
        };
    }, []);
    useLayoutEffect(() => {
        if ((menu || draining) && !layer.current.matches(":popover-open")) layer.current.showPopover();
        if (!menu && !draining && layer.current.matches(":popover-open")) layer.current.hidePopover();
    }, [menu, draining]);
    const close = () => {
        menu?.restore();
        setMenu(null);
    };
    useEffect(() => {
        const dismiss = () => {
            close();
            gesture.reset();
        };
        document.addEventListener("visibilitychange", dismiss);
        window.addEventListener("blur", dismiss);
        window.addEventListener("resize", dismiss);
        return () => {
            document.removeEventListener("visibilitychange", dismiss);
            window.removeEventListener("blur", dismiss);
            window.removeEventListener("resize", dismiss);
        };
    }, [menu]);
    return (
        <div
            ref={layer}
            popover="manual"
            className="molten-menu-layer"
            {...gesture.handlers}
            onKeyDown={(event) => event.stopPropagation()}
        >
            {menu && (
                <MenuSurface
                    portalRoot={layer.current}
                    items={menu.items}
                    point={menu.point}
                    onCancel={close}
                    onSelect={(item) => {
                        close();
                        if (!item.role) item.click?.();
                    }}
                />
            )}
        </div>
    );
});
PreviewContextMenu.displayName = "PreviewContextMenu";
