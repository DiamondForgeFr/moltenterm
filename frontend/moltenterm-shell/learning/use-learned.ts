// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { waveEventSubscribeSingle } from "@/app/store/wps";
import { useCallback, useEffect, useRef, useState } from "react";
import { learningDefaults, learningList } from "./learning-client";
import { emptyDefaults, LearningAllScope, LearningDefaults, LearningEvent, LearningItem } from "./learning-model";

export type LearnedState = {
    // The store answered (or could not): a view that prefills waits for it once, never for ever.
    ready: boolean;
    items: LearningItem[];
    defaults: LearningDefaults;
};

const NotReady = (workflow: string): LearnedState => ({ ready: false, items: [], defaults: emptyDefaults(workflow) });

// What a workflow learned, kept current by the store's event: the items for the "What MoltenTerm learned" list, and the
// defaults the workflow starts from. Without the store (a window outside the app, a test) the workflow learned nothing.
export function useLearned(workflow: string): LearnedState & { reload: () => void } {
    const [state, setState] = useState<LearnedState>(() => NotReady(workflow));
    const request = useRef(0);
    const reload = useCallback(() => {
        const n = ++request.current;
        Promise.all([learningList(workflow), learningDefaults(workflow)])
            .then(([list, defaults]) => {
                if (n !== request.current) {
                    return;
                }
                const items = list.workflows.find((w) => w.workflow === workflow)?.items ?? [];
                setState({ ready: true, items, defaults });
            })
            .catch((e) => {
                if (n !== request.current) {
                    return;
                }
                console.log("learning: not read", workflow, e);
                setState({ ready: true, items: [], defaults: emptyDefaults(workflow) });
            });
    }, [workflow]);
    useEffect(() => {
        setState(NotReady(workflow));
        reload();
        let unsubscribe: () => void;
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: LearningEvent as WaveEventName,
                scope: workflow,
                handler: reload,
            });
        } catch (e) {
            console.log("learning: no event bus", e);
        }
        return () => {
            request.current++;
            unsubscribe?.();
        };
    }, [workflow, reload]);
    return { ...state, reload };
}

// Every workflow that learns, for the Settings section: one subscription under the all-workflows scope.
export function useLearnedAll(workflows: string[]): {
    ready: boolean;
    byWorkflow: Record<string, LearningItem[]>;
    reload: () => void;
} {
    const [state, setState] = useState<{ ready: boolean; byWorkflow: Record<string, LearningItem[]> }>({
        ready: false,
        byWorkflow: {},
    });
    const request = useRef(0);
    const reload = useCallback(() => {
        const n = ++request.current;
        learningList()
            .then((list) => {
                if (n !== request.current) {
                    return;
                }
                const byWorkflow: Record<string, LearningItem[]> = {};
                for (const workflow of workflows) {
                    byWorkflow[workflow] = list.workflows.find((w) => w.workflow === workflow)?.items ?? [];
                }
                setState({ ready: true, byWorkflow });
            })
            .catch((e) => {
                if (n === request.current) {
                    console.log("learning: not read", e);
                    setState({ ready: true, byWorkflow: {} });
                }
            });
    }, [workflows]);
    useEffect(() => {
        reload();
        let unsubscribe: () => void;
        try {
            unsubscribe = waveEventSubscribeSingle({
                eventType: LearningEvent as WaveEventName,
                scope: LearningAllScope,
                handler: reload,
            });
        } catch (e) {
            console.log("learning: no event bus", e);
        }
        return () => {
            request.current++;
            unsubscribe?.();
        };
    }, [reload]);
    return { ...state, reload };
}
