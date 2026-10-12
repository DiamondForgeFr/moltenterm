// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Background test mode (#495). Test instances that agents launch (AI Testing runs, the perf harness) must never take
// the keyboard focus or cover the user's work: on macOS, BaseWindow.show() and focus(), and webContents.focus(),
// activate the application. With MOLTENTERM_BACKGROUND=1 (never on by default) the instance:
// - runs with the "accessory" activation policy on macOS: no Dock icon, no menu bar, never the active app on its own;
// - shows every window with showInactive(), parked in a corner of the screen (see park), above the other windows
//   without being key, transparent and click-through;
// - turns every window focus into a virtual one: the window the app asked to focus reports isFocused(), is returned
//   by getFocusedWindow() and gets its "focus" event (the previous one its "blur"), so everything that follows the
//   focus (the focused window of the backend, the tab activity model, the paint check of #461) behaves as if the
//   focus had moved, while the OS focus stays with the user's app.
// The methods are replaced on the prototypes rather than at each call site: every show and focus of Wave's code, of
// MoltenTerm's and of Electron's own helpers goes through them, including paths added later, with no patch in Wave's
// files beyond the install call.

import { app, BaseWindow, BrowserWindow, screen } from "electron";

export const BackgroundModeEnv = "MOLTENTERM_BACKGROUND";

// How much of a parked window stays on screen, from the bottom-right corner of the primary display's work area. A
// window entirely covered counts as occluded on macOS (its pages go "hidden" and stop drawing), and macOS keeps at
// least a strip of a window on screen anyway (#495).
export const BackgroundVisiblePx = { width: 160, height: 120 };

type Rect = { x: number; y: number; width: number; height: number };

export function isBackgroundMode(env: Record<string, string | undefined> = process.env): boolean {
    return env[BackgroundModeEnv] === "1";
}

// The window keeps its size (pages lay out and draw as they would in the user's window), only its position changes.
export function backgroundPlacement(workArea: Rect, bounds: Rect, visible = BackgroundVisiblePx): Rect {
    const width = Math.max(1, bounds.width);
    const height = Math.max(1, bounds.height);
    return {
        x: workArea.x + workArea.width - Math.min(visible.width, width),
        y: workArea.y + workArea.height - Math.min(visible.height, height),
        width,
        height,
    };
}

export type FocusableWindow = {
    isDestroyed(): boolean;
    emit(event: string, ...args: any[]): boolean;
};

// Which window the app last focused, as the OS would have it had the focus moved.
export class VirtualFocus<W extends FocusableWindow> {
    current: W = null;

    get(): W {
        if (this.current != null && this.current.isDestroyed()) {
            this.current = null;
        }
        return this.current;
    }

    is(win: W): boolean {
        return win != null && this.get() === win;
    }

    focus(win: W) {
        if (win == null || win.isDestroyed()) {
            return;
        }
        const prev = this.get();
        if (prev === win) {
            return;
        }
        this.current = win;
        if (prev != null) {
            prev.emit("blur");
        }
        win.emit("focus");
    }

    blur(win: W) {
        if (!this.is(win)) {
            return;
        }
        this.current = null;
        if (!win.isDestroyed()) {
            win.emit("blur");
        }
    }

    forget(win: W) {
        if (this.current === win) {
            this.current = null;
        }
    }
}

type WindowProto = {
    show(): void;
    showInactive(): void;
    focus(): void;
    blur(): void;
    hide(): void;
    minimize(): void;
    isFocused(): boolean;
    isVisible(): boolean;
    isMinimized(): boolean;
    isDestroyed(): boolean;
    getBounds(): Rect;
    setBounds(bounds: Partial<Rect>): void;
    setAlwaysOnTop(flag: boolean, level?: string): void;
    setVisibleOnAllWorkspaces(visible: boolean, options?: object): void;
    setOpacity(opacity: number): void;
    setIgnoreMouseEvents(ignore: boolean): void;
    once(event: string, listener: () => void): unknown;
    emit(event: string, ...args: any[]): boolean;
};

const focus = new VirtualFocus<WindowProto>();
const parked = new WeakSet<WindowProto>();
let installed = false;

export function getVirtualFocus(): VirtualFocus<FocusableWindow> {
    return focus;
}

function park(win: WindowProto) {
    if (parked.has(win)) {
        return;
    }
    parked.add(win);
    win.setBounds(backgroundPlacement(screen.getPrimaryDisplay().workArea, win.getBounds()));
    // Above the other windows without being key, on every Space (a full-screen app included), so the user's windows
    // never cover the test page: covered, it would go "hidden" and stop drawing. Transparent and click-through, so the
    // corner it floats over stays the user's; macOS still counts it as visible and Chromium still draws it.
    win.setAlwaysOnTop(true, "floating");
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    win.setOpacity(0);
    win.setIgnoreMouseEvents(true);
    win.once("closed", () => focus.forget(win));
}

function showInBackground(win: WindowProto, showInactive: () => void) {
    park(win);
    if (win.isMinimized() || !win.isVisible()) {
        showInactive();
    }
}

function patchWindowPrototype(proto: WindowProto) {
    const orig = {
        showInactive: proto.showInactive,
        hide: proto.hide,
        minimize: proto.minimize,
        isFocused: proto.isFocused,
    };
    proto.show = function (this: WindowProto) {
        showInBackground(this, () => orig.showInactive.call(this));
        focus.focus(this);
    };
    proto.showInactive = function (this: WindowProto) {
        showInBackground(this, () => orig.showInactive.call(this));
    };
    proto.focus = function (this: WindowProto) {
        showInBackground(this, () => orig.showInactive.call(this));
        focus.focus(this);
    };
    proto.blur = function (this: WindowProto) {
        focus.blur(this);
    };
    proto.hide = function (this: WindowProto) {
        focus.blur(this);
        orig.hide.call(this);
    };
    proto.minimize = function (this: WindowProto) {
        focus.blur(this);
        orig.minimize.call(this);
    };
    // The user may still click a parked window: then it is really focused.
    proto.isFocused = function (this: WindowProto) {
        return focus.is(this) || orig.isFocused.call(this);
    };
}

function patchOwn(target: any, names: string[], patch: (proto: any) => void) {
    if (names.some((name) => Object.prototype.hasOwnProperty.call(target, name))) {
        patch(target);
    }
}

// Focusing a page focuses its window too on macOS (Electron's WebContents::Focus), which activates the app. In the
// mode a page only takes the keyboard while its window really is key (the user clicked it); agents drive pages
// through CDP, which delivers input to a page whatever the OS focus.
function patchWebContents(proto: any) {
    if (proto == null || patchedWebContents.has(proto)) {
        return;
    }
    patchedWebContents.add(proto);
    const origFocus = proto.focus;
    proto.focus = function (this: Electron.WebContents) {
        const owner = ownerWindowOf(this);
        if (owner != null && origIsFocused.call(owner)) {
            origFocus.call(this);
        }
    };
}

const patchedWebContents = new WeakSet<object>();
let origIsFocused: (this: BaseWindow) => boolean = null;

function ownerWindowOf(wc: Electron.WebContents): BaseWindow {
    return BaseWindow.getAllWindows().find(
        (w) =>
            !w.isDestroyed() &&
            ((w instanceof BrowserWindow && w.webContents === wc) ||
                w.contentView.children.some((v: any) => v.webContents === wc))
    );
}

// Called once, first thing in appMain (before the app is ready and before any window). Does nothing without the
// variable.
export function installBackgroundMode(): boolean {
    if (installed || !isBackgroundMode()) {
        return false;
    }
    installed = true;
    console.log(`[#495] background test mode (${BackgroundModeEnv}=1): windows never take the focus`);
    if (process.platform === "darwin") {
        app.setActivationPolicy("accessory");
    }
    origIsFocused = BaseWindow.prototype.isFocused;
    const names = ["show", "showInactive", "focus", "blur", "hide", "minimize", "isFocused"];
    patchWindowPrototype(BaseWindow.prototype as unknown as WindowProto);
    patchOwn(BrowserWindow.prototype, names, (p) => patchWindowPrototype(p));
    const getFocused = () => (focus.get() as unknown as BaseWindow) ?? null;
    BaseWindow.getFocusedWindow = getFocused;
    BrowserWindow.getFocusedWindow = () => {
        const win = getFocused();
        return win instanceof BrowserWindow ? win : null;
    };
    app.focus = () => {};
    app.on("web-contents-created", (_e, wc) => patchWebContents(Object.getPrototypeOf(wc)));
    return true;
}
