// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The launcher of a new view (FR-SHELL-089, DS-SHELL-128): the command palette with the favourites on top. A new view
// opened directly on an agent passes through here too: the agent starts at once, without the chooser.

import { atoms, getSettingsKeyAtom, WOS } from "@/app/store/global";
import { isMacOS } from "@/util/platformutil";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import type React from "react";
import { useEffect, useMemo, useRef } from "react";
import { useKnownCodingAgents } from "../coding-agent/coding-agent";
import { useLocale } from "../i18n/i18n";
import { typeMorphCall } from "../morph/morph-call";
import { CommandPalette, NewViewChooser } from "../palette/command-palette";
import { formatKeys } from "../shortcuts/format";
import { newViewFavoriteBindings } from "../shortcuts/registry";
import { readWorkspaceProject } from "../workspace-project";
import { dismissNewView, openInNewView } from "./new-view";
import {
    NewViewAgentsMetaKey,
    newViewChoices,
    NewViewFavoritesKey,
    NewViewMetaKey,
    NewViewRunMetaKey,
    resolveFavorites,
} from "./new-view-model";

export function isNewViewBlock(block: Block): boolean {
    return block?.meta?.[NewViewMetaKey as keyof MetaType] === true;
}

type NewViewChooserViewProps = { blockId: string; inputRef: React.RefObject<HTMLInputElement> };

export function NewViewChooserView({ blockId, inputRef }: NewViewChooserViewProps) {
    const block = useAtomValue(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const ws = useAtomValue(atoms.workspace);
    const favoritesSetting = useAtomValue(getSettingsKeyAtom(NewViewFavoritesKey));
    const locale = useLocale();
    const installedAgents = useKnownCodingAgents();
    const runId = block?.meta?.[NewViewRunMetaKey as keyof MetaType] as string;
    const focusAgents = block?.meta?.[NewViewAgentsMetaKey as keyof MetaType] === true;
    const projectLinked = readWorkspaceProject(ws).dir !== "";
    const choices = useMemo(
        () =>
            newViewChoices({
                presets: fullConfig?.presets,
                installedAgents,
                widgets: fullConfig?.widgets,
                workspaceId: ws?.oid,
                projectLinked,
            }),
        [fullConfig, installedAgents, ws?.oid, projectLinked, locale]
    );
    const started = useRef(false);
    useEffect(() => {
        if (!runId || started.current) {
            return;
        }
        const entry = choices.find((c) => c.id === runId);
        if (entry == null) {
            return;
        }
        started.current = true;
        fireAndForget(() => openInNewView(entry, blockId));
    }, [runId, choices, blockId]);
    const chooser: NewViewChooser = useMemo(() => {
        const mac = isMacOS();
        return {
            favorites: resolveFavorites(favoritesSetting, choices),
            favoriteKeys: newViewFavoriteBindings(mac).map((k) => formatKeys(k, mac)),
            onOpen: (entry) => fireAndForget(() => openInNewView(entry, blockId)),
            onCancel: () => fireAndForget(() => dismissNewView(blockId)),
            onAskAgent: async (agent, request) => {
                await dismissNewView(blockId);
                await typeMorphCall(agent, request);
            },
            focusAgents,
        };
    }, [favoritesSetting, choices, blockId, focusAgents]);
    if (runId) {
        return null;
    }
    return (
        <CommandPalette
            host="pane"
            blockId={blockId}
            inPlace="replace"
            inputRef={inputRef}
            autoFocus
            newView={chooser}
        />
    );
}
