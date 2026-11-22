// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The ghost of a block (FR-SHELL-018, #2467): what the arranging mode draws where a block would stand and draws nothing.
// A block the developer hid is a compact ghost at the end of the flow, with the eye that shows it; a block that only
// shows when it has something to show (the permission request, the milestone, the plan usage, the workspace task) is a
// compact ghost at its rank, which says when it shows, and which the real block replaces as soon as it has something to
// show. A ghost is a block of the flow like the others, so it is carried, hidden and widened like them. Outside the
// arranging mode it draws nothing, which is what a block with nothing to show always did.

import { useContext } from "react";
import { useT } from "../i18n/i18n";
import { ArrangeContext } from "./companion-arrange-context";
import { ConditionalWhenKeys, SectionNameKeys } from "./companion-arrange-model";
import { CompanionBlock } from "./companion-block";
import type { CompanionSectionId } from "./companion-layout";
import { SectionTiles } from "./companion-section-tiles";

export type GhostKind = "when" | "hidden";

export function ArrangeGhost({ id, kind }: { id: CompanionSectionId; kind: GhostKind }) {
    const t = useT();
    const arrange = useContext(ArrangeContext);
    if (arrange == null) {
        return null;
    }
    const text = kind === "hidden" ? t("companion.arrange.hiddenBody") : t(ConditionalWhenKeys[id] ?? "");
    return (
        <CompanionBlock
            flowId={id}
            className="mt-cb-ghost"
            label={t(SectionNameKeys[id])}
            icon={SectionTiles[id]}
            data-ghost={kind}
            data-testid="companion-ghost"
        >
            <div className="mt-cb-sum" data-tip={text}>
                {text}
            </div>
        </CompanionBlock>
    );
}
