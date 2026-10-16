// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The window title, "MoltenTerm - <tab>": the tab view's document title, which Electron shows on the window. A Project
// tab is named in the interface language, so the title follows a language change (#741).

import { MoltentermWindowTitle } from "@/util/moltenterm-identity";
import { I18nModel } from "./i18n/i18n";
import { tabShownName } from "./project/project-model";

let titleTab: Tab = null;
let stopListening: () => void = null;

function applyTitle() {
    document.title = `${MoltentermWindowTitle} - ${tabShownName(titleTab)}`;
}

export function setWindowTitleTab(tab: Tab) {
    titleTab = tab;
    applyTitle();
    if (stopListening == null) {
        stopListening = I18nModel.getInstance().onLocaleChange(() => applyTitle());
    }
}
