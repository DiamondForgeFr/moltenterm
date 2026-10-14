// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import * as electron from "electron";
import { MenuRoleKeys, MenuRoleLabels } from "../frontend/moltenterm-shell/menu/menu-model"; // MOLTENTERM-PATCH (#371, #623)
import { fireAndForget } from "../frontend/util/util";
import { focusedBuilderWindow, getBuilderWindowById } from "./emain-builder";
import { openBuilderWindow } from "./emain-ipc";
import { isDev, unamePlatform } from "./emain-platform";
import { clearTabCache } from "./emain-tabview";
import { decreaseZoomLevel, increaseZoomLevel, resetZoomLevel } from "./emain-util";
import {
    createNewWaveWindow,
    createWorkspace,
    focusedWaveWindow,
    getAllWaveWindows,
    getWaveWindowByWorkspaceId,
    relaunchBrowserWindows,
    WaveBrowserWindow,
} from "./emain-window";
import { ElectronWshClient } from "./emain-wsh";
import {
    ContextMenuEvents,
    contextMenuTargetLive,
    contextMenuWindow,
    executeCapturedContextMenuRole,
    liveContextMenuHost,
} from "./moltenterm-contextmenu";
import { contextMenuRole } from "./moltenterm-contextmenu-policy";
import { mt, onMainLocaleChange } from "./moltenterm-i18n"; // MOLTENTERM-PATCH (#623): the menus follow app:language
import { makeMoltentermGettingStartedMenuItem } from "./moltenterm-onboarding"; // MOLTENTERM-PATCH (#161)
import { makeMoltentermSafeModeMenuItem } from "./moltenterm-safemode"; // MOLTENTERM-PATCH (#20)
import { makeMoltentermEditWorkspaceMenuItem } from "./moltenterm-workspace-menu"; // MOLTENTERM-PATCH (#294)
// MOLTENTERM-PATCH (#5): `updater` is no longer imported; the menu has no update item.

type AppMenuCallbacks = {
    createNewWaveWindow: () => Promise<void>;
    relaunchBrowserWindows: () => Promise<void>;
};

function getWindowWebContents(window: electron.BaseWindow): electron.WebContents {
    if (window == null) {
        return null;
    }
    // Check BrowserWindow first (for Tsunami Builder windows)
    if (window instanceof electron.BrowserWindow) {
        return window.webContents;
    }
    // Check WaveBrowserWindow (for main Wave windows with tab views)
    if (window instanceof WaveBrowserWindow) {
        if (window.activeTabView) {
            return window.activeTabView.webContents;
        }
        return null;
    }
    return null;
}

async function getWorkspaceMenu(ww?: WaveBrowserWindow): Promise<Electron.MenuItemConstructorOptions[]> {
    const workspaceList = await RpcApi.WorkspaceListCommand(ElectronWshClient);
    const workspaceMenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: mt("appMenu.createWorkspace"), // MOLTENTERM-PATCH (#623)
            click: (_, window) => fireAndForget(() => createWorkspace((window as WaveBrowserWindow) ?? ww)),
        },
        // MOLTENTERM-PATCH (#294): the workspace edit sheet of the window's workspace
        makeMoltentermEditWorkspaceMenuItem((window) => getWindowWebContents(window ?? ww)),
    ];
    function getWorkspaceSwitchAccelerator(i: number): string {
        if (i < 9) {
            return unamePlatform == "darwin" ? `Command+Control+${i + 1}` : `Alt+Control+${i + 1}`;
        }
    }
    if (workspaceList?.length) {
        workspaceMenu.push(
            { type: "separator" },
            ...workspaceList.map<Electron.MenuItemConstructorOptions>((workspace, i) => {
                return {
                    label: `${workspace.workspacedata.name}`,
                    click: (_, window) => {
                        ((window as WaveBrowserWindow) ?? ww)?.switchWorkspace(workspace.workspacedata.oid);
                    },
                    accelerator: getWorkspaceSwitchAccelerator(i),
                };
            })
        );
    }
    return workspaceMenu;
}

function makeEditMenu(fullConfig?: FullConfigType): Electron.MenuItemConstructorOptions[] {
    let pasteAccelerator: string;
    if (unamePlatform === "darwin") {
        pasteAccelerator = "Command+V";
    } else {
        const ctrlVPaste = fullConfig?.settings?.["app:ctrlvpaste"];
        if (ctrlVPaste == null) {
            pasteAccelerator = unamePlatform === "win32" ? "Control+V" : "";
        } else if (ctrlVPaste) {
            pasteAccelerator = "Control+V";
        } else {
            pasteAccelerator = "";
        }
    }
    // MOLTENTERM-PATCH (#623): role items carry their label in the interface language (Electron's follow the bundle's)
    return [
        {
            role: "undo",
            label: mt("appMenu.undo"),
            accelerator: unamePlatform === "darwin" ? "Command+Z" : "",
        },
        {
            role: "redo",
            label: mt("appMenu.redo"),
            accelerator: unamePlatform === "darwin" ? "Command+Shift+Z" : "",
        },
        { type: "separator" },
        {
            role: "cut",
            label: mt("appMenu.cut"),
            accelerator: unamePlatform === "darwin" ? "Command+X" : "",
        },
        {
            role: "copy",
            label: mt("appMenu.copy"),
            accelerator: unamePlatform === "darwin" ? "Command+C" : "",
        },
        {
            role: "paste",
            label: mt("appMenu.paste"),
            accelerator: pasteAccelerator,
        },
        {
            role: "pasteAndMatchStyle",
            label: mt("appMenu.pasteAndMatchStyle"),
            accelerator: unamePlatform === "darwin" ? "Command+Shift+V" : "",
        },
        {
            role: "delete",
            label: mt("appMenu.delete"),
        },
        {
            role: "selectAll",
            label: mt("appMenu.selectAll"),
            accelerator: unamePlatform === "darwin" ? "Command+A" : "",
        },
    ];
}

function makeFileMenu(
    numWaveWindows: number,
    callbacks: AppMenuCallbacks,
    fullConfig: FullConfigType
): Electron.MenuItemConstructorOptions[] {
    const fileMenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: mt("appMenu.newWindow"), // MOLTENTERM-PATCH (#623)
            accelerator: "CommandOrControl+Shift+N",
            click: () => fireAndForget(callbacks.createNewWaveWindow),
        },
        {
            role: "close",
            label: mt("appMenu.closeWindow"), // MOLTENTERM-PATCH (#623)
            accelerator: "",
            click: () => {
                focusedWaveWindow?.close();
            },
        },
    ];
    const featureWaveAppBuilder = fullConfig?.settings?.["feature:waveappbuilder"];
    if (isDev || featureWaveAppBuilder) {
        fileMenu.splice(1, 0, {
            label: mt("appMenu.newBuilderWindow"), // MOLTENTERM-PATCH (#623)
            accelerator: unamePlatform === "darwin" ? "Command+Shift+B" : "Alt+Shift+B",
            click: () => openBuilderWindow(""),
        });
    }
    if (numWaveWindows == 0) {
        fileMenu.push({
            label: "New Window (hidden-1)",
            accelerator: unamePlatform === "darwin" ? "Command+N" : "Alt+N",
            acceleratorWorksWhenHidden: true,
            visible: false,
            click: () => fireAndForget(callbacks.createNewWaveWindow),
        });
        fileMenu.push({
            label: "New Window (hidden-2)",
            accelerator: unamePlatform === "darwin" ? "Command+T" : "Alt+T",
            acceleratorWorksWhenHidden: true,
            visible: false,
            click: () => fireAndForget(callbacks.createNewWaveWindow),
        });
    }
    return fileMenu;
}

function makeAppMenuItems(webContents: electron.WebContents): Electron.MenuItemConstructorOptions[] {
    const appMenuItems: Electron.MenuItemConstructorOptions[] = [
        {
            label: mt("appMenu.about", { app: electron.app.getName() }), // MOLTENTERM-PATCH (#4, #191, #623): the gold's own name
            click: (_, window) => {
                (getWindowWebContents(window) ?? webContents)?.send("menu-item-about");
            },
        },
        makeMoltentermGettingStartedMenuItem((window) => getWindowWebContents(window) ?? webContents), // MOLTENTERM-PATCH (#161)
        // MOLTENTERM-PATCH (#5): no "Check for Updates" item: it polled Wave's
        // update feed even with auto-update disabled.
        { type: "separator" },
        makeMoltentermSafeModeMenuItem(), // MOLTENTERM-PATCH (#20): start without mods to repair them
        { type: "separator" },
    ];
    if (unamePlatform === "darwin") {
        // MOLTENTERM-PATCH (#623): labels in the interface language
        appMenuItems.push(
            { role: "services", label: mt("appMenu.services") },
            { type: "separator" },
            { role: "hide", label: mt("appMenu.hide", { app: electron.app.getName() }) },
            { role: "hideOthers", label: mt("appMenu.hideOthers") },
            { type: "separator" }
        );
    }
    appMenuItems.push({ role: "quit", label: mt("appMenu.quit", { app: electron.app.getName() }) }); // MOLTENTERM-PATCH (#623)
    return appMenuItems;
}

function makeViewMenu(
    webContents: electron.WebContents,
    callbacks: AppMenuCallbacks,
    isBuilderWindowFocused: boolean,
    fullscreenOnLaunch: boolean
): Electron.MenuItemConstructorOptions[] {
    const devToolsAccel = unamePlatform === "darwin" ? "Option+Command+I" : "Alt+Shift+I";
    return [
        {
            label: mt(isBuilderWindowFocused ? "appMenu.reloadWindow" : "appMenu.reloadTab"), // MOLTENTERM-PATCH (#623)
            accelerator: "Shift+CommandOrControl+R",
            click: (_, window) => {
                (getWindowWebContents(window) ?? webContents)?.reloadIgnoringCache();
            },
        },
        {
            label: mt("appMenu.relaunchAllWindows"), // MOLTENTERM-PATCH (#623)
            click: () => callbacks.relaunchBrowserWindows(),
        },
        {
            label: mt("appMenu.clearTabCache"), // MOLTENTERM-PATCH (#623)
            click: () => clearTabCache(),
        },
        {
            label: mt("appMenu.toggleDevTools"), // MOLTENTERM-PATCH (#623)
            accelerator: devToolsAccel,
            click: (_, window) => {
                const wc = getWindowWebContents(window) ?? webContents;
                wc?.toggleDevTools();
            },
        },
        { type: "separator" },
        {
            label: mt("appMenu.resetZoom"), // MOLTENTERM-PATCH (#623)
            accelerator: "CommandOrControl+0",
            click: (_, window) => {
                const wc = getWindowWebContents(window) ?? webContents;
                if (wc) {
                    resetZoomLevel(wc);
                }
            },
        },
        {
            label: mt("appMenu.zoomIn"), // MOLTENTERM-PATCH (#623)
            accelerator: "CommandOrControl+=",
            click: (_, window) => {
                const wc = getWindowWebContents(window) ?? webContents;
                if (wc) {
                    increaseZoomLevel(wc);
                }
            },
        },
        {
            label: "Zoom In (hidden)",
            accelerator: "CommandOrControl+Shift+=",
            click: (_, window) => {
                const wc = getWindowWebContents(window) ?? webContents;
                if (wc) {
                    increaseZoomLevel(wc);
                }
            },
            visible: false,
            acceleratorWorksWhenHidden: true,
        },
        {
            label: mt("appMenu.zoomOut"), // MOLTENTERM-PATCH (#623)
            accelerator: "CommandOrControl+-",
            click: (_, window) => {
                const wc = getWindowWebContents(window) ?? webContents;
                if (wc) {
                    decreaseZoomLevel(wc);
                }
            },
        },
        {
            label: "Zoom Out (hidden)",
            accelerator: "CommandOrControl+Shift+-",
            click: (_, window) => {
                const wc = getWindowWebContents(window) ?? webContents;
                if (wc) {
                    decreaseZoomLevel(wc);
                }
            },
            visible: false,
            acceleratorWorksWhenHidden: true,
        },
        {
            label: mt("appMenu.fullScreenOnLaunch"), // MOLTENTERM-PATCH (#623)
            submenu: [
                {
                    label: mt("common.on"), // MOLTENTERM-PATCH (#623)
                    type: "radio",
                    checked: fullscreenOnLaunch,
                    click: () => {
                        RpcApi.SetConfigCommand(ElectronWshClient, { "window:fullscreenonlaunch": true });
                    },
                },
                {
                    label: mt("common.off"), // MOLTENTERM-PATCH (#623)
                    type: "radio",
                    checked: !fullscreenOnLaunch,
                    click: () => {
                        RpcApi.SetConfigCommand(ElectronWshClient, { "window:fullscreenonlaunch": false });
                    },
                },
            ],
        },
        { type: "separator" },
        {
            role: "togglefullscreen",
        },
        { type: "separator" },
        {
            label: mt("appMenu.toggleWidgetsBar"), // MOLTENTERM-PATCH (#623)
            click: () => {
                fireAndForget(async () => {
                    const workspaceId = focusedWaveWindow?.workspaceId;
                    if (!workspaceId) return;
                    const oref = `workspace:${workspaceId}`;
                    const meta = await RpcApi.GetMetaCommand(ElectronWshClient, { oref });
                    const current = meta?.["layout:widgetsvisible"] ?? true;
                    await RpcApi.SetMetaCommand(ElectronWshClient, {
                        oref,
                        meta: { "layout:widgetsvisible": !current },
                    });
                });
            },
        },
    ];
}

async function makeFullAppMenu(callbacks: AppMenuCallbacks, workspaceOrBuilderId?: string): Promise<Electron.Menu> {
    const numWaveWindows = getAllWaveWindows().length;
    const webContents = workspaceOrBuilderId && getWebContentsByWorkspaceOrBuilderId(workspaceOrBuilderId);
    const appMenuItems = makeAppMenuItems(webContents);

    const isBuilderWindowFocused = focusedBuilderWindow != null;
    let fullscreenOnLaunch = false;
    let fullConfig: FullConfigType = null;
    try {
        fullConfig = await RpcApi.GetFullConfigCommand(ElectronWshClient);
        fullscreenOnLaunch = fullConfig?.settings["window:fullscreenonlaunch"];
    } catch (e) {
        console.error("Error fetching config:", e);
    }
    const editMenu = makeEditMenu(fullConfig);
    const fileMenu = makeFileMenu(numWaveWindows, callbacks, fullConfig);
    const viewMenu = makeViewMenu(webContents, callbacks, isBuilderWindowFocused, fullscreenOnLaunch);
    let workspaceMenu: Electron.MenuItemConstructorOptions[] = null;
    try {
        workspaceMenu = await getWorkspaceMenu();
    } catch (e) {
        console.error("getWorkspaceMenu error:", e);
    }
    // MOLTENTERM-PATCH (#623): the menus' titles and role items in the interface language
    const windowMenu: Electron.MenuItemConstructorOptions[] = [
        { role: "minimize", label: mt("appMenu.minimize"), accelerator: "" },
        { role: "zoom", label: mt("appMenu.zoom") },
        { type: "separator" },
        { role: "front", label: mt("appMenu.front") },
    ];
    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        { role: "appMenu", submenu: appMenuItems },
        { role: "fileMenu", label: mt("appMenu.file"), submenu: fileMenu },
        { role: "editMenu", label: mt("appMenu.edit"), submenu: editMenu },
        { role: "viewMenu", label: mt("appMenu.view"), submenu: viewMenu },
    ];
    if (workspaceMenu != null && !isBuilderWindowFocused) {
        menuTemplate.push({
            label: mt("appMenu.workspace"), // MOLTENTERM-PATCH (#623)
            id: "workspace-menu",
            submenu: workspaceMenu,
        });
    }
    menuTemplate.push({
        role: "windowMenu",
        label: mt("appMenu.window"), // MOLTENTERM-PATCH (#623)
        submenu: windowMenu,
    });
    return electron.Menu.buildFromTemplate(menuTemplate);
}

export function instantiateAppMenu(workspaceOrBuilderId?: string): Promise<electron.Menu> {
    return makeFullAppMenu(
        {
            createNewWaveWindow,
            relaunchBrowserWindows,
        },
        workspaceOrBuilderId
    );
}

// does not a set a menu on windows
export function makeAndSetAppMenu() {
    if (unamePlatform === "win32") {
        return;
    }
    fireAndForget(async () => {
        const menu = await instantiateAppMenu();
        electron.Menu.setApplicationMenu(menu);
    });
}

function initMenuEventSubscriptions() {
    waveEventSubscribeSingle({
        eventType: "workspace:update",
        handler: makeAndSetAppMenu,
    });
}

function getWebContentsByWorkspaceOrBuilderId(workspaceOrBuilderId: string): electron.WebContents {
    const ww = getWaveWindowByWorkspaceId(workspaceOrBuilderId);
    if (ww) {
        return ww.activeTabView?.webContents;
    }

    const bw = getBuilderWindowById(workspaceOrBuilderId);
    if (bw) {
        return bw.webContents;
    }

    return null;
}

function convertMenuDefArrToMenu(
    webContents: electron.WebContents,
    menuDefArr: ElectronContextMenuItem[],
    menuState: { hasClick: boolean; token?: string; target?: string; active: boolean }
): electron.Menu {
    const menuItems: electron.MenuItem[] = [];
    for (const menuDef of menuDefArr) {
        const menuItemTemplate: electron.MenuItemConstructorOptions = {
            // MOLTENTERM-PATCH (#623): an edit role's label in the interface language
            label:
                menuDef.label ??
                (MenuRoleKeys[menuDef.role] ? mt(MenuRoleKeys[menuDef.role]) : MenuRoleLabels[menuDef.role]),
            type: menuDef.type === "header" ? "normal" : menuDef.type,
            visible: menuDef.visible,
            click: () => {
                if (!menuState.active || !contextMenuTargetLive(webContents, menuState.target)) return;
                if (menuDef.role && !executeCapturedContextMenuRole(webContents, menuState.target, menuDef.role))
                    return;
                menuState.hasClick = true;
                webContents.send("contextmenu-click", menuDef.id, menuState.token);
            },
            checked: menuDef.checked,
            enabled:
                menuDef.type === "header" || (menuDef.role && !contextMenuRole(menuDef.role)) ? false : menuDef.enabled,
        };
        // MOLTENTERM-PATCH (#370): the shortcut is shown, never registered: the renderer's key model handles it
        if (typeof menuDef.accelerator === "string" && /^[A-Za-z0-9+\-=[\]\\;',./`]{1,40}$/.test(menuDef.accelerator)) {
            menuItemTemplate.accelerator = menuDef.accelerator;
            menuItemTemplate.registerAccelerator = false;
        }
        if (menuDef.submenu != null) {
            menuItemTemplate.submenu = convertMenuDefArrToMenu(webContents, menuDef.submenu, menuState);
        }
        const menuItem = new electron.MenuItem(menuItemTemplate);
        menuItems.push(menuItem);
    }
    return electron.Menu.buildFromTemplate(menuItems);
}

const nativeContextMenus = new Map<number, () => void>(); // MOLTENTERM-PATCH (#371): retire native popups on replacement/lifecycle changes.
electron.ipcMain.on(
    "contextmenu-show",
    (event, workspaceOrBuilderId: string, menuDefArr: ElectronContextMenuItem[], token?: string, target?: string) => {
        // MOLTENTERM-PATCH (#371): the sender, not a renderer-supplied workspace, owns this request.
        const webContents = liveContextMenuHost(event.sender) ? event.sender : null;
        if (!webContents) {
            console.error("invalid window for context menu:", workspaceOrBuilderId);
            event.returnValue = true;
            return;
        }
        nativeContextMenus.get(webContents.id)?.();
        if (!contextMenuTargetLive(webContents, target) || menuDefArr.length === 0) {
            webContents.send("contextmenu-click", null, token);
            event.returnValue = true;
            return;
        }
        fireAndForget(async () => {
            const menuState = { hasClick: false, token, target, active: true };
            const menu = convertMenuDefArrToMenu(webContents, menuDefArr, menuState);
            const window = contextMenuWindow(webContents);
            const cleanup = () => {
                menuState.active = false;
                if (nativeContextMenus.get(webContents.id) === retire) nativeContextMenus.delete(webContents.id);
                window.removeListener("blur", retire);
                ContextMenuEvents.removeListener("revoke", revoke);
                webContents.removeListener("did-start-navigation", retire);
                webContents.removeListener("destroyed", retire);
            };
            const retire = () => {
                cleanup();
                menu.closePopup(window);
            };
            const revoke = (host: electron.WebContents, lease: string) => {
                if (host === webContents && lease === target) retire();
            };
            nativeContextMenus.set(webContents.id, retire);
            window.on("blur", retire);
            ContextMenuEvents.on("revoke", revoke);
            webContents.on("did-start-navigation", retire);
            webContents.once("destroyed", retire);
            menu.popup({
                window,
                callback: () => {
                    cleanup();
                    if (!menuState.hasClick && !webContents.isDestroyed()) {
                        webContents.send("contextmenu-click", null, token);
                    }
                },
            });
        });
        event.returnValue = true;
    }
);

electron.ipcMain.on("workspace-appmenu-show", (event, workspaceId: string) => {
    fireAndForget(async () => {
        const webContents = getWebContentsByWorkspaceOrBuilderId(workspaceId);
        if (!webContents) {
            console.error("invalid window for workspace app menu:", workspaceId);
            return;
        }
        const menu = await instantiateAppMenu(workspaceId);
        menu.popup();
    });
    event.returnValue = true;
});

electron.ipcMain.on("builder-appmenu-show", (event, builderId: string) => {
    fireAndForget(async () => {
        const webContents = getWebContentsByWorkspaceOrBuilderId(builderId);
        if (!webContents) {
            console.error("invalid window for builder app menu:", builderId);
            return;
        }
        const menu = await instantiateAppMenu(builderId);
        menu.popup();
    });
    event.returnValue = true;
});

// MOLTENTERM-PATCH (#623): built on each call, in the interface language; the app and dock menus are rebuilt when it changes
function makeDockMenu(): electron.Menu {
    return electron.Menu.buildFromTemplate([
        {
            label: mt("appMenu.newWindow"),
            click() {
                fireAndForget(createNewWaveWindow);
            },
        },
    ]);
}

function makeDockTaskbar() {
    if (unamePlatform == "darwin") {
        electron.app.dock.setMenu(makeDockMenu());
    }
}

onMainLocaleChange(() => {
    makeAndSetAppMenu();
    makeDockTaskbar();
});

export { initMenuEventSubscriptions, makeDockTaskbar };
