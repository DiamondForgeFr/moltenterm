// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Tips (#534): MoltenTerm's own help page, opened from the rail's lightbulb, in the language of Settings. It replaces
// Wave's tips view under the same view type ("tips"), whose content was about Wave's blocks and wsh. The shortcuts come
// from the shortcuts registry, so they always match Settings > Keyboard.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { isMacOS } from "@/util/platformutil";
import { atom } from "jotai";
import { useMemo } from "react";
import { PageCard, PageColumn, PageHeader, PageRowClass } from "../settings/settings-page";
import { platformShortcuts } from "../shortcuts/registry";
import { filterShortcuts } from "../shortcuts/shortcuts-search";
import { ShortcutSections } from "../shortcuts/shortcuts-sheet";

export const MoltentermTipsView = "tips";

type Tip = { code?: string; title: string; text: string; icon?: string };

const ReshapeTips: Tip[] = [
    {
        code: "/morph <what you want>",
        title: "Reshape MoltenTerm with your agent",
        text: "In Claude Code, Codex or another agent, ask for a panel, a command or a layout: the agent writes a mod and MoltenTerm asks before it runs it. ($morph in Codex, /skill:morph in Kimi Code.)",
    },
    {
        code: "molten undo",
        title: "Take a change back",
        text: "Every morph is versioned; undo returns to the previous state.",
    },
    {
        code: "molten copy <text>",
        title: "Show text to copy",
        text: "A box with a Copy button, next to the terminal. Agents use it for tokens and commands.",
    },
    {
        code: "molten help",
        title: "Every molten command",
        text: "Mods, history, agents, sessions and docs, from any MoltenTerm terminal.",
    },
];

const WorkTips: Tip[] = [
    {
        icon: "layer-group",
        title: "Sessions survive",
        text: "Terminals and agents keep running when MoltenTerm quits or updates. The Sessions icon on the rail lists every one still running.",
    },
    {
        icon: "magnifying-glass",
        title: "The command palette",
        text: "Open panels, folders, agents and workspaces by typing a few letters.",
    },
    {
        icon: "table-columns",
        title: "Split where you work",
        text: "Split the focused panel to add a terminal, a browser or any view beside it; drag a session onto a panel to show it there.",
    },
    {
        icon: "compass",
        title: "Getting started",
        text: "The first run (your agent, a first morph, your project) is in the app menu and the command palette.",
    },
];

export class TipsViewModel implements ViewModel {
    viewType = MoltentermTipsView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("lightbulb");
    viewName = atom("Tips");
    noPadding = atom(true);

    constructor({ blockId, nodeModel }: ViewModelInitType) {
        this.blockId = blockId;
        this.nodeModel = nodeModel;
    }

    get viewComponent(): ViewComponent {
        return TipsView;
    }
}

function TipRow({ tip }: { tip: Tip }) {
    return (
        <div className={PageRowClass}>
            {tip.icon ? (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-6 bg-surface-2 text-secondary">
                    <i className={`fa fa-solid fa-${tip.icon} text-icon-14`} aria-hidden />
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <div className="text-12 font-medium text-primary">{tip.title}</div>
                <div className="text-12 leading-5 text-muted">{tip.text}</div>
            </div>
            {tip.code ? (
                <code className="shrink-0 rounded-4 bg-surface-2 px-1.5 py-0.5 font-mono text-11 text-primary @max-w600:hidden">
                    {tip.code}
                </code>
            ) : null}
        </div>
    );
}

function TipsView(_props: ViewComponentProps<TipsViewModel>) {
    const mac = isMacOS();
    const sections = useMemo(() => filterShortcuts(platformShortcuts(mac), "", mac), [mac]);
    return (
        <div className="@container h-full w-full overflow-y-auto bg-surface-1 text-primary" data-testid="molten-tips">
            <PageColumn>
                <PageHeader
                    title="Tips"
                    icon="lightbulb"
                    description="The few gestures that make MoltenTerm yours, and every shortcut."
                />
                <PageCard title="Reshape it" hint="From any MoltenTerm terminal.">
                    {ReshapeTips.map((tip) => (
                        <TipRow key={tip.title} tip={tip} />
                    ))}
                </PageCard>
                <PageCard title="Work in it">
                    {WorkTips.map((tip) => (
                        <TipRow key={tip.title} tip={tip} />
                    ))}
                </PageCard>
                <PageCard title="Shortcuts" hint="The same list as Settings > Keyboard.">
                    <div className="flex flex-col gap-3 px-4 py-3">
                        <ShortcutSections
                            sections={sections}
                            mac={mac}
                            headingClass="pb-1 text-12 font-medium text-secondary"
                        />
                    </div>
                </PageCard>
            </PageColumn>
        </div>
    );
}
