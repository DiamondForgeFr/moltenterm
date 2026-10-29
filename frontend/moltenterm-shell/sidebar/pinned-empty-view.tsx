// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// A pinned view whose last panel closed (FR-SHELL-081): the view stays, as a pinned view closes only once unpinned,
// and says how to go on: add a panel, or unpin it. A new workspace's view not opened yet (FR-SHELL-092) makes its
// panels here instead, the first time it is shown.

import { createBlock, WOS } from "@/app/store/global";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useMemo } from "react";
import { EmptyState } from "../empty-state";
import { useT } from "../i18n/i18n";
import { ViewPendingMetaKey } from "../workspace-views/workspace-views-model";
import { ViewPins } from "./view-pins-store";

export function PinnedEmptyView({ tabId }: { tabId: string }) {
    const t = useT();
    const state = useAtomValue(ViewPins.getInstance().stateAtom(tabId));
    const tabAtom = useMemo(() => WOS.getWaveObjectAtom<Tab>(WOS.makeORef("tab", tabId)), [tabId]);
    const pending = !!useAtomValue(tabAtom)?.meta?.[ViewPendingMetaKey];
    useEffect(() => {
        if (pending) {
            fireAndForget(() => ViewPins.getInstance().openPending(tabId));
        }
    }, [pending, tabId]);
    if (state === "temporary" || pending) {
        return null;
    }
    return (
        <EmptyState
            icon="thumbtack"
            title={t("sidebar.views.emptyTitle")}
            hint={t("sidebar.views.emptyHint")}
            primary={{
                label: t("sidebar.views.emptyAdd"),
                testId: "pinned-empty-add",
                onClick: () => fireAndForget(() => createBlock({ meta: { view: "launcher" } })),
            }}
            secondary={{
                label: t("sidebar.pins.menu.unpin"),
                testId: "pinned-empty-unpin",
                onClick: () => fireAndForget(() => ViewPins.getInstance().unpin(tabId)),
            }}
            testId="pinned-empty-view"
        />
    );
}
