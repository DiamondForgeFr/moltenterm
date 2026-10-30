// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { fireAndForget } from "@/util/util";
import { useEffect, useRef, useState } from "react";
import { TabActivity, whileShown } from "../tab-activity";
import type { WorkspaceRailEntry } from "../workspace-rail-model";
import { sentToAiRows, type SentRow } from "./library-model";
import { readSentPanels } from "./sent-panels";
import { makeSentRefresh } from "./sent-refresh";
import { giveAccessBack, removeAccess } from "./share-access";

const SentPollMs = 5000;
// Undo can outlive the section, and an old scan can still be settling when the section opens again.
const SentRefresh = makeSentRefresh<SentRow[]>();

export function useSentAccess(
    entries: WorkspaceRailEntry[],
    showUndo: (removed: SentRow[], name: string, all: boolean, undo: () => Promise<number>) => void,
    showPartialError: (name: string) => void
) {
    const [rows, setRows] = useState<SentRow[]>(null);
    const [removing, setRemoving] = useState<Set<string>>(() => new Set());
    const refreshRef = useRef<object>(null);
    const entriesKey = entries.map((e) => e.id).join(" ");
    const entriesRef = useRef(entries);
    entriesRef.current = entries;
    useEffect(() => {
        const binding = {};
        refreshRef.current = binding;
        setRemoving(new Set());
        const deactivate = SentRefresh.activate(
            async (current) => sentToAiRows(await readSentPanels(entriesRef.current, current)),
            setRows,
            (error) => console.log("library: sent to AI", error)
        );
        const stop = TabActivity.getInstance().every(whileShown(SentPollMs), SentRefresh.request, "library-sent-to-ai");
        return () => {
            deactivate();
            if (refreshRef.current === binding) refreshRef.current = null;
            stop();
        };
    }, [entriesKey]);

    const remove = (target: SentRow[], name: string, all: boolean) => {
        const binding = refreshRef.current;
        if (binding == null) return;
        const keys = target.map((r) => r.key);
        setRemoving((cur) => new Set([...cur, ...keys]));
        fireAndForget(async () => {
            await SentRefresh.mutate(async () => {
                try {
                    const removed = await removeAccess(target);
                    showUndo(removed, name, all && removed.length === target.length, () =>
                        SentRefresh.mutate(() => giveAccessBack(removed))
                    );
                    if (removed.length > 0 && removed.length < target.length) showPartialError(name);
                    if (refreshRef.current === binding) {
                        setRows((cur) => (cur ?? []).filter((r) => !removed.some((x) => x.key === r.key)));
                    }
                } finally {
                    if (refreshRef.current === binding) {
                        setRemoving((cur) => new Set([...cur].filter((k) => !keys.includes(k))));
                    }
                }
            });
        });
    };
    return { rows, removing, remove };
}
