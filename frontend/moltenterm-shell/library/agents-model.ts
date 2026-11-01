// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The library's Agents section (FR-SHELL-088 #1699): every agent of wavesrv's catalog (pkg/molten/onboarding), one
// page each in the same layout, no vendor ranked first. Pure, so the rules are tested without a window.

import type {
    AgentFacts,
    AgentUninstall,
    OnboardingAgent,
    OnboardingAgents,
} from "../../moltenterm-onboarding/onboarding-agent-model";
import type { CliInstallStatus } from "../../moltenterm-onboarding/onboarding-install-model";
import { pourAgentCards, type PourAgentCard } from "../../moltenterm-onboarding/onboarding-pour-agents";

export type LibraryAgent = { card: PourAgentCard; agent: OnboardingAgent };

// The pour's cards (same detection, same accounts), recipes aside: an agent page installs and uninstalls a program,
// a recipe has none. Found first, then the others, each group by name.
export function libraryAgents(list: OnboardingAgents): LibraryAgent[] {
    const byId = new Map((list?.agents ?? []).map((a) => [a.id, a]));
    const rows = pourAgentCards(list)
        .filter((c) => !c.recipe && byId.has(c.id))
        .map((card) => ({ card, agent: byId.get(card.id) }));
    const byName = (a: LibraryAgent, b: LibraryAgent) =>
        a.card.name.localeCompare(b.card.name, "en", { sensitivity: "base" });
    return [...rows.filter((r) => r.card.ready).sort(byName), ...rows.filter((r) => !r.card.ready).sort(byName)];
}

export type AgentStatusKind = "missing" | "signedin" | "signinunseen";

// Keys of library.agents.status.<kind>. A sign-in MoltenTerm did not see is never said to be missing: the keychain
// may hold it.
export function agentStatusKind(card: PourAgentCard): AgentStatusKind {
    if (!card?.ready) {
        return "missing";
    }
    return card.signedIn ? "signedin" : "signinunseen";
}

export type UninstallOffer = "none" | "button" | "manual";

// Uninstall is a button only when the catalog has the vendor's command for the way this copy was installed; a copy
// found without one gets the manual way and the docs link; an agent not found has nothing to remove.
export function uninstallOffer(agent: OnboardingAgent): UninstallOffer {
    if (!agent?.found) {
        return "none";
    }
    return agent.uninstall?.available && agent.uninstall.command ? "button" : "manual";
}

// The documented commands, for the manual way: each method's command once, the undocumented ones left out.
export function manualUninstallCommands(agent: OnboardingAgent): AgentUninstall[] {
    const seen = new Set<string>();
    return (agent?.uninstallmethods ?? []).filter((m) => {
        if (!m.command || seen.has(m.command)) {
            return false;
        }
        seen.add(m.command);
        return true;
    });
}

// What the confirmation names: the program's files the command removes, and, ticked only, the settings and sign-in
// folders wavesrv moves to the trash (never deleted).
export function uninstallRemoves(
    uninstall: AgentUninstall,
    removeConfig: boolean
): { files: string[]; trash: string[] } {
    return { files: uninstall?.removes ?? [], trash: removeConfig ? (uninstall?.config ?? []) : [] };
}

export function canRemoveConfig(uninstall: AgentUninstall): boolean {
    return (uninstall?.config ?? []).length > 0;
}

// The plain words for what the settings folders hold; an agent without its own sentence gets the general one.
export function configHoldsKey(uninstall: AgentUninstall): string {
    return uninstall?.configholdskey || "library.agents.uninstall.holds.other";
}

export type PriceLine = {
    // keys of library.agents.price.<key>
    key: "free" | "freeThen" | "freeThenBare" | "from" | "fromBare" | "notstated";
    vars?: { amount: string; currency: string; period: string; plan?: string };
    noteKey?: string;
    // the vendor does not say whether a free plan runs the CLI
    freeUnknown?: boolean;
};

// The cost line of FR-ONB-008 AC-2: free to start when the vendor says so, the cheapest plan as the vendor's page shows
// it (no conversion, no rounding), else not stated. null without a profile.
export function priceLine(profile: AgentFacts): PriceLine {
    if (profile == null) {
        return null;
    }
    const from = profile.from;
    const free = profile.freetier === "yes";
    const freeUnknown = profile.freetier === "notstated";
    if (!from?.amount) {
        return free ? { key: "free" } : { key: "notstated", freeUnknown };
    }
    const vars = {
        amount: from.amount,
        currency: from.currency ?? "",
        period: from.period === "year" ? "year" : "month",
        plan: from.plan,
    };
    const bare = !from.plan;
    if (free) {
        return { key: bare ? "freeThenBare" : "freeThen", vars, noteKey: from.notekey };
    }
    return { key: bare ? "fromBare" : "from", vars, noteKey: from.notekey, freeUnknown };
}

// Whether the profile says anything: an agent the research has not covered yet (Gemini CLI) shows no profile block.
export function hasProfile(profile: AgentFacts): boolean {
    if (profile == null) {
        return false;
    }
    return (
        (profile.models?.length ?? 0) > 0 ||
        !!profile.goodforkey ||
        (profile.strengthkeys?.length ?? 0) > 0 ||
        (profile.weakkeys?.length ?? 0) > 0 ||
        profile.from != null ||
        !!profile.freetier
    );
}

const StaleDays = 90;

// After 90 days the page says the facts may have changed (#1697's decision 8).
export function isStale(checkedOn: string, now: Date): boolean {
    const checked = Date.parse(checkedOn);
    if (!Number.isFinite(checked)) {
        return false;
    }
    return now.getTime() - checked > StaleDays * 24 * 60 * 60 * 1000;
}

export const BeyondCodeKinds = ["writing", "research", "images", "voice"] as const;

// What the page's Uninstall shows from the agent's job: an install's status is not an uninstall's.
export function uninstallStatus(job: CliInstallStatus): CliInstallStatus {
    return job?.kind === "uninstall" ? job : null;
}

export function installStatus(job: CliInstallStatus): CliInstallStatus {
    return job != null && job.kind !== "uninstall" ? job : null;
}

export type UninstallPhase = "idle" | "running" | "done" | "stillfound" | "failed" | "canceled";

// After the command, the page checks again: the agent gone is done, still found says so (another copy on the PATH).
export function uninstallPhase(job: CliInstallStatus, found: boolean): UninstallPhase {
    switch (job?.state) {
        case "running":
            return "running";
        case "failed":
            return "failed";
        case "canceled":
            return "canceled";
        case "succeeded":
            return found ? "stillfound" : "done";
    }
    return "idle";
}

// The compatibility matrix (FR-AGC-001), read through its route when wavesrv serves it (#1696); the detailed rows are
// #1685's. Only the counts are shown here: the matrix's feature names are not translated yet.
export type MatrixCell = { level: string };
export type MatrixRow = { id: string; features: Record<string, MatrixCell> };
export type Matrix = { asof?: string; features?: { id: string }[]; agents?: MatrixRow[] };

export type MatrixSummary = { native: number; adapted: number; limited: number; total: number; asof?: string };

export function matrixSummary(matrix: Matrix, agentId: string): MatrixSummary {
    const features = matrix?.features ?? [];
    const row = matrix?.agents?.find((a) => a.id === agentId);
    if (row == null || features.length === 0) {
        return null;
    }
    const rtn: MatrixSummary = { native: 0, adapted: 0, limited: 0, total: features.length, asof: matrix.asof };
    for (const f of features) {
        const level = row.features?.[f.id]?.level;
        if (level === "native") {
            rtn.native++;
        } else if (level === "adapted") {
            rtn.adapted++;
        } else if (level === "process-only") {
            rtn.limited++;
        }
    }
    return rtn;
}

// ---------- Help me choose (FR-ONB-008 AC-6 to AC-9, #1697's choice.json) ----------

export type ChooseGoal = "code" | "write-research" | "first-try" | "dontknow";
export type ChooseBudget = "free" | "around-20" | "more" | "dontknow";
export type ChooseAnswers = { goal?: ChooseGoal; budget?: ChooseBudget; already?: string };

export const ChooseGoals: ChooseGoal[] = ["code", "write-research", "first-try", "dontknow"];
export const ChooseBudgets: ChooseBudget[] = ["free", "around-20", "more", "dontknow"];
// The subscriptions of the catalog by product name (data, not translated), then None.
export const ChooseSubscriptions: { id: string; label: string }[] = [
    { id: "chatgpt", label: "ChatGPT" },
    { id: "claude", label: "Claude" },
    { id: "google-ai", label: "Google AI (Gemini)" },
    { id: "github-copilot", label: "GitHub Copilot" },
    { id: "cursor", label: "Cursor" },
    { id: "x-subscription", label: "The X Subscription / SuperGrok" },
    { id: "mistral", label: "Mistral (Vibe, ex-Le Chat)" },
    { id: "kimi", label: "Kimi" },
    { id: "zai", label: "Z.ai" },
    { id: "minimax", label: "MiniMax" },
    { id: "qwencloud", label: "QwenCloud / Alibaba Model Studio" },
];
export const ChooseNone = "none";
export const ChooseShown = 2;

export type ChooseReason = { key: string; vars?: Record<string, string> };
export type ChooseSuggestion = { row: LibraryAgent; reasons: ChooseReason[] };
export type ChooseResult = { shown: ChooseSuggestion[]; others: ChooseSuggestion[] };

// A seeded draw, so tests can fix it; the path draws a new seed each time it opens.
function seededRandom(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function shuffled<T>(items: T[], rand: () => number): T[] {
    const rtn = [...items];
    for (let i = rtn.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [rtn[i], rtn[j]] = [rtn[j], rtn[i]];
    }
    return rtn;
}

function priceAmount(profile: AgentFacts): number {
    const raw = profile?.from?.amount;
    if (!raw) {
        return null;
    }
    const n = Number(raw.replace(",", "."));
    return Number.isFinite(n) ? n : null;
}

function withinBudget(profile: AgentFacts, budget: ChooseBudget): boolean {
    if (budget == null || budget === "more" || budget === "dontknow") {
        return true;
    }
    const free = profile?.freetier === "yes";
    if (budget === "free") {
        return free;
    }
    const amount = priceAmount(profile);
    // compared within its own currency, never converted (rule 2)
    return free || (amount != null && amount <= 20);
}

function reasonsFor(row: LibraryAgent, answers: ChooseAnswers, paid: boolean): ChooseReason[] {
    const profile = row.agent.profile;
    const amount = priceAmount(profile);
    const rtn: ChooseReason[] = [];
    if (paid) {
        const plan = ChooseSubscriptions.find((s) => s.id === answers.already)?.label ?? answers.already;
        rtn.push({ key: "library.agents.choose.reasons.already-paid", vars: { plan } });
    }
    if (profile?.freetier === "yes") {
        rtn.push({ key: "library.agents.choose.reasons.free-to-start" });
    } else if (answers.budget === "around-20" && amount != null && amount <= 20) {
        rtn.push({
            key: "library.agents.choose.reasons.within-budget",
            vars: { amount: profile.from.amount, currency: profile.from.currency ?? "" },
        });
    }
    if (answers.goal && answers.goal !== "dontknow") {
        rtn.push({ key: `library.agents.choose.reasons.goal-${answers.goal}` });
    }
    return rtn.slice(0, 3);
}

// The fixed rules of choice.json: a subscription the developer already pays that includes the agent first, whatever
// the budget; then the budget and the use filters; a random order inside each group, never by vendor or price; two
// shown, the others behind "See the N other matches".
export function chooseAgents(rows: LibraryAgent[], answers: ChooseAnswers, seed: number): ChooseResult {
    const rand = seededRandom(seed);
    const goal = answers.goal;
    const usesGoal = (row: LibraryAgent) =>
        goal == null || goal === "dontknow" || (row.agent.profile?.uses ?? []).includes(goal);
    const candidates = (rows ?? []).filter((r) => r.agent.profile != null && usesGoal(r));
    const already = answers.already && answers.already !== ChooseNone ? answers.already : null;
    const paid = already ? candidates.filter((r) => (r.agent.profile.includedin ?? []).includes(already)) : [];
    const rest = candidates.filter((r) => !paid.includes(r) && withinBudget(r.agent.profile, answers.budget));
    const all = [
        ...shuffled(paid, rand).map((row) => ({ row, reasons: reasonsFor(row, answers, true) })),
        ...shuffled(rest, rand).map((row) => ({ row, reasons: reasonsFor(row, answers, false) })),
    ];
    return { shown: all.slice(0, ChooseShown), others: all.slice(ChooseShown) };
}

// The path's state, shared by the Library and the first launch (FR-ONB-008): steps 0 to 2 are the questions, 3 the
// suggestions. The answers stay in the window that asked them.
export const ChooseQuestionCount = 3;
export type ChooseState = { step: number; answers: ChooseAnswers; seed: number };

// A new draw at each opening, so ties never come in the same order (choice.json rule 4).
export function startChooseState(seed: number = Math.floor(Math.random() * 2 ** 31)): ChooseState {
    return { step: 0, answers: {}, seed };
}

export function answerChooseState(state: ChooseState, answers: ChooseAnswers): ChooseState {
    if (state == null || state.step >= ChooseQuestionCount) {
        return state;
    }
    return { ...state, answers: { ...state.answers, ...answers }, step: state.step + 1 };
}

export function backChooseState(state: ChooseState): ChooseState {
    if (state == null || state.step === 0) {
        return state;
    }
    return { ...state, step: state.step - 1 };
}

// The cards the first launch highlights once the path ends: the shown suggestions only, the grid's order untouched.
export function suggestedIds(rows: LibraryAgent[], state: ChooseState): string[] {
    if (state == null || state.step < ChooseQuestionCount) {
        return [];
    }
    return chooseAgents(rows, state.answers, state.seed).shown.map((s) => s.row.card.id);
}

export function priceText(t: (key: string, vars?: Record<string, string>) => string, profile: AgentFacts): string {
    const line = priceLine(profile);
    if (line == null) {
        return "";
    }
    const vars = line.vars
        ? { ...line.vars, plan: line.vars.plan ?? "", period: t(`library.agents.period.${line.vars.period}`) }
        : undefined;
    return t(`library.agents.price.${line.key}`, vars);
}
