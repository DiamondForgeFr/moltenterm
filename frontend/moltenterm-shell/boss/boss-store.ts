// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The foreman's bubble in a window (FR-BOSS-001, DS-BOSS-001): where it sits and whether it is collapsed (the window's meta,
// so every view of the window draws the same and a relaunch keeps them), the count and the peek it tells, the one cue
// when the count rises, and the collapse while the developer types in a terminal under it. The bubble never takes the
// focus and opens nothing: it only listens. Its Sessions card (FR-BOSS-002) shows only when the developer asks for it
// and goes back to where the focus was when he hides it.

import { atoms, getSettingsKeyAtom, globalStore, WOS } from "@/app/store/global";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { fireAndForget } from "@/util/util";
import { atom, Atom, PrimitiveAtom } from "jotai";
import { selectAtom } from "jotai/utils";
import { AgentStateInfo } from "../agent-state-model";
import { AgentStates } from "../agent-state-store";
import { I18nModel } from "../i18n/i18n";
import { MoltentermNotifications } from "../notifications-store";
import { SharedReadiedAtom, SharedReviewsAnswersAtom } from "../reviews/reviews-state-atoms";
import { DurableSessions } from "../sessions/sessions-store";
import { FocusTarget, focusTargetOf, restoreFocus } from "./boss-card-model";
import {
    BossBubbleMetaKey,
    BossCollapseOnTypeSettingKey,
    bossName,
    BossNameSettingKey,
    bossSettingOn,
    BossShowSettingKey,
} from "./boss-name";
import { attentionAgents, Badge, BossPeek, makeBadge, makePeek, workspaceNamesOf } from "./boss-overview";
import {
    Area,
    bubbleMetaValue,
    BubbleState,
    collapsesWhileTyping,
    DefaultPlace,
    nextCue,
    readBubbleState,
    Rect,
    rectToPlace,
    sameBubbleState,
} from "./boss-place";
import { buildToHandle, toHandleBadge, ToHandleList } from "./boss-to-handle-model";
import { startUsageReadings, UsageReadingsAtom } from "./boss-usage";

// The slice of the document the model listens on, so the rules run against a stand-in in the tests.
export type BossDom = {
    addEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
    removeEventListener: (type: string, listener: (event: any) => void, options?: any) => void;
    activeElement?: any;
    body?: any;
    hasFocus?: () => boolean;
};

export type CloseCardOptions = {
    // The card hid because the developer went somewhere (a session, the full view): the focus is that place's.
    restoreFocus?: boolean;
};

const TerminalInputClass = "xterm-helper-textarea";

// The block frame of the terminal a keystroke reaches, or null when it reaches no terminal.
export function terminalBlockOf(target: any): { blockId: string; rect: Rect } {
    if (target?.classList?.contains?.(TerminalInputClass) !== true) {
        return null;
    }
    const block = target.closest?.("[data-blockid]");
    const blockId = block?.getAttribute?.("data-blockid");
    if (!blockId) {
        return null;
    }
    const box = block.getBoundingClientRect();
    return { blockId, rect: { left: box.left, top: box.top, width: box.width, height: box.height } };
}

export class BossBubbleModel {
    private static instance: BossBubbleModel = null;

    // Set until the window's meta echoes a change, so a drop or a collapse shows at once.
    pendingAtom = atom(null) as PrimitiveAtom<BubbleState>;
    // The bubble's rectangle while it is dragged, in the area's coordinates.
    dragAtom = atom(null) as PrimitiveAtom<Rect>;
    // The terminal whose typing folded the bubble into its pennant; it comes back when the focus leaves that terminal.
    typingBlockAtom = atom(null) as PrimitiveAtom<string>;
    // Changes when the count rose, to play the one cue again.
    cueAtom = atom(0) as PrimitiveAtom<number>;
    // The peek shows.
    peekOpenAtom = atom(false) as PrimitiveAtom<boolean>;
    // The Sessions card shows (FR-BOSS-002).
    cardOpenAtom = atom(false) as PrimitiveAtom<boolean>;
    // The To handle rows set aside with Later, by their key: back at the card's next opening (FR-BOSS-003).
    parkedAtom = atom({}) as PrimitiveAtom<Record<string, boolean>>;

    windowMetaAtom: Atom<Record<string, any>>;
    stateAtom: Atom<BubbleState>;
    // Collapsed by the developer, or while he types under it.
    collapsedAtom: Atom<boolean>;
    nameAtom: Atom<string>;
    showAtom: Atom<boolean>;
    collapseOnTypeAtom: Atom<boolean>;
    attentionAtom: Atom<AgentStateInfo[]>;
    // The rows the To handle tab shows, and the badge that counts them.
    toHandleAtom: Atom<ToHandleList>;
    badgeAtom: Atom<Badge>;
    // The agents that wait or failed: the one cue follows them, as it always did.
    attentionBadgeAtom: Atom<Badge>;
    peekAtom: Atom<BossPeek>;

    private writeSeq = 0;
    // The bubble's rectangle on screen, given by the component that draws it.
    private rectSource: () => Rect = null;
    // Where the focus was when the card opened, and the document it is given back in.
    private cardReturn: FocusTarget = null;
    private dom: BossDom = null;

    private constructor() {
        this.windowMetaAtom = atom((get) => {
            const windowId = get(atoms.uiContext)?.windowid;
            if (!windowId) {
                return null;
            }
            return WOS.getObjectValue<WaveWindow>(WOS.makeORef("window", windowId), get)?.meta ?? null;
        });
        this.stateAtom = atom((get) => get(this.pendingAtom) ?? readBubbleState(get(this.windowMetaAtom)));
        this.collapsedAtom = atom((get) => get(this.stateAtom).collapsed || get(this.typingBlockAtom) != null);
        this.nameAtom = atom((get) => bossName(get(getSettingsKeyAtom(BossNameSettingKey as keyof SettingsType))));
        this.showAtom = atom((get) => bossSettingOn(get(getSettingsKeyAtom(BossShowSettingKey as keyof SettingsType))));
        this.collapseOnTypeAtom = atom((get) =>
            bossSettingOn(get(getSettingsKeyAtom(BossCollapseOnTypeSettingKey as keyof SettingsType)))
        );
        // The list changes when an agent enters or leaves waiting or error, not on every state event.
        this.attentionAtom = selectAtom(
            atom((get) => attentionAgents(get(AgentStates.getInstance().dataAtom))),
            (list) => list,
            (a, b) => a.length === b.length && a.every((info, i) => info === b[i])
        );
        this.toHandleAtom = atom((get) =>
            buildToHandle({
                states: get(AgentStates.getInstance().dataAtom),
                notifications: get(MoltentermNotifications.getInstance().shownEntriesAtom),
                answers: get(SharedReviewsAnswersAtom),
                readied: get(SharedReadiedAtom),
                sessions: get(DurableSessions.getInstance().dataAtom)?.sessions,
                parked: get(this.parkedAtom),
            })
        );
        this.badgeAtom = selectAtom(
            atom((get) => toHandleBadge(get(this.toHandleAtom))),
            (badge) => badge,
            (a, b) => a.count === b.count && a.tone === b.tone
        );
        this.attentionBadgeAtom = selectAtom(
            atom((get) => makeBadge(get(this.attentionAtom))),
            (badge) => badge,
            (a, b) => a.count === b.count && a.tone === b.tone
        );
        this.peekAtom = atom((get) => {
            get(I18nModel.getInstance().localeAtom);
            const states = get(AgentStates.getInstance().dataAtom);
            return makePeek({
                states,
                workspaceNames: workspaceNamesOf(states, (id) =>
                    get(WOS.getWaveObjectAtom<Workspace>(WOS.makeORef("workspace", id)))
                ),
                sessions: get(DurableSessions.getInstance().dataAtom)?.sessions ?? [],
                notifications: get(MoltentermNotifications.getInstance().entriesAtom),
                usage: get(UsageReadingsAtom),
                now: Date.now(),
            });
        });
    }

    static getInstance(): BossBubbleModel {
        if (BossBubbleModel.instance == null) {
            BossBubbleModel.instance = new BossBubbleModel();
        }
        return BossBubbleModel.instance;
    }

    setRectSource(source: () => Rect): void {
        this.rectSource = source;
    }

    private state(): BubbleState {
        return globalStore.get(this.stateAtom);
    }

    private write(next: BubbleState): void {
        const windowId = globalStore.get(atoms.uiContext)?.windowid;
        if (!windowId || sameBubbleState(next, this.state())) {
            return;
        }
        const seq = ++this.writeSeq;
        globalStore.set(this.pendingAtom, next);
        fireAndForget(async () => {
            try {
                await RpcApi.SetMetaCommand(TabRpcClient, {
                    oref: WOS.makeORef("window", windowId),
                    meta: { [BossBubbleMetaKey]: bubbleMetaValue(next) } as MetaType,
                });
            } finally {
                if (seq === this.writeSeq) {
                    globalStore.set(this.pendingAtom, null);
                }
            }
        });
    }

    // The developer's collapse: it stays until he brings the bubble back.
    collapse(): void {
        globalStore.set(this.peekOpenAtom, false);
        globalStore.set(this.typingBlockAtom, null);
        this.write({ ...this.state(), collapsed: true });
    }

    // Show the bubble: the pennant's menu and the card's header (the pennant's click shows the card).
    expand(): void {
        globalStore.set(this.peekOpenAtom, false);
        globalStore.set(this.typingBlockAtom, null);
        this.write({ ...this.state(), collapsed: false });
    }

    resetPosition(): void {
        this.write({ ...this.state(), place: DefaultPlace });
    }

    // The bubble dropped where the pointer left it.
    drop(rect: Rect, area: Area): void {
        this.write({ ...this.state(), place: rectToPlace(rect, area) });
    }

    // The developer's click (the bubble, the pennant) or command (the palette) shows the card; nothing else does. The
    // focus moves into it because he asked, and goes back to returnTo (the element that held it) when the card hides.
    openCard(returnTo?: FocusTarget): void {
        if (globalStore.get(this.cardOpenAtom) || !globalStore.get(this.showAtom)) {
            return;
        }
        this.cardReturn = returnTo ?? focusTargetOf(this.dom?.activeElement, this.dom);
        globalStore.set(this.peekOpenAtom, false);
        globalStore.set(this.parkedAtom, {});
        globalStore.set(this.cardOpenAtom, true);
    }

    // Sets a To handle row aside until the card is next opened (Later, FR-BOSS-003).
    park(key: string): void {
        globalStore.set(this.parkedAtom, { ...globalStore.get(this.parkedAtom), [key]: true });
    }

    // Hides the card and leaves the app as it was: the focus goes back unless the developer put it elsewhere meanwhile
    // (a click outside lands first).
    closeCard(options: CloseCardOptions = {}): void {
        if (!globalStore.get(this.cardOpenAtom)) {
            return;
        }
        const target = this.cardReturn;
        const dom = this.dom;
        this.cardReturn = null;
        globalStore.set(this.cardOpenAtom, false);
        if (options.restoreFocus === false || target == null || dom == null) {
            return;
        }
        // The card leaves the page on the next render: look at the focus once it has.
        setTimeout(() => restoreFocus(target, dom), 0);
    }

    toggleCard(returnTo?: FocusTarget): void {
        if (globalStore.get(this.cardOpenAtom)) {
            this.closeCard();
            return;
        }
        this.openCard(returnTo);
    }

    // A keystroke reaching a terminal under the bubble folds it into the pennant at once (AC4). Nothing is stopped or
    // redirected: the keystroke goes where it was going. While the card shows, the bubble keeps its place under it.
    noteKeyDown(event: { target: any; key: string; metaKey?: boolean }): void {
        if (globalStore.get(this.typingBlockAtom) != null || globalStore.get(this.cardOpenAtom)) {
            return;
        }
        const terminal = terminalBlockOf(event.target);
        const bubble = terminal == null ? null : (this.rectSource?.() ?? null);
        const collapse = collapsesWhileTyping({
            enabled: globalStore.get(this.showAtom) && globalStore.get(this.collapseOnTypeAtom),
            manual: this.state().collapsed,
            key: event,
            bubble,
            terminal: terminal?.rect ?? null,
        });
        if (collapse) {
            globalStore.set(this.peekOpenAtom, false);
            globalStore.set(this.typingBlockAtom, terminal.blockId);
        }
    }

    // The focus left the terminal he typed in: the bubble comes back (AC4).
    noteFocusLeft(dom: BossDom): void {
        const typing = globalStore.get(this.typingBlockAtom);
        // The card is a detour of the focus, not a departure: the bubble stays folded under it.
        if (typing == null || globalStore.get(this.cardOpenAtom)) {
            return;
        }
        // A window that lost the system's focus keeps its focused element: he is still in that terminal.
        if (dom.hasFocus?.() === false) {
            return;
        }
        const active = dom.activeElement;
        if (active?.closest?.("[data-blockid]")?.getAttribute?.("data-blockid") === typing) {
            return;
        }
        globalStore.set(this.typingBlockAtom, null);
    }

    // The count rose: one cue, and only when a first reading is in (a window starting is not an agent waiting).
    private watchCount(): () => void {
        const agents = AgentStates.getInstance();
        let last: number = null;
        const check = () => {
            const next = nextCue(
                last,
                globalStore.get(this.attentionBadgeAtom).count,
                globalStore.get(agents.loadedAtom)
            );
            last = next.last;
            if (next.cue) {
                globalStore.set(this.cueAtom, (n) => n + 1);
            }
        };
        const stops = [globalStore.sub(this.attentionBadgeAtom, check), globalStore.sub(agents.loadedAtom, check)];
        check();
        return () => stops.forEach((stop) => stop());
    }

    // Listens while a bubble is on screen: the keystrokes and the focus (capture, passive: nothing is stopped), the
    // count, and the usage readings the peek tells.
    attach(dom: BossDom): () => void {
        this.dom = dom;
        const onKeyDown = (event: any) => this.noteKeyDown(event);
        const onFocusChange = () => this.noteFocusLeft(dom);
        // focusout fires before the focus lands anywhere: look once it has.
        const onFocusOut = () => setTimeout(onFocusChange, 0);
        dom.addEventListener("keydown", onKeyDown, { capture: true, passive: true });
        dom.addEventListener("focusin", onFocusChange, { capture: true, passive: true });
        dom.addEventListener("focusout", onFocusOut, { capture: true, passive: true });
        const stopCount = this.watchCount();
        const stopUsage = startUsageReadings();
        return () => {
            dom.removeEventListener("keydown", onKeyDown, { capture: true });
            dom.removeEventListener("focusin", onFocusChange, { capture: true });
            dom.removeEventListener("focusout", onFocusOut, { capture: true });
            stopCount();
            stopUsage();
            globalStore.set(this.typingBlockAtom, null);
            globalStore.set(this.peekOpenAtom, false);
            globalStore.set(this.cardOpenAtom, false);
            this.cardReturn = null;
            this.dom = null;
        };
    }
}
