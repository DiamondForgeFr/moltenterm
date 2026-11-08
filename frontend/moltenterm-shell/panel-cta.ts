// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// What a call to action inside a panel needs to open another panel beside it (#1844, FR-SHELL-139 AC13): the panel it
// is in, and whether the click asked for a new view. The doors it feeds are openFromPanel (app-panel.ts), and through
// it openMoltentermView, openCicdTab and ReviewsModel.openReviews.

import { isMacOS } from "@/util/platformutil";
import { useCallback } from "react";
import { type ClickModifiers, type PanelOrigin, panelOrigin } from "./app-panel-model";
import { useT } from "./i18n/i18n";
import { usePanelBlockId } from "./view360/offcarpet-model";

export function usePanelOrigin(): (click?: ClickModifiers) => PanelOrigin {
    const blockId = usePanelBlockId();
    return useCallback((click?: ClickModifiers) => panelOrigin(blockId, click, isMacOS()), [blockId]);
}

// A call to action's tooltip, told how to open its panel in a new view instead.
export function useNewViewHint(): (title: string) => string {
    const t = useT();
    return useCallback((title: string) => t("cta.newViewHint", { title }), [t]);
}
