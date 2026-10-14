// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// Tips (#534): MoltenTerm's own help page, opened from the rail's lightbulb, in the language of Settings. It replaces
// Wave's tips view under the same view type ("tips"), whose content was about Wave's blocks and wsh. The shortcuts come
// from the shortcuts registry, so they always match Settings > Keyboard.

import type { BlockNodeModel } from "@/app/block/blocktypes";
import { isMacOS } from "@/util/platformutil";
import { atom } from "jotai";
import { useMemo } from "react";
import { I18nModel, t, useT } from "../i18n/i18n";
import { PageCard, PageColumn, PageHeader, PageRowClass } from "../settings/settings-page";
import { platformShortcuts } from "../shortcuts/registry";
import { filterShortcuts } from "../shortcuts/shortcuts-search";
import { ShortcutSections } from "../shortcuts/shortcuts-sheet";

export const MoltentermTipsView = "tips";

type Tip = { id: string; code?: string; icon?: string };

// Titles and texts are keys (tips.items.<id>.title and .text), translated where shown.
const ReshapeTips: Tip[] = [
    { id: "morph", code: "/morph <what you want>" },
    { id: "undo", code: "molten undo" },
    { id: "copy", code: "molten copy <text>" },
    { id: "help", code: "molten help" },
];

const WorkTips: Tip[] = [
    { id: "sessions", icon: "layer-group" },
    { id: "palette", icon: "magnifying-glass" },
    { id: "split", icon: "table-columns" },
    { id: "gettingStarted", icon: "compass" },
];

export class TipsViewModel implements ViewModel {
    viewType = MoltentermTipsView;
    blockId: string;
    nodeModel: BlockNodeModel;
    viewIcon = atom("lightbulb");
    viewName = atom((get) => {
        get(I18nModel.getInstance().localeAtom);
        return t("tips.viewName");
    });
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
    const t = useT();
    return (
        <div className={PageRowClass}>
            {tip.icon ? (
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-6 bg-surface-2 text-secondary">
                    <i className={`fa fa-solid fa-${tip.icon} text-icon-14`} aria-hidden />
                </span>
            ) : null}
            <div className="min-w-0 flex-1">
                <div className="text-12 font-medium text-primary">{t(`tips.items.${tip.id}.title`)}</div>
                <div className="text-12 leading-5 text-muted">{t(`tips.items.${tip.id}.text`)}</div>
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
    const t = useT();
    const mac = isMacOS();
    const sections = useMemo(() => filterShortcuts(platformShortcuts(mac), "", mac), [mac]);
    return (
        <div className="@container h-full w-full overflow-y-auto bg-surface-1 text-primary" data-testid="molten-tips">
            <PageColumn>
                <PageHeader title={t("tips.title")} icon="lightbulb" description={t("tips.description")} />
                <PageCard title={t("tips.reshape.title")} hint={t("tips.reshape.hint")}>
                    {ReshapeTips.map((tip) => (
                        <TipRow key={tip.id} tip={tip} />
                    ))}
                </PageCard>
                <PageCard title={t("tips.work.title")}>
                    {WorkTips.map((tip) => (
                        <TipRow key={tip.id} tip={tip} />
                    ))}
                </PageCard>
                <PageCard title={t("tips.shortcuts.title")} hint={t("tips.shortcuts.hint")}>
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
