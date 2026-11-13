// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Scene 6 of the pour, your colleague (FR-ONB-007 B-1 to B-6, DS-ONB-007, #2304): Brokk introduces himself in his own
// words, the scene says where he lives and how to reach him from anywhere, and, wherever the brainstorm is available,
// teaches /brainstorm beside a small drawing of a brainstorm on a synthetic idea. It takes what it shows as props, so it
// renders without a window: his animated face comes from onboarding-brokk-face.tsx, through the view.

import { DefaultBossName } from "../moltenterm-shell/boss/boss-name";
import { brokkInitial } from "../moltenterm-shell/boss/brokk-avatar-model";
import { useT } from "../moltenterm-shell/i18n/i18n";
import { formatShortcutById } from "../moltenterm-shell/shortcuts/format";
import { GlowRing } from "../moltenterm-shell/suite/suite";
import { withCodes } from "./onboarding-parts";
import { withKeys } from "./onboarding-pour-build";
import "./onboarding-pour-brokk.css";

export type BrokkIntro = {
    // His name as set in his preferences; Brokk when empty.
    name?: string;
    // The developer turned him off on this computer: only possible on a replay through Getting started.
    off?: boolean;
    // The brainstorm is available in this window (FR-BOSS-010 AC1 and FR-BOSS-011): only then is /brainstorm named.
    brainstorm?: boolean;
    // His animated face; without one (a render without a window) the frame wears his initial, never a still.
    face?: React.ReactNode;
};

export const BrainstormCommand = "/brainstorm";

// The drawing's box, which keeps its proportions at any width (onboarding-pour-brokk.css).
const GraphWidth = 300;
const GraphHeight = 180;

// The example brainstorm (synthetic, FR-ONB-007 B-5): a centre plate and the three plates linked to it, placed in
// percent of the drawing's box.
export const IdeaPlates = [
    { key: "centre", x: 48, y: 50 },
    { key: "who", x: 22, y: 19 },
    { key: "first", x: 76, y: 22 },
    { key: "risks", x: 72, y: 82 },
] as const;

export function brokkShownName(intro: BrokkIntro): string {
    return intro?.name?.trim() || DefaultBossName;
}

export function BrokkIntroMark({ name }: { name: string }) {
    return (
        <span className="mt-pour-brokk-mark" data-testid="pour-brokk-mark">
            {brokkInitial(name)}
        </span>
    );
}

// The drawing is hidden from assistive technology: the sentence beside it says what it shows.
function IdeaGraph() {
    const t = useT();
    const [centre, ...around] = IdeaPlates;
    return (
        <div className="mt-pour-brokk-graph" aria-hidden data-testid="pour-brokk-graph">
            <span className="mt-pour-brokk-example">{t("onboarding.pour.brokk.example")}</span>
            <svg viewBox={`0 0 ${GraphWidth} ${GraphHeight}`}>
                {around.map((plate, i) => (
                    <line
                        key={plate.key}
                        x1={(centre.x * GraphWidth) / 100}
                        y1={(centre.y * GraphHeight) / 100}
                        x2={(plate.x * GraphWidth) / 100}
                        y2={(plate.y * GraphHeight) / 100}
                        pathLength={1}
                        data-i={i}
                    />
                ))}
            </svg>
            {IdeaPlates.map((plate, i) => (
                <span
                    key={plate.key}
                    className="mt-pour-brokk-plate"
                    data-centre={i === 0 ? "" : undefined}
                    data-i={i}
                    style={{ left: `${plate.x}%`, top: `${plate.y}%` }}
                >
                    {t(`onboarding.pour.brokk.idea.${plate.key}`)}
                </span>
            ))}
        </div>
    );
}

function BrainstormTeach({ name }: { name: string }) {
    const t = useT();
    return (
        <section className="mt-pour-brokk-idea" data-testid="pour-brokk-brainstorm">
            <div className="mt-pour-brokk-idea-text">
                <b>{t("onboarding.pour.brokk.ideaLead")}</b>
                <span>{withCodes(t("onboarding.pour.brokk.ideaText", { name }), { brainstorm: BrainstormCommand })}</span>
            </div>
            <IdeaGraph />
        </section>
    );
}

export function BrokkScene({ intro }: { intro: BrokkIntro }) {
    const t = useT();
    const b = "onboarding.pour.brokk";
    const name = brokkShownName(intro);
    const keys = formatShortcutById("palette");
    return (
        <div className="mt-pour-inner" data-testid="pour-brokk">
            <div className="mt-pour-brokk-face" data-testid="pour-brokk-face">
                {intro?.face ?? <BrokkIntroMark name={name} />}
                <GlowRing on />
            </div>
            <div className="mt-pour-kicker">{t(`${b}.kicker`)}</div>
            <h1>
                {t(`${b}.titleA`, { name })} <span className="mt-pour-hot">{t(`${b}.titleB`)}</span>
            </h1>
            <p className="mt-pour-sub mt-pour-brokk-says" data-testid="pour-brokk-says">
                {t(`${b}.says`)}
            </p>
            <p className="mt-pb-morphline mt-pour-brokk-where" data-testid="pour-brokk-where">
                {intro?.off ? t(`${b}.off`, { name }) : withKeys(t(`${b}.where`), keys)}
            </p>
            {intro?.brainstorm ? <BrainstormTeach name={name} /> : null}
        </div>
    );
}
