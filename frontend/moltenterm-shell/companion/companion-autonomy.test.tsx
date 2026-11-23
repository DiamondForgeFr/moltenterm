// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The main agent's permissions as they are drawn (#2474, FR-SHELL-018, FR-SHELL-063 AC9 to AC12): the Permissions control
// and its menu, the Autonomous chip and its Stop, the count of what the session approved, and the hero wearing them.

import { readFileSync } from "fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { contrastRatio, parseColor } from "../accent";
import type { AgentStateInfo } from "../agent-state-model";
import { I18nModel, t } from "../i18n/i18n";
import {
    AutonomousChipView,
    AutonomyLine,
    HeroPermit,
    modeError,
    PermissionsMenu,
    PermissionsTool,
    tonightEnd,
} from "./companion-autonomy";
import { CompanionHero, CompanionHeroProps } from "./companion-hero";
import type { CompanionView } from "./companion-model";
import type { PermitAutonomy } from "./companion-permit-model";

vi.mock("@/app/store/global", () => ({ openLink: vi.fn() }));
vi.mock("@/app/store/wps", () => ({ waveEventSubscribeSingle: vi.fn(() => () => {}) }));
vi.mock("@/app/store/wshrpcutil", () => ({ TabRpcClient: { wshRpcCall: vi.fn(() => new Promise(() => {})) } }));
vi.mock("@/app/store/wshclientapi", () => ({ RpcApi: { SetMetaCommand: vi.fn(), SetConfigCommand: vi.fn() } }));

const Minute = 60_000;
const Session = "11111111-2222-3333-4444-555555555555";
// Monday 23 November 2026, 10:42 local.
const now = new Date(2026, 10, 23, 10, 42, 0).getTime();

function find(node: any, predicate: (node: any) => boolean): any {
    if (node == null || typeof node !== "object") return null;
    if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
    if (predicate(node)) return node;
    return find(node.props?.children, predicate);
}

function byId(node: any, id: string): any {
    return find(node, (n) => n.props?.["data-testid"] === id);
}

function autonomy(over: Partial<PermitAutonomy> = {}): PermitAutonomy {
    return { blockid: "b1", sessionid: Session, mode: "always", since: now, approved: 0, ...over };
}

function permit(over: Partial<HeroPermit> = {}): HeroPermit {
    return {
        name: "Flore",
        available: true,
        reason: "",
        autonomy: null,
        now,
        onChoose: vi.fn(async () => ""),
        ...over,
    };
}

// A period that has 52 minutes left.
const hour = () => autonomy({ mode: "for", since: now - 8 * Minute, until: now + 52 * Minute });

function menu(over: Partial<HeroPermit> = {}, extra: { busy?: boolean; error?: string } = {}) {
    return { permit: permit(over), t, titleId: "title", onPick: vi.fn(), onDone: vi.fn(), ...extra };
}

describe("the Permissions control (#2474)", () => {
    it("is a shield and what the session does, opening a menu", () => {
        const html = renderToStaticMarkup(<PermissionsTool permit={permit()} />);
        expect(html).toContain("lucide-shield");
        expect(html).toContain("Permissions: ask me");
        expect(html).toContain('aria-label="Permissions of Flore: ask me"');
        expect(html).toContain('aria-haspopup="dialog"');
        expect(html).toContain('aria-expanded="false"');
        expect(html).toContain("fa-chevron-down");
        expect(html).toContain('data-tip="When Flore asks for permission"');
        expect(html).not.toContain("mt-cdash-perm-tool-on");
    });

    it("says automatic, or always, once the session runs on its own", () => {
        const periodHtml = renderToStaticMarkup(<PermissionsTool permit={permit({ autonomy: hour() })} />);
        expect(periodHtml).toContain("Permissions: automatic");
        expect(periodHtml).toContain("mt-cdash-perm-tool-on");
        expect(renderToStaticMarkup(<PermissionsTool permit={permit({ autonomy: autonomy() })} />)).toContain(
            "Permissions: always"
        );
    });
});

describe("the Permissions menu (#2474)", () => {
    it("titles itself with the agent and offers Ask me, the periods, and Always, with the rule for sensitive commands", () => {
        const html = renderToStaticMarkup(<PermissionsMenu {...menu()} />);
        expect(html).toContain("When Flore asks for permission");
        expect(html).toContain("Ask me");
        expect(html).toContain("In the companion, then the terminal");
        expect(html).toContain("Approve automatically for…");
        for (const label of ["15 min", "1 h", "4 h", "Until tonight"]) {
            expect(html).toContain(`>${label}<`);
        }
        expect(html).toContain("Always approve automatically");
        expect(html).toContain("For this Flore session");
        expect(html).toContain("Sensitive commands (force push, deletion…) always ask.");
        expect(html).toContain('aria-labelledby="title"');
    });

    it("marks the choice that stands: Ask me by default, the period chosen, always", () => {
        const marked = (over: Partial<HeroPermit>) =>
            [...renderToStaticMarkup(<PermissionsMenu {...menu(over)} />).matchAll(/<button[^>]*>/g)]
                .map((m) => m[0])
                .filter((b) => b.includes('aria-pressed="true"'))
                .map((b) => /data-testid="([^"]+)"/.exec(b)?.[1]);
        const period = (ms: number) => autonomy({ mode: "for", since: now, until: now + ms });
        expect(marked({})).toEqual(["companion-permit-ask"]);
        expect(marked({ autonomy: hour() })).toEqual(["companion-permit-period-1h"]);
        expect(marked({ autonomy: period(60 * Minute) })).toEqual(["companion-permit-period-1h"]);
        expect(marked({ autonomy: period(15 * Minute) })).toEqual(["companion-permit-period-15m"]);
        expect(marked({ autonomy: period(240 * Minute) })).toEqual(["companion-permit-period-4h"]);
        expect(marked({ autonomy: period(7 * 60 * Minute) })).toEqual(["companion-permit-period-tonight"]);
        expect(marked({ autonomy: autonomy() })).toEqual(["companion-permit-always"]);
    });

    it("says where 'until tonight' ends, on hover", () => {
        const html = renderToStaticMarkup(<PermissionsMenu {...menu()} />);
        expect(html).toContain('data-tip="Until 22:00"');
        expect(html.match(/data-tip=/g)).toHaveLength(1);
    });

    it("sends the choice: a period, always, and Ask me", () => {
        const props = menu();
        const element = PermissionsMenu(props);
        byId(element, "companion-permit-period-4h").props.onClick();
        byId(element, "companion-permit-period-tonight").props.onClick();
        byId(element, "companion-permit-always").props.onClick();
        byId(element, "companion-permit-ask").props.onClick();
        expect(props.onPick.mock.calls).toEqual([["for", "4h"], ["for", "tonight"], ["always"], ["ask"]]);
    });

    it("closes on Escape alone", () => {
        const props = menu();
        const element = PermissionsMenu(props) as any;
        const stopPropagation = vi.fn();
        element.props.onKeyDown({ key: "Enter", stopPropagation });
        expect(props.onDone).not.toHaveBeenCalled();
        element.props.onKeyDown({ key: "Escape", stopPropagation });
        expect(props.onDone).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
    });

    it("keeps the choices that need the hook off, with the reason, and Ask me on", () => {
        const props = menu({
            available: false,
            reason: "Not available here: it was started outside MoltenTerm's launcher",
        });
        const element = PermissionsMenu(props);
        expect(byId(element, "companion-permit-always").props.disabled).toBe(true);
        for (const p of ["15m", "1h", "4h", "tonight"]) {
            expect(byId(element, `companion-permit-period-${p}`).props.disabled).toBe(true);
        }
        expect(byId(element, "companion-permit-ask").props.disabled).toBeFalsy();
        const html = renderToStaticMarkup(<PermissionsMenu {...props} />);
        expect(html).toContain("Not available here: it was started outside MoltenTerm&#x27;s launcher");
        expect(html).toContain('aria-disabled="true"');
    });

    it("holds every choice while one is on its way, and says when it failed", () => {
        const element = PermissionsMenu(menu({}, { busy: true }));
        for (const id of ["companion-permit-ask", "companion-permit-always", "companion-permit-period-1h"]) {
            expect(byId(element, id).props.disabled).toBe(true);
        }
        const html = renderToStaticMarkup(
            <PermissionsMenu {...menu({}, { error: "The choice did not go through." })} />
        );
        expect(html).toContain('role="alert"');
        expect(html).toContain("The choice did not go through.");
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = renderToStaticMarkup(<PermissionsMenu {...menu()} />);
            expect(html).toContain("Quand Flore demande une autorisation");
            expect(html).toContain("Me demander");
            expect(html).toContain("Dans le compagnon, puis le terminal");
            expect(html).toContain("Valider automatiquement pendant…");
            expect(html).toContain("Jusqu&#x27;à ce soir");
            expect(html).toContain("Toujours valider automatiquement");
            expect(html).toContain("Pour cette session de Flore");
            expect(html).toContain("Les commandes sensibles (poussée forcée, suppression…) demandent toujours.");
            expect(html).toContain('data-tip="Jusqu&#x27;à 22:00"');
            const tool = renderToStaticMarkup(<PermissionsTool permit={permit()} />);
            expect(tool).toContain("Autorisations : me demander");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

describe("the words of a choice that did not go through", () => {
    it("is nothing when it went through, the reason when the session cannot be answered, and a plain failure otherwise", () => {
        expect(modeError(t, { status: "set" })).toBe("");
        expect(modeError(t, { status: "unavailable", reason: "it runs on a remote host" })).toBe(
            "Not available here: it runs on a remote host"
        );
        expect(
            modeError(t, { status: "unavailable", reason: "x", reasontext: { code: "keepawake.session.remote" } })
        ).toBe("Not available here: it runs on a remote host");
        expect(modeError(t, { status: "invalid" })).toBe("The choice did not go through.");
        expect(modeError(t, { status: "unavailable" })).toBe("The choice did not go through.");
        expect(modeError(t, null)).toBe("The choice did not go through.");
    });
});

describe("the Autonomous chip (#2474)", () => {
    const chip = (
        over: Partial<HeroPermit> = {},
        extra: Partial<React.ComponentProps<typeof AutonomousChipView>> = {}
    ) => ({
        permit: permit(over),
        t,
        onStop: vi.fn(),
        ...extra,
    });

    it("says the time left of a period, with a shield and a Stop", () => {
        const html = renderToStaticMarkup(<AutonomousChipView {...chip({ autonomy: hour() })} />);
        expect(html).toContain("lucide-shield-check");
        expect(html).toContain("Autonomous · 52 min left");
        expect(html).toContain(">Stop<");
        expect(html).toContain('aria-label="Stop the autonomous mode: Flore asks you again"');
        expect(html).toContain('role="status"');
    });

    it("says always for an always", () => {
        expect(renderToStaticMarkup(<AutonomousChipView {...chip({ autonomy: autonomy() })} />)).toContain(
            "Autonomous · always"
        );
    });

    it("shows nothing while the session asks", () => {
        expect(AutonomousChipView(chip())).toBeNull();
    });

    it("stops on a click on Stop, and the click goes no further", () => {
        const props = chip({ autonomy: hour() });
        const stopPropagation = vi.fn();
        byId(AutonomousChipView(props), "companion-autonomous-stop").props.onClick({ stopPropagation });
        expect(props.onStop).toHaveBeenCalledTimes(1);
        expect(stopPropagation).toHaveBeenCalledTimes(1);
        expect(
            byId(AutonomousChipView(chip({ autonomy: hour() }, { busy: true })), "companion-autonomous-stop").props
                .disabled
        ).toBe(true);
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = renderToStaticMarkup(<AutonomousChipView {...chip({ autonomy: hour() })} />);
            expect(html).toContain("Autonome · encore 52 min");
            expect(html).toContain(">Arrêter<");
            expect(renderToStaticMarkup(<AutonomousChipView {...chip({ autonomy: autonomy() })} />)).toContain(
                "Autonome · toujours"
            );
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

describe("what the session approved on its own (#2474)", () => {
    it("counts them since the mode began, with the list to open", () => {
        const html = renderToStaticMarkup(<AutonomyLine permit={permit({ autonomy: autonomy({ approved: 7 }) })} />);
        expect(html).toContain("7 permissions approved automatically since 10:42");
        expect(html).toContain("see the list");
        expect(html).toContain('aria-expanded="false"');
        expect(html).not.toContain("companion-autolist");
    });

    it("says one in the singular, and nothing yet without a list to open", () => {
        expect(
            renderToStaticMarkup(<AutonomyLine permit={permit({ autonomy: autonomy({ approved: 1 }) })} />)
        ).toContain("1 permission approved automatically since 10:42");
        const none = renderToStaticMarkup(<AutonomyLine permit={permit({ autonomy: autonomy({ approved: 0 }) })} />);
        expect(none).toContain("Nothing approved automatically since 10:42");
        expect(none).not.toContain("see the list");
    });

    it("shows nothing while the session asks", () => {
        expect(renderToStaticMarkup(<AutonomyLine permit={permit()} />)).toBe("");
    });

    it("reads in French", () => {
        const i18n = I18nModel.getInstance();
        try {
            i18n.setLanguageSetting("fr");
            const html = renderToStaticMarkup(
                <AutonomyLine permit={permit({ autonomy: autonomy({ approved: 7 }) })} />
            );
            expect(html).toContain("7 autorisations validées automatiquement depuis 10:42");
            expect(html).toContain("voir la liste");
        } finally {
            i18n.setLanguageSetting("");
        }
    });
});

describe("where 'until tonight' ends", () => {
    const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m, 0).getTime();
    // The same table as the gate's (TestPeriodEnds, pkg/molten/keepawake/gate_test.go).
    it.each([
        [at(23, 10), at(23, 22)],
        [at(23, 20, 59), at(23, 22)],
        [at(23, 21), at(24, 6)],
        [at(23, 23, 30), at(24, 6)],
        [at(23, 2), at(23, 6)],
        [at(23, 5, 59), at(23, 6)],
        [at(23, 6), at(23, 22)],
    ])("%s", (from, want) => {
        expect(tonightEnd(from)).toBe(want);
    });
});

describe("the main agent block while its session runs on its own (#2474)", () => {
    const view: CompanionView = {
        blockid: "b1",
        version: 1,
        status: "live",
        agent: "claude",
        agentname: "Claude Code",
        usage: { pageurl: "https://claude.ai/settings/usage", pagename: "Claude usage" },
        session: { path: `/s/${Session}.jsonl`, linkedby: "hook", title: "Ship the search", started: now - Minute },
    };
    const hero = (heroPermit?: HeroPermit) => {
        const agentState: AgentStateInfo = { blockid: "b1", agent: "claude", state: "working", version: 1 };
        const props: CompanionHeroProps = {
            view,
            agentState,
            provider: "",
            arranging: false,
            onArrange: () => {},
            onLeaveArranging: () => {},
            integrationDetails: false,
            persistentIntegration: false,
            onIntegration: () => {},
            onHistory: () => {},
            onBackToCurrent: () => {},
            permit: heroPermit,
        };
        return renderToStaticMarkup(<CompanionHero {...props} />);
    };

    it("is as it was for an agent MoltenTerm cannot answer, or while the control is not known yet", () => {
        const html = hero(undefined);
        expect(html).not.toContain("companion-permit-tool");
        expect(html).not.toContain("data-autonomous");
        expect(html).not.toContain("companion-autonomous-chip");
    });

    it("puts the Permissions control first among its tools, and stays plain while the session asks", () => {
        const html = hero(permit());
        const tool = html.indexOf('data-testid="companion-permit-tool"');
        expect(tool).toBeGreaterThan(0);
        expect(tool).toBeLessThan(html.indexOf('data-testid="companion-usage"'));
        expect(tool).toBeLessThan(html.indexOf('data-testid="companion-history-open"'));
        expect(html).not.toContain("data-autonomous");
        expect(html).not.toContain("companion-autonomous-chip");
        expect(html).not.toContain("companion-autoline");
    });

    it("turns steel blue: the block, its chip in the header, the count of what it approved", () => {
        const html = hero(permit({ autonomy: { ...hour(), approved: 7 } }));
        expect(html).toMatch(/<section[^>]*data-autonomous=""[^>]*>/);
        expect(html).toMatch(/<section[^>]*class="mt-cb mt-cdash-hero"/);
        expect(html).toContain("Autonomous · 52 min left");
        expect(html).toContain("7 permissions approved automatically since");
        const chip = html.indexOf('data-testid="companion-autonomous-chip"');
        expect(chip).toBeGreaterThan(html.indexOf("Main agent"));
        expect(chip).toBeLessThan(html.indexOf('data-testid="companion-permit-tool"'));
        expect(html).toContain("Permissions: automatic");
    });
});

describe("the steel blue's tokens (#2474)", () => {
    // tokens.css and companion-permit.css are read as text: the colours are the theme's, in both themes.
    const tokens = readFileSync(new URL("../tokens.css", import.meta.url), "utf8");
    const css = readFileSync(new URL("./companion-permit.css", import.meta.url), "utf8");

    it("is a theme token with the light theme's counterpart, and the block wears it from the token only", () => {
        expect(tokens).toContain("--mt-state-autonomous: #7db4e6;");
        expect(tokens).toContain("--mt-state-autonomous-wash: #1b2530;");
        expect(tokens).toContain("--mt-state-autonomous-edge: #3f5a73;");
        expect(/:root\.mt-light \{[^}]*--mt-state-autonomous: #[0-9a-f]{6};/.test(tokens)).toBe(true);
        expect(css.replace(/\/\*[\s\S]*?\*\//g, "")).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
        expect(css).toContain("--df-accent: var(--mt-state-autonomous)");
        expect(css).toContain(".mt-cdash-hero[data-autonomous]");
    });

    it("reads at 4.5:1 on the block's surfaces and on its own chip, in both themes (WCAG 1.4.3)", () => {
        const dark = tokens.slice(tokens.indexOf(":root {"), tokens.indexOf(":root.mt-light {"));
        const light = tokens.slice(
            tokens.indexOf(":root.mt-light {"),
            tokens.indexOf(":root.mt-light [data-mt-dark-surface]")
        );
        const hex = (scope: string, name: string) => parseColor(new RegExp(`${name}: (#[0-9a-f]{6});`).exec(scope)[1]);
        for (const [scope, surfaces] of [
            [dark, ["--mt-surface-1", "--mt-surface-2", "--mt-surface-3", "--mt-state-autonomous-wash"]],
            [light, ["--mt-surface-1", "--mt-surface-2", "--mt-state-autonomous-wash"]],
        ] as [string, string[]][]) {
            for (const surface of surfaces) {
                expect(
                    contrastRatio(hex(scope, "--mt-state-autonomous"), hex(scope, surface)),
                    surface
                ).toBeGreaterThanOrEqual(4.5);
            }
            expect(
                contrastRatio(hex(scope, "--mt-state-autonomous-edge"), hex(scope, "--mt-surface-2")),
                "edge"
            ).toBeGreaterThanOrEqual(1.5);
        }
    });

    it("keeps the chip in the header where it fits, and moves it to the body's first row where it does not", () => {
        expect(css).toMatch(/\[data-where="body"\] \{\s*display: none;/);
        // The header needs the French label (405 px) and tools (313 px) notches beside the chip: below that, the body.
        const queries = [...css.matchAll(/@container mt-hero \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/g)];
        const chipQuery = queries.find((m) => m[2].includes('data-where="head"'));
        expect(Number(chipQuery?.[1])).toBeGreaterThanOrEqual(728);
        expect(css).toMatch(/\[data-where="head"\] \{\s*display: none;/);
        expect(css).toMatch(/\[data-where="body"\] \{\s*display: inline-flex;/);
    });

    it("stands still under reduced motion: the permission styles run no animation of their own", () => {
        expect(css).not.toMatch(/animation|@keyframes|transition/);
    });
});
