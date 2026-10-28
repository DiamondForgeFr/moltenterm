// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// One menu per view (FR-SHELL-081): the same on a tile, a top-row block and a temporary row, headed "<name> · <state>"
// and offering only what the state allows (view-menu-model.ts). The tab's own actions of the former tab bar (flag,
// backgrounds, layout of the view on screen, copy id, reopen closed) stay in it, so nothing the tab menu offered is lost.

import { atoms, globalStore } from "@/app/store/global";
import type { TabEnv } from "@/app/tab/tab";
import { buildTabContextMenu } from "@/app/tab/tabcontextmenu";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { currentEqualize } from "../equalize/equalize-actions";
import { tCount } from "../i18n/i18n";
import { acceleratorById } from "../shortcuts/format";
import { view360MenuItems } from "../view360/view360-toggle";
import { workspaceShownName } from "../workspace-default-name";
import { viewMenuHeader, viewMenuPlan } from "./view-menu-model";
import { ViewState } from "./view-pins-model";
import { ViewPins, ViewRef } from "./view-pins-store";
import { openViewPopover } from "./view-popover";

type TFn = (key: string, vars?: Record<string, any>) => string;

export type ViewMenuTarget = {
    ref: ViewRef;
    state: ViewState;
    modified: boolean;
    name: string;
    // The icon the developer chose, null when the view shows its panels' icons.
    icon: string;
    // The view on screen gets the layout actions (equalize, 360 view).
    active: boolean;
    // MoltenTerm's own Project tab: a tile it pins itself, whose pin state the menu leaves alone.
    projectTab?: boolean;
};

export type ViewMenuHooks = {
    // Rename in place (a row's or a tile's field); without it, the rename page opens where the menu was.
    startRename?: () => void;
    onClose?: () => void;
    env?: TabEnv;
    // Where the menu was opened, for its Rename and Change icon pages.
    at: { x: number; y: number };
};

// The workspace as the sidebar names it.
function shownWorkspace(t: TFn): string {
    return workspaceShownName(globalStore.get(atoms.workspace)?.name, t) || t("rail.unsavedWorkspace");
}

function layoutItems(t: TFn): ContextMenuItem[] {
    const items: ContextMenuItem[] = [];
    const equalize = currentEqualize();
    if (equalize != null) {
        const auto = equalize.auto;
        items.push(
            {
                label: t("sidebar.view.equalize"),
                icon: "table-columns",
                enabled: globalStore.get(equalize.canEqualizeAtom) && !auto,
                accelerator: acceleratorById("equalize-panels"),
                click: () => equalize.equalize(),
            },
            {
                label: t("sidebar.view.equalizeAuto"),
                type: "checkbox",
                checked: auto,
                click: () => equalize.setAuto(!auto),
            }
        );
    }
    const view360 = getLayoutModelForStaticTab()?.moltenView360;
    if (view360 != null) {
        items.push({ label: t("sidebar.view.view360"), type: "submenu", submenu: view360MenuItems(view360) });
    }
    return items;
}

function pinItems(target: ViewMenuTarget, t: TFn): ContextMenuItem[] {
    const pins = ViewPins.getInstance();
    const plan = viewMenuPlan(target.state, target.modified, target.projectTab);
    const workspace = shownWorkspace(t);
    const tabId = target.ref.tabId;
    const items: ContextMenuItem[] = [];
    if (plan.pinHere) {
        items.push({
            label: t("sidebar.pins.menu.pinHere", { workspace }),
            icon: "thumbtack",
            click: () => pins.openPinPage(tabId, target.name, "here"),
        });
    }
    if (plan.pinEverywhere) {
        items.push(
            target.state === "temporary"
                ? {
                      label: t("sidebar.pins.menu.pinEverywhere"),
                      icon: "layer-group",
                      click: () => pins.openPinPage(tabId, target.name, "everywhere"),
                  }
                : {
                      label: t("sidebar.pins.menu.pinEverywhereNow"),
                      icon: "layer-group",
                      click: () => fireAndForget(() => pins.pinEverywhere(tabId, target.name)),
                  }
        );
    }
    if (plan.pinOnlyHere) {
        items.push({
            label: t("sidebar.pins.menu.pinOnlyHere", { workspace }),
            icon: "thumbtack",
            click: () => fireAndForget(() => pins.pinOnlyHere(tabId, target.ref.pinId)),
        });
    }
    if (plan.makeTemporary) {
        items.push({
            label: t("sidebar.pins.menu.makeTemporary"),
            icon: "thumbtack-slash",
            click: () => fireAndForget(() => (tabId ? pins.unpin(tabId) : pins.unpinGlobal(target.ref.pinId))),
        });
    }
    return items;
}

// Close the finished views (FR-SHELL-080): its bordered button gave way to Clear (#1253), the action stays in a
// temporary view's menu while some temporary view's agents have all finished.
export function closeFinishedItems(target: ViewMenuTarget): ContextMenuItem[] {
    if (target.state !== "temporary") {
        return [];
    }
    const pins = ViewPins.getInstance();
    const count = globalStore.get(pins.finishedAtom).length;
    if (count === 0) {
        return [];
    }
    return [
        {
            label: tCount("sidebar.pins.closeFinished", count),
            icon: "broom",
            click: () => fireAndForget(() => pins.closeFinished()),
        },
    ];
}

export function viewMenuItems(target: ViewMenuTarget, hooks: ViewMenuHooks, t: TFn): ContextMenuItem[] {
    const pins = ViewPins.getInstance();
    const tabId = target.ref.tabId;
    // A missed fork toast is not final (#1272): the view's menu keeps Update the pinned view while its pin exists.
    const origin = tabId && target.state === "temporary" ? pins.forkOriginOf(tabId) : null;
    const plan = viewMenuPlan(target.state, target.modified, target.projectTab, origin != null);
    const workspace = shownWorkspace(t);
    const items: ContextMenuItem[] = [
        { type: "header", label: viewMenuHeader(target.name, target.state, workspace, t) },
    ];
    if (plan.updatePinned) {
        items.push({
            label: t("sidebar.pins.menu.updatePinned", { name: origin.name }),
            icon: "layer-group",
            click: () => fireAndForget(() => pins.updatePinned(tabId)),
        });
    }
    if (plan.saveOrRevert && tabId) {
        items.push(
            {
                label: t(target.state === "everywhere" ? "sidebar.pins.menu.saveEverywhere" : "sidebar.pins.menu.save"),
                icon: "check",
                click: () => fireAndForget(() => pins.saveState(tabId)),
            },
            {
                label: t("sidebar.pins.menu.revert"),
                icon: "rotate-left",
                click: () => fireAndForget(() => pins.revert(tabId)),
            }
        );
    }
    const page = { ref: target.ref, name: target.name, icon: target.icon, x: hooks.at.x, y: hooks.at.y };
    items.push(
        {
            label: t("sidebar.views.rename"),
            icon: "pen",
            accelerator: hooks.startRename ? acceleratorById("rename-tab") : undefined,
            click: () => (hooks.startRename ? hooks.startRename() : openViewPopover({ kind: "rename", ...page })),
        },
        {
            label: t("sidebar.views.changeIcon"),
            icon: "icons",
            click: () => openViewPopover({ kind: "icon", ...page }),
        }
    );
    if (!target.projectTab) {
        items.push({
            label: t("sidebar.views.duplicate"),
            icon: "clone",
            click: () => fireAndForget(() => pins.duplicate(target.ref)),
        });
    }
    const pinned = pinItems(target, t);
    if (pinned.length > 0) {
        items.push({ type: "separator" }, ...pinned);
    }
    if (tabId && target.active) {
        const layout = layoutItems(t);
        if (layout.length > 0) {
            items.push({ type: "separator" }, ...layout);
        }
    }
    if (tabId && hooks.env != null) {
        // The tab's own menu without what the view menu replaces: its rename, the tab bar position the sidebar
        // replaces, and Close where the state forbids it.
        const drop = new Set([t("wave.tab.rename"), t("wave.tab.tabBarPosition")]);
        if (!plan.close) {
            drop.add(t("wave.tab.close"));
        }
        const tabItems = buildTabContextMenu(tabId, { current: hooks.startRename }, () => hooks.onClose?.(), hooks.env);
        const close = t("wave.tab.close");
        items.push(
            { type: "separator" },
            ...tabItems
                .filter((item) => !drop.has(item.label))
                .map((item) => (item.label === close ? { ...item, label: t("sidebar.views.close") } : item))
        );
    }
    items.push(...closeFinishedItems(target));
    if (plan.closeNote && !target.projectTab) {
        items.push({ label: t("sidebar.views.closeNote"), icon: "lock", enabled: false });
    }
    return items;
}
