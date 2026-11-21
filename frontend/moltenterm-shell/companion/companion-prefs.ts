// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The companion's remembered choices (#555), in the client's meta like the line map's window: the same for every
// companion, kept across restarts. A choice shows at once; a failed write only loses the memory of it.

import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/jotaiStore";
import { makeORef } from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom, useAtomValue } from "jotai";
import { useState } from "react";
import { CompanionPrefs, CompanionPrefsMetaKey, readCompanionPrefs, withChosenTab } from "./companion-files-model";
import {
    CompanionLayout,
    DefaultCompanionLayout,
    isDefaultLayout,
    normalizeLayout,
    sameLayout,
} from "./companion-layout";

const NoClient = atom(null) as Atom<Client>;

function clientAtom(): Atom<Client> {
    return ClientModel.getInstance().clientAtom ?? NoClient;
}

// A second choice made before the first write came back builds on the first, not on the stale meta.
let unconfirmed: CompanionPrefs = null;

function rememberCompanionPrefs(patch: CompanionPrefs, onWritten?: () => void): void {
    const clientId = ClientModel.getInstance().clientId;
    if (clientId == null) {
        return;
    }
    const prefs = {
        ...readCompanionPrefs(unconfirmed ?? globalStore.get(clientAtom())?.meta?.[CompanionPrefsMetaKey]),
        ...patch,
    };
    unconfirmed = prefs;
    fireAndForget(async () => {
        try {
            await RpcApi.SetMetaCommand(TabRpcClient, {
                oref: makeORef("client", clientId),
                meta: { [CompanionPrefsMetaKey]: prefs } as MetaType,
            });
            onWritten?.();
        } finally {
            if (unconfirmed === prefs) {
                unconfirmed = null;
            }
        }
    });
}

export function useCompanionPref(
    key: "filesopen" | "usagedetails" | "summariesasked" | "idleopen" | "reviewopen"
): [boolean, (value: boolean) => void] {
    const client = useAtomValue(clientAtom());
    const stored = readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey])[key] === true;
    const [chosen, setChosen] = useState<boolean>(null);
    const set = (value: boolean) => {
        setChosen(value);
        rememberCompanionPrefs({ [key]: value });
    };
    return [chosen ?? stored, set];
}

// Whether the Taken by others group is open, as the developer left it (#2418): undefined while he never chose, so the
// block's width decides. The choice is the same in every companion and shows at once.
export function useTakenOpen(): [boolean, (open: boolean) => void] {
    const client = useAtomValue(clientAtom());
    const stored = readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey]).takenopen;
    const [chosen, setChosen] = useState<boolean>(undefined);
    const set = (open: boolean) => {
        setChosen(open);
        rememberCompanionPrefs({ takenopen: open });
    };
    return [chosen ?? stored, set];
}

// The milestone tabs just chosen, shown until the client's meta carries them (and kept when the write failed).
const SavedTabs = atom<Record<string, number>>(null) as PrimitiveAtom<Record<string, number>>;

function currentTabs(): Record<string, number> {
    const meta = globalStore.get(clientAtom())?.meta?.[CompanionPrefsMetaKey];
    return globalStore.get(SavedTabs) ?? readCompanionPrefs(meta).milestonetabs ?? {};
}

// The milestone tab the developer chose in a project's Tasks block (#2416): 0 while none was chosen. It is the same in
// every companion of the project; a choice that is no open milestone any more falls to the oldest one
// (chosenMilestone), so it lasts exactly while its milestone is open.
export function useMilestoneChoice(dir: string): [number, (milestone: number) => void] {
    const client = useAtomValue(clientAtom());
    const saved = useAtomValue(SavedTabs);
    const tabs = saved ?? readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey]).milestonetabs;
    return [tabs?.[dir] ?? 0, (milestone: number) => saveMilestoneChoice(dir, milestone)];
}

export function saveMilestoneChoice(dir: string, milestone: number): void {
    if (!dir || !(milestone > 0) || currentTabs()[dir] === milestone) {
        return;
    }
    const next = withChosenTab(currentTabs(), dir, milestone);
    globalStore.set(SavedTabs, next);
    rememberCompanionPrefs({ milestonetabs: next }, () => {
        if (globalStore.get(SavedTabs) === next) {
            globalStore.set(SavedTabs, null);
        }
    });
}

// The layout just saved, shown until the client's meta carries it (and kept when the write failed, like the other
// choices): every companion of the window reads it, so an arrangement shows in all of them at once.
const SavedLayout = atom<CompanionLayout>(null) as PrimitiveAtom<CompanionLayout>;

function currentLayout(): CompanionLayout {
    const meta = globalStore.get(clientAtom())?.meta?.[CompanionPrefsMetaKey];
    return globalStore.get(SavedLayout) ?? readCompanionPrefs(meta).layout ?? DefaultCompanionLayout;
}

// The developer's arrangement of the sections (#2395), the default one while none is stored.
export function useCompanionLayout(): CompanionLayout {
    const client = useAtomValue(clientAtom());
    const saved = useAtomValue(SavedLayout);
    return saved ?? readCompanionPrefs(client?.meta?.[CompanionPrefsMetaKey]).layout ?? DefaultCompanionLayout;
}

// Nothing is written for a layout that is the one in force, and the default layout is stored as no layout at all.
export function saveCompanionLayout(layout: CompanionLayout): void {
    const next = normalizeLayout(layout);
    if (sameLayout(next, currentLayout())) {
        return;
    }
    globalStore.set(SavedLayout, next);
    rememberCompanionPrefs({ layout: isDefaultLayout(next) ? undefined : next }, () => {
        if (globalStore.get(SavedLayout) === next) {
            globalStore.set(SavedLayout, null);
        }
    });
}
