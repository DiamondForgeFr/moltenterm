// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import {
    blockViewToIcon,
    blockViewToName,
    getViewIconElem,
    OptMagnifyButton,
    renderHeaderElements,
} from "@/app/block/blockutil";
import { getBlockBadgeAtom } from "@/app/store/badge";
import { recordTEvent, refocusNode } from "@/app/store/global";
import { uxCloseBlock } from "@/app/store/keymodel";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useWaveEnv } from "@/app/waveenv/waveenv";
import { IconButton } from "@/element/iconbutton";
import { NodeModel } from "@/layout/index";
import * as util from "@/util/util";
import { cn, makeIconClass } from "@/util/util";
import * as jotai from "jotai";
import * as React from "react";
// MOLTENTERM-PATCH (#401): the command panel's trigger, the header right-click and the body's short menu
import { blockBodyMenuItems, openHeaderCommandPanel } from "../../moltenterm-shell/command-panel/block-menus";
import { openCommandPanelFromTrigger } from "../../moltenterm-shell/command-panel/command-panel-store";
// MOLTENTERM-PATCH (#406): the header's lead (icon, title, muted context), its one Pill and the working segment
import {
    MoltenHeaderLead,
    MoltenHeaderPill,
    MoltenHeaderWorking,
    useHeaderHasProposal,
    useMoltenHeader,
    withoutHeaderPills,
} from "../../moltenterm-shell/header/panel-header";
import { AgentLinksHeaderButton } from "../../moltenterm-shell/agent-links/agent-links-menu"; // MOLTENTERM-PATCH (#1050)
import { HeaderCloseButton } from "../../moltenterm-shell/header/header-close-button"; // MOLTENTERM-PATCH (#705)
import { useT } from "../../moltenterm-shell/i18n/i18n"; // MOLTENTERM-PATCH (#623)
import { anchoredMenuEvent, buttonMenuAnchor } from "../../moltenterm-shell/menu/menu-anchor"; // MOLTENTERM-PATCH (#1439)
import { formatShortcutById } from "../../moltenterm-shell/shortcuts/format"; // MOLTENTERM-PATCH (#371)
import { splitPanel } from "../../moltenterm-shell/split/split"; // MOLTENTERM-PATCH (#370)
import { CarpetHeaderButton } from "../../moltenterm-shell/view360/view360-places"; // MOLTENTERM-PATCH (#616, #1412)
import { splitDownLabel, splitRightLabel } from "../../moltenterm-shell/split/split-menu"; // MOLTENTERM-PATCH (#370, #623)
import { BlockEnv } from "./blockenv";
import { BlockFrameProps } from "./blocktypes";

// MOLTENTERM-PATCH (#370, #401): exported for the block body's menu (blockframe.tsx). The view's settings moved to
// the command panel (FR-SHELL-047): the body keeps a short menu, Split right, Split down, Magnify, More… ⌘., Close.
export function handleHeaderContextMenu(
    e: React.MouseEvent<HTMLDivElement>,
    blockId: string,
    viewModel: ViewModel,
    nodeModel: NodeModel,
    blockEnv: BlockEnv
) {
    e.preventDefault();
    e.stopPropagation();
    blockEnv.showContextMenu(blockBodyMenuItems(blockId, nodeModel), e);
}

type HeaderTextElemsProps = {
    viewModel: ViewModel;
    blockId: string;
    preview: boolean;
    error?: Error;
    // MOLTENTERM-PATCH (#406): at most one pill per header, the most urgent state's
    hidePills?: boolean;
};

const HeaderTextElems = React.memo(({ viewModel, blockId, preview, error, hidePills }: HeaderTextElemsProps) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const frameTextAtom = waveEnv.getBlockMetaKeyAtom(blockId, "frame:text");
    const frameText = jotai.useAtomValue(frameTextAtom);
    let headerTextUnion = util.useAtomValueSafe(viewModel?.viewText);
    headerTextUnion = frameText ?? headerTextUnion;

    const headerTextElems: React.ReactElement[] = [];
    if (typeof headerTextUnion === "string") {
        if (!util.isBlank(headerTextUnion)) {
            headerTextElems.push(
                <div key="text" className="block-frame-text ellipsis">
                    &lrm;{headerTextUnion}
                </div>
            );
        }
    } else if (Array.isArray(headerTextUnion)) {
        // MOLTENTERM-PATCH (#406)
        headerTextElems.push(
            ...renderHeaderElements(hidePills ? withoutHeaderPills(headerTextUnion) : headerTextUnion, preview)
        );
    }
    if (error != null) {
        const copyHeaderErr = () => {
            navigator.clipboard.writeText(error.message + "\n" + error.stack);
        };
        headerTextElems.push(
            <div className="iconbutton disabled" key="controller-status" onClick={copyHeaderErr}>
                <i
                    className="fa-sharp fa-solid fa-triangle-exclamation"
                    title={"Error Rendering View Header: " + error.message}
                />
            </div>
        );
    }

    return <div className="block-frame-textelems-wrapper">{headerTextElems}</div>;
});
HeaderTextElems.displayName = "HeaderTextElems";

// MOLTENTERM-PATCH (#1439): the header width under which Magnify joins the "⋯"; header.css folds at the same width
const FoldMagnifyPx = 300;

type HeaderEndIconsProps = {
    viewModel: ViewModel;
    nodeModel: NodeModel;
    blockId: string;
    termHeader?: boolean; // MOLTENTERM-PATCH (#406)
};

const HeaderEndIcons = React.memo(({ viewModel, nodeModel, blockId, termHeader }: HeaderEndIconsProps) => {
    const blockEnv = useWaveEnv<BlockEnv>();
    const endIconButtons = util.useAtomValueSafe(viewModel?.endIconButtons);
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const ephemeral = jotai.useAtomValue(nodeModel.isEphemeral);
    const numLeafs = jotai.useAtomValue(nodeModel.numLeafs);
    const magnifyDisabled = numLeafs <= 1;
    const showSplitButtons = jotai.useAtomValue(blockEnv.getSettingsKeyAtom("term:showsplitbuttons"));
    const t = useT(); // MOLTENTERM-PATCH (#623)
    // MOLTENTERM-PATCH (#406): a terminal's proposals wait in the command panel; its trigger carries a dot meanwhile
    const hasProposal = useHeaderHasProposal(blockId, termHeader);

    const endIconsElem: React.ReactElement[] = [];

    // MOLTENTERM-PATCH (#1439): a narrow header folds the view's own buttons (and the opt-in split buttons) into one
    // "⋯" before anything else (header.css); the menu lists them under the same titles
    const foldedDecls: IconButtonDecl[] = [...(endIconButtons ?? [])];
    if (endIconButtons && endIconButtons.length > 0) {
        endIconsElem.push(
            <span key="mt-view-buttons" className="molten-fold-1 contents">
                {endIconButtons.map((button, idx) => (
                    <IconButton key={idx} decl={button} />
                ))}
            </span>
        );
    }
    // MOLTENTERM-PATCH (#370): still opt-in and terminal-only; they open the content picker like every split
    if (showSplitButtons && viewModel?.viewType === "term") {
        const splitHorizontalDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "columns",
            title: `${splitRightLabel()} (${formatShortcutById("split-right")})`,
            click: (e) => {
                e.stopPropagation();
                util.fireAndForget(() => splitPanel(blockId, "right"));
            },
        };
        const splitVerticalDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "grip-lines",
            title: `${splitDownLabel()} (${formatShortcutById("split-down")})`,
            click: (e) => {
                e.stopPropagation();
                util.fireAndForget(() => splitPanel(blockId, "down"));
            },
        };
        foldedDecls.push(splitHorizontalDecl, splitVerticalDecl);
        endIconsElem.push(
            <span key="mt-split-buttons" className="molten-fold-1 contents">
                <IconButton key="split-horizontal" decl={splitHorizontalDecl} />
                <IconButton key="split-vertical" decl={splitVerticalDecl} />
            </span>
        );
    }
    // MOLTENTERM-PATCH (#1439): the "⋯" shows only once the header folds something (header.css); a magnified panel
    // keeps its un-magnify button, which is its only way out
    const canFoldMagnify = !magnified && !ephemeral && !magnifyDisabled;
    const moreDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "ellipsis",
        title: t("wave.block.moreActions"),
        click: (e) => {
            e.stopPropagation();
            const width = (e.currentTarget as Element)
                .closest(".block-frame-default-header")
                ?.getBoundingClientRect().width;
            const items: ContextMenuItem[] = [];
            for (const decl of foldedDecls) {
                if (typeof decl.icon !== "string" || util.isBlank(decl.title)) {
                    continue;
                }
                items.push({
                    label: decl.title,
                    icon: decl.icon,
                    enabled: !decl.disabled,
                    click: () => decl.click?.(e),
                });
            }
            if (canFoldMagnify && width < FoldMagnifyPx) {
                items.push({ label: t("wave.block.magnify"), icon: "expand", click: () => nodeModel.toggleMagnify() });
            }
            blockEnv.showContextMenu(items, anchoredMenuEvent(e, buttonMenuAnchor(e.currentTarget as Element)));
        },
    };
    if (foldedDecls.length > 0 || canFoldMagnify) {
        endIconsElem.push(
            <IconButton
                key="mt-more"
                decl={moreDecl}
                className={foldedDecls.length > 0 ? "molten-fold-more" : "molten-fold-more-2"}
            />
        );
    }
    // MOLTENTERM-PATCH (#1050): the connections of the terminal's agents, shown only when it holds one (FR-CONT-022)
    endIconsElem.push(<AgentLinksHeaderButton key="mt-agent-links" blockId={blockId} termHeader={!!termHeader} />);
    // MOLTENTERM-PATCH (#616, #1412): "Store on the carpet" right before the gear, on every panel outside the fixed
    // zone, in and out of 360 view; a pinned panel shows its filled pin, which unpins it (FR-SHELL-123)
    endIconsElem.push(<CarpetHeaderButton key="mt-pin" blockId={blockId} />);
    // MOLTENTERM-PATCH (#401): the gear becomes the command panel's trigger (FR-SHELL-047, DS-SHELL-085)
    const settingsDecl: IconButtonDecl = {
        elemtype: "iconbutton",
        icon: "sliders",
        // MOLTENTERM-PATCH (#623)
        title: t(hasProposal ? "wave.block.suggestionsAndOptions" : "wave.block.commandsAndOptions", {
            shortcut: formatShortcutById("command-panel"),
        }),
        click: (e) =>
            openCommandPanelFromTrigger(
                blockId,
                (e.target as Element)?.closest?.("button") ?? (e.currentTarget as Element)
            ),
    };
    endIconsElem.push(
        <IconButton
            key="settings"
            decl={settingsDecl}
            className={cn("block-frame-settings", hasProposal && "molten-has-proposal")} // MOLTENTERM-PATCH (#406)
        />
    );
    if (ephemeral) {
        const addToLayoutDecl: IconButtonDecl = {
            elemtype: "iconbutton",
            icon: "circle-plus",
            title: t("wave.block.addToLayout"), // MOLTENTERM-PATCH (#623)
            click: () => {
                nodeModel.addEphemeralNodeToLayout();
            },
        };
        endIconsElem.push(<IconButton key="add-to-layout" decl={addToLayoutDecl} />);
    } else {
        endIconsElem.push(
            <span key="unmagnify" className={cn("contents", canFoldMagnify && "molten-fold-2")}>
                <OptMagnifyButton
                    magnified={magnified}
                    toggleMagnify={() => {
                        nodeModel.toggleMagnify();
                        setTimeout(() => refocusNode(blockId), 50);
                    }}
                    disabled={magnifyDisabled}
                />
            </span>
        );
    }

    // MOLTENTERM-PATCH (#705, #939): a magnified panel shows no × and keeps no slot, so un-magnify ends the row
    // flush right; right after un-magnify the × ignores clicks until the pointer leaves it
    endIconsElem.push(
        <HeaderCloseButton
            key="close"
            magnified={magnified}
            onClose={() => uxCloseBlock(nodeModel.blockId)}
            className="block-frame-default-close"
        />
    );

    return <div className="block-frame-end-icons">{endIconsElem}</div>;
});
HeaderEndIcons.displayName = "HeaderEndIcons";

const BlockFrame_Header = ({
    nodeModel,
    viewModel,
    preview,
    connBtnRef,
    changeConnModalAtom,
    error,
}: BlockFrameProps & { changeConnModalAtom: jotai.PrimitiveAtom<boolean>; error?: Error }) => {
    const waveEnv = useWaveEnv<BlockEnv>();
    const metaView = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "view"));
    const metaFrameTitle = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "frame:title"));
    const metaFrameIcon = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "frame:icon"));
    const metaConnection = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "connection"));
    let viewName = util.useAtomValueSafe(viewModel?.viewName) ?? blockViewToName(metaView);
    let viewIconUnion = util.useAtomValueSafe(viewModel?.viewIcon) ?? blockViewToIcon(metaView);
    const preIconButton = util.useAtomValueSafe(viewModel?.preIconButton);
    const useTermHeader = util.useAtomValueSafe(viewModel?.useTermHeader);
    const badge = jotai.useAtomValue(getBlockBadgeAtom(useTermHeader ? nodeModel.blockId : null));
    const magnified = jotai.useAtomValue(nodeModel.isMagnified);
    const prevMagifiedState = React.useRef(magnified);
    const manageConnection = util.useAtomValueSafe(viewModel?.manageConnection);
    const iconColor = jotai.useAtomValue(waveEnv.getBlockMetaKeyAtom(nodeModel.blockId, "icon:color"));
    const dragHandleRef = preview ? null : nodeModel.dragHandleRef;
    const localHostName = jotai.useAtomValue(waveEnv.getLocalHostDisplayNameAtom());
    viewName = metaFrameTitle ?? viewName;
    viewIconUnion = metaFrameIcon ?? viewIconUnion;
    // MOLTENTERM-PATCH (#406): every header is [16 px icon] Title, muted context, at most one Pill (FR-SHELL-052).
    // A terminal's title is its agent, the connection shows only when remote and the durability moved into the
    // command panel; every panel has a title, so a view's hideViewName no longer hides it.
    const headerState = useMoltenHeader({
        blockId: nodeModel.blockId,
        viewModel,
        preview,
        termHeader: !!useTermHeader,
        manageConnection: !!manageConnection,
        connection: metaConnection,
        frameTitle: metaFrameTitle,
        viewName: viewName || blockViewToName(metaView),
        localHostName,
        changeConnModalAtom,
    });

    React.useEffect(() => {
        if (magnified && !preview && !prevMagifiedState.current) {
            waveEnv.rpc.ActivityCommand(TabRpcClient, { nummagnify: 1 });
            recordTEvent("action:magnify", { "block:view": viewName });
        }
        prevMagifiedState.current = magnified;
    }, [magnified]);

    const viewIconElem = getViewIconElem(viewIconUnion, iconColor);
    const viewIconName =
        typeof viewIconUnion === "string"
            ? viewIconUnion
            : typeof viewIconUnion?.icon === "string"
              ? viewIconUnion.icon
              : null;

    return (
        <div
            className="block-frame-default-header"
            data-role="block-header"
            ref={dragHandleRef}
            onContextMenu={(e) => openHeaderCommandPanel(e, nodeModel.blockId)} // MOLTENTERM-PATCH (#401)
        >
            <MoltenHeaderLead
                state={headerState}
                iconElem={viewIconElem}
                iconName={viewIconName}
                iconColor={iconColor}
                manageConnection={!!manageConnection}
                localHostName={localHostName}
                connBtnRef={connBtnRef}
                preIcon={
                    preIconButton ? <IconButton decl={preIconButton} className="block-frame-preicon-button" /> : null
                }
            />
            {useTermHeader && badge && (
                <div className="pointer-events-none flex items-center px-1" style={{ color: badge.color || "#fbbf24" }}>
                    <i className={makeIconClass(badge.icon, true, { defaultIcon: "circle-small" })} />
                </div>
            )}
            <HeaderTextElems
                viewModel={viewModel}
                blockId={nodeModel.blockId}
                preview={preview}
                error={error}
                hidePills={headerState.pill != null}
            />
            <MoltenHeaderPill state={headerState} viewModel={viewModel} />
            <HeaderEndIcons
                viewModel={viewModel}
                nodeModel={nodeModel}
                blockId={nodeModel.blockId}
                termHeader={!!useTermHeader && !preview}
            />
            <MoltenHeaderWorking state={headerState} />
        </div>
    );
};

export { BlockFrame_Header };
