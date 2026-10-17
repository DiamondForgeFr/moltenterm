// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentsign

import (
	"reflect"
	"strings"
	"testing"
)

var valentin = Signature{FirstName: "Valentin", Agent: "Claude Code", Model: "Opus 5.5", Effort: "medium"}
var jerome = Signature{FirstName: "Jérôme", Agent: "Codex", Model: "gpt-5.5-codex", Effort: "high"}

func TestSignatureFormats(t *testing.T) {
	if got := valentin.Line(); got != "Valentin · Claude Code · Opus 5.5 · medium" {
		t.Fatalf("line: %q", got)
	}
	if got := valentin.Trailer(); got != "Molten-Agent: Valentin (Claude Code, Opus 5.5, medium)" {
		t.Fatalf("trailer: %q", got)
	}
	partial := Signature{FirstName: "Camille", Agent: "Codex"}
	if got := partial.Line(); got != "Camille · Codex" {
		t.Fatalf("partial line: %q", got)
	}
	if got := partial.TrailerValue(); got != "Camille (Codex)" {
		t.Fatalf("partial trailer: %q", got)
	}
	odd := Signature{FirstName: "A\nB", Agent: "Claude Code", Model: "Opus 5.5 (1M, context)", Effort: "x·y"}
	if got := odd.TrailerValue(); got != "A B (Claude Code, Opus 5.5 1M context, x-y)" {
		t.Fatalf("cleaned trailer: %q", got)
	}
}

func TestTrailerRoundTrip(t *testing.T) {
	for _, sig := range []Signature{valentin, jerome, {FirstName: "Camille", Agent: "Codex"}, {FirstName: "Solo"}} {
		got, ok := ParseTrailerValue(sig.TrailerValue())
		if !ok || got != sig {
			t.Fatalf("round trip of %+v: %+v %v", sig, got, ok)
		}
	}
	if _, ok := ParseTrailerValue("  "); ok {
		t.Fatal("an empty value is no signature")
	}
}

func TestCommitAgents(t *testing.T) {
	msg := "feat(#847): x\n\nBody line: not a trailer\n\nMolten-Agent: Valentin (Claude Code, Opus 5.5, medium)\nCo-Authored-By: Claude <noreply@anthropic.com>\n"
	got := CommitAgents(msg)
	if !reflect.DeepEqual(got, []Signature{valentin}) {
		t.Fatalf("agents: %+v", got)
	}
	if got := CommitAgents("fix: nothing"); len(got) != 0 {
		t.Fatalf("no trailer: %+v", got)
	}
}

func TestWithAgentAddsBlockAboveGenerated(t *testing.T) {
	body := "Resolves #847\n\nSummary.\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n"
	got := WithAgent(body, valentin)
	if !strings.HasSuffix(got, "\n\n🤖 Generated with [Claude Code](https://claude.com/claude-code)\n") {
		t.Fatalf("generated line no longer last:\n%s", got)
	}
	if !strings.Contains(got, BlockStart+"\n---\nMade by Valentin · Claude Code · Opus 5.5 · medium\n"+BlockEnd) {
		t.Fatalf("block:\n%s", got)
	}
	if !strings.HasPrefix(got, "Resolves #847\n\nSummary.\n\n"+BlockStart) {
		t.Fatalf("body kept:\n%s", got)
	}
	b, ok := ParseBlock(got)
	if !ok || !reflect.DeepEqual(b.Agents, []Signature{valentin}) {
		t.Fatalf("parsed: %+v %v", b, ok)
	}
}

func TestWithAgentKeepsEarlierAgentsAndReview(t *testing.T) {
	body := WithAgent("Resolves #1", jerome)
	body = WithReview(body, Review{Name: "Anthony", Date: "2026-10-16", Url: "https://github.com/o/r/pull/1#pullrequestreview-9"})
	body = WithAgent(body, valentin)
	if strings.Count(body, BlockStart) != 1 {
		t.Fatalf("one block:\n%s", body)
	}
	want := "Made by Valentin · Claude Code · Opus 5.5 · medium\\\nEarlier: Jérôme · Codex · gpt-5.5-codex · high\\\n" +
		"Reviewed by Anthony · 2026-10-16 · [review](https://github.com/o/r/pull/1#pullrequestreview-9)\n"
	if !strings.Contains(body, want) {
		t.Fatalf("block lines:\n%s", body)
	}
	b, _ := ParseBlock(body)
	if !reflect.DeepEqual(b.Agents, []Signature{valentin, jerome}) {
		t.Fatalf("agents: %+v", b.Agents)
	}
	if b.Reviewed == nil || *b.Reviewed != (Review{Name: "Anthony", Date: "2026-10-16", Url: "https://github.com/o/r/pull/1#pullrequestreview-9"}) {
		t.Fatalf("review: %+v", b.Reviewed)
	}
	again := WithAgent(body, Signature{FirstName: "Jérôme", Agent: "Codex", Model: "gpt-5.5-codex", Effort: "low"})
	b, _ = ParseBlock(again)
	if len(b.Agents) != 2 || b.Agents[0].Effort != "low" || b.Agents[1] != valentin {
		t.Fatalf("same agent moves first with its new effort: %+v", b.Agents)
	}
}

func TestWithReviewWithoutAgents(t *testing.T) {
	got := WithReview("", Review{Name: "Anthony", Date: "2026-10-16"})
	if got != BlockStart+"\n---\nReviewed by Anthony · 2026-10-16\n"+BlockEnd+"\n" {
		t.Fatalf("review only: %q", got)
	}
}

func TestPrAgents(t *testing.T) {
	body := WithAgent(WithAgent("", jerome), Signature{FirstName: "Camille", Agent: "Codex"})
	commits := []string{
		"feat: one\n\nMolten-Agent: Jérôme (Codex, gpt-5.5-codex, high)",
		"fix: by hand",
		"feat: two\n\nMolten-Agent: Valentin (Claude Code, Opus 5.5, medium)",
	}
	got, fromCommits := PrAgents(commits, body)
	want := []Signature{valentin, jerome, {FirstName: "Camille", Agent: "Codex"}}
	if !fromCommits || !reflect.DeepEqual(got, want) {
		t.Fatalf("agents: %+v %v", got, fromCommits)
	}
	got, fromCommits = PrAgents([]string{"fix: by hand"}, body)
	if fromCommits || len(got) != 2 || got[0].FirstName != "Camille" {
		t.Fatalf("body only: %+v %v", got, fromCommits)
	}
	if got, _ := PrAgents(nil, "no block"); len(got) != 0 {
		t.Fatalf("unknown agent: %+v", got)
	}
}
