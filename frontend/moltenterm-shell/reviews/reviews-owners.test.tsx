// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-REV-034 (#2174, #2207): what the owners menu, the funnel, the owner chip, a lead's group and the calm line show,
// and that the panel's body keeps no owners row.

import { readFileSync } from "fs";
import { atom, PrimitiveAtom } from "jotai";
import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { I18nModel, labelled, t } from "../i18n/i18n";
import { CheckAgentsButton } from "./reviews-check";
import { LeadGroupHeader, OthersWaitLine, OwnerChip, OwnersFilterHost } from "./reviews-owners";
import type { OwnersMenuAnchor } from "./reviews-owners-filter";
import { OwnersFilterIcon } from "./reviews-owners-icon";
import { OwnersMenu } from "./reviews-owners-menu";
import type { OwnersFilterFacts } from "./reviews-owners-model";
import type { ViewScopeState } from "./reviews-owners-store";

function view(over: Partial<ViewScopeState> = {}): ViewScopeState {
    const none = () => {};
    return {
        tabId: "t1",
        scope: { agents: [], ignored: [] },
        names: null,
        present: [],
        proposed: [],
        add: none,
        ignore: none,
        remove: none,
        only: none,
        showAll: none,
        ...over,
    };
}

const Anchor: OwnersMenuAnchor = { right: 300, bottom: 40 };
const Owners = [
    { name: "Flore", count: 2, subs: 2 },
    { name: "Hugo", count: 1, subs: 0 },
];

function menu(v: ViewScopeState, hidden = 0, owners = Owners): string {
    return renderToStaticMarkup(
        <OwnersMenu
            view={v}
            owners={owners}
            hidden={hidden}
            label="Choose whose work to show"
            anchor={Anchor}
            onClose={() => {}}
        />
    );
}

describe("the owners menu", () => {
    it("lists the owners with their work and sub-agents, none checked without a filter", () => {
        const html = menu(view({ present: ["Flore"] }));
        expect(html).toContain('role="menu"');
        expect(html).toContain('data-agent="Flore"');
        expect(html).toContain('data-agent="Hugo"');
        expect(html).toContain("+ 2 sub-agents");
        expect(html).not.toContain('aria-checked="true"');
        expect(html).not.toContain("reviews-owners-menu-all");
        expect(html).not.toContain("reviews-owners-hidden");
        expect(html).not.toContain("reviews-owners-proposal");
    });

    it("checks the followed agent, then says what the filter hides above Show all", () => {
        const html = menu(view({ scope: { agents: ["Flore"], ignored: [] }, names: new Set(["flore", "hugo"]) }), 14);
        expect(html).toContain('aria-checked="true"');
        expect(html).toContain("14 others hidden");
        expect(html).toContain("Show all");
        expect(html.indexOf("14 others hidden")).toBeLessThan(html.indexOf("Show all"));
    });

    it("counts one hidden pull request in the singular, and says nothing for none", () => {
        const scope = { agents: ["Flore"], ignored: [] };
        expect(menu(view({ scope }), 1)).toContain("1 other hidden");
        expect(menu(view({ scope }), 0)).not.toContain("reviews-owners-hidden");
        expect(menu(view({ scope }), 0)).toContain("Show all");
    });

    it("proposes an agent that joined at the bottom, with Add and Ignore, and applies nothing", () => {
        const html = menu(
            view({ scope: { agents: ["Flore"], ignored: [] }, proposed: ["Jérôme"], present: ["Flore", "Jérôme"] }),
            3
        );
        expect(html).toContain('data-testid="reviews-owners-proposal"');
        expect(html).toContain("+ Jérôme ?");
        expect(html).toContain('data-testid="reviews-owners-proposal-add"');
        expect(html).toContain('aria-label="Ignore Jérôme"');
        expect(html.indexOf("reviews-owners-proposal")).toBeGreaterThan(html.indexOf("reviews-owners-menu-all"));
        expect(html.match(/role="menuitemcheckbox"/g)).toHaveLength(Owners.length);
    });

    it("keeps an agent that left on the filter, listed and checked, until it is unchecked", () => {
        const html = menu(view({ scope: { agents: ["Zoé"], ignored: [] }, present: [] }));
        expect(html).toMatch(/aria-checked="true"[^>]*data-agent="Zoé"/);
    });

    it("says no agent owns work yet when the list holds none", () => {
        expect(menu(view({ present: ["Flore"] }), 0, [])).toContain("No agent owns work here yet.");
    });

    it("hangs from a fixed position, out of the panel's body", () => {
        const html = menu(view({ present: ["Flore"] }));
        expect(html).toContain("fixed");
        expect(html).toContain("overflow-auto");
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));
        it("words the menu", () => {
            const html = menu(
                view({
                    scope: { agents: ["Flore"], ignored: [] },
                    proposed: ["Jérôme"],
                    present: ["Flore", "Jérôme"],
                }),
                14
            );
            expect(html).toContain("+ 2 sous-agents");
            expect(html).toContain("14 autres masquées");
            expect(html).toContain("Tout afficher");
            expect(html).toContain("Ajouter");
        });
    });
});

// AC12: the panel's body keeps no chip, no label and no sentence about the filter; the host draws no row at all.
describe("the panel's body", () => {
    function filterAtoms(facts: OwnersFilterFacts) {
        return {
            blockId: "b1",
            factsAtom: atom(facts),
            listsAtom: atom(0) as PrimitiveAtom<number>,
            menuAtom: atom(null) as PrimitiveAtom<OwnersMenuAnchor>,
            shownAtom: atom(null) as PrimitiveAtom<number>,
        };
    }
    function host(facts: OwnersFilterFacts, v: ViewScopeState): string {
        return renderToStaticMarkup(
            <OwnersFilterHost filter={filterAtoms(facts)} view={v} owners={Owners} hidden={14} />
        );
    }

    it("shows no owners row and no sentence in a view without an agent", () => {
        expect(host({ shown: false, names: [] }, view())).toBe("");
    });

    it("shows no owners row, chip, label or sentence when agents are in the view", () => {
        expect(host({ shown: true, names: [] }, view({ present: ["Flore"], proposed: ["Flore"] }))).toBe("");
    });

    it("shows none while a filter is on, nor for what it hides or an agent that joined", () => {
        const filtered = view({
            scope: { agents: ["Flore"], ignored: [] },
            names: new Set(["flore"]),
            present: ["Flore", "Jérôme"],
            proposed: ["Jérôme"],
        });
        expect(host({ shown: true, names: ["Flore"] }, filtered)).toBe("");
    });
});

describe("the funnel", () => {
    it("is an outline without a filter and takes a quarter fill with one", () => {
        const off = renderToStaticMarkup(<OwnersFilterIcon filled={false} />);
        const on = renderToStaticMarkup(<OwnersFilterIcon filled />);
        expect(off).toContain('fill="none"');
        expect(on).toContain('fill="currentColor"');
        expect(on).toContain('fill-opacity="0.25"');
        expect(on).toContain('aria-hidden="true"');
        expect(on).not.toContain("<text");
    });

    it("words its tooltip with the language's colon", () => {
        expect(t("reviews.owners.filterButton")).toBe("Filter by owner");
        expect(labelled(t("reviews.owners.label"), "Flore, Bérénice")).toBe("Owners: Flore, Bérénice");
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));
        it("words its tooltip", () => {
            expect(t("reviews.owners.filterButton")).toBe("Filtrer par responsable");
            expect(labelled(t("reviews.owners.label"), "Flore, Bérénice")).toMatch(
                /^Responsables\s:\sFlore, Bérénice$/
            );
        });
    });

    // The two choices of the design that no render shows: the action colour, and a filter that stays visible when the
    // panel is not focused.
    it("takes the action colour while a filter is on, and stays shown when the panel is not focused", () => {
        const header = readFileSync(new URL("../header/header.css", import.meta.url), "utf8");
        const shell = readFileSync(new URL("../moltenterm-shell.css", import.meta.url), "utf8");
        expect(header).toMatch(/\.wave-iconbutton\.mt-owners-filter\.is-on\s*\{[^}]*color:\s*var\(--mt-action\)/);
        expect(shell).toContain(".mt-owners-filter.is-on");
    });
});

describe("a card's owner", () => {
    it("names the agent, and the lead that handed it the work", () => {
        const own = renderToStaticMarkup(<OwnerChip owner={{ name: "Flore", lead: "" }} />);
        expect(own).toContain('data-owner="Flore"');
        expect(own).toContain(">Flore<");
        const sub = renderToStaticMarkup(<OwnerChip owner={{ name: "Hugo", lead: "Flore" }} />);
        expect(sub).toContain("Hugo · sub-agent of Flore");
    });

    it("says by hand only in a list where agents sign, and nothing otherwise", () => {
        expect(renderToStaticMarkup(<OwnerChip owner={null} byHand />)).toContain(">by hand<");
        expect(renderToStaticMarkup(<OwnerChip owner={null} />)).toBe("");
    });
});

describe("a lead's group", () => {
    it("names the lead, its sub-agents and the count, with the shortcut to filter on it", () => {
        const html = renderToStaticMarkup(
            <LeadGroupHeader lead="Flore" subs={["Hugo", "Léa"]} count={4} onFilter={() => {}} />
        );
        expect(html).toContain('data-lead="Flore"');
        expect(html).toContain("+ Hugo, Léa");
        expect(html).toContain("· 4");
        expect(html).toContain("Filter on Flore");
    });

    it("holds the work nobody owns under No agent, which folds", () => {
        const folded = renderToStaticMarkup(
            <LeadGroupHeader lead="" subs={[]} count={2} open={false} onToggle={() => {}} />
        );
        expect(folded).toContain("No agent");
        expect(folded).toContain("made by hand or by an agent that closed");
        expect(folded).toContain('aria-expanded="false"');
        expect(folded).not.toContain("Filter on");
    });
});

describe("Check the agents on a filtered list", () => {
    const check = { busy: false, report: null, check: () => {} } as unknown as Parameters<
        typeof CheckAgentsButton
    >[0]["check"];

    it("names whose agents it asks and how many pull requests it covers", () => {
        const html = renderToStaticMarkup(
            <CheckAgentsButton check={check} scope={{ names: ["Flore"], others: 14 }} count={3} />
        );
        expect(html).toContain("Check the agents of Flore (3)");
        expect(
            renderToStaticMarkup(<CheckAgentsButton check={check} scope={{ names: ["Flore"], others: 14 }} count={1} />)
        ).toContain("Check the agent of Flore (1)");
    });

    it("reads as it always did without a filter", () => {
        const html = renderToStaticMarkup(<CheckAgentsButton check={check} />);
        expect(html).toContain("Check the agents<");
        expect(html).not.toContain(" of ");
    });
});

describe("the calm line for what waits outside the filter", () => {
    it("counts the hidden pull requests that wait for the developer, with a link to show them", () => {
        const html = renderToStaticMarkup(<OthersWaitLine local={2} revealed={false} onToggle={() => {}} />);
        expect(html).toContain("2 others wait for you");
        expect(html).toContain('role="status"');
        expect(html).toContain(">Show<");
        expect(renderToStaticMarkup(<OthersWaitLine local={1} revealed onToggle={() => {}} />)).toContain(
            "1 other waits for you"
        );
    });

    it("counts what waits in the workspace's other projects too, and names them", () => {
        const html = renderToStaticMarkup(
            <OthersWaitLine
                local={1}
                elsewhere={[{ projectId: "p2", label: "Mobile", count: 2 }]}
                revealed={false}
                onToggle={() => {}}
            />
        );
        expect(html).toContain("3 others wait for you");
        expect(html).toContain("2 in Mobile");
        expect(html).toContain('data-project="p2"');
    });

    it("offers no Show when everything that waits is in another project", () => {
        const html = renderToStaticMarkup(
            <OthersWaitLine
                local={0}
                elsewhere={[{ projectId: "p2", label: "Mobile", count: 1 }]}
                revealed={false}
                onToggle={() => {}}
            />
        );
        expect(html).toContain("1 other waits for you");
        expect(html).not.toContain("reviews-owners-waits-toggle");
    });

    it("is absent when nothing waits", () => {
        expect(renderToStaticMarkup(<OthersWaitLine local={0} revealed={false} onToggle={() => {}} />)).toBe("");
    });
});
