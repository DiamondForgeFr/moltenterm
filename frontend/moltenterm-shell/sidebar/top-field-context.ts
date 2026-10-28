// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What the closed top field shows (FR-SHELL-083): kept apart from top-field-model.ts, whose search rules load with the
// open field, so the resting field costs the JS every tab view loads up front almost nothing (NFR-PERF-003).

export type FieldContext = { icon: string; text: string; url: boolean };

export type FocusFacts = {
    // The focused panel's page address, when it is a browser panel.
    url?: string;
    panelLabel?: string;
    panelIcon?: string;
    viewName?: string;
    panelCount?: number;
};

// What the closed field shows (DS of #1181): a page's address, else "<panel> · <view>" when the view holds several
// panels, the panel name dropped when the view is already named after it, so a name never shows twice.
export function fieldContext(focus: FocusFacts): FieldContext {
    const url = (focus?.url ?? "").trim();
    if (url) {
        return { icon: "globe", text: url, url: true };
    }
    const view = (focus?.viewName ?? "").trim();
    if (!view) {
        return { icon: "magnifying-glass", text: "", url: false };
    }
    const label = (focus?.panelLabel ?? "").trim();
    const icon = focus?.panelIcon || "magnifying-glass";
    if (!label || (focus?.panelCount ?? 1) <= 1 || fold(view).startsWith(fold(label))) {
        return { icon, text: view, url: false };
    }
    return { icon, text: `${label} · ${view}`, url: false };
}

// Lower case without accents: "équipe" matches "Equipe".
export function fold(text: string): string {
    return (text ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
