// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The brainstorm mode in a view (FR-BOSS-010 AC2, AC3, AC7, DS-BOSS-011, #2246). Its state lives in wavesrv
// (pkg/molten/brainstorm), so every view of every window shows the same layer and a tab switch keeps it; the event only
// says it changed, and the view reads it back from the route. This model:
// - opens it when the developer starts a brainstorm (Brokk's menu) or when his answer opens one;
// - gives each answer of his conversation to wavesrv while it is on, with the graph block it carries;
// - holds the toasts, the system notifications and his visits, lets only what is critical break through at the edge,
//   and says in one line on exit how many things arrived;
// - slides the sidebar in, and brings it back on exit unless the developer showed it meanwhile;
// - ends it when his card closes (Escape, a click on the dim, his square).
//
// It loads on demand (brainstorm-boot.ts), the first time the mode is needed in a view; the 3D scene loads later still,
// behind the stage's own import().

import { atoms, getApi } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import { waveEventSubscribeSingle } from "@/app/store/wps";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { atom, Atom, PrimitiveAtom } from "jotai";
import type { AgentStatesData } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { BossBubbleModel } from "../boss/boss-store";
import { AnswerRead, BrokkSession } from "../boss/brokk-session";
import { currentBrainstormAllowed } from "../build/current-build";
import type { SystemNotifyApi } from "../handoff-system-notify";
import { t, tCount } from "../i18n/i18n";
import { notificationTitle, type MoltentermNotification } from "../notifications-model";
import { MoltentermNotifications } from "../notifications-store";
import { SidebarModel } from "../sidebar/sidebar-store";
import { TabActivity } from "../tab-activity";
import { showToast } from "../toast-store";
import {
    BrainstormEvent,
    BrainstormPromptAtom,
    BrainstormRouteId,
    BrainstormState,
    BrainstormStateAtom,
    BrainstormSummary,
    CallTimeoutMs,
    CloseCommand,
    DeleteCommand,
    FindCommand,
    ForkCommand,
    ListCommand,
    LoadCommand,
    NewCommand,
    OpenCommand,
    RenameCommand,
    StateCommand,
    TurnCommand,
} from "./brainstorm-boot";
import { setBrainstormHold } from "./brainstorm-hold";
import {
    answerQuestions,
    answerStep,
    breaksThrough,
    EmptyTally,
    newlyCrashed,
    pickerOf,
    sidebarOnClose,
    sidebarOnOpen,
    tallied,
    Tally,
} from "./brainstorm-model";

export {
    CloseCommand,
    DeleteCommand,
    FindCommand,
    ForkCommand,
    ListCommand,
    LoadCommand,
    NewCommand,
    OpenCommand,
    RenameCommand,
    StateCommand,
    TurnCommand,
} from "./brainstorm-boot";
export type { BrainstormPrompt, BrainstormState, BrainstormSummary } from "./brainstorm-boot";

// must match the Reason… codes of pkg/molten/brainstorm/service_folders.go
export type FolderFailure = "unknown" | "notsaved" | "noidea" | "invalid" | "trash" | "notrash" | "failed";

// His fork (AC11): the other project he heard, asked in the widget until the developer answers.
export type ForkAsk = { key: string; title: string; reason: string };

// What the widget says of the developer's last action on a folder that did not go through, or of a forget.
export type FolderNotice =
    | { kind: "failed"; failure: FolderFailure }
    | { kind: "forgot"; title: string; trashed: boolean };

// Set on the window's meta while the mode keeps the sidebar slid in: the views of the window bring it back on exit.
export const SidebarSlidMetaKey = "molten:brainstormsidebar";

const SummaryToastId = "brainstorm-summary";

// What broke through the pause: one line at the layer's edge, the latest.
export type Breakthrough = { key: string; kind: "trust" | "crash"; text: string; at: number };

type Call = (command: string, data: Record<string, unknown>) => Promise<any>;

const LiveCall: Call = (command, data) =>
    TabRpcClient.wshRpcCall(command, data, { route: BrainstormRouteId, timeout: CallTimeoutMs });

function notifyApi(): SystemNotifyApi {
    try {
        return getApi() as unknown as SystemNotifyApi;
    } catch {
        return null;
    }
}

export class BrainstormModel {
    private static instance: BrainstormModel = null;

    // The atom the layer reads up front (brainstorm-boot.ts): this model writes it.
    stateAtom = BrainstormStateAtom;
    openAtom: Atom<boolean>;
    // When he last spoke or the graph last grew in this view: the camera follows the topic until a pause.
    talkAtAtom = atom(0) as PrimitiveAtom<number>;
    breakthroughAtom = atom(null) as PrimitiveAtom<Breakthrough>;
    // Where the camera looks, as the stage's scene says (the header's last words, #2257).
    cameraModeAtom = atom("overview") as PrimitiveAtom<"follow" | "overview">;
    tallyAtom = atom(EmptyTally) as PrimitiveAtom<Tally>;
    // The folders (#2248): the question in his talk window, the widget's list and whether it is unfolded, his fork's
    // question, and the line about the last action.
    promptAtom = BrainstormPromptAtom;
    listAtom = atom([]) as PrimitiveAtom<BrainstormSummary[]>;
    widgetOpenAtom = atom(false) as PrimitiveAtom<boolean>;
    forkAtom = atom(null) as PrimitiveAtom<ForkAsk>;
    noticeAtom = atom(null) as PrimitiveAtom<FolderNotice>;

    private call: Call = LiveCall;
    private started = false;
    private paused = false;
    private sent = new Set<string>();
    // The swap each answer began in, by the answer's id (review of #2248).
    private swapOf = new Map<string, number>();
    private asked = new Set<string>();
    private listRev = -1;
    private seen = new Map<string, number>();
    private agentsBefore: AgentStatesData = null;
    private cardWasOpen = false;
    // The mode opened his card in this view (a tab switch onto it): it closes it again when it ends.
    private cardOpenedByMode = false;
    private stops: (() => void)[] = [];

    private constructor() {
        this.openAtom = atom((get) => get(this.stateAtom)?.open === true);
    }

    static getInstance(): BrainstormModel {
        if (BrainstormModel.instance == null) {
            BrainstormModel.instance = new BrainstormModel();
        }
        return BrainstormModel.instance;
    }

    static resetInstance(): void {
        BrainstormModel.instance?.stop();
        BrainstormModel.instance = null;
        globalStore.set(BrainstormStateAtom, null);
        globalStore.set(BrainstormPromptAtom, null);
    }

    useCall(call: Call): void {
        this.call = call;
    }

    allowed(): boolean {
        return currentBrainstormAllowed();
    }

    isOpen(): boolean {
        return globalStore.get(this.openAtom);
    }

    private onScreen(): boolean {
        return globalStore.get(TabActivity.getInstance().onScreenAtom) !== false;
    }

    // Listens while the view lives. Does nothing on a release channel: the layer, the graph and the pause do not exist.
    start(): () => void {
        if (this.started || !this.allowed()) {
            return () => {};
        }
        this.started = true;
        const boss = BossBubbleModel.getInstance();
        try {
            this.stops.push(
                waveEventSubscribeSingle({
                    eventType: BrainstormEvent as WaveEventName,
                    handler: () => void this.refresh(),
                })
            );
        } catch (e) {
            console.log("brainstorm: no event bus", e);
        }
        // Each reading of his answer that brings words is him speaking: the camera follows the topic (#2259: the session
        // no longer holds a speaking flag, his face's speech is brokk-speech.ts's).
        this.stops.push(
            BrokkSession.getInstance().listenAnswers((answer) => {
                globalStore.set(this.talkAtAtom, Date.now());
                void this.onAnswer(answer);
            })
        );
        this.cardWasOpen = globalStore.get(boss.cardOpenAtom);
        this.stops.push(globalStore.sub(boss.cardOpenAtom, () => this.onCard(globalStore.get(boss.cardOpenAtom))));
        const notifications = MoltentermNotifications.getInstance();
        this.stops.push(globalStore.sub(notifications.entriesAtom, () => this.onEntries(notifications.entries())));
        const agents = AgentStates.getInstance();
        this.stops.push(globalStore.sub(agents.dataAtom, () => this.onAgents(globalStore.get(agents.dataAtom))));
        const activity = TabActivity.getInstance();
        this.stops.push(globalStore.sub(activity.onScreenAtom, () => this.onScreenChange()));
        void this.refresh();
        return () => this.stop();
    }

    stop(): void {
        this.stops.splice(0).forEach((stop) => stop());
        this.started = false;
    }

    private async ask(command: string, data: Record<string, unknown>): Promise<any> {
        try {
            return await this.call(command, data);
        } catch (e) {
            console.log("brainstorm: wavesrv did not answer", command, e);
            return null;
        }
    }

    async refresh(): Promise<void> {
        this.apply(await this.ask(StateCommand, {}));
    }

    // A state read back from wavesrv; an older one than the view has is dropped. A restarted wavesrv counts its versions
    // from 0 again, so only a state of the same wavesrv is compared.
    apply(next: BrainstormState): void {
        if (next == null) {
            return;
        }
        const current = globalStore.get(this.stateAtom);
        if (current != null && next.session === current.session && next.version < current.version) {
            return;
        }
        const wasOpen = current?.open === true;
        const grew = (next.graph?.rev ?? 0) !== (current?.graph?.rev ?? 0);
        globalStore.set(this.stateAtom, next);
        if (grew && next.open) {
            globalStore.set(this.talkAtAtom, Date.now());
        }
        if (!wasOpen && next.open) {
            this.opened();
        } else if (wasOpen && !next.open) {
            this.closed();
        }
        if (next.open && (next.listrev ?? 0) !== this.listRev) {
            this.listRev = next.listrev ?? 0;
            void this.refreshList();
        }
    }

    // The widget's list, read again when it changed.
    async refreshList(): Promise<BrainstormSummary[]> {
        const result = await this.ask(ListCommand, {});
        const list: BrainstormSummary[] = result?.brainstorms ?? [];
        globalStore.set(this.listAtom, list);
        return list;
    }

    // The developer starts a brainstorm (Brokk's menu, the palette, `/brainstorm`, FR-BOSS-010 AC2): his card opens and the
    // layer dims at once. With no idea his talk window offers the saved ones first (the picker of AC10a, #2248); with
    // none saved, he says his opening line and the next message tells his session it is a brainstorm.
    // With an idea (`/brainstorm <idea>`, #2257) the developer's next message is that idea, so he says no opening line of
    // his own: his answer puts it at the centre. Unless one of nearly that title is saved: he asks first (AC10a), and the
    // field does not send it. Resolves true when the field sends the idea now.
    async begin(idea = ""): Promise<boolean> {
        if (!this.allowed()) {
            return false;
        }
        const boss = BossBubbleModel.getInstance();
        const session = BrokkSession.getInstance();
        boss.openCard(undefined, { force: true });
        boss.pinCard();
        const wasOpen = this.isOpen();
        const state: BrainstormState = await this.ask(OpenCommand, { by: "you" });
        this.apply(state);
        if (state == null) {
            return false;
        }
        globalStore.set(this.promptAtom, null);
        if (idea !== "") {
            const found = await this.ask(FindCommand, { title: idea });
            if (found?.match != null) {
                globalStore.set(this.promptAtom, { kind: "duplicate", idea, match: found.match });
                focusTalkField();
                return false;
            }
            session.setLead(t("boss.brainstorm.lead"));
            return true;
        }
        const picker = pickerOf(await this.refreshList());
        if (picker != null) {
            globalStore.set(this.promptAtom, picker);
        } else if (!wasOpen) {
            this.sayOpening();
        }
        focusTalkField();
        return false;
    }

    private sayOpening(): void {
        const session = BrokkSession.getInstance();
        session.addLocalLine(
            t("boss.brainstorm.opening", { name: globalStore.get(BossBubbleModel.getInstance().nameAtom) })
        );
        session.setLead(t("boss.brainstorm.lead"));
    }

    dismissPrompt(): void {
        globalStore.set(this.promptAtom, null);
    }

    private failed(failure: FolderFailure): void {
        globalStore.set(this.noticeAtom, { kind: "failed", failure });
    }

    // Moves to a saved brainstorm (AC10, AC10c): the developer's click on Resume, Load or a chip. wavesrv saves the one
    // open first; then the graph swaps, his talk window shows that brainstorm's conversation, he says where it was, and
    // the next message tells his session to read the resume brief wavesrv put in his folder.
    async load(slug: string): Promise<boolean> {
        if (!this.allowed() || !slug) {
            return false;
        }
        this.dismissPrompt();
        globalStore.set(this.forkAtom, null);
        const boss = BossBubbleModel.getInstance();
        boss.openCard(undefined, { force: true });
        boss.pinCard();
        const result = await this.ask(LoadCommand, { slug });
        if (result?.state == null) {
            this.failed("failed");
            return false;
        }
        this.apply(result.state);
        if (result.error) {
            this.failed(result.error);
            return false;
        }
        globalStore.set(this.noticeAtom, null);
        globalStore.set(this.widgetOpenAtom, false);
        const title = result.state.brainstorm?.title ?? "";
        const session = BrokkSession.getInstance();
        session.stopFollowing();
        session.showConversation(result.turns ?? []);
        session.addLocalLine(t("boss.brainstorm.resume", { title }));
        this.leadInto(title, result.resumebrief === true);
        focusTalkField();
        return true;
    }

    // The next message tells his session it is this brainstorm: to read its resume brief when wavesrv wrote one, else
    // only that it is a brainstorm (an old brief in his folder is never pointed to).
    private leadInto(title: string, resumeBrief: boolean): void {
        BrokkSession.getInstance().setLead(
            resumeBrief ? t("boss.brainstorm.resumedLead", { title }) : t("boss.brainstorm.lead")
        );
    }

    // A new idea (AC10): the one open stays saved, his talk window starts over with his opening line, and the folder is
    // made at his first central idea.
    async newIdea(): Promise<boolean> {
        if (!this.allowed()) {
            return false;
        }
        this.dismissPrompt();
        globalStore.set(this.forkAtom, null);
        const result = await this.ask(NewCommand, {});
        if (result?.state == null) {
            this.failed("failed");
            return false;
        }
        this.apply(result.state);
        if (result.error) {
            this.failed(result.error);
            return false;
        }
        globalStore.set(this.noticeAtom, null);
        globalStore.set(this.widgetOpenAtom, false);
        BrokkSession.getInstance().stopFollowing();
        BrokkSession.getInstance().showConversation([]);
        this.sayOpening();
        focusTalkField();
        return true;
    }

    // The duplicate's Start fresh: a new idea, and the idea goes as the message whose answer puts it at the centre.
    async startFresh(idea: string): Promise<void> {
        if (!(await this.newIdea())) {
            return;
        }
        const session = BrokkSession.getInstance();
        session.setLead(t("boss.brainstorm.lead"));
        await session.say(idea);
    }

    // All brainstorms… unfolds the widget's list (AC10a).
    showAll(): void {
        this.dismissPrompt();
        globalStore.set(this.widgetOpenAtom, true);
        void this.refreshList();
    }

    async rename(slug: string, title: string): Promise<boolean> {
        const clean = (title ?? "").trim();
        if (!this.allowed() || !slug || clean === "") {
            return false;
        }
        const result = await this.ask(RenameCommand, { slug, title: clean });
        if (result?.state == null) {
            this.failed("failed");
            return false;
        }
        this.apply(result.state);
        if (result.error) {
            this.failed(result.error);
            return false;
        }
        globalStore.set(this.noticeAtom, null);
        void this.refreshList();
        return true;
    }

    // Forgets a brainstorm (AC10d). Called only from the confirm button of a question that showed its title and last
    // change: Brokk's forget operation, or the widget's Delete, only ask it. It names the brainstorm by its slug and id,
    // so that a folder renamed meanwhile is never the one taken. Its folder goes to the trash, or, where the system has
    // none, is removed for good as that question said; wavesrv takes away its resume brief, and its title leaves his
    // brief's list.
    async forgetFolder(summary: BrainstormSummary): Promise<boolean> {
        if (!this.allowed() || !summary?.slug) {
            return false;
        }
        this.dismissPrompt();
        const state = globalStore.get(this.stateAtom);
        const wasOpen = state?.brainstorm?.slug === summary.slug;
        const result = await this.ask(DeleteCommand, {
            slug: summary.slug,
            id: summary.id ?? "",
            permanent: state?.cantrash !== true,
        });
        if (result?.state == null) {
            this.failed("failed");
            return false;
        }
        this.apply(result.state);
        if (result.error) {
            this.failed(result.error);
            return false;
        }
        if (wasOpen) {
            BrokkSession.getInstance().stopFollowing();
        }
        const title = result.summary?.title ?? "";
        globalStore.set(this.noticeAtom, { kind: "forgot", title, trashed: result.trashed === true });
        BrokkSession.getInstance().addLocalLine(
            t(result.trashed ? "boss.brainstorm.forgotTrash" : "boss.brainstorm.forgotRemoved", { title })
        );
        void this.refreshList();
        return true;
    }

    // Yes to his fork (AC11): its own folder, both graphs keep a reference, and the mode moves to it.
    async forkYes(): Promise<boolean> {
        const ask = globalStore.get(this.forkAtom);
        if (ask == null || !this.allowed()) {
            return false;
        }
        globalStore.set(this.forkAtom, null);
        const result = await this.ask(ForkCommand, { title: ask.title, reason: ask.reason });
        if (result?.state == null) {
            this.failed("failed");
            return false;
        }
        this.apply(result.state);
        if (result.error) {
            this.failed(result.error);
            return false;
        }
        const title = result.state.brainstorm?.title ?? ask.title;
        const session = BrokkSession.getInstance();
        session.stopFollowing();
        session.showConversation([]);
        session.addLocalLine(t("boss.brainstorm.forked", { title }));
        this.leadInto(title, result.resumebrief === true);
        focusTalkField();
        return true;
    }

    // No, we stay here: nothing moves.
    forkNo(): void {
        globalStore.set(this.forkAtom, null);
    }

    // His questions about the folders in a complete answer (#2248): each becomes a question to the developer, once per
    // answer. resume and forget name a saved title: wavesrv finds it, and nothing is asked for a title it does not have.
    private async onQuestions(answer: AnswerRead): Promise<void> {
        const questions = answerQuestions({ markdown: answer.markdown, final: answer.final, allowed: this.allowed() });
        if (questions == null) {
            return;
        }
        const key = `${answer.turn}:${answer.id}`;
        if (this.asked.has(key)) {
            return;
        }
        this.asked.add(key);
        if (questions.fork != null && this.isOpen() && globalStore.get(this.stateAtom)?.brainstorm != null) {
            globalStore.set(this.forkAtom, { key, ...questions.fork });
        }
        const title = questions.forget ?? questions.resume;
        if (title == null) {
            return;
        }
        const found = await this.ask(FindCommand, { title });
        const match: BrainstormSummary = found?.match;
        if (match == null) {
            return;
        }
        if (questions.forget != null) {
            globalStore.set(this.promptAtom, { kind: "forget", match });
            return;
        }
        if (globalStore.get(this.stateAtom)?.brainstorm?.slug === match.slug && this.isOpen()) {
            return;
        }
        globalStore.set(this.promptAtom, { kind: "resume", match });
    }

    async end(): Promise<void> {
        if (!this.isOpen()) {
            return;
        }
        this.apply(await this.ask(CloseCommand, {}));
    }

    // Each reading of his answer: the turn goes to wavesrv once, as soon as its graph block is complete, else once his
    // agent is done (a turn of words alone). Outside the mode only an answer that opens a brainstorm goes.
    async onAnswer(answer: AnswerRead): Promise<void> {
        // The brainstorm this answer began in: wavesrv refuses its turn once the developer moved to another one.
        const swap = globalStore.get(this.stateAtom)?.swap;
        if (!this.swapOf.has(answer.id) && swap != null) {
            this.swapOf.set(answer.id, swap);
        }
        void this.onQuestions(answer);
        const step = answerStep({
            markdown: answer.markdown,
            turn: answer.turn,
            final: answer.final,
            open: this.isOpen(),
            allowed: this.allowed(),
        });
        if (step.kind !== "turn" || this.sent.has(step.key)) {
            return;
        }
        this.sent.add(step.key);
        if (step.dropped !== "") {
            // Never the content (FR-BOSS-010 AC8): the reason alone.
            console.log("brainstorm: a graph block was dropped:", step.dropped);
        }
        globalStore.set(this.talkAtAtom, Date.now());
        const result = await this.ask(TurnCommand, {
            key: step.key,
            you: answer.you,
            brokk: step.text,
            block: step.block,
            at: Date.now(),
            swap: this.swapOf.get(answer.id),
        });
        this.apply(result?.state);
    }

    private opened(): void {
        this.pause(true);
        this.sent.clear();
        this.seen = new Map(
            MoltentermNotifications.getInstance()
                .entries()
                .map((e) => [e.id, e.updated])
        );
        globalStore.set(this.tallyAtom, EmptyTally);
        globalStore.set(this.breakthroughAtom, null);
        globalStore.set(this.cameraModeAtom, "overview");
        this.agentsBefore = globalStore.get(AgentStates.getInstance().dataAtom);
        globalStore.set(this.talkAtAtom, Date.now());
        if (this.onScreen()) {
            this.takeTheScreen();
        }
    }

    // On screen while the mode is on: his card is open and pinned, and the sidebar slides in.
    private takeTheScreen(): void {
        const boss = BossBubbleModel.getInstance();
        if (!globalStore.get(boss.cardOpenAtom)) {
            boss.openCard(undefined, { force: true });
            this.cardOpenedByMode = true;
        }
        boss.pinCard();
        this.cardWasOpen = true;
        const sidebar = SidebarModel.getInstance();
        if (sidebarOnOpen(sidebar.isEnabled(), sidebar.isHidden()) === "slide") {
            sidebar.setHidden(true);
            void writeWindowMeta({ [SidebarSlidMetaKey]: true });
        }
    }

    // The developer switched the brainstorm off in Features in test (FR-BOSS-011). The mode is wavesrv's, which now
    // refuses every view, so it can no longer tell this one that the mode ended: what the mode held here is let go as
    // when it ends (the pause, the slid sidebar, his pinned card), and the view forgets its state. Wavesrv's own state
    // is read again when the switch is back on.
    forget(): void {
        const was = this.isOpen();
        globalStore.set(this.stateAtom, null);
        if (was) {
            this.closed();
        }
    }

    // The pause of the notifications, here and in Electron main: asked again for the state it is in, it does nothing, so
    // the mode opening again after this view let go of it holds once, and one end releases it.
    private pause(on: boolean): void {
        if (this.paused === on) {
            return;
        }
        this.paused = on;
        setBrainstormHold(on);
        notifyApi()?.moltentermSystemNotifyHold?.(on);
    }

    private closed(): void {
        this.pause(false);
        globalStore.set(this.breakthroughAtom, null);
        // The questions of the mode go with it; his offer to resume, asked outside it, stays.
        globalStore.set(this.forkAtom, null);
        globalStore.set(this.widgetOpenAtom, false);
        globalStore.set(this.noticeAtom, null);
        const prompt = globalStore.get(this.promptAtom);
        if (prompt?.kind === "picker" || prompt?.kind === "duplicate") {
            globalStore.set(this.promptAtom, null);
        }
        const count = globalStore.get(this.tallyAtom).ids.size;
        globalStore.set(this.tallyAtom, EmptyTally);
        // His card goes with the mode in a view the mode opened it in (the mode ended in another view).
        if (this.cardOpenedByMode) {
            this.cardOpenedByMode = false;
            this.cardWasOpen = false;
            BossBubbleModel.getInstance().closeCard({ restoreFocus: false });
        }
        if (!this.onScreen()) {
            return;
        }
        const sidebar = SidebarModel.getInstance();
        const slid = globalStore.get(sidebar.windowMetaAtom)?.[SidebarSlidMetaKey] === true;
        if (slid) {
            if (sidebarOnClose(slid, sidebar.isHidden()) === "restore") {
                sidebar.setHidden(false);
            }
            void writeWindowMeta({ [SidebarSlidMetaKey]: null });
        }
        if (count > 0) {
            // One line for what arrived (AC3): the notifications are in the center, unread, as they came.
            showToast({
                id: SummaryToastId,
                kind: "info",
                title: tCount("boss.brainstorm.summary", count),
                actions: [
                    {
                        id: "show",
                        label: t("boss.brainstorm.summaryShow"),
                        run: () => BossBubbleModel.getInstance().showPanel("notifications"),
                    },
                ],
            });
        }
    }

    private onScreenChange(): void {
        if (this.isOpen() && this.onScreen()) {
            this.takeTheScreen();
        }
    }

    // His card closing ends the mode (AC2): Escape, a click on the dim, his square. Only the view on screen decides.
    private onCard(open: boolean): void {
        const was = this.cardWasOpen;
        this.cardWasOpen = open;
        if (was && !open && this.isOpen() && this.onScreen()) {
            void this.end();
        }
    }

    private onEntries(entries: MoltentermNotification[]): void {
        if (!this.isOpen()) {
            return;
        }
        const tally = globalStore.get(this.tallyAtom);
        const next = tallied(tally, entries, this.seen);
        if (next === tally) {
            return;
        }
        globalStore.set(this.tallyAtom, next);
        const critical = entries.filter((e) => next.ids.has(e.id) && !tally.ids.has(e.id) && breaksThrough(e));
        const latest = critical[critical.length - 1];
        if (latest != null) {
            globalStore.set(this.breakthroughAtom, {
                key: latest.id,
                kind: latest.source === "trust" ? "trust" : "crash",
                text: notificationTitle(latest),
                at: Date.now(),
            });
        }
    }

    private onAgents(data: AgentStatesData): void {
        const before = this.agentsBefore;
        this.agentsBefore = data;
        if (!this.isOpen() || before == null) {
            return;
        }
        const crashed = newlyCrashed(before, data);
        if (crashed.length === 0) {
            return;
        }
        const info = data.states[crashed[crashed.length - 1]];
        const name = info?.firstname || info?.agentname || "";
        globalStore.set(this.breakthroughAtom, {
            key: `crash:${info?.blockid}`,
            kind: "crash",
            text: name !== "" ? t("boss.brainstorm.crashedNamed", { name }) : t("boss.brainstorm.crashed"),
            at: Date.now(),
        });
    }
}

async function writeWindowMeta(meta: Record<string, any>): Promise<void> {
    const windowId = globalStore.get(atoms.uiContext)?.windowid;
    if (!windowId) {
        return;
    }
    try {
        await RpcApi.SetMetaCommand(TabRpcClient, { oref: `window:${windowId}`, meta: meta as MetaType });
    } catch (e) {
        console.log("brainstorm: the window's meta could not be written", e);
    }
}

// The talk field takes the keyboard once his group is in (it arrives after two frames): his conversation window opens
// with it, so the exchange shows beside the thought.
export function focusTalkField(tries = 12): void {
    if (typeof document === "undefined") {
        return;
    }
    const field = document.querySelector<HTMLTextAreaElement>("[data-testid='brokk-talk-input']");
    if (field != null) {
        field.focus({ preventScroll: true });
        return;
    }
    if (tries > 0) {
        requestAnimationFrame(() => focusTalkField(tries - 1));
    }
}
