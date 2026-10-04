// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The widgets the workspace rail's tool section shows (FR-SHELL-012, DS-SHELL-012). Kept apart from the component so
// the rules can be tested without the app.

import { shouldIncludeWidgetForWorkspace } from "@/app/workspace/widgetfilter";

// Wave's built-in widgets carry this key prefix; the launcher behind the add-panel button already offers them.
export const DefaultWidgetPrefix = "defwidget@";

// Beyond this count the rail would push its workspaces out of sight, so the rest goes in the overflow flyout.
export const MaxRailWidgets = 4;

export function railCustomWidgets(
    widgets: { [key: string]: WidgetConfigType },
    workspaceId: string
): WidgetConfigType[] {
    if (widgets == null) {
        return [];
    }
    const list = Object.entries(widgets)
        .filter(([key, widget]) => widget != null && !key.startsWith(DefaultWidgetPrefix))
        .filter(([, widget]) => !widget["display:hidden"] && shouldIncludeWidgetForWorkspace(widget, workspaceId))
        .map(([key, widget]) => ({ key, widget }));
    // The key breaks ties so the order does not depend on how the config map was serialized.
    list.sort(
        (a, b) => (a.widget["display:order"] ?? 0) - (b.widget["display:order"] ?? 0) || a.key.localeCompare(b.key)
    );
    return list.map((e) => e.widget);
}

// A single widget past the limit takes the overflow button's place instead of hiding behind it.
export function splitRailWidgets(
    widgets: WidgetConfigType[],
    max = MaxRailWidgets
): { shown: WidgetConfigType[]; overflow: WidgetConfigType[] } {
    if (widgets.length <= max + 1) {
        return { shown: widgets, overflow: [] };
    }
    return { shown: widgets.slice(0, max), overflow: widgets.slice(max) };
}

export function railWidgetTooltip(widget: WidgetConfigType): string {
    return widget.description || widget.label || "Widget";
}
