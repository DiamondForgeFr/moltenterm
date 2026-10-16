// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MoltenHost } from "../../molten/molten-host";
import { translate } from "../i18n/i18n-core";
import { formatModUsage, ModsSection } from "./settings-mods";

function render(): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <ModsSection />
        </Provider>
    );
}

afterEach(() => {
    MoltenHost.resetInstance();
});

describe("Settings > Mods (FR-PERF-014)", () => {
    it("shows each mod's numbers and marks the one over budget with the reason", () => {
        const host = MoltenHost.getInstance();
        const reason = "4.8 % CPU while idle over the last 30 s (budget 2 %)";
        globalStore.set(host.modsAtom, [
            {
                id: "copy-box",
                name: "Copy box",
                path: "builtin:copy-box",
                state: "active",
                commands: ["copy"],
                builtin: true,
                usage: { activatems: 1.2, scriptms: 3, cpupct: 0, timers: 0, heapmb: 0.3, over: false },
            },
            {
                id: "heavy",
                name: "Heavy",
                path: "/cfg/mods/heavy",
                state: "active",
                commands: [],
                usage: { activatems: 2, scriptms: 1500, cpupct: 4.8, timers: 1, heapmb: null, over: true, reason },
            },
            {
                id: "copy",
                path: "/cfg/mods/copy",
                state: "failed",
                commands: [],
                error: 'activate: command "copy" is already registered by mod "copy-box"; mod "copy" cannot register it',
            },
        ]);
        const html = render();
        expect(html).toContain("Copy box");
        expect(html).toContain("molten copy");
        expect(html).toContain("0.0 % CPU idle · 0 timers · activation 1 ms · 0.3 MB at activation");
        expect(html.match(/Over budget/g)).toHaveLength(1);
        expect(html).toContain("4.8 % CPU idle · 1 timer · activation 2 ms");
        expect(html).toContain(reason);
        expect(html).toContain("is already registered by mod &quot;copy-box&quot;; mod &quot;copy&quot; cannot");
        expect(html).toContain("budget is 2 % CPU and 20 MB");
    });

    it("says when there is no mod", () => {
        expect(render()).toContain("No mods");
    });

    it("formats no usage as nothing", () => {
        expect(formatModUsage(null)).toBe("");
    });

    it("writes French decimals with a comma and the singular for 0 (#741)", () => {
        const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);
        const usage = { activatems: 1.2, scriptms: 3, cpupct: 0, timers: 0, heapmb: 0.3, over: false };
        expect(formatModUsage(usage, fr, "fr")).toBe(
            "0,0 % de CPU au repos · 0 minuteur · activation 1 ms · 0,3 Mo à l'activation"
        );
    });
});
