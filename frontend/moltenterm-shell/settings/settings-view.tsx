// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The waveconfig view as MoltenTerm shows it (FR-SHELL-050): the settings screen, or, once a JSON file is open (from
// Advanced, or a "file" in the block's meta such as the rail's Edit widgets.json), Wave's editor under a bar that
// leads back to the screen. The view model stays Wave's (waveconfig-model.ts, MOLTENTERM-PATCH #404).

import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { WaveConfigView } from "@/app/view/waveconfig/waveconfig";
import type { WaveConfigViewModel } from "@/app/view/waveconfig/waveconfig-model";
import { useAtomValue } from "jotai";
import { memo } from "react";
import { SettingsScreen } from "./settings-screen";

// Back to the screen: the editor's unsaved changes are confirmed first, then the block forgets its file.
export function closeConfigFile(model: WaveConfigViewModel) {
    if (!model.confirmDiscardChanges()) {
        return;
    }
    model.discardChanges();
    globalStore.set(model.selectedFileAtom, null);
    void model.env.rpc.SetMetaCommand(TabRpcClient, { oref: makeORef("block", model.blockId), meta: { file: null } });
}

export function openConfigFile(model: WaveConfigViewModel, path: string) {
    const file = [...model.getConfigFiles(), ...model.getDeprecatedConfigFiles()].find((f) => f.path === path);
    if (file == null) {
        return;
    }
    void model.loadFile(file);
}

export const MoltentermSettingsView = memo((props: ViewComponentProps<WaveConfigViewModel>) => {
    const { blockId, model } = props;
    const selectedFile = useAtomValue(model.selectedFileAtom);
    const metaFile = useAtomValue(model.env.getBlockMetaKeyAtom(blockId, "file"));
    if (selectedFile == null && !metaFile) {
        const files = model.getConfigFiles().map((f) => ({ path: f.path, name: f.name, description: f.description }));
        return <SettingsScreen blockId={blockId} files={files} onOpenFile={(path) => openConfigFile(model, path)} />;
    }
    return (
        <div className="flex h-full w-full min-h-0 flex-col">
            <div className="flex h-row-lg shrink-0 items-center gap-2 border-b border-line px-2">
                <button
                    type="button"
                    onClick={() => closeConfigFile(model)}
                    className="molten-btn-ghost inline-flex h-row cursor-pointer items-center gap-1.5 rounded-6 px-2 text-12"
                >
                    <i className="fa fa-solid fa-chevron-left text-11" aria-hidden />
                    Settings
                </button>
                <span className="text-12 text-muted">JSON files</span>
            </div>
            <div className="relative min-h-0 flex-1">
                <WaveConfigView {...props} />
            </div>
        </div>
    );
});

MoltentermSettingsView.displayName = "MoltentermSettingsView";
