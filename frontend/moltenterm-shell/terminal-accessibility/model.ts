// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { getApi, getSettingsKeyAtom, globalStore } from "@/app/store/global";
import { Terminal } from "@xterm/xterm";
import { I18nModel, t } from "../i18n/i18n";
import { AccessibilitySource, bindScreenReader, screenReaderEnabled, ScreenReaderSetting } from "./screen-reader";

let source: AccessibilitySource;
function getSource(): AccessibilitySource {
    source ??= new AccessibilitySource(getApi());
    return source;
}

export function terminalScreenReaderEnabled(): boolean {
    return screenReaderEnabled(globalStore.get(getSettingsKeyAtom(ScreenReaderSetting)), getSource().get());
}

export function localizeTerminalAccessibility(terminal?: Terminal) {
    Terminal.strings.promptLabel = t("terminalAccessibility.input");
    Terminal.strings.tooMuchOutput = t("terminalAccessibility.tooMuchOutput");
    terminal?.textarea?.setAttribute("aria-label", Terminal.strings.promptLabel);
}

export function bindTerminalAccessibility(terminal: Terminal): () => void {
    const disposeMode = bindScreenReader(terminal, terminalScreenReaderEnabled, (update) => {
        const disposeNative = getSource().subscribe(update);
        const disposeSetting = globalStore.sub(getSettingsKeyAtom(ScreenReaderSetting), update);
        return () => {
            disposeNative();
            disposeSetting();
        };
    });
    let disposed = false;
    const disposeLocale = I18nModel.getInstance().onLocaleChange(() => {
        if (!disposed) localizeTerminalAccessibility(terminal);
    });
    localizeTerminalAccessibility(terminal);
    return () => {
        disposed = true;
        disposeMode();
        disposeLocale();
    };
}
