// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// What every panel offers a developer, behind Option (FR-SHELL-047 security rationale): its id.

import { t } from "../../i18n/i18n";
import { CommandProvider, PanelContext, PanelSection } from "../panel-types";

export function developerSections(ctx: PanelContext): PanelSection[] {
    return [
        {
            id: "developer",
            kind: "developer",
            title: t("cmdpanel.section.developer"),
            items: [
                {
                    id: "dev:copyid",
                    type: "action",
                    label: t("cmdpanel.developer.copyId"),
                    icon: "copy",
                    keywords: ["block id", "blockid"],
                    detail: ctx.blockId.slice(0, 8),
                    run: () => navigator.clipboard.writeText(ctx.blockId),
                },
            ],
        },
    ];
}

export const DeveloperProvider: CommandProvider = {
    id: "developer",
    kind: "developer",
    // After the widgets' own developer items.
    order: 100,
    sections: developerSections,
};
