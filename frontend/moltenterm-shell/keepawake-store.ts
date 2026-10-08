// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The windows' copy of wavesrv's keep-awake state (FR-SHELL-023, DS-SHELL-062): a read at start, then the
// molten:keepawake events, which carry the whole state on every change, so every window agrees within a moment
// (FR-SHELL-022-AC8). The coffee, the session overrides and the policy are changed from here.

import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import {
    applyKeepAwakeState,
    cleanSleepPolicy,
    coffeeOf,
    EmptyKeepAwakeState,
    KeepAwakeCoffee,
    KeepAwakeCoffeeCommand,
    KeepAwakeEvent,
    KeepAwakeOverrideCommand,
    KeepAwakeRoute,
    KeepAwakeState,
    KeepAwakeStateCommand,
    SleepPolicy,
    SleepPolicyGesture,
} from "./keepawake-model";
import { registerNotificationGesture } from "./notifications-store";

const StateTimeoutMs = 5000;
const StateRetryMs = 2000;
const StateMaxTries = 10;
const CommandTimeoutMs = 10000;

export class KeepAwakeModel {
    private static instance: KeepAwakeModel = null;

    stateAtom = atom(EmptyKeepAwakeState) as PrimitiveAtom<KeepAwakeState>;
    coffeeAtoms = new Map<string, Atom<KeepAwakeCoffee>>();
    anyCoffeeAtoms = new Map<string, Atom<boolean>>();
    started = false;

    private constructor() {}

    static getInstance(): KeepAwakeModel {
        if (!KeepAwakeModel.instance) {
            KeepAwakeModel.instance = new KeepAwakeModel();
            KeepAwakeModel.instance.start();
        }
        return KeepAwakeModel.instance;
    }

    apply(next: KeepAwakeState): void {
        const current = globalStore.get(this.stateAtom);
        const applied = applyKeepAwakeState(current, next);
        if (applied !== current) {
            globalStore.set(this.stateAtom, applied);
        }
    }

    // Subscribes first, so nothing published while the first read travels is lost (versions order the two).
    start(): void {
        if (this.started) {
            return;
        }
        this.started = true;
        try {
            waveEventSubscribeSingle({
                eventType: KeepAwakeEvent as WaveEventName,
                handler: (event) => this.apply(event.data as KeepAwakeState),
            });
        } catch (e) {
            // The preview server has no event bus.
            console.log("keep-awake: no event bus", e);
            return;
        }
        registerNotificationGesture(SleepPolicyGesture, async (args) => {
            const policy = cleanSleepPolicy(args?.policy);
            if (policy == null) {
                return { ok: false, error: "Unknown sleep policy." };
            }
            await this.setPolicy(policy);
            return { ok: true, resolve: true };
        });
        let tries = 0;
        const load = () => {
            fireAndForget(async () => {
                try {
                    this.apply(await this.call(KeepAwakeStateCommand, {}, StateTimeoutMs));
                } catch {
                    // The route comes up with Mission Control.
                    if (++tries < StateMaxTries) {
                        setTimeout(load, StateRetryMs);
                    }
                }
            });
        };
        load();
    }

    private async call(command: string, data: any, timeout = CommandTimeoutMs): Promise<KeepAwakeState> {
        return (await TabRpcClient.wshRpcCall(command, data, { route: KeepAwakeRoute, timeout })) as KeepAwakeState;
    }

    coffeeAtom(workspaceId: string): Atom<KeepAwakeCoffee> {
        let rtn = this.coffeeAtoms.get(workspaceId);
        if (rtn == null) {
            rtn = atom((get) => (workspaceId == null ? null : coffeeOf(get(this.stateAtom), workspaceId)));
            this.coffeeAtoms.set(workspaceId, rtn);
        }
        return rtn;
    }

    // Whether one of the workspaces has its coffee on (a collapsed product shows the droplet then).
    anyCoffeeAtom(workspaceIds: string[]): Atom<boolean> {
        const key = workspaceIds.join(" ");
        let rtn = this.anyCoffeeAtoms.get(key);
        if (rtn == null) {
            rtn = atom((get) => {
                const state = get(this.stateAtom);
                return workspaceIds.some((id) => coffeeOf(state, id) != null);
            });
            this.anyCoffeeAtoms.set(key, rtn);
        }
        return rtn;
    }

    async setCoffee(workspaceId: string, on: boolean): Promise<void> {
        this.apply(await this.call(KeepAwakeCoffeeCommand, { workspaceid: workspaceId, on }));
    }

    async setOverride(blockId: string, policy: "allow" | "letsleep" | ""): Promise<void> {
        this.apply(await this.call(KeepAwakeOverrideCommand, { blockid: blockId, policy }));
    }

    async setPolicy(policy: SleepPolicy): Promise<void> {
        await RpcApi.SetConfigCommand(TabRpcClient, { "power:sleeppolicy": policy });
    }
}
