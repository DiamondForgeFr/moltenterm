// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// The set of provider marks (#2542, FR-BOSS-009 AC113): every agent MoltenTerm supports resolves to its provider's mark
// or to a recorded reason for the AI icon, an unknown agent keeps the AI icon, and each shipped file is the provider's
// own, safe to draw and recorded in NOTICE with its source and terms. Pure reads of the repository's files, made while
// the file is collected (no timeout there), so a loaded machine cannot make a test late.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
    AgentsWithoutMark,
    CatalogAliases,
    markAgentOf,
    markOf,
    markSize,
    ProviderMarks,
    ReasonNoMark,
    ReasonNotObtained,
    ReasonTerms,
    withoutMarkOf,
} from "./provider-marks";

const Root = join(__dirname, "../../..");
const read = (file: string) => readFileSync(join(Root, file), "utf8");

const AgentState = read("pkg/molten/agentstate.go");
const OnboardingAgents = read("pkg/molten/onboarding/agents.go");
const Notice = read("NOTICE");

// The agent ids MoltenTerm supports, by their constant in pkg/molten/agentstate.go.
const ConstOfId = new Map<string, string>(
    [...AgentState.matchAll(/^\s+(AgentId[A-Za-z]+)\s+=\s+"([a-z0-9-]+)"/gm)].map((m) => [m[1], m[2]])
);
const SupportedAgents = [...ConstOfId.values()];

// The ids the Library and the first launch offer: the keys of the catalogue in pkg/molten/onboarding/agents.go.
const CatalogIds = [...OnboardingAgents.matchAll(/^\t(?:"([a-z-]+)"|molten\.(AgentId[A-Za-z]+)):\s+\{/gm)].map(
    (m) => m[1] ?? ConstOfId.get(m[2])
);

describe("the agents MoltenTerm supports", () => {
    it("reads the supported agents from the Go source", () => {
        expect(SupportedAgents).toEqual(
            expect.arrayContaining(["claude", "codex", "gemini", "opencode", "kimi", "qwen", "cursor", "vibe"])
        );
        expect(CatalogIds.length).toBeGreaterThanOrEqual(8);
        expect(CatalogIds.every((id) => typeof id === "string")).toBe(true);
    });

    it("gives every supported agent its provider's mark, or says why it keeps the AI icon", () => {
        for (const agent of SupportedAgents) {
            const mark = markOf(agent);
            const without = withoutMarkOf(agent);
            expect(mark != null || without != null, `${agent} has neither a mark nor a reason`).toBe(true);
            expect(mark != null && without != null, `${agent} has both a mark and a reason`).toBe(false);
        }
    });

    it("gives every agent of the Library's catalogue the same answer as the agent it stands for", () => {
        for (const id of CatalogIds) {
            const canonical = CatalogAliases[id] ?? id;
            expect(SupportedAgents, `${id} is no supported agent`).toContain(canonical);
            expect(markOf(id)).toBe(markOf(canonical));
            expect(withoutMarkOf(id)).toBe(withoutMarkOf(canonical));
        }
    });

    it("lists no agent that is not supported", () => {
        for (const id of [...Object.keys(ProviderMarks), ...Object.keys(AgentsWithoutMark)]) {
            expect(SupportedAgents, `${id} is no supported agent`).toContain(id);
        }
        for (const [alias, id] of Object.entries(CatalogAliases)) {
            expect(CatalogIds, `${alias} is no catalogue id`).toContain(alias);
            expect(SupportedAgents).toContain(id);
        }
    });

    it("draws Claude Code, Codex, OpenCode and Cursor with their own marks", () => {
        for (const agent of ["claude", "codex", "opencode", "cursor"]) {
            expect(markOf(agent), agent).toBeDefined();
        }
        expect(markOf("claude")?.provider).toBe("Anthropic");
        expect(markOf("codex")?.provider).toBe("OpenAI");
        expect(markOf("claude-code")).toBe(markOf("claude"));
    });

    it("keeps the AI icon for Kimi Code, whose terms do not allow a mark in an application", () => {
        expect(markOf("kimi")).toBeUndefined();
        expect(withoutMarkOf("kimi")?.reason).toBe(ReasonTerms);
        expect(withoutMarkOf("kimi")?.source).toBe("https://www.kimi.com/policies/logo-usage-terms");
    });

    it("keeps the AI icon for an agent MoltenTerm does not know, whatever its name", () => {
        for (const agent of [
            "",
            "unknown",
            "glm",
            "minimax",
            "constructor",
            "__proto__",
            "toString",
            "hasOwnProperty",
        ]) {
            expect(markOf(agent), agent).toBeUndefined();
        }
        expect(markOf(undefined)).toBeUndefined();
        expect(markOf(null)).toBeUndefined();
        expect(withoutMarkOf("unknown")).toBeUndefined();
    });
});

describe("the agents that keep the AI icon say why", () => {
    it("records a reason, a source and a note for each", () => {
        const reasons = [ReasonTerms, ReasonNoMark, ReasonNotObtained];
        for (const [agent, why] of Object.entries(AgentsWithoutMark)) {
            expect(reasons, agent).toContain(why.reason);
            expect(why.provider, agent).not.toBe("");
            expect(why.source, agent).toMatch(/^https:\/\//);
            expect(why.note.length, agent).toBeGreaterThan(20);
        }
    });

    it("records each of them in NOTICE under its provider's name", () => {
        const providers = new Set(Object.values(AgentsWithoutMark).map((why) => why.provider));
        for (const provider of providers) {
            expect(Notice, provider).toContain(provider);
        }
    });
});

describe("each mark is recorded with its source and terms", () => {
    for (const [agent, mark] of Object.entries(ProviderMarks)) {
        it(`${agent}: the files exist, and NOTICE names the provider, the files, the source and the terms`, () => {
            for (const file of [mark.shipped.onDark, mark.shipped.onLight]) {
                expect(() => readFileSync(join(Root, file)), file).not.toThrow();
                expect(Notice, file).toContain(file);
            }
            for (const file of [mark.kit.onDark, mark.kit.onLight]) {
                expect(Notice, file).toContain(file);
            }
            expect(Notice).toContain(mark.provider);
            expect(Notice).toContain(mark.terms);
            expect(mark.source).not.toBe("");
            expect(mark.onDark).not.toBe("");
            expect(mark.onLight).not.toBe("");
            expect(mark.terms).toMatch(/^https:\/\//);
        });
    }
});

// An SVG file is data the app draws in an img element, where a script never runs; it is still checked, since a file a
// provider's kit ships is untrusted until read, and kept as small as the provider's own file.
describe("the shipped files are plain drawings", () => {
    const Forbidden = [
        /<script/i,
        /\son[a-z]+\s*=/i,
        /<foreignObject/i,
        /<image\b/i,
        /<use\b/i,
        /<iframe/i,
        /<!ENTITY/i,
        /@import/i,
        /javascript:/i,
        /href\s*=/i,
        /url\(\s*['"]?(?!#)/i,
    ];
    const shipped = new Set(
        Object.values(ProviderMarks)
            .flatMap((mark) => [mark.shipped.onDark, mark.shipped.onLight])
            .filter((file) => file.startsWith("frontend/moltenterm-shell/provider-marks/assets/"))
    );
    for (const file of shipped) {
        it(`${file}`, () => {
            const text = read(file);
            expect(text.length).toBeLessThan(10000);
            expect(text).toMatch(/<svg[\s>]/);
            for (const pattern of Forbidden) {
                expect(text, String(pattern)).not.toMatch(pattern);
            }
        });
    }

    it("lists every file of the assets folder, so a file nobody records cannot ship", () => {
        const names = [...shipped].map((file) => file.split("/").pop());
        const present = readdirSync(join(Root, "frontend/moltenterm-shell/provider-marks/assets"));
        expect(present.sort()).toEqual(names.sort());
    });
});

describe("the launcher's row finds the agent of a preset", () => {
    it("takes the preset's own id when it has a mark", () => {
        expect(markAgentOf("codex", "codex")).toBe("codex");
    });

    it("takes the program the command starts when the id is the developer's own", () => {
        expect(markAgentOf("work", "claude --model opus")).toBe("claude");
        expect(markAgentOf("work", "  codex  ")).toBe("codex");
    });

    it("finds nothing for an agent without a mark or a command that starts another program", () => {
        expect(markAgentOf("kimi", "kimi")).toBeUndefined();
        expect(markAgentOf("work", "my-agent --fast")).toBeUndefined();
        expect(markAgentOf(undefined, undefined)).toBeUndefined();
    });
});

describe("the size a mark is drawn at", () => {
    it("fits the visible mark to the slot, whatever clear space the file has", () => {
        for (const [agent, mark] of Object.entries(ProviderMarks)) {
            const { width, height } = markSize(mark, 16);
            const visibleHeight = height * mark.glyph;
            const visibleWidth = width * mark.glyph;
            expect(Math.max(visibleHeight, visibleWidth), agent).toBeGreaterThanOrEqual(15.9);
            expect(width / height, agent).toBeCloseTo(mark.ratio, 1);
        }
    });

    it("draws a mark with clear space of its own larger than its slot, so it is not smaller than the others", () => {
        const blossom = markSize(ProviderMarks.codex, 16);
        expect(blossom.height).toBeGreaterThan(16 * 1.5);
        const claude = markSize(ProviderMarks.claude, 16);
        expect(claude).toEqual({ width: 16, height: 16 });
    });

    it("never draws a mark under the provider's own minimum height", () => {
        const opencode = markSize(ProviderMarks.opencode, 12);
        expect(opencode.height).toBeGreaterThanOrEqual(ProviderMarks.opencode.minHeight);
        expect(opencode.width).toBeCloseTo(opencode.height * 0.8, 1);
    });
});
