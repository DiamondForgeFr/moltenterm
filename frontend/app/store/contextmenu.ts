// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0
// MOLTENTERM-PATCH (#371): renderer presentation with correlated, exactly-once sessions.
// MOLTENTERM-PATCH (#408): native menus get the host's sections and Developer gate (FR-SHELL-054).

import { layoutMenuTree } from "../../moltenterm-shell/menu/menu-model";
import { atoms, getApi, globalStore } from "./global";

export type ShowContextMenuOpts = {
    onSelect?: (item: ContextMenuItem) => void;
    onCancel?: () => void;
    onClose?: (item: ContextMenuItem | null) => void;
};
export type ContextMenuSession = {
    token: string;
    menu: ContextMenuItem[];
    event: React.MouseEvent<any>;
    select: (item: ContextMenuItem, roleAction?: () => void) => void;
    cancel: () => void;
};
type Presenter = (session: ContextMenuSession | null) => void;

class ContextMenuModel {
    private static instance: ContextMenuModel;
    handlers = new Map<string, ContextMenuItem>();
    activeOpts: ShowContextMenuOpts = null;
    session: ContextMenuSession = null;
    native = false;
    nativeTarget: string = null;
    presenter: Presenter = null;
    useNative: () => boolean = () => false;

    private constructor() {
        getApi().onContextMenuClick(this.handleContextMenuClick.bind(this));
    }
    static getInstance(): ContextMenuModel {
        return (ContextMenuModel.instance ??= new ContextMenuModel());
    }
    registerPresenter(presenter: Presenter, useNative: () => boolean): () => void {
        this.presenter = presenter;
        this.useNative = useNative;
        return () => {
            if (this.presenter !== presenter) return;
            const session = this.session;
            this.presenter = null;
            presenter(null);
            session?.cancel();
        };
    }
    finish(token: string, item: ContextMenuItem, roleAction?: () => void): void {
        if (this.session?.token !== token) return;
        const opts = this.activeOpts;
        const presented = !this.native;
        const nativeTarget = this.nativeTarget;
        this.nativeTarget = null;
        this.session = null;
        this.activeOpts = null;
        this.handlers.clear();
        if (presented) this.presenter?.(null);
        try {
            if (item == null) opts?.onCancel?.();
            else {
                try {
                    if (item.role) roleAction?.();
                    else item.click?.();
                } finally {
                    opts?.onSelect?.(item);
                }
            }
        } finally {
            try {
                opts?.onClose?.(item ?? null);
            } finally {
                if (nativeTarget) getApi().revokeContextMenuTarget?.(nativeTarget);
            }
        }
    }
    handleContextMenuClick(id: string | null, token?: string): void {
        if (!this.native || this.session == null || (token != null && token !== this.session.token)) return;
        const item = id != null ? this.handlers.get(id) : null;
        if (id != null && item == null) return;
        this.finish(this.session.token, item);
    }
    _convertAndRegisterMenu(menu: ContextMenuItem[]): ElectronContextMenuItem[] {
        return menu.map((item) => {
            const electronItem: ElectronContextMenuItem = {
                id: crypto.randomUUID(),
                role: item.role,
                type: item.type,
                label: item.label,
                sublabel: item.sublabel,
                checked: item.checked,
                accelerator: item.accelerator,
                visible: item.visible,
                enabled: item.enabled,
            };
            if ((item.click || item.role) && !item.submenu && item.type !== "header" && item.type !== "separator") {
                this.handlers.set(electronItem.id, item);
            }
            if (item.submenu) electronItem.submenu = this._convertAndRegisterMenu(item.submenu);
            return electronItem;
        });
    }
    showContextMenu(menu: ContextMenuItem[], ev: React.MouseEvent<any>, opts?: ShowContextMenuOpts): void {
        ev.stopPropagation();
        ev.preventDefault?.();
        this.session?.cancel();
        // A cancellation callback may itself have opened a new menu.
        if (this.session != null) return;
        const token = crypto.randomUUID();
        this.activeOpts = opts;
        this.native = !this.presenter || this.useNative();
        const session: ContextMenuSession = {
            token,
            menu,
            event: ev,
            select: (item, action) => this.finish(token, item, action),
            cancel: () => this.finish(token, null),
        };
        this.session = session;
        if (menu.every((item) => item.visible === false)) {
            session.cancel();
            return;
        }
        if (!this.native) {
            this.presenter(session);
            return;
        }
        const items = this._convertAndRegisterMenu(layoutMenuTree(menu, { developer: !!(ev as any)?.altKey }));
        const oid = globalStore.get(atoms.workspaceId) ?? globalStore.get(atoms.builderId);
        this.nativeTarget = getApi().captureContextMenuTarget?.((ev as any).contextMenuGuestId);
        getApi().showContextMenu(oid, items, token, this.nativeTarget);
    }
}
export { ContextMenuModel };
