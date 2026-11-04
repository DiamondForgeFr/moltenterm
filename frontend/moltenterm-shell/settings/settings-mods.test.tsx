// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

import { globalStore } from "@/app/store/jotaiStore";
import { Provider } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MoltenHost, MoltenModStatus } from "../../molten/molten-host";
import { formatTrustDate } from "../../molten/molten-trust-store";
import { translate } from "../i18n/i18n-core";
import { formatModUsage, ModsSection, modTrustText } from "./settings-mods";
import { ModsRevokeModel } from "./settings-mods-model";

function render(): string {
    return renderToStaticMarkup(
        <Provider store={globalStore}>
            <ModsSection />
        </Provider>
    );
}

afterEach(() => {
    MoltenHost.resetInstance();
    ModsRevokeModel.resetInstance();
});

function userMod(id: string, extra: Partial<MoltenModStatus> = {}): MoltenModStatus {
    return { id, path: `/cfg/mods/${id}`, state: "active", commands: [], ...extra };
}

// The markup of one mod's row.
function rowOf(html: string, id: string): string {
    const start = html.indexOf(`data-mod="${id}"`);
    expect(start).toBeGreaterThan(-1);
    const next = html.indexOf('data-mod="', start + 1);
    return html.slice(start, next === -1 ? undefined : next);
}

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

describe("Settings > Mods: trust (FR-MORPH-004, #1880)", () => {
    const trustedAt = "2026-11-02T12:00:00Z";
    const fr = (key: string, vars?: Record<string, string | number>) => translate("fr", key, vars);

    function show(mods: MoltenModStatus[]) {
        globalStore.set(MoltenHost.getInstance().modsAtom, mods);
    }

    it("tells when the user trusted a mod, and that another is not trusted", () => {
        show([
            userMod("clock", { trusted: true, trustedat: trustedAt }),
            userMod("ghost", { state: "untrusted", trusted: false }),
        ]);
        const html = render();
        expect(rowOf(html, "clock")).toContain(`Trusted on ${formatTrustDate(trustedAt, "en")}`);
        expect(rowOf(html, "clock")).toContain('data-mod-trust="trusted"');
        expect(rowOf(html, "ghost")).toContain("Not trusted. Enabling it asks for your agreement first.");
        expect(rowOf(html, "ghost")).toContain('data-mod-trust="untrusted"');
        expect(rowOf(html, "ghost")).toContain("Waiting for your approval");
    });

    it("says nothing about trust for a built-in mod or a language pack, which run no code of the user's", () => {
        show([
            userMod("copy-box", { builtin: true, path: "builtin:copy-box" }),
            userMod("pack", { dataonly: true, languages: ["xx"] }),
        ]);
        const html = render();
        expect(html).not.toContain("data-mod-trust");
        expect(html).not.toContain("Revoke trust");
    });

    it("offers Revoke trust on a trusted mod only, as a calm action", () => {
        show([
            userMod("clock", { trusted: true, trustedat: trustedAt }),
            userMod("ghost", { state: "untrusted", trusted: false }),
            userMod("copy-box", { builtin: true }),
        ]);
        const html = render();
        expect(html.match(/data-action="revoke-trust"/g)).toHaveLength(1);
        const button = rowOf(html, "clock").match(/<button[^>]*data-action="revoke-trust"[^>]*>([^<]*)<\/button>/);
        expect(button[1]).toBe("Revoke trust");
        expect(button[0]).toContain("border-border");
        expect(button[0]).not.toMatch(/danger|destructive|red/);
    });

    it("keeps the action out of a mod that is not trusted any more", () => {
        show([userMod("clock", { state: "disabled", trusted: false })]);
        expect(render()).not.toContain("Revoke trust");
    });

    it("disables the button and says Revoking… while the host works", () => {
        show([userMod("clock", { trusted: true, trustedat: trustedAt })]);
        ModsRevokeModel.getInstance().setRow("clock", { busy: true });
        const row = rowOf(render(), "clock");
        const button = row.match(/<button[^>]*data-action="revoke-trust"[^>]*>/)[0];
        expect(button).toContain('disabled=""');
        expect(row).toContain("Revoking…");
        expect(row).toContain("df-domino-loader");
    });

    it("confirms inline what happens, once the mod is stopped", () => {
        show([userMod("clock", { state: "disabled", trusted: false })]);
        ModsRevokeModel.getInstance().setRow("clock", { busy: false, note: { kind: "done" } });
        const row = rowOf(render(), "clock");
        expect(row).toContain('role="status"');
        expect(row).toContain(
            "The mod is stopped. MoltenTerm will ask for your agreement again the next time it is enabled."
        );
        expect(row).toContain('aria-label="Close this message"');
    });

    it("drops the confirmation once the user trusts the mod again", () => {
        show([userMod("clock", { trusted: true, trustedat: trustedAt })]);
        ModsRevokeModel.getInstance().setRow("clock", { busy: false, note: { kind: "done" } });
        expect(render()).not.toContain("The mod is stopped.");
    });

    it("shows a failure as an alert with its reason, and leaves the button to try again", () => {
        show([userMod("clock", { trusted: true, trustedat: trustedAt })]);
        ModsRevokeModel.getInstance().setRow("clock", {
            busy: false,
            note: { kind: "failed", message: "/data/molten/trust.json is not valid JSON" },
        });
        const row = rowOf(render(), "clock");
        expect(row).toContain('role="alert"');
        expect(row).toContain("Trust could not be revoked: /data/molten/trust.json is not valid JSON");
        expect(row).toContain("Revoke trust");
    });

    it("never writes the reason as HTML", () => {
        show([userMod("clock", { trusted: true })]);
        ModsRevokeModel.getInstance().setRow("clock", { busy: false, note: { kind: "failed", message: "<b>x</b>" } });
        expect(render()).toContain("&lt;b&gt;x&lt;/b&gt;");
    });

    it("writes the trust line in French, with the date in French", () => {
        const trusted = userMod("clock", { trusted: true, trustedat: trustedAt });
        expect(modTrustText(trusted, fr, "fr", "UTC")).toBe("Confiance accordée le 2 nov. 2026");
        expect(modTrustText(userMod("clock", { trusted: true }), fr, "fr")).toBe("Confiance accordée");
        expect(modTrustText(userMod("ghost", { trusted: false }), fr, "fr")).toBe(
            "Confiance non accordée. L'activer demande d'abord votre accord."
        );
        expect(modTrustText(userMod("copy-box", { builtin: true }), fr, "fr")).toBe("");
    });

    it("words the action and the confirmation in French as the ticket asks", () => {
        expect(fr("settings.mods.trust.revoke")).toBe("Retirer la confiance");
        expect(fr("settings.mods.trust.revoked")).toBe(
            "Le mod est arrêté. MoltenTerm vous redemandera votre accord à sa prochaine activation."
        );
    });

    it("falls back to Trusted when the record has no readable date", () => {
        expect(modTrustText(userMod("clock", { trusted: true, trustedat: "someday" }), undefined, "en")).toBe(
            "Trusted"
        );
    });
});
