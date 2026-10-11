// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Work that lives only in this tab view's memory (#476, after #454, FR-PERF-008): the tab view budget may destroy a
// hidden view, so the main process asks the view first (emain/moltenterm-tabview-budget-live.ts) and keeps one that
// answers yes.
// Terminals, layouts and block settings live in wavesrv and come back with a rebuilt view; these do not:
// - a file edited in a preview or code editor and not saved (PreviewModel.newFileContent);
// - a configuration file edited and not saved (WaveConfigViewModel.hasEditedAtom, the settings view included).
// A browser panel's page is reloaded at its URL (the budget evicts those views last, emain/moltenterm-tabview-budget.ts).

import { getAllBlockComponentModels, globalStore } from "@/app/store/global";
import type { Atom } from "jotai";

export const UnsavedWorkProbeName = "moltentermHasUnsavedWork";

type AtomReader = <T>(atom: Atom<T>) => T;

type ProbedViewModel = {
    viewType?: string;
    newFileContent?: Atom<string>;
    hasEditedAtom?: Atom<boolean>;
};

export function viewHasUnsavedWork(viewModel: ProbedViewModel, get: AtomReader): boolean {
    if (viewModel == null) {
        return false;
    }
    if (viewModel.newFileContent != null && get(viewModel.newFileContent) != null) {
        return true;
    }
    if (viewModel.hasEditedAtom != null && get(viewModel.hasEditedAtom) === true) {
        return true;
    }
    return false;
}

export function tabHasUnsavedWork(viewModels: ProbedViewModel[], get: AtomReader): boolean {
    return (viewModels ?? []).some((vm) => viewHasUnsavedWork(vm, get));
}

// The main process calls window.moltentermHasUnsavedWork() through executeJavaScript before evicting the view.
export function installUnsavedWorkProbe() {
    (globalThis as Record<string, unknown>)[UnsavedWorkProbeName] = () =>
        tabHasUnsavedWork(
            getAllBlockComponentModels().map((bcm) => bcm?.viewModel as ProbedViewModel),
            (atom) => globalStore.get(atom)
        );
}
