// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Carries out a palette entry (FR-SHELL-013). "in place" replaces the pane the palette lives in, or opens a new pane
// from the global palette; "right" splits the given pane to its right.

import {
    createBlock,
    createBlockSplitHorizontally,
    createTab,
    getApi,
    getBlockComponentModel,
    replaceBlock,
} from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { getLayoutModelForStaticTab } from "@/layout/index";
import { fireAndForget } from "@/util/util";
import { Atom } from "jotai";
import { PaletteRun } from "./palette-model";

export type PalettePlacement = "replace" | "new" | "right";

export type PaletteTarget = { placement: PalettePlacement; blockId: string };

const CommandReadyTimeoutMs = 15000;
const CommandReadyPollMs = 100;

// An agent starts in a local shell terminal: the shell gets the workspace folder from wavesrv (#82, a shell block
// without cmd:cwd), runs the user's rc files (their PATH, their aliases), stays durable, and is still there when the
// agent exits. The command is typed once the shell runs, so it lands in the shell's history like any other.
export const AgentBlockDef: BlockDef = { meta: { view: "term", controller: "shell" } };

export function folderBlockDef(path: string): BlockDef {
    return { meta: { view: "term", controller: "shell", "cmd:cwd": path } };
}

async function openBlock(blockdef: BlockDef, target: PaletteTarget): Promise<string> {
    if (target.placement === "replace" && target.blockId) {
        return replaceBlock(target.blockId, blockdef, true);
    }
    if (target.placement === "right" && target.blockId) {
        return createBlockSplitHorizontally(blockdef, target.blockId, "after");
    }
    return createBlock(blockdef);
}

type ShellViewModel = { shellProcStatus?: Atom<string>; sendDataToController?: (data: string) => void };

function readyShell(blockId: string): ShellViewModel {
    const vm = getBlockComponentModel(blockId)?.viewModel as ShellViewModel;
    if (vm?.shellProcStatus == null || vm.sendDataToController == null) {
        return null;
    }
    return globalStore.get(vm.shellProcStatus) === "running" ? vm : null;
}

// Types command into the terminal block once its shell runs. Input written before the shell reads its first line is
// kept by the terminal, so "running" is enough: no need to wait for the prompt.
export function typeCommandWhenReady(blockId: string, command: string): Promise<boolean> {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            const vm = readyShell(blockId);
            if (vm != null) {
                vm.sendDataToController(command + "\r");
                resolve(true);
                return;
            }
            if (Date.now() - started > CommandReadyTimeoutMs) {
                console.log(`palette: the terminal ${blockId} did not start, "${command}" was not typed`);
                resolve(false);
                return;
            }
            setTimeout(tick, CommandReadyPollMs);
        };
        tick();
    });
}

function focusBlock(blockId: string) {
    const layoutModel = getLayoutModelForStaticTab();
    const node = blockId ? layoutModel?.getNodeByBlockId(blockId) : null;
    if (node != null) {
        layoutModel.focusNode(node.id);
    }
}

function openSettings() {
    fireAndForget(() => createBlock({ meta: { view: "waveconfig" } }, false, true));
}

export async function runPaletteEntry(run: PaletteRun, target: PaletteTarget): Promise<void> {
    switch (run.kind) {
        case "agent": {
            const blockId = await openBlock(AgentBlockDef, target);
            await typeCommandWhenReady(blockId, run.command);
            return;
        }
        case "widget":
            await openBlock(run.blockdef, target);
            return;
        case "folder":
            await openBlock(folderBlockDef(run.path), target);
            return;
        case "newtab":
            createTab();
            return;
        case "newworkspace":
            getApi().createWorkspace();
            return;
        case "switchworkspace":
            getApi().switchWorkspace(run.workspaceId);
            return;
        case "settings":
            openSettings();
            return;
        case "focusorigin":
            focusBlock(target.blockId);
            return;
    }
}
