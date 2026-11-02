// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Block } from "@/app/block/block";
import { CenteredDiv } from "@/element/quickelems";
import { ContentRenderer, NodeModel, PreviewRenderer, TileLayout } from "@/layout/index";
import { TileLayoutContents } from "@/layout/lib/types";
import { atoms, getApi } from "@/store/global";
import * as services from "@/store/services";
import * as WOS from "@/store/wos";
import { atom, useAtomValue } from "jotai";
import * as React from "react";
import { useMemo } from "react";
import { PinnedEmptyView } from "../../moltenterm-shell/sidebar/pinned-empty-view"; // MOLTENTERM-PATCH (#1185)
import { pinnedViewKeepsTab } from "../../moltenterm-shell/sidebar/view-pins-store"; // MOLTENTERM-PATCH (#1185)

const tileGapSizeAtom = atom((get) => {
    const settings = get(atoms.settingsAtom);
    return settings["window:tilegapsize"];
});

// MOLTENTERM-PATCH (#1216): frameGapPx, the Spaces frame's one margin, replaces the tile gap and the padding
type TabContentProps = { tabId: string; noTopPadding?: boolean; frameGapPx?: number };

const TabContent = React.memo(({ tabId, noTopPadding, frameGapPx }: TabContentProps) => {
    const oref = useMemo(() => WOS.makeORef("tab", tabId), [tabId]);
    const loadingAtom = useMemo(() => WOS.getWaveObjectLoadingAtom(oref), [oref]);
    const tabLoading = useAtomValue(loadingAtom);
    const tabAtom = useMemo(() => WOS.getWaveObjectAtom<Tab>(oref), [oref]);
    const tabData = useAtomValue(tabAtom);
    const settingsGapSize = useAtomValue(tileGapSizeAtom);
    const tileGapSize = frameGapPx ?? settingsGapSize;

    const tileLayoutContents = useMemo(() => {
        const renderContent: ContentRenderer = (nodeModel: NodeModel) => {
            return <Block key={nodeModel.blockId} nodeModel={nodeModel} preview={false} />;
        };

        const renderPreview: PreviewRenderer = (nodeModel: NodeModel) => {
            return <Block key={nodeModel.blockId} nodeModel={nodeModel} preview={true} />;
        };

        function onNodeDelete(data: TabLayoutData) {
            return services.ObjectService.DeleteBlock(data.blockId);
        }

        return {
            renderContent,
            renderPreview,
            tabId,
            onNodeDelete,
            gapSizePx: tileGapSize,
        } as TileLayoutContents;
    }, [tabId, tileGapSize]);

    let innerContent;

    if (tabLoading) {
        innerContent = <CenteredDiv>Tab Loading</CenteredDiv>;
    } else if (!tabData) {
        innerContent = <CenteredDiv>Tab Not Found</CenteredDiv>;
    } else if (!tabData?.blockids?.length && pinnedViewKeepsTab(tabId)) {
        // MOLTENTERM-PATCH (#1185): a pinned view left without a panel says how to go on (FR-SHELL-081)
        innerContent = <PinnedEmptyView tabId={tabId} />;
    } else if (tabData?.blockids?.length == 0) {
        innerContent = null;
    } else {
        innerContent = (
            <TileLayout
                key={tabId}
                contents={tileLayoutContents}
                tabAtom={tabAtom}
                getCursorPoint={getApi().getCursorPoint}
            />
        );
    }

    return (
        <div className={`flex flex-row flex-grow min-h-0 w-full items-center justify-center overflow-hidden relative ${noTopPadding || frameGapPx != null ? "" : "pt-[3px]"} ${frameGapPx != null ? "" : "pr-[3px]"}`}>
            {innerContent}
        </div>
    );
});

export { TabContent };
