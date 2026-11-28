// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The Integration panel's security fix block and its cards (FR-REV-036 AC17, #2591) on invented data, the four steps of
// the validated mockup of #2511: ?step=1 the first-time ask, 2 the fix at work, 3 ready to merge, 4 after the merge.
// ?lang=fr shows them in French. The frame holds the real list (ReviewsList) over an answer made here, so every card,
// tag, fact and button is the product's own.

import { AgentStates } from "../../moltenterm-shell/agent-state-store";
import { I18nModel } from "../../moltenterm-shell/i18n/i18n";
import { ReviewsAnswers } from "../../moltenterm-shell/reviews/reviews-client";
import type { ReviewCheck, ReviewPr, ReviewsAnswer } from "../../moltenterm-shell/reviews/reviews-model";
import { OwnersFilter } from "../../moltenterm-shell/reviews/reviews-owners-filter";
import type { SecurityBlock } from "../../moltenterm-shell/reviews/reviews-security-model";
import { UpcomingAnswers } from "../../moltenterm-shell/reviews/reviews-upcoming-client";
import { ReviewsList } from "../../moltenterm-shell/reviews/reviews-view";
import type { SecurityFix } from "../../moltenterm-shell/reviews/security-fix-model";

import "../../moltenterm-shell/molten-button.css";
import "../../moltenterm-shell/moltenterm-shell.css";

const params = new URLSearchParams(globalThis.location?.search);
const language = params.get("lang");
if (language) {
    I18nModel.getInstance().setLanguageSetting(language);
}
const french = language === "fr";
const text = (en: string, fr: string) => (french ? fr : en);
const step = Math.min(4, Math.max(1, Number(params.get("step") ?? "1") || 1));

const Dir = "/atelier";
const Minute = 60_000;
const Now = Date.now();
const Scan = "Scan dependencies";
const Workflow = "Dependency security";

function checks(failedScan: boolean, pending = 0): ReviewCheck[] {
    const rtn: ReviewCheck[] = Array.from({ length: 13 }, (_, i) => ({
        name: `job ${i + 1}`,
        state: "success" as const,
    }));
    if (pending > 0) {
        return [
            ...rtn.slice(0, 13 - pending).map((c) => ({ ...c })),
            ...rtn.slice(13 - pending).map((c) => ({ ...c, state: "pending" as const })),
            { name: Scan, state: "pending" as const, workflow: Workflow },
        ];
    }
    return [
        ...rtn,
        { name: Scan, state: failedScan ? ("failure" as const) : ("success" as const), workflow: Workflow, runid: 91 },
    ];
}

function ci(list: ReviewCheck[]): ReviewPr["ci"] {
    const count = (state: string) => list.filter((c) => c.state === state).length;
    const failure = count("failure");
    const pending = count("pending");
    return {
        state: failure > 0 ? "failure" : pending > 0 ? "pending" : "success",
        success: count("success"),
        failure,
        pending,
        checks: list,
    };
}

function pr(number: number, ticket: number, title: string, over: Partial<ReviewPr> = {}): ReviewPr {
    return {
        number,
        title: `[#${ticket}] ${title}`,
        url: `https://github.com/exemple/atelier/pull/${number}`,
        branch: `feature/${ticket}-work`,
        base: "develop",
        headoid: `h${number}`.padEnd(40, "0"),
        createdat: new Date(Now - 5 * 60 * Minute).toISOString(),
        updatedat: new Date(Now - 2 * Minute).toISOString(),
        ticket,
        tickettitle: title,
        merge: "clean",
        ci: ci(checks(false)),
        report: { state: "present" },
        unpublished: 0,
        ...over,
    };
}

const BlockedBy = (over: Partial<ReviewPr> = {}) => ({
    merge: "failing" as const,
    ci: ci(checks(true)),
    securityblock: "aaaaaaaaaaaaaaaa",
    ...over,
});

const Advisories: SecurityBlock["advisories"] = [
    { id: "GO-2026-9101", ecosystem: "Go", package: "go.exemple.io/telemetrie", version: "1.4.0", fixed: "1.7.0" },
    { id: "GO-2026-9102", ecosystem: "Go", package: "github.com/exemple/websocket", version: "1.5.3", fixed: "1.5.4" },
    { id: "GHSA-xxxx-0000-yyyy", ecosystem: "npm", package: "exemple-parser", version: "2.1.0", fixed: "2.1.3" },
];

const Block: SecurityBlock = {
    fingerprint: "aaaaaaaaaaaaaaaa",
    check: "Dependency security / Scan dependencies",
    origin: "declared",
    source: "report",
    advisories: Advisories,
    trunkfailing: true,
    shared: true,
    prs: [4102, 4105, 4107].map((number) => ({ number, checks: [Scan], shared: true, reasons: ["trunk" as const] })),
};

const Titles = {
    export: text("Shortcuts: export the list", "Raccourcis : exporter la liste"),
    folders: text("Files: folders sorted first", "Fichiers : tri des dossiers en premier"),
    favicon: text("Browser: favicon of single pages", "Navigateur : favicon des pages uniques"),
    sessions: text("Sessions: resume the last one opened", "Sessions : reprendre la dernière ouverte"),
    tabs: text("Tabs: drag to another window", "Onglets : glisser vers une autre fenêtre"),
    fix: text("Security advisories on 3 dependencies", "Avis de sécurité sur 3 dépendances"),
};

const FixBranch = "fix/4109-avis-dependances";
const FixIds = Advisories.map((a) => a.id);

function fixAt(state: SecurityFix["state"], over: Partial<SecurityFix> = {}): SecurityFix {
    return {
        fingerprint: Block.fingerprint,
        ids: FixIds,
        dir: Dir,
        state,
        auto: true,
        ticket: 4109,
        pr: 4110,
        prurl: "https://github.com/exemple/atelier/pull/4110",
        branch: FixBranch,
        trunk: "develop",
        agent: "claude",
        agentname: "Lucie",
        blockid: "lucie",
        resolution: "bump",
        startedat: Now - 6 * Minute,
        updatedat: Now - Minute,
        ...over,
    };
}

function answerOf(which: number): ReviewsAnswer {
    const exportPr = pr(4100, 4096, Titles.export, {
        reviewdecision: "CHANGES_REQUESTED",
        merge: "blocked",
        branch: "feature/4096-export",
    });
    const tabs = pr(4099, 4095, Titles.tabs, { branch: "feature/4095-tabs" });
    const folders = pr(4102, 4098, Titles.folders, { ...BlockedBy(), branch: "feature/4098-folders" });
    const favicon = pr(4105, 4103, Titles.favicon, {
        ...BlockedBy(),
        branch: "feature/4103-favicon",
        report: { state: "missing" },
    });
    const sessions = pr(4107, 4106, Titles.sessions, { ...BlockedBy(), branch: "feature/4106-sessions" });
    const base = {
        dir: Dir,
        state: "ok" as const,
        repo: "exemple/atelier",
        url: "https://github.com/exemple/atelier",
        target: "develop",
        githubat: Now,
    };
    if (which === 1) {
        return {
            ...base,
            ready: [exportPr, folders, favicon, sessions, tabs],
            drafts: [],
            securityblocks: [Block],
            securityfixes: [],
        };
    }
    if (which === 2) {
        const draft = pr(4110, 4109, Titles.fix, {
            draft: true,
            branch: FixBranch,
            report: { state: "missing" },
            ci: ci(checks(false, 2)),
        });
        return {
            ...base,
            ready: [exportPr, folders, favicon, sessions, tabs],
            drafts: [draft],
            securityblocks: [Block],
            securityfixes: [fixAt("working")],
        };
    }
    if (which === 3) {
        const ready = pr(4110, 4109, Titles.fix, { branch: FixBranch });
        return {
            ...base,
            ready: [exportPr, ready, folders, favicon, sessions, tabs],
            drafts: [],
            securityblocks: [Block],
            securityfixes: [fixAt("ready")],
        };
    }
    const running = pr(4102, 4098, Titles.folders, { branch: "feature/4098-folders", ci: ci(checks(false, 5)) });
    const green = pr(4107, 4106, Titles.sessions, { branch: "feature/4106-sessions" });
    const handed = pr(4105, 4103, Titles.favicon, {
        branch: "feature/4103-favicon",
        report: { state: "missing" },
        ci: ci(checks(false)),
    });
    return {
        ...base,
        ready: [exportPr, running, handed, green, tabs],
        drafts: [],
        securityblocks: [],
        securityfixes: [fixAt("merged", { mergedat: Now - Minute, unblocks: [4102, 4105, 4107] })],
    };
}

// Lucie works on the fix's branch while it is a draft; Bastien works on the favicon branch from the second step on.
function seedAgents() {
    const agents = AgentStates.getInstance();
    agents.apply([
        {
            blockid: "lucie",
            agent: "claude",
            agentname: "Claude Code",
            firstname: "Lucie",
            state: "working",
            since: Now - 6 * Minute,
            started: Now - 6 * Minute,
            model: "claude-opus-5-5",
            modelname: "opus",
            effort: "high",
            version: 1,
        },
        {
            blockid: "bastien",
            agent: "codex",
            agentname: "Codex",
            firstname: "Bastien",
            state: "working",
            since: Now - 14 * Minute,
            started: Now - 14 * Minute,
            model: "gpt-5",
            modelname: "gpt",
            effort: "medium",
            version: 1,
        },
    ]);
    UpcomingAnswers.getInstance().store({
        dir: Dir,
        branches: [],
        agents: [
            ...(step === 2
                ? [
                      {
                          branch: FixBranch,
                          worktree: "/w/lucie",
                          kind: "panel" as const,
                          blockid: "lucie",
                          agent: "claude",
                          firstname: "Lucie",
                          started: Now - 6 * Minute,
                      },
                  ]
                : []),
            ...(step >= 2
                ? [
                      {
                          branch: "feature/4103-favicon",
                          worktree: "/w/bastien",
                          kind: "panel" as const,
                          blockid: "bastien",
                          agent: "codex",
                          firstname: "Bastien",
                          started: Now - 14 * Minute,
                      },
                  ]
                : []),
        ],
        at: Now,
    });
}

const answer = answerOf(step);
seedAgents();
ReviewsAnswers.getInstance().store(answer);

const filter = new OwnersFilter("preview-reviews");

export function ReviewsSecurityPreview() {
    return (
        <div className="p-4" data-testid="reviews-security-preview">
            <div
                className="flex flex-col overflow-hidden rounded-6 border border-border bg-[var(--mt-surface-1)]"
                style={{ width: 600, height: 860 }}
            >
                <div className="flex h-8 items-center gap-2 border-b border-border px-2.5 text-12 text-secondary">
                    <b className="font-medium text-primary">{text("Integration", "Intégration")}</b>
                    <span className="text-muted">· atelier</span>
                    <span className="ml-auto text-11 text-muted">
                        {text("into", "vers")} <code>develop</code>
                    </span>
                </div>
                <ReviewsList dir={Dir} answer={answer} blockId="preview-reviews" filter={filter} />
            </div>
        </div>
    );
}
