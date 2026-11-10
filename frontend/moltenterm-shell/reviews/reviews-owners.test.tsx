// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// FR-REV-034 (#2174): what the owners bar, the owner chip, a lead's group and the calm line show.

import { renderToStaticMarkup } from "react-dom/server";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChainEdge } from "../agent-chain-store";
import { I18nModel } from "../i18n/i18n";
import { CheckAgentsButton } from "./reviews-check";
import { LeadGroupHeader, OthersWaitLine, OwnerChip, OwnersBar } from "./reviews-owners";
import type { ViewScopeState } from "./reviews-owners-store";

const Chain: ChainEdge[] = [
    { lead: "Flore", sub: "Hugo", at: 1 },
    { lead: "Flore", sub: "Léa", at: 2 },
];

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

function bar(v: ViewScopeState, hidden = 0, owners = [{ name: "Flore", count: 2, subs: 2 }]): string {
    return renderToStaticMarkup(<OwnersBar view={v} edges={Chain} owners={owners} hidden={hidden} />);
}

describe("the owners bar", () => {
    it("says there is no filter in a view without an agent", () => {
        const html = bar(view());
        expect(html).toContain('data-filtered="false"');
        expect(html).toContain("No agent in this view: no filter");
        expect(html).toContain("All · 1");
        expect(html).not.toContain('data-testid="reviews-owners-chip"');
        expect(html).not.toContain('data-testid="reviews-owners-hidden"');
    });

    it("shows the followed agent with its sub-agents and what is hidden", () => {
        const html = bar(
            view({ scope: { agents: ["Flore"], ignored: [] }, names: new Set(["flore", "hugo", "lea"]) }),
            14
        );
        expect(html).toContain('data-filtered="true"');
        expect(html).toContain('data-agent="Flore"');
        expect(html).toContain("+ 2 sub-agents");
        expect(html).toContain('aria-label="Stop following Flore"');
        expect(html).toContain("14 others hidden");
        expect(html).toContain("Show all");
        expect(html).not.toContain("No agent in this view");
    });

    it("counts one hidden pull request in the singular, and says nothing for none", () => {
        const scope = { agents: ["Flore"], ignored: [] };
        expect(bar(view({ scope }), 1)).toContain("1 other hidden");
        expect(bar(view({ scope }), 0)).not.toContain("reviews-owners-hidden");
    });

    it("proposes an agent that joined, with Add and Ignore, and applies nothing", () => {
        const html = bar(
            view({ scope: { agents: ["Flore"], ignored: [] }, proposed: ["Jérôme"], present: ["Flore", "Jérôme"] })
        );
        expect(html).toContain('data-testid="reviews-owners-proposal"');
        expect(html).toContain("+ Jérôme ?");
        expect(html).toContain('data-testid="reviews-owners-proposal-add"');
        expect(html).toContain('aria-label="Ignore Jérôme"');
        expect(html.match(/data-testid="reviews-owners-chip"/g)).toHaveLength(1);
        expect(html).not.toContain('data-agent="Jérôme" class="inline-flex h-7 items-center gap-1.5');
    });

    it("keeps an agent that left on the filter until it is removed", () => {
        const html = bar(view({ scope: { agents: ["Flore"], ignored: [] }, present: [] }));
        expect(html).toContain('data-agent="Flore"');
    });

    describe("in French", () => {
        beforeAll(() => I18nModel.getInstance().setLanguageSetting("fr"));
        afterAll(() => I18nModel.getInstance().setLanguageSetting("en"));
        it("words the bar", () => {
            const html = bar(
                view({ scope: { agents: ["Flore"], ignored: [] }, proposed: ["Jérôme"], present: ["Flore", "Jérôme"] }),
                14
            );
            expect(html).toContain("Responsables");
            expect(html).toContain("+ 2 sous-agents");
            expect(html).toContain("14 autres masquées");
            expect(html).toContain("Tout afficher");
            expect(html).toContain("Ajouter");
        });
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
        const html = renderToStaticMarkup(<OthersWaitLine count={2} revealed={false} onToggle={() => {}} />);
        expect(html).toContain("2 others wait for you");
        expect(html).toContain('role="status"');
        expect(html).toContain(">Show<");
        expect(renderToStaticMarkup(<OthersWaitLine count={1} revealed onToggle={() => {}} />)).toContain(
            "1 other waits for you"
        );
    });

    it("is absent when nothing waits", () => {
        expect(renderToStaticMarkup(<OthersWaitLine count={0} revealed={false} onToggle={() => {}} />)).toBe("");
    });
});
