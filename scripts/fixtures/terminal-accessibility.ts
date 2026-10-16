// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { Terminal } from "@xterm/xterm";
import { I18nModel } from "../../frontend/moltenterm-shell/i18n/i18n";
import {
    bindTerminalAccessibility,
    localizeTerminalAccessibility,
    terminalScreenReaderEnabled,
} from "../../frontend/moltenterm-shell/terminal-accessibility/model";
import { globalStore, preferenceAtom, setNative, subscriptions } from "./terminal-accessibility-global";

function check(condition: unknown, message: string) {
    if (!condition) throw new Error(message);
}

Object.assign(globalThis, {
    runTerminalAccessibilityChecks: async () => {
        document.body.innerHTML = '<main><div id="terminal"></div><button id="outside">After terminal</button></main>';
        const host = document.querySelector<HTMLDivElement>("#terminal");
        globalStore.set(preferenceAtom, "auto");
        setNative(true);
        I18nModel.getInstance().setLanguageSetting("en");
        localizeTerminalAccessibility();
        const terminal = new Terminal({ cols: 60, rows: 12, screenReaderMode: terminalScreenReaderEnabled() });
        terminal.open(host);
        const dispose = bindTerminalAccessibility(terminal);
        const textarea = terminal.textarea;
        terminal.focus();
        check(
            terminal.options.screenReaderMode && host.querySelector(".xterm-accessibility"),
            "automatic native detection missing on new terminal"
        );
        await new Promise<void>((resolve) => terminal.write("retained output\r\nsecond line", resolve));
        const buffer = terminal.buffer.active;
        const input: string[] = [];
        terminal.onData((data) => input.push(data));
        for (const [preference, expected] of [
            ["off", false],
            ["on", true],
            ["auto", true],
        ] as const) {
            globalStore.set(preferenceAtom, preference);
            check(terminal.options.screenReaderMode === expected, `${preference} did not apply live`);
            check(
                Boolean(host.querySelector(".xterm-accessibility")) === expected,
                `${preference} accessible DOM incorrect`
            );
            check(
                terminal.textarea === textarea && terminal.buffer.active === buffer,
                "terminal input or buffer recreated"
            );
            check(buffer.getLine(0).translateToString(true) === "retained output", "buffer output lost");
            check(document.activeElement === textarea, "focus moved during accessibility update");
        }
        setNative(false);
        check(!terminal.options.screenReaderMode, "automatic mode ignored native change");
        globalStore.set(preferenceAtom, "on");
        setNative(false);
        check(terminal.options.screenReaderMode, "explicit On lost to detection");
        globalStore.set(preferenceAtom, "off");
        setNative(true);
        check(!terminal.options.screenReaderMode, "explicit Off lost to detection");
        globalStore.set(preferenceAtom, "auto");
        I18nModel.getInstance().setLanguageSetting("fr");
        check(textarea.getAttribute("aria-label") === "Saisie du terminal", "live French terminal label missing");
        check(Terminal.strings.tooMuchOutput.startsWith("Trop de texte"), "overflow announcement not localized");
        terminal.input("echo accessible\r", true);
        check(input.join("") === "echo accessible\r", "input callback changed or duplicated");
        await new Promise<void>((resolve) => {
            const observer = new MutationObserver(verify);
            function verify() {
                if (host.querySelector(".xterm-accessibility")?.textContent?.includes("retained output")) {
                    observer.disconnect();
                    resolve();
                }
            }
            observer.observe(host, { subtree: true, childList: true, characterData: true });
            verify();
        });
        document.querySelector<HTMLButtonElement>("#outside").focus();
        check(document.activeElement?.id === "outside", "cannot move focus to application controls");
        const listenerCount = I18nModel.getInstance().listeners.size;
        dispose();
        check(I18nModel.getInstance().listeners.size === listenerCount - 1, "locale listener leaked");
        const frozenMode = terminal.options.screenReaderMode;
        globalStore.set(preferenceAtom, "off");
        setNative(false);
        check(terminal.options.screenReaderMode === frozenMode, "disposed binding changed terminal");
        terminal.dispose();
        localizeTerminalAccessibility();
        const next = new Terminal({ cols: 60, rows: 12, screenReaderMode: terminalScreenReaderEnabled() });
        next.open(host);
        const disposeNext = bindTerminalAccessibility(next);
        check(
            !next.options.screenReaderMode && !host.querySelector(".xterm-accessibility"),
            "Off did not apply to new terminal"
        );
        check(subscriptions === 1, "native bridge subscribed more than once across terminal remount");
        disposeNext();
        next.dispose();
        return { checks: 18, nativeSubscriptions: subscriptions };
    },
});
