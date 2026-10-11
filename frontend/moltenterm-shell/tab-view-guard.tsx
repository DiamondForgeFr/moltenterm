// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { atoms, getApi } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { atom, Atom, useAtomValue } from "jotai";
import React, { ReactNode } from "react";
import { PendingSurface } from "./view-pending";

const NullTabAtom = atom<Tab>(null) as Atom<Tab>;

// The pending state of a tab view (FR-PERF-001 AC4), in its visible form (FR-PERF-004, view-pending.tsx): never an
// unmounted, black root.
export function TabViewPending() {
    return (
        <div className="flex-grow w-full h-full">
            <PendingSurface phase="loading" />
        </div>
    );
}

type TabViewBoundaryProps = {
    resetKey: string;
    onError?: (error: Error) => void;
    children: ReactNode;
};

type TabViewBoundaryState = {
    error: Error;
};

// Without a boundary, a render error anywhere in the view unmounts React's root and leaves an empty #main for good.
// This one shows the pending state instead and renders the view again on the next update of its workspace, its tab or
// a reinit (the view being shown again).
export class TabViewBoundary extends React.Component<TabViewBoundaryProps, TabViewBoundaryState> {
    state: TabViewBoundaryState = { error: null };

    static getDerivedStateFromError(error: Error): TabViewBoundaryState {
        return { error };
    }

    componentDidCatch(error: Error) {
        this.props.onError?.(error);
    }

    componentDidUpdate(prevProps: TabViewBoundaryProps) {
        if (this.state.error == null || prevProps.resetKey === this.props.resetKey) {
            return;
        }
        this.setState({ error: null });
    }

    render() {
        if (this.state.error != null) {
            return <TabViewPending />;
        }
        return this.props.children;
    }
}

function logTabViewError(error: Error) {
    console.error("tab view render error, showing the pending state", error);
    try {
        getApi().sendLog("tab view render error (pending state shown): " + error?.message + "\n" + error?.stack);
    } catch (_) {
        // the log is best effort
    }
}

// The one place where a tab view checks that its workspace and its tab exist before anything below dereferences them:
// a deleted workspace or tab, or one not loaded yet, shows the pending state instead of throwing.
export function TabViewGuard({ children }: { children: ReactNode }) {
    const tabId = useAtomValue(atoms.staticTabId);
    const ws = useAtomValue(atoms.workspace);
    const tab = useAtomValue(tabId ? WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)) : NullTabAtom);
    const reinitVersion = useAtomValue(atoms.reinitVersion);
    if (ws == null || tab == null) {
        return <TabViewPending />;
    }
    return (
        <TabViewBoundary resetKey={`${ws.version}:${tab.version}:${reinitVersion}`} onError={logTabViewError}>
            {children}
        </TabViewBoundary>
    );
}
