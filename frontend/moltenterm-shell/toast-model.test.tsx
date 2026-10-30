// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InlineCodeText, splitInlineCode } from "./inline-code";
import { displayActions, GoToTerminalLabel, MoltentermNotification } from "./notifications-model";
import {
    bellOrder,
    checkQuestion,
    goneNotificationToasts,
    makeToast,
    MaxToastAnswers,
    MaxToasts,
    notificationToastId,
    pushToast,
    Toast,
    toastActionsOf,
    toastStackPlace,
    toneOf,
} from "./toast-model";
import { ToastStack } from "./toast-stack";
import { showToast, Toasts } from "./toast-store";

function entry(id: string, extra: Partial<MoltentermNotification> = {}): MoltentermNotification {
    return { id, time: 1, updated: 1, title: id, source: "agent", kind: "info", read: false, ...extra };
}

function toast(id: string, extra: Partial<Toast> = {}): Toast {
    return makeToast({ id, title: id, ...extra }, id);
}

describe("toast stack (FR-SHELL-055 AC1)", () => {
    it("keeps three toasts, the newest last, and lets the oldest go to the center", () => {
        let stack: Toast[] = [];
        const collapsed: Toast[] = [];
        for (const id of ["a", "b", "c", "d", "e"]) {
            const push = pushToast(stack, toast(id));
            stack = push.stack;
            collapsed.push(...push.collapsed);
        }
        expect(MaxToasts).toBe(3);
        expect(stack.map((t) => t.id)).toEqual(["c", "d", "e"]);
        expect(collapsed.map((t) => t.id)).toEqual(["a", "b"]);
    });

    it("moves a toast pushed again to the newest place instead of adding one", () => {
        const stack = [toast("a"), toast("b"), toast("c")];
        const push = pushToast(stack, toast("a", { title: "changed" }));
        expect(push.stack.map((t) => t.id)).toEqual(["b", "c", "a"]);
        expect(push.stack[2].title).toBe("changed");
        expect(push.collapsed).toEqual([]);
    });

    it("keeps waiting and error toasts on screen and caps the actions at two", () => {
        const noop = () => {};
        expect(toast("a", { kind: "warning" }).stays).toBe(true);
        expect(toast("a", { kind: "error" }).stays).toBe(true);
        expect(toast("a", { kind: "success" }).stays).toBe(false);
        expect(toast("a").stays).toBe(false);
        expect(toast("a", { kind: "error", stays: false }).stays).toBe(false);
        const actions = ["1", "2", "3"].map((id) => ({ id, label: id, run: noop }));
        expect(makeToast({ title: "t", actions }, "x").actions.map((a) => a.id)).toEqual(["1", "2"]);
    });

    it("drops a notification's toast once it is read, resolved, archived or deleted", () => {
        const stack = ["unread", "read", "resolved", "archived", "deleted"].map((id) =>
            toast(notificationToastId(id), { notificationId: id })
        );
        stack.push(toast("own"));
        const entries = [
            entry("unread"),
            entry("read", { read: true }),
            entry("resolved", { resolved: 2 }),
            entry("archived", { archived: 2 }),
        ];
        expect(goneNotificationToasts(stack, entries)).toEqual([
            "notif:read",
            "notif:resolved",
            "notif:archived",
            "notif:deleted",
        ]);
    });
});

describe("the stack comes from the bell (#1403)", () => {
    it("sits under the bell's row, one frame margin right of a docked or floating sidebar", () => {
        expect(
            toastStackPlace({ windowWidth: 2000, frameGap: 8, bellBottom: 34, bellRight: 264, sidebarRight: 272 })
        ).toEqual({ top: 40, left: 280, width: 360 });
    });

    it("keeps the frame margin when the sidebar is hidden off the window's edge", () => {
        expect(
            toastStackPlace({ windowWidth: 1000, frameGap: 8, bellBottom: 34, bellRight: -20, sidebarRight: -24 })
        ).toEqual({ top: 40, left: 8, width: 360 });
    });

    it("narrows in a small window instead of running past its right edge", () => {
        const place = toastStackPlace({ windowWidth: 600, frameGap: 8, bellBottom: 34, sidebarRight: 300 });
        expect(place.left + place.width).toBeLessThanOrEqual(600 - 8);
    });

    it("hangs under a bell that is not in the sidebar, inside the window", () => {
        const place = toastStackPlace({ windowWidth: 1200, frameGap: 0, bellBottom: 30, bellRight: 1100 });
        expect(place).toEqual({ top: 36, left: 1100 - 360, width: 360 });
    });

    it("falls back to the window row's height without a bell", () => {
        expect(toastStackPlace({ windowWidth: 1280, frameGap: 8 }).top).toBe(40);
    });

    it("shows the newest toast first, nearest the bell", () => {
        let stack: Toast[] = [];
        for (const id of ["a", "b", "c"]) {
            stack = pushToast(stack, toast(id)).stack;
        }
        expect(bellOrder(stack).map((t) => t.id)).toEqual(["c", "b", "a"]);
    });

    it("lets long labels wrap inside their buttons and the actions wrap to a new row", () => {
        Toasts.resetInstance();
        showToast({
            title: "Un terminal veut garder cet ordinateur éveillé",
            actions: [
                { id: "a", label: "Ouvrir un terminal à cet endroit", run: () => {} },
                { id: "b", label: "Ouvrir le panneau Intégration", run: () => {} },
            ],
        });
        const html = renderToStaticMarkup(<ToastStack onOpenCenter={() => {}} />);
        expect(html).toContain("flex flex-wrap items-center gap-1");
        const buttons = html.match(/<button type="button"[^>]*>Ouvrir[^<]*<\/button>/g);
        expect(buttons).toHaveLength(2);
        for (const button of buttons) {
            expect(button).toContain("min-h-6");
            expect(button).toContain("whitespace-normal");
            expect(button).not.toMatch(/[" ]h-6[" ]/);
        }
        expect(html).not.toContain("truncate");
    });
});

describe("toast store", () => {
    beforeEach(() => Toasts.resetInstance());

    it("counts the notification toasts that collapsed into the center and tells each caller why it left", () => {
        const left: string[] = [];
        for (const id of ["a", "b", "c", "d"]) {
            showToast({ id, title: id, notificationId: id, onDismiss: (reason) => left.push(`${id}:${reason}`) });
        }
        const model = Toasts.getInstance();
        expect(model.stack().map((t) => t.id)).toEqual(["b", "c", "d"]);
        expect(globalStore.get(model.collapsedAtom)).toBe(1);
        expect(left).toEqual(["a:collapsed"]);
        model.dismiss("c", "user");
        expect(left).toEqual(["a:collapsed", "c:user"]);
        model.clearNotificationToasts();
        expect(model.stack()).toEqual([]);
        expect(globalStore.get(model.collapsedAtom)).toBe(0);
    });

    it("pulses the bell only for a notification's toast that times out (#1403)", () => {
        const model = Toasts.getInstance();
        showToast({ id: "n", title: "n", notificationId: "n" });
        showToast({ id: "p", title: "p" });
        showToast({ id: "u", title: "u", notificationId: "u" });
        model.dismiss("p", "timeout");
        model.dismiss("u", "user");
        expect(globalStore.get(model.landedAtom)).toBe(0);
        model.dismiss("n", "timeout");
        expect(globalStore.get(model.landedAtom)).toBe(1);
    });

    it("lets a caller push its own question with two actions (#413)", () => {
        const yes = vi.fn();
        const id = showToast({
            title: "Use the repository's logo?",
            actions: [
                { id: "yes", label: "Use it", run: yes },
                { id: "no", label: "Not now", run: () => {} },
            ],
            stays: true,
        });
        const shown = Toasts.getInstance()
            .stack()
            .find((t) => t.id === id);
        expect(shown.actions.map((a) => a.label)).toEqual(["Use it", "Not now"]);
        shown.actions[0].run();
        expect(yes).toHaveBeenCalled();
    });
});

describe("notification kinds (FR-SHELL-055 AC2)", () => {
    it("maps done to green, waiting to amber, error to red and information to neutral", () => {
        expect(toneOf("success")).toMatchObject({ tone: "done", colorClass: "text-success" });
        expect(toneOf("warning")).toMatchObject({ tone: "waiting", colorClass: "text-warning" });
        expect(toneOf("error")).toMatchObject({ tone: "error", colorClass: "text-error" });
        expect(toneOf("info")).toMatchObject({ tone: "info", colorClass: "text-secondary" });
    });

    it("never paints success in the accent (orange)", () => {
        for (const kind of ["success", "warning", "error", "info"] as const) {
            expect(toneOf(kind).colorClass).not.toMatch(/accent/);
        }
    });

    it("draws each kind's toast with its own tone, and the collapsed ones as a link to the center", () => {
        Toasts.resetInstance();
        for (const kind of ["info", "success", "warning", "error"] as const) {
            showToast({ title: `${kind} title`, message: "Run `task dev`", kind, notificationId: kind });
        }
        const html = renderToStaticMarkup(<ToastStack onOpenCenter={() => {}} />);
        expect(html.match(/data-testid="toast"/g)).toHaveLength(3);
        expect(html).toContain('data-tone="done"');
        expect(html).toContain('data-tone="waiting"');
        expect(html).toMatch(/role="alert"[^>]*data-tone="error"/);
        expect(html).toContain("1 more in Notifications");
        expect(html).toContain('<code class="molten-inline-code');
        expect(html).not.toContain("`");
        const toasts = html.slice(html.indexOf('data-testid="toast"'));
        expect(toasts).not.toMatch(/(bg|text|border)-accent/);
    });

    it("shows a 32 px thumbnail in place of the tone's icon when the toast carries one (DS-SHELL-101)", () => {
        Toasts.resetInstance();
        showToast({ title: "Use Demo's logo?", thumbnail: "http://localhost/logo.png" });
        const html = renderToStaticMarkup(<ToastStack onOpenCenter={() => {}} />);
        expect(html).toMatch(
            /<img src="http:\/\/localhost\/logo.png" alt=""[^>]*data-role="toast-thumbnail"[^>]*h-8 w-8/
        );
        expect(html).not.toContain("fa-circle-info");
        expect(html).toContain('<span class="sr-only">Information: </span>');
    });

    it("tells each tone by its icon and its label, not by colour alone", () => {
        const icons = new Set(["success", "warning", "error", "info"].map((k) => toneOf(k as any).icon));
        expect(icons.size).toBe(4);
    });
});

describe("inline code (FR-SHELL-055 AC3)", () => {
    it("splits backticked spans out of a message", () => {
        expect(splitInlineCode("Run `task check:ts` then `npx vitest`.")).toEqual([
            { code: false, text: "Run " },
            { code: true, text: "task check:ts" },
            { code: false, text: " then " },
            { code: true, text: "npx vitest" },
            { code: false, text: "." },
        ]);
    });

    it("leaves a lone or empty pair of backticks as typed", () => {
        expect(splitInlineCode("a ` b")).toEqual([{ code: false, text: "a ` b" }]);
        expect(splitInlineCode("a `` b")).toEqual([{ code: false, text: "a `` b" }]);
        expect(splitInlineCode("")).toEqual([]);
    });

    it("renders code elements and no backtick, with markup in the message escaped", () => {
        const html = renderToStaticMarkup(<InlineCodeText text="Allow `rm -rf <dir>`?" />);
        expect(html).toContain("<code");
        expect(html).toContain("rm -rf &lt;dir&gt;");
        expect(html).not.toContain("`");
    });
});

describe("Go to the terminal (FR-SHELL-055 AC4)", () => {
    const waiting = entry("w", {
        kind: "warning",
        title: "Codex is waiting for you",
        workspaceid: "ws",
        tabid: "tab",
        blockid: "blk",
    });

    it("comes first on a waiting agent, whichever agent, pointing at its terminal", () => {
        for (const title of [
            "Codex is waiting for you",
            "Claude Code is waiting for you",
            "Gemini is waiting for you",
        ]) {
            const [first] = toastActionsOf({ ...waiting, title });
            expect(first).toMatchObject({
                label: GoToTerminalLabel,
                kind: "open",
                blockid: "blk",
                tabid: "tab",
                workspaceid: "ws",
            });
        }
        expect(toastActionsOf({ ...waiting, kind: "error" })[0].label).toBe(GoToTerminalLabel);
    });

    it("is not offered without a terminal, once resolved, for information or other sources", () => {
        expect(displayActions({ ...waiting, blockid: undefined })).toEqual([]);
        expect(displayActions({ ...waiting, resolved: 2 })).toEqual([]);
        expect(displayActions({ ...waiting, kind: "info" })).toEqual([]);
        expect(displayActions({ ...waiting, kind: "success" })).toEqual([]);
        expect(displayActions({ ...waiting, source: "build" })).toEqual([]);
    });

    it("keeps one other action beside it in a toast, and is not doubled when stored", () => {
        const stored = { id: "go", label: "Show", kind: "open" as const, blockid: "blk" };
        const other = { id: "x", label: "Approve", kind: "gesture" as const, gesture: "g" };
        const extra = { id: "y", label: "Later", kind: "gesture" as const, gesture: "h" };
        expect(toastActionsOf({ ...waiting, actions: [other, extra] }).map((a) => a.label)).toEqual([
            GoToTerminalLabel,
            "Approve",
        ]);
        expect(displayActions({ ...waiting, actions: [stored] }).map((a) => a.id)).toEqual(["go"]);
    });
});

describe("a question's answers in a toast (#595)", () => {
    const answer = (id: string, gesture = "molten:agenthandoff") => ({
        id,
        label: id,
        kind: "gesture" as const,
        gesture,
        args: { decision: id },
    });

    it("shows all three answers of one gesture", () => {
        const question = entry("q", { kind: "warning", actions: [answer("once"), answer("always"), answer("block")] });
        expect(checkQuestion(question)).toBe(true);
        expect(toastActionsOf(question).map((a) => a.id)).toEqual(["once", "always", "block"]);
        const shown = makeToast(
            {
                title: "q",
                question: true,
                actions: toastActionsOf(question).map((a) => ({ id: a.id, label: a.label, run: () => {} })),
            },
            "q"
        );
        expect(shown.actions).toHaveLength(MaxToastAnswers);
    });

    it("keeps two buttons for actions that are not one question's answers", () => {
        const mixed = entry("m", { actions: [answer("a"), answer("b", "other"), answer("c")] });
        expect(checkQuestion(mixed)).toBe(false);
        expect(toastActionsOf(mixed)).toHaveLength(2);
        expect(checkQuestion(entry("two", { actions: [answer("a"), answer("b")] }))).toBe(false);
    });
});
