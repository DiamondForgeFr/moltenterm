// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The Reviews view's side of Launch (FR-REV-031): the calls to wavesrv, the launch of each project as wavesrv
// publishes it, and the dialogs' request. Nothing here polls: the state comes with molten:mission:launch.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useEffect } from "react";
import { openInBrowserPanel } from "../browser/browser-routing";
import { MissionRouteId } from "../mission/mission-client";
import { LogChunk } from "../mission/mission-model";
import {
    LaunchPlan,
    LaunchRecipe,
    LaunchRecipeAnswer,
    LaunchState,
    LaunchTarget,
    launchUrlToOpen,
} from "./reviews-launch-model";

// must match the names in pkg/molten/mission/launch.go and launch_recipe.go
export const LaunchRecipeCommand = "moltenmissionlaunchrecipe";
export const LaunchSaveRecipeCommand = "moltenmissionlaunchsaverecipe";
export const LaunchPlanCommand = "moltenmissionlaunchplan";
export const LaunchStartCommand = "moltenmissionlaunchstart";
export const LaunchStopCommand = "moltenmissionlaunchstop";
export const LaunchRetryCommand = "moltenmissionlaunchretry";
export const LaunchStateCommand = "moltenmissionlaunchstate";
export const LaunchLogCommand = "moltenmissionlaunchlog";
export const LaunchEvent = "molten:mission:launch";

const LaunchRpcTimeoutMs = 30000;
// Stopping waits for the servers (10 s each, side by side) and a port holder's grace.
const LaunchStopTimeoutMs = 60000;

function call<T>(command: string, data: unknown, timeout = LaunchRpcTimeoutMs): Promise<T> {
    return TabRpcClient.wshRpcCall(command, data, { route: MissionRouteId, timeout });
}

export type LaunchAsk = { dir: string; target: LaunchTarget; recipeOnly?: boolean; at: number };

export class LaunchModel {
    private static instance: LaunchModel = null;

    statesAtom = atom({}) as PrimitiveAtom<Record<string, LaunchState>>;
    // The dialog to open: a card's Launch, Back to the trunk, or the recipe alone.
    askAtom = atom(null) as PrimitiveAtom<LaunchAsk>;
    // The launches started from this window, and those whose page it opened.
    asked = new Set<string>();
    opened = new Set<string>();

    private constructor() {}

    static getInstance(): LaunchModel {
        if (LaunchModel.instance == null) {
            LaunchModel.instance = new LaunchModel();
        }
        return LaunchModel.instance;
    }

    static resetInstance(): void {
        LaunchModel.instance = null;
    }

    store(state: LaunchState, dir: string) {
        if (!dir) {
            return;
        }
        const states = globalStore.get(this.statesAtom);
        globalStore.set(this.statesAtom, { ...states, [dir]: state });
        const url = launchUrlToOpen(state, this.asked, this.opened);
        if (url) {
            this.opened.add(state.id);
            fireAndForget(() => openInBrowserPanel(url));
        }
    }

    ask(dir: string, target: LaunchTarget, recipeOnly?: boolean) {
        globalStore.set(this.askAtom, { dir, target, recipeOnly, at: Date.now() });
    }

    closeAsk() {
        globalStore.set(this.askAtom, null);
    }

    async refresh(dir: string) {
        const state = await call<LaunchState>(LaunchStateCommand, { dir });
        this.store(state, dir);
    }

    recipe(dir: string): Promise<LaunchRecipeAnswer> {
        return call(LaunchRecipeCommand, { dir });
    }

    saveRecipe(dir: string, recipe: LaunchRecipe): Promise<LaunchRecipeAnswer> {
        return call(LaunchSaveRecipeCommand, { dir, recipe });
    }

    plan(dir: string, target: LaunchTarget): Promise<LaunchPlan> {
        return call(LaunchPlanCommand, { dir, target });
    }

    async start(dir: string, target: LaunchTarget, stash: boolean, stopports: boolean) {
        const state = await call<LaunchState>(
            LaunchStartCommand,
            { dir, target, stash, stopports },
            LaunchStopTimeoutMs
        );
        this.asked.add(state.id);
        this.store(state, dir);
    }

    async stop(dir: string) {
        this.store(await call<LaunchState>(LaunchStopCommand, { dir }, LaunchStopTimeoutMs), dir);
    }

    async retry(dir: string) {
        const state = await call<LaunchState>(LaunchRetryCommand, { dir });
        this.asked.add(state.id);
        this.store(state, dir);
    }

    // Opens the version's page again, on the developer's click.
    open(state: LaunchState) {
        if (!state?.url) {
            return;
        }
        fireAndForget(() => openInBrowserPanel(state.url));
    }

    log(dir: string, step: string, from: number): Promise<LogChunk> {
        return call(LaunchLogCommand, { dir, step, from });
    }
}

// The project's launch, asked once and then followed through wavesrv's events.
export function useLaunchState(dir: string): LaunchState {
    const model = LaunchModel.getInstance();
    const states = useAtomValue(model.statesAtom);
    useEffect(() => {
        if (!dir) {
            return;
        }
        const unsubscribe = waveEventSubscribeSingle({
            eventType: LaunchEvent as WaveEventName,
            scope: dir,
            handler: (event) => model.store(event.data as LaunchState, dir),
        });
        model.refresh(dir).catch(() => {});
        return unsubscribe;
    }, [dir, model]);
    const state = dir ? states[dir] : null;
    return state?.id ? state : null;
}
