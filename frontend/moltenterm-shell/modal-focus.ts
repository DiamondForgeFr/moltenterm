// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { modalIsOpen } from "./modal-open";

const ModalSelector = '[role="dialog"][aria-modal="true"], [role="alertdialog"][aria-modal="true"]';
const FocusableSelector = 'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]';
const ActiveDialogs = new Map<HTMLElement, { last: HTMLElement; invoker: HTMLElement[] }>();

function available(el: HTMLElement): boolean {
    return (
        el?.isConnected &&
        !el.matches(":disabled") &&
        el.closest('[hidden], [inert], [aria-hidden="true"]') == null &&
        el.getClientRects().length > 0 &&
        !["hidden", "collapse"].includes(getComputedStyle(el).visibility)
    );
}

export function topModal(): HTMLElement {
    return Array.from(document.querySelectorAll<HTMLElement>(ModalSelector)).filter(available).at(-1) ?? null;
}

// Inline confirmations use Escape only without a modal; custom modal callers name the surface that owns their answer.
export function modalOwnsKeys(role?: string | string[]): boolean {
    const top = topModal();
    if (role == null) {
        return !modalIsOpen();
    }
    if (top == null) {
        return false;
    }
    const roles = Array.isArray(role) ? role : [role];
    return roles.includes(top.closest<HTMLElement>("[data-role]")?.dataset.role);
}

function tabStops(dialog: HTMLElement): HTMLElement[] {
    return Array.from(dialog.querySelectorAll<HTMLElement>(FocusableSelector))
        .filter((el) => el.tabIndex >= 0 && available(el) && el.closest(ModalSelector) === dialog)
        .sort((a, b) => (a.tabIndex || Infinity) - (b.tabIndex || Infinity));
}

function focus(el: HTMLElement) {
    el.focus({ preventScroll: true });
}

function focusInside(dialog: HTMLElement, preferred?: HTMLElement) {
    if (preferred && dialog.contains(preferred) && available(preferred)) {
        focus(preferred);
        return;
    }
    const remembered = ActiveDialogs.get(dialog)?.last;
    const buttons = dialog.querySelector<HTMLElement>("[data-dialog-buttons]");
    const firstButton = buttons && tabStops(dialog).find((el) => buttons.contains(el));
    focus((remembered && available(remembered) ? remembered : null) ?? firstButton ?? tabStops(dialog)[0] ?? dialog);
}

// Read before React commits descendants' autoFocus. Keep ancestors too: a successful close may remove the invoker.
export function captureModalInvoker(): HTMLElement[] {
    const path: HTMLElement[] = [];
    if (typeof document === "undefined") {
        return path;
    }
    let el = document.activeElement as HTMLElement;
    while (el && el !== document.body) {
        path.push(el);
        el = el.parentElement;
    }
    const modal = path.find((owner) => ActiveDialogs.has(owner));
    if (modal) {
        path.push(...ActiveDialogs.get(modal).invoker.filter((owner) => !path.includes(owner)));
    }
    return path;
}

function restoreFocus(invoker: HTMLElement[]) {
    const top = topModal();
    if (top) {
        if (!top.contains(document.activeElement)) {
            focusInside(top, invoker[0]);
        }
        return;
    }
    for (const owner of invoker) {
        if (!available(owner)) {
            continue;
        }
        const target = owner.matches(FocusableSelector)
            ? owner
            : Array.from(owner.querySelectorAll<HTMLElement>(FocusableSelector)).find(
                  (el) => el.tabIndex >= 0 && available(el)
              );
        if (target) {
            focus(target);
            return;
        }
    }
    // The whole invoking pane can disappear. Its surviving app landmark is the final keyboard destination.
    const main = document.querySelector<HTMLElement>('main, [role="main"], #main') ?? document.body;
    if (!main.hasAttribute("tabindex")) {
        main.tabIndex = -1;
    }
    focus(main);
}

// Tab and Shift+Tab stay inside the dialog (NFR-SHELL-014): aria-modal alone does not keep the keyboard in it.
export function containModalFocus(dialog: HTMLElement, invoker: HTMLElement[]): () => void {
    const record = { last: null as HTMLElement, invoker };
    ActiveDialogs.set(dialog, record);
    const ensureFocus = () => {
        if (topModal() !== dialog) {
            return;
        }
        const current = document.activeElement as HTMLElement;
        if (dialog.contains(current) && available(current)) {
            record.last = current;
        } else {
            focusInside(dialog);
        }
    };
    const onFocus = () => ensureFocus();
    const onKey = (e: KeyboardEvent) => {
        if (e.key !== "Tab" || topModal() !== dialog) {
            return;
        }
        const stops = tabStops(dialog);
        const index = stops.indexOf(document.activeElement as HTMLElement);
        e.preventDefault();
        // Handle the whole sequence so positive tabindex or the focused fallback cannot escape its bounds.
        const next = index < 0
            ? e.shiftKey ? stops.length - 1 : 0
            : (index + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        focus(stops[next] ?? dialog);
    };
    document.addEventListener("focusin", onFocus, true);
    document.addEventListener("keydown", onKey, true);
    const observer = new MutationObserver(ensureFocus);
    observer.observe(dialog, {
        subtree: true,
        childList: true,
        attributes: true,
        attributeFilter: ["disabled", "hidden", "inert", "style", "class", "tabindex", "aria-hidden"],
    });
    ensureFocus();
    return () => {
        observer.disconnect();
        document.removeEventListener("focusin", onFocus, true);
        document.removeEventListener("keydown", onKey, true);
        ActiveDialogs.delete(dialog);
        // React removes portals after layout cleanup. A replacement modal mounted in that commit takes precedence.
        queueMicrotask(() => {
            if (!ActiveDialogs.has(dialog)) {
                restoreFocus(invoker);
            }
        });
    };
}
