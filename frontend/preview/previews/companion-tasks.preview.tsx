// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The agent companion's Tasks block (#2416, FR-SHELL-018) on invented data: one tab per open milestone, a late one
// beside the agents at work, a finished one that waits for its release, and the narrow companion with its +N chip. The
// frames hold the real work area. ?lang=fr shows them in French.

import type { AgentStateInfo } from "../../moltenterm-shell/agent-state-model";
import { ColumnsBand } from "../../moltenterm-shell/companion/companion-layout";
import { MilestoneInfo, MilestonesView } from "../../moltenterm-shell/companion/companion-milestone-model";
import { CompanionSubagent, CompanionView } from "../../moltenterm-shell/companion/companion-model";
import { CompanionWork } from "../../moltenterm-shell/companion/companion-work";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";

import "../../moltenterm-shell/molten-button.css";
import "../../moltenterm-shell/moltenterm-shell.css";

const Min = 60 * 1000;
const Day = 24 * 60 * Min;
const Now = Date.UTC(2026, 10, 19, 12);

const language = new URLSearchParams(globalThis.location?.search).get("lang");
if (language) {
    I18nModel.getInstance().setLanguageSetting(language);
}
const french = language === "fr";

const agentState: AgentStateInfo = {
    blockid: "preview-terminal",
    agent: "claude",
    agentname: "Claude Code",
    state: "working",
    version: 1,
};

const subagents: CompanionSubagent[] = [
    {
        id: "a",
        description: "#41 Fix the checkout total",
        branch: "fix/41-checkout-total",
        kind: "sf-fix",
        model: "claude-opus-5-5",
        background: true,
        state: "running",
        started: Now - 120 * Min,
    },
    {
        id: "b",
        description: "#38 Receipt e-mail in the buyer's language",
        branch: "feature/38-receipt-language",
        kind: "sf-build",
        model: "claude-sonnet-5-5",
        background: true,
        state: "running",
        started: Now - 20 * Min,
    },
    {
        id: "c",
        description: "#35 Faster product search",
        branch: "feature/35-search",
        kind: "sf-build",
        model: "claude-sonnet-5-5",
        background: true,
        state: "running",
        started: Now - 5 * Min,
    },
];

const view: CompanionView = {
    blockid: "preview-terminal",
    version: 1,
    status: "live",
    agent: "claude",
    agentname: "Claude Code",
    session: { path: "/s.jsonl", linkedby: "hook", branch: "develop", title: "Prepare the shop's 2.4 release" },
    todos: [],
    subagents,
};

const sentences: Record<number, [string, string]> = {
    41: ["The checkout total shows once instead of twice.", "Le total du panier ne s'affiche plus qu'une fois."],
    38: [
        "The receipt e-mail is written in the buyer's language.",
        "L'e-mail de reçu s'écrit dans la langue de l'acheteur.",
    ],
    35: [
        "The product search answers faster on a large catalogue.",
        "La recherche de produits répond plus vite sur un grand catalogue.",
    ],
    33: ["Wishlists can be shared by a link.", "Les listes d'envies se partagent par un lien."],
    31: [
        "The order page lists the parcel's tracking steps.",
        "La page de commande liste les étapes de suivi du colis.",
    ],
    29: [
        "Prices round the same way in the cart and on the invoice.",
        "Les prix s'arrondissent pareil dans le panier et sur la facture.",
    ],
    27: [
        "The admin can export last month's orders as a file.",
        "L'administrateur peut exporter les commandes du mois dernier.",
    ],
    25: [
        "Coupons can be limited to one product category.",
        "Les coupons peuvent se limiter à une catégorie de produits.",
    ],
};

function tickets(numbers: number[]) {
    return numbers.map((number) => ({
        number,
        title: `Ticket ${number} title`,
        url: `https://github.com/example/shop/issues/${number}`,
        sentence: sentences[number]?.[french ? 1 : 0],
    }));
}

function milestone(m: Partial<MilestoneInfo> & Pick<MilestoneInfo, "number" | "title">): MilestoneInfo {
    return {
        url: `https://github.com/example/shop/milestone/${m.number}`,
        open: 0,
        closed: 0,
        remaining: m.open ?? 0,
        tickets: [],
        loaded: true,
        ...m,
    };
}

const late = milestone({
    number: 2,
    title: "1.0.0",
    due: Now - 21 * Day,
    open: 12,
    closed: 1082,
    tickets: tickets([41, 38, 35, 33, 31, 29, 27, 25, 23, 21, 19, 17]),
});
const next = milestone({
    number: 3,
    title: "1.1.0",
    due: Now + 40 * Day,
    open: 6,
    closed: 2,
    tickets: tickets([51, 52, 53, 54, 55, 56]),
});
const later = milestone({ number: 4, title: "Later", open: 9, closed: 0, tickets: tickets([61, 62, 63]) });
const ideas = milestone({ number: 5, title: "Ideas", open: 4, closed: 0, tickets: tickets([71, 72]) });
const backlog = milestone({ number: 6, title: "Backlog", open: 30, closed: 0, loaded: false });

const released = milestone({ number: 13, title: "v1.3.0", due: Now + 8 * Day, open: 0, closed: 36 });
const upcoming = milestone({
    number: 14,
    title: "v1.4.0",
    due: Now + 29 * Day,
    open: 41,
    closed: 1,
    tickets: tickets([201, 202, 203]),
});

const MainView: MilestonesView = { dir: "/shop", state: "ok", milestones: [late, next, later] };
const ReadyView: MilestonesView = { dir: "/shop", state: "ok", milestones: [released, upcoming] };
const NarrowView: MilestonesView = { dir: "/shop", state: "ok", milestones: [late, next, later, ideas, backlog] };

const TasksOnly: ColumnsBand = { kind: "columns", ids: ["tasks"], left: ["tasks"], right: [] };

function Frame({
    name,
    width,
    milestones,
    band,
    chosen,
}: {
    name: string;
    width: number;
    milestones: MilestonesView;
    band?: ColumnsBand;
    chosen?: number;
}) {
    return (
        <div className="flex flex-col gap-1">
            <div className="text-11 text-muted">{name}</div>
            <div
                className="overflow-hidden bg-surface-1 pb-6 text-primary"
                style={{ width }}
                data-testid={`companion-frame-${name}`}
            >
                <CompanionWork
                    view={view}
                    agentState={agentState}
                    dir=""
                    now={Now}
                    band={band}
                    milestones={milestones}
                    chosen={chosen}
                />
            </div>
        </div>
    );
}

// ?frame=narrow shows one frame alone, for a capture of it.
const only = new URLSearchParams(globalThis.location?.search).get("frame");

export function CompanionTasksPreview() {
    const shows = (name: string) => !only || only === name;
    return (
        <div className="flex flex-col gap-6 p-4" data-testid="companion-tasks-preview">
            {shows("main") ? <Frame name="main" width={1240} milestones={MainView} /> : null}
            {shows("ready") ? <Frame name="ready" width={820} milestones={ReadyView} band={TasksOnly} /> : null}
            {shows("other-tab") ? (
                <Frame name="other-tab" width={820} milestones={ReadyView} band={TasksOnly} chosen={14} />
            ) : null}
            {shows("narrow") ? <Frame name="narrow" width={420} milestones={NarrowView} /> : null}
        </div>
    );
}
