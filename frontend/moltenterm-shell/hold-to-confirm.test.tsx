// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { WaveEnvContext } from "@/app/waveenv/waveenv";
import { readFileSync } from "fs";
import { atom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HoldFlashMs, HoldResetMs, HoldToConfirmButton, scheduleHoldCompletion } from "./hold-to-confirm";

function renderWithSettings(node: React.ReactNode, settings: Record<string, unknown>): string {
    const env = {
        getSettingsKeyAtom: (key: string) => atom(settings[key]),
        atoms: { prefersReducedMotionAtom: atom(false) },
    };
    return renderToStaticMarkup(<WaveEnvContext.Provider value={env as any}>{node}</WaveEnvContext.Provider>);
}

describe("hold completion (DS-SHELL-059)", () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("flashes, acts after the flash, then returns to idle for a control that stays", () => {
        const events: string[] = [];
        scheduleHoldCompletion(
            false,
            () => events.push("confirm"),
            (value) => events.push(value ? "completing" : "idle")
        );
        expect(events).toEqual(["completing"]);
        vi.advanceTimersByTime(HoldFlashMs);
        expect(events).toEqual(["completing", "confirm"]);
        vi.advanceTimersByTime(HoldResetMs);
        expect(events).toEqual(["completing", "confirm", "idle"]);
    });

    it("acts at once under reduced motion, with no flash", () => {
        const events: string[] = [];
        scheduleHoldCompletion(
            true,
            () => events.push("confirm"),
            (value) => events.push(value ? "completing" : "idle")
        );
        expect(events).toEqual(["confirm"]);
    });

    it("never acts once cancelled, as when the control unmounts during the flash", () => {
        const events: string[] = [];
        const cancel = scheduleHoldCompletion(
            false,
            () => events.push("confirm"),
            (value) => events.push(value ? "completing" : "idle")
        );
        cancel();
        vi.advanceTimersByTime(5000);
        expect(events).toEqual(["completing"]);
    });
});

describe("hold-to-confirm button", () => {
    const glyph = <i className="molten-hold-glyph relative" data-testid="custom-glyph" aria-hidden />;

    it("takes its name, glyph and role from the caller and draws the shared ring and tint", () => {
        const markup = renderWithSettings(
            <HoldToConfirmButton
                onConfirm={() => null}
                label="Do it, hold to confirm"
                hint="Hold to do it"
                glyph={glyph}
                dataRole="custom"
            />,
            {}
        );
        expect(markup).toContain('aria-label="Do it, hold to confirm"');
        expect(markup).toContain('data-role="custom"');
        expect(markup).toContain('data-testid="custom-glyph"');
        expect(markup).toContain('data-testid="hold-ring"');
        expect(markup).toContain('data-testid="hold-tint"');
        expect(markup).toContain("molten-hold-disc");
        expect(markup).toContain('draggable="false"');
    });

    it("is a plain button with the plain name when the setting is off", () => {
        const markup = renderWithSettings(
            <HoldToConfirmButton
                onConfirm={() => null}
                label="Do it, hold to confirm"
                hint="Hold to do it"
                plainLabel="Do it"
                glyph={glyph}
            />,
            { "tab:holdtoclose": false }
        );
        expect(markup).toContain('aria-label="Do it"');
        expect(markup).not.toContain("hold-ring");
        expect(markup).toContain('data-testid="custom-glyph"');
    });

    it("keeps the hover colour of the tab's × from overriding the held colour", () => {
        const css = readFileSync(new URL("./hold-to-close.css", import.meta.url), "utf8");
        expect(css).toContain(".molten-hold-close:hover:not([data-holding], [data-completing]) .molten-hold-glyph");
    });
});
