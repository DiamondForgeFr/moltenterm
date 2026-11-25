// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Which zone of the sidebar a panel dragged over it is on, and where in it (FR-SHELL-080, #2548). A panel is dragged
// with the HTML5 backend, so the pointer is read from the drag layer; the sidebar's sections say what they are through
// the attributes sidebar-drag.ts already puts on them.

import { endMark, landsBefore, listHitAt, PanelHit } from "./panel-view-model";
import { zoneAt } from "./sidebar-drag";
import { anchorOfFolder } from "./view-folders-store";
import { ItemAttr } from "./view-list-drag";

const KeyAttr = "data-sb-key";
const ZoneAttr = "data-sb-zone";
// A zone drawn for another project of the workspace while a panel is dragged.
export const ProjectZoneAttr = "data-sb-project";
const TabKeyPrefix = "tab:";
const FolderKeyPrefix = "folder:";

export function projectZoneProps(projectId: string): Record<string, string> {
    return { [ProjectZoneAttr]: projectId };
}

// The tab a view dropped before an item of the Views list lands before: a view's own, or a folder's first.
export function anchorOfItem(itemKey: string): string {
    if (itemKey == null) {
        return null;
    }
    if (itemKey.startsWith(TabKeyPrefix)) {
        return itemKey.slice(TabKeyPrefix.length);
    }
    return itemKey.startsWith(FolderKeyPrefix) ? anchorOfFolder(itemKey.slice(FolderKeyPrefix.length)) : null;
}

function blockOrder(zoneEl: HTMLElement): string[] {
    return Array.from(zoneEl.querySelectorAll<HTMLElement>(`[${KeyAttr}]`)).map((el) => el.getAttribute(KeyAttr));
}

function listHit(zoneEl: HTMLElement, y: number): PanelHit {
    const rows = Array.from(zoneEl.querySelectorAll<HTMLElement>(`[${ItemAttr}]`));
    const slots = rows.map((el) => {
        const r = el.getBoundingClientRect();
        return { key: el.getAttribute(ItemAttr), top: r.top, height: r.height };
    });
    const hit = listHitAt(y, slots);
    if (hit.folderKey != null) {
        return { zone: "temporary", key: null, folderId: hit.folderKey.slice(FolderKeyPrefix.length), before: null };
    }
    return { zone: "temporary", key: hit.before, before: anchorOfItem(hit.before) };
}

// The zone under a point and the place in it; null away from every zone.
export function panelHitAt(x: number, y: number): PanelHit {
    const el = document.elementFromPoint(x, y);
    const projectEl = el?.closest<HTMLElement>(`[${ProjectZoneAttr}]`);
    if (projectEl != null) {
        return { zone: "project", projectId: projectEl.getAttribute(ProjectZoneAttr) };
    }
    const zoneEl = el?.closest<HTMLElement>(`[${ZoneAttr}]`);
    if (zoneEl == null) {
        return null;
    }
    const zone = zoneEl.getAttribute(ZoneAttr);
    if (zone === "temporary") {
        return listHit(zoneEl, y);
    }
    if (zone !== "top" && zone !== "tiles") {
        return null;
    }
    const order = blockOrder(zoneEl);
    const on = zoneAt(x, y);
    const end = endMark(order);
    const key = on?.key ?? end.key;
    const after = on?.key != null ? on.after : end.after;
    return {
        zone,
        key,
        after,
        stacked: on?.key != null ? !!on.stacked : false,
        before: landsBefore(order, key, after),
    };
}
