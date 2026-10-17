// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { initGlobalAtoms } from "@/app/store/global-atoms";
import { GlobalModel } from "@/app/store/global-model";
import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { createRoot } from "react-dom/client";
import { PreviewClientId, PreviewTabId, PreviewWindowId } from "../mock/mockwaveenv";
import { installPreviewElectronApi } from "../mock/preview-electron-api";
import { SettingsSliderPreview } from "./settings-slider.preview";

installPreviewElectronApi();
const initOpts = {
    tabId: PreviewTabId,
    windowId: PreviewWindowId,
    clientId: PreviewClientId,
    environment: "renderer",
    platform: "darwin",
    isPreview: true,
} as GlobalInitOptions;
initGlobalAtoms(initOpts);
GlobalModel.getInstance().initialize(initOpts);
createRoot(document.getElementById("main")).render(
    <Provider store={globalStore}>
        <SettingsSliderPreview />
    </Provider>
);
