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
    BrainstormRouteId,
    BrainstormState,
    BrainstormStateAtom,
    CallTimeoutMs,
    CloseCommand,
    OpenCommand,
    StateCommand,
    TurnCommand,
} from "./brainstorm-boot";
import { setBrainstormHold } from "./brainstorm-hold";
import {
    answerStep,
    breaksThrough,
    EmptyTally,
    newlyCrashed,
    sidebarOnClose,
    sidebarOnOpen,
    tallied,
    Tally,
} from "./brainstorm-model";

export { CloseCommand, OpenCommand, StateCommand, TurnCommand } from "./brainstorm-boot";
export type { BrainstormState, BrainstormSummary } from "./brainstorm-boot";

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

    private call: Call = LiveCall;
    private started = false;
    private paused = false;
    private sent = new Set<string>();
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
    }

    // The developer starts a brainstorm (Brokk's menu, FR-BOSS-010 AC2): his card opens, he says so in his own line, and
    // the next message tells his session it is a brainstorm. The layer dims at once.
    // With an idea (the field's `/brainstorm <idea>`, #2257) the developer's next message is that idea, so he says no
    // opening line of his own: his answer puts it at the centre.
    async begin(withIdea = false): Promise<void> {
        if (!this.allowed()) {
            return;
        }
        const boss = BossBubbleModel.getInstance();
        const session = BrokkSession.getInstance();
        boss.openCard(undefined, { force: true });
        boss.pinCard();
        const wasOpen = this.isOpen();
        const state: BrainstormState = await this.ask(OpenCommand, { by: "you" });
        this.apply(state);
        if (withIdea && state != null) {
            session.setLead(t("boss.brainstorm.lead"));
        } else if (!wasOpen && state != null) {
            // He says so: a new idea, or the one this computer kept, taken up where it was.
            const title = state.brainstorm?.title ?? "";
            session.addLocalLine(
                title !== ""
                    ? t("boss.brainstorm.resume", { title })
                    : t("boss.brainstorm.opening", { name: globalStore.get(boss.nameAtom) })
            );
            session.setLead(t("boss.brainstorm.lead"));
        }
        focusTalkField();
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
