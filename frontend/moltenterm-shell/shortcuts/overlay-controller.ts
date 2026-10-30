// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The shortcut overlay's state (FR-SHELL-090, DS-SHELL-129): closed, held (shown while ⌘ is held, gone on release) or
// pinned (⌘/, gone on Escape, a click, ⌘/ or any other shortcut, which still runs). Only this small module loads at
// startup; the overlay itself (shortcut-overlay.tsx) is imported the first time it shows.

import * as keyutil from "@/util/keyutil";
import { isMacOS } from "@/util/platformutil";
import { modalIsOpen } from "../modal-open";
import { HoldDetector, holdKeyFor, isModifierKey } from "./overlay-hold";
import { ShortcutsSheetAltKey, ShortcutsSheetKey } from "./registry";

export type OverlayMode = "closed" | "held" | "pinned";

// The mounted overlay, as the lazy module hands it back.
export type OverlayView = {
    setMode: (mode: OverlayMode) => void;
    close: () => void;
    contains: (node: Node) => boolean;
};

export const OverlayRootId = "mt-shortcut-overlay";

type OverlayLoader = () => Promise<{ mountShortcutOverlay: (ctl: OverlayController) => OverlayView }>;

const DefaultLoader: OverlayLoader = () => import("./shortcut-overlay");

export function isOverlayToggleKey(e: WaveKeyboardEvent): boolean {
    return keyutil.checkKeyPressed(e, ShortcutsSheetKey) || keyutil.checkKeyPressed(e, ShortcutsSheetAltKey);
}

export class OverlayController {
    mode: OverlayMode = "closed";
    view: OverlayView = null;
    loading: Promise<void> = null;
    loader: OverlayLoader;
    hold: HoldDetector;
    // Whether the overlay may open now (no dialog up).
    canOpen: () => boolean;

    constructor(opts: { mac?: boolean; loader?: OverlayLoader; canOpen?: () => boolean; isFocused?: () => boolean } = {}) {
        this.loader = opts.loader ?? DefaultLoader;
        this.canOpen = opts.canOpen ?? (() => !modalIsOpen());
        this.hold = new HoldDetector({
            holdKey: holdKeyFor(opts.mac ?? isMacOS()),
            isFocused: opts.isFocused,
            onShow: () => this.show("held"),
            onHide: () => {
                if (this.mode === "held") {
                    this.close();
                }
            },
        });
    }

    show(mode: OverlayMode) {
        if (mode === "closed") {
            this.close();
            return;
        }
        if (this.mode === "closed" && !this.canOpen()) {
            return;
        }
        this.mode = mode;
        if (this.view != null) {
            this.view.setMode(mode);
            return;
        }
        if (this.loading != null) {
            return;
        }
        this.loading = this.loader()
            .then((mod) => {
                this.view = mod.mountShortcutOverlay(this);
                this.view.setMode(this.mode);
            })
            .catch((e) => console.log("shortcut overlay failed to load", e))
            .finally(() => {
                this.loading = null;
            });
    }

    close() {
        if (this.mode === "closed") {
            return;
        }
        this.mode = "closed";
        this.view?.setMode("closed");
    }

    // ⌘/: shows the overlay until closed; over a held overlay it keeps it after the release.
    toggle() {
        if (this.mode === "pinned") {
            this.close();
            return;
        }
        this.show("pinned");
    }

    // Every key of the window, and the notices of a focused web page. Returns true when the key was for the overlay
    // alone (Escape closing it), so the caller swallows it.
    key(e: WaveKeyboardEvent): boolean {
        this.hold.key(e);
        if (this.mode === "closed" || e.type !== "keydown" || isModifierKey(e.key)) {
            return false;
        }
        if (isOverlayToggleKey(e)) {
            return false;
        }
        this.close();
        return e.key === "Escape";
    }

    pointer(target: Node) {
        this.hold.pointer();
        if (this.mode === "closed" || (target != null && this.view?.contains(target))) {
            return;
        }
        this.close();
    }

    blur() {
        this.hold.blur();
    }

    focus() {
        this.hold.focus();
    }
}

let controller: OverlayController = null;
let installed = false;

export function getOverlayController(): OverlayController {
    if (controller == null) {
        controller = new OverlayController();
    }
    return controller;
}

// Once per window, from the key model's registration: the capture listeners and the web page notices.
export function installShortcutOverlay() {
    if (typeof document === "undefined" || installed) {
        return;
    }
    installed = true;
    const ctl = getOverlayController();
    document.addEventListener(
        "keydown",
        (e) => {
            if (ctl.key(keyutil.adaptFromReactOrNativeKeyEvent(e))) {
                e.preventDefault();
                e.stopPropagation();
            }
        },
        true
    );
    document.addEventListener("keyup", (e) => ctl.key(keyutil.adaptFromReactOrNativeKeyEvent(e)), true);
    document.addEventListener("pointerdown", (e) => ctl.pointer(e.target as Node), true);
    window.addEventListener("blur", () => ctl.blur());
    window.addEventListener("focus", () => ctl.focus());
    (window as { api?: ElectronApi }).api?.onMoltentermKeyNotice?.((e) => ctl.key(e));
}
