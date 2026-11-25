// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Manage contexts (FR-SHELL-159, #2534) on mock objects: five contexts, seven workspaces, the dialog open on the first
// context. `?lang=fr` shows it in French. There is no backend here, so a save reports that it failed.

import { mockObjectForPreview } from "@/app/store/wos";
import { PreviewClientId, PreviewTabId, PreviewWindowId, PreviewWorkspaceId } from "@/preview/mock/mockwaveenv";
import { useState } from "react";
import { ManageContextsDialog } from "../../moltenterm-shell/contexts/manage-contexts";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";
import type { WorkspaceRailEntry } from "../../moltenterm-shell/workspace-rail-model";
// The shell's own tokens and rules (the app loads them in wave.ts): the action orange, the selected liseré.
import "../../moltenterm-shell/molten-button.css";
import "../../moltenterm-shell/moltenterm-shell.css";

// The first context is the one the dialog opens on, and the default context's id is the one it reads before the client
// object has loaded.
const Contexts = [
    {
        id: "workshop",
        name: "Studio",
        description: "The software the studio builds and sells",
        emblem: "code-xml",
        shape: "arrow",
        folder: "~/Projects/Studio",
    },
    { id: "tools", name: "Workshop", description: "Everything I run myself", emblem: "hammer", shape: "v" },
    { id: "client-a", name: "Client A", description: "", emblem: "briefcase", shape: "swallowtail" },
    { id: "client-b", name: "Client B", description: "", emblem: "briefcase", shape: "moon" },
    { id: "personal", name: "Personal", description: "", emblem: "heart", shape: "round" },
];

const Workspaces: [string, string, string][] = [
    ["Website", "#c9d65a", "workshop"],
    ["Mobile app", "#a8622c", "workshop"],
    ["Back office", "#9a9a9a", "workshop"],
    ["Docs", "#5b8def", "workshop"],
    ["Billing", "#e8d24a", "workshop"],
    ["Brand", "#e0782f", "workshop"],
    ["Exchanges", "#2FA6A0", "client-a"],
];

const Entries: WorkspaceRailEntry[] = Workspaces.map(([name, color, contextId], i) => ({
    id: `preview-ctx-ws-${i}`,
    name,
    icon: "fire",
    color,
    saved: true,
    active: i === 0,
    open: i === 0,
    contextId,
}));

function seed() {
    mockObjectForPreview<Client>(`client:${PreviewClientId}`, {
        otype: "client",
        oid: PreviewClientId,
        version: 1,
        windowids: [PreviewWindowId],
        meta: { "molten:contexts": Contexts } as MetaType,
    } as Client);
    mockObjectForPreview<WaveWindow>(`window:${PreviewWindowId}`, {
        otype: "window",
        oid: PreviewWindowId,
        version: 1,
        workspaceid: PreviewWorkspaceId,
        pos: { x: 0, y: 0 },
        winsize: { width: 1280, height: 900 },
        lastfocusts: 0,
        meta: {},
    });
    mockObjectForPreview<Workspace>(`workspace:${PreviewWorkspaceId}`, {
        otype: "workspace",
        oid: PreviewWorkspaceId,
        version: 1,
        name: "Website",
        icon: "fire",
        color: "#c9d65a",
        tabids: [PreviewTabId],
        activetabid: PreviewTabId,
        meta: { "molten:context": "workshop" } as MetaType,
    });
}

seed();

export function ManageContextsPreview() {
    const [open, setOpen] = useState(true);
    const language = new URLSearchParams(window.location.search).get("lang");
    if (language) {
        I18nModel.getInstance().setLanguageSetting(language);
    }
    if (!open) {
        return (
            <button
                type="button"
                className="cursor-pointer rounded-4 border border-border px-3 py-1.5 text-12"
                onClick={() => setOpen(true)}
            >
                Open
            </button>
        );
    }
    return <ManageContextsDialog entries={Entries} onClose={() => setOpen(false)} />;
}
