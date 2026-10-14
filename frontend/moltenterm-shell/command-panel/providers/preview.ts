// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Preview sections (DS-SHELL-086, DS-SHELL-090): preview-model's settings menu regrouped into File (its actions,
// in sentence case) and View (Font size and Word wrap as native options with This panel and All previews scopes),
// plus a folder's defaults. The actions run Wave's own items.

import { t } from "../../i18n/i18n";
import { metaBinding, settingsBinding } from "../bindings";
import { CommandProvider, PanelContext, PanelItem, PanelSection } from "../panel-types";
import { adaptMenuItems } from "../wave-adapter";

export const PreviewFontSizeDefault = 12;

// Wave's labels in the panel's words; the open-with labels (Reveal in Finder…) are already sentence-like.
const Renames: Record<string, { labelKey: string; icon?: string }> = {
    "Copy Full Path": { labelKey: "cmdpanel.preview.copyFullPath", icon: "copy" },
    "Copy File Name": { labelKey: "cmdpanel.preview.copyFileName", icon: "copy" },
    "Open File in Default Application": {
        labelKey: "cmdpanel.preview.openDefaultApp",
        icon: "arrow-up-right-from-square",
    },
    "Download File": { labelKey: "cmdpanel.preview.download", icon: "download" },
    "Open Preview in New Block": { labelKey: "cmdpanel.preview.openNewPanel", icon: "arrow-up-right-from-square" },
    "Open Terminal Here": { labelKey: "cmdpanel.preview.openTerminal", icon: "terminal" },
    "Save File": { labelKey: "common.save", icon: "floppy-disk" },
    "Revert File": { labelKey: "cmdpanel.preview.revert", icon: "rotate-left" },
    "Directory Sort Order": { labelKey: "cmdpanel.preview.sortOrder", icon: "arrow-down-wide-short" },
    "Show Hidden Files": { labelKey: "cmdpanel.preview.hiddenFiles", icon: "eye" },
};

const FolderLabels = new Set(["Directory Sort Order", "Show Hidden Files", "Default Settings"]);

export function previewSections(ctx: PanelContext): PanelSection[] {
    const waveItems: ContextMenuItem[] = (ctx.viewModel as any)?.getSettingsMenuItems?.() ?? [];
    const labels = new Set<string>();
    const collect = (items: ContextMenuItem[]) =>
        (items ?? []).forEach((i) => {
            if (i?.label) {
                labels.add(i.label);
            }
        });
    collect(waveItems);
    const adapted = adaptMenuItems(waveItems, "preview:");
    const rename = (item: PanelItem): PanelItem => {
        const r = Renames[item.label];
        if (r == null && item.label.startsWith("Reveal in ")) {
            return { ...item, icon: item.icon ?? "folder" };
        }
        return r ? { ...item, label: t(r.labelKey), icon: item.icon ?? r.icon } : item;
    };
    const file: PanelItem[] = [];
    const folder: PanelItem[] = [];
    for (const item of adapted.items) {
        const waveLabel = item.label;
        if (waveLabel === "Editor Font Size" || waveLabel === "Word Wrap") {
            continue;
        }
        if (FolderLabels.has(waveLabel)) {
            if (item.type !== "info") {
                folder.push(rename(item));
            }
            continue;
        }
        file.push(rename(item));
    }
    const view: PanelItem[] = [];
    // Wave offers them only while a file is open in the editor.
    if (labels.has("Editor Font Size")) {
        view.push({
            id: "preview:fontsize",
            type: "number",
            label: t("cmdpanel.preview.fontSize"),
            icon: "text-height",
            min: 6,
            max: 32,
            step: 1,
            control: "stepper",
            format: (v) => `${v} px`,
            defaultValue: PreviewFontSizeDefault,
            scopes: [
                metaBinding<number>(ctx.blockId, "editor:fontsize"),
                settingsBinding<number>("editor:fontsize", PreviewFontSizeDefault),
            ],
        });
    }
    if (labels.has("Word Wrap")) {
        view.push({
            id: "preview:wordwrap",
            type: "toggle",
            label: t("cmdpanel.preview.wordWrap"),
            icon: "text-width",
            keywords: ["wrap lines"],
            defaultValue: false,
            scopes: [
                metaBinding<boolean>(ctx.blockId, "editor:wordwrap"),
                settingsBinding<boolean>("editor:wordwrap", false),
            ],
        });
    }
    return [
        { id: "widget:preview:file", kind: "widget", title: t("cmdpanel.preview.file"), items: file },
        { id: "widget:preview:view", kind: "widget", title: t("cmdpanel.preview.view"), items: view },
        { id: "widget:preview:folder", kind: "widget", title: t("cmdpanel.preview.folderDefaults"), items: folder },
        { id: "developer", kind: "developer", title: t("cmdpanel.section.developer"), items: adapted.developer },
    ];
}

export const PreviewProvider: CommandProvider = {
    id: "preview",
    kind: "widget",
    needs: ["view:preview"],
    sections: previewSections,
};
