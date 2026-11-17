// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/app/store/global", () => ({ getApi: () => ({}) }));

import { initialLogsCardState, LogsCardState } from "./logs-card-model";
import { LogsCardView } from "./logs-settings";

const noop = () => {};

// A size is written with a non-breaking space between the figure and its unit: the tests read it as a plain one.
function render(state: Partial<LogsCardState>): string {
    return renderToStaticMarkup(
        <LogsCardView
            state={{ ...initialLogsCardState(), ...state }}
            onAsk={noop}
            onCancel={noop}
            onConfirm={noop}
            onShow={noop}
        />
    ).replace(/\p{Zs}/gu, " ");
}

const Info = { total: 48_200_000, current: 3_000_000, rotated: 45_200_000, files: 6, highMark: 1_000_000_000 };

describe("Settings › Advanced › Logs (#2335)", () => {
    it("says it is reading until the size arrives, with the buttons out of reach", () => {
        const html = render({});
        expect(html).toContain("Reading the size");
        expect(html).toMatch(/data-testid="logs-show"[^>]*disabled/);
        expect(html).toMatch(/data-testid="logs-clear"[^>]*disabled/);
    });

    it("says when the size cannot be read", () => {
        const html = render({ loaded: true });
        expect(html).toContain("could not be read");
        expect(html).not.toContain("df-domino-loader");
    });

    it("waits with the dominoes, while the size is read and while the clear runs", () => {
        expect(render({})).toContain("df-domino-loader");
        const clearing = render({ loaded: true, info: Info, confirming: true, busy: true });
        expect(clearing).toContain("df-domino-loader");
        expect(clearing).toContain("Clearing");
    });

    it("shows the total size, the number of files and the two actions", () => {
        const html = render({ loaded: true, info: Info });
        expect(html).toMatch(/data-testid="logs-size"[^>]*>48 MB</);
        expect(html).toContain("6 files, the current one included");
        expect(html).toContain("Show in folder");
        expect(html).toContain("Clear logs");
        expect(html).not.toContain('data-testid="logs-confirm"');
        expect(html).not.toMatch(/data-testid="logs-show"[^>]*disabled/);
    });

    it("asks before it clears, naming what is removed and keeping the logging going", () => {
        const html = render({ loaded: true, info: Info, confirming: true });
        expect(html).toContain('data-testid="logs-confirm"');
        expect(html).toContain("Clear 48 MB of logs?");
        expect(html).toContain("rotated files are removed");
        expect(html).toContain("current file is emptied");
        expect(html).toContain("keeps logging");
        expect(html).toContain("Cancel");
        expect(html).not.toContain('data-testid="logs-clear"');
    });

    it("says how much was freed, and what could not be done", () => {
        expect(
            render({ loaded: true, info: { ...Info, total: 900 }, outcome: "cleared", freed: 48_000_000 })
        ).toContain("Logs cleared: 48 MB freed.");
        expect(render({ loaded: true, info: Info, outcome: "partial" })).toContain("could not be removed");
        expect(render({ loaded: true, info: Info, outcome: "failed" })).toContain("could not be cleared");
    });

    it("names no operating system and no machine", () => {
        const html = render({ loaded: true, info: Info, confirming: true });
        expect(html).not.toMatch(/\b(mac|macos|finder|windows|linux|explorer)\b/i);
    });
});
