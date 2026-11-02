// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import { AgentPressTracker, keepUserFocus } from "./agent-press-focus";

describe("an agent's click keeps the window's focus (#971)", () => {
    it("counts overlapping presses per webview", () => {
        const tracker = new AgentPressTracker();
        tracker.note(7, true);
        tracker.note(7, true);
        tracker.note(7, false);
        expect(tracker.pressing(7)).toBe(true);
        expect(tracker.pressing(8)).toBe(false);
        tracker.note(7, false);
        tracker.note(7, false);
        expect(tracker.pressing(7)).toBe(false);
        tracker.note(7, true);
        expect(tracker.pressing(7)).toBe(true);
    });

    it("gives the focus back at the end of the press when the webview took it, without a focus event", () => {
        const tracker = new AgentPressTracker();
        const terminal = { isConnected: true, focus: vi.fn() };
        const webview = { tag: "webview" };
        const doc = { activeElement: terminal as unknown, querySelector: vi.fn(() => webview) };
        tracker.note(5, true, doc);
        doc.activeElement = webview;
        tracker.note(5, false, doc);
        expect(doc.querySelector).toHaveBeenCalledWith('webview[data-webcontentsid="5"]');
        expect(terminal.focus).toHaveBeenCalledTimes(1);
        tracker.note(5, true, doc);
        doc.activeElement = terminal;
        tracker.note(5, false, doc);
        expect(terminal.focus).toHaveBeenCalledTimes(1);
    });

    it("gives the focus back to the terminal it came from while the agent presses", () => {
        const tracker = new AgentPressTracker();
        const webview = { blur: vi.fn() };
        const terminal = { isConnected: true, focus: vi.fn() };
        tracker.note(3, true);
        expect(keepUserFocus(3, webview, terminal, tracker)).toBe(true);
        expect(terminal.focus).toHaveBeenCalledTimes(1);
        expect(webview.blur).not.toHaveBeenCalled();
    });

    it("blurs the page when the focus came from nowhere, or from an element now gone", () => {
        const tracker = new AgentPressTracker();
        const webview = { blur: vi.fn() };
        tracker.note(3, true);
        expect(keepUserFocus(3, webview, null, tracker)).toBe(true);
        const gone = { isConnected: false, focus: vi.fn() };
        expect(keepUserFocus(3, webview, gone, tracker)).toBe(true);
        expect(gone.focus).not.toHaveBeenCalled();
        expect(webview.blur).toHaveBeenCalledTimes(2);
    });

    it("leaves the user's own focus alone: no agent press under way, or another webview's", () => {
        const tracker = new AgentPressTracker();
        const webview = { blur: vi.fn() };
        const terminal = { isConnected: true, focus: vi.fn() };
        expect(keepUserFocus(3, webview, terminal, tracker)).toBe(false);
        tracker.note(4, true);
        expect(keepUserFocus(3, webview, terminal, tracker)).toBe(false);
        expect(terminal.focus).not.toHaveBeenCalled();
        expect(webview.blur).not.toHaveBeenCalled();
    });
});
