// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package release

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestAuditPublicNotes(t *testing.T) {
	clean := "## What this version brings\n\nThe status bar opens the version history.\n\n- Colours like #4f46e5 and [a heading](#usage) are fine.\n- The CI panel shows each pull request's checks.\n"
	if problems := AuditPublicNotes(clean, "DiamondForgeFr/moltenterm"); len(problems) > 0 {
		t.Fatalf("clean notes refused: %v", problems)
	}
	cases := map[string]string{
		"ticket":   "- The history opens (#187), see #12 #13.",
		"link":     "- See https://github.com/DiamondForgeFr/moltenterm/issues/187.",
		"count":    "- 31 commits and 23 tickets went into this version.",
		"empty":    "  \n",
		"too long": strings.Repeat("- a line\n", MaxPublicNoteLines+1),
	}
	for name, text := range cases {
		problems := AuditPublicNotes(text, "DiamondForgeFr/moltenterm")
		if len(problems) != 1 {
			t.Errorf("%s: problems %v, want one", name, problems)
		}
	}
	if problems := AuditPublicNotes("- See https://github.com/DiamondForgeFr/moltenterm-site for the docs.", "DiamondForgeFr/moltenterm"); len(problems) > 0 {
		t.Fatalf("a link to another repository of the owner was refused: %v", problems)
	}
	if refs := ticketReferences("#1 #2, page#3 &#38; (#4) #5-b"); strings.Join(refs, " ") != "#1 #2 #4" {
		t.Fatalf("ticket references %v", refs)
	}
}

func TestExecAgentGivesThePromptOnStdin(t *testing.T) {
	out, err := ExecAgent(context.Background(), t.TempDir(), []string{"cat"}, "the prompt")
	if err != nil || string(out) != "the prompt" {
		t.Fatalf("cat answered %q, %v", out, err)
	}
	if _, err := ExecAgent(context.Background(), t.TempDir(), []string{"false"}, ""); err == nil {
		t.Fatalf("a failing agent did not fail")
	}
	if got := cleanAgentNotes([]byte("```markdown\n## New\n\n- A thing\n```\n")); got != "## New\n\n- A thing" {
		t.Fatalf("fence not removed: %q", got)
	}
}

func TestPublicNotesFrontMatter(t *testing.T) {
	notes := ParsePublicNotes("---\ndraft: true\nchannel: rc\n---\n\n## New\n\n- A thing\n")
	if !notes.IsDraft() || notes.Get("channel") != "rc" || notes.Body != "## New\n\n- A thing\n" {
		t.Fatalf("parsed %+v", notes)
	}
	notes.Set(FrontMatterDate, "2026-10-20")
	if got := notes.String(); got != "---\ndraft: true\nchannel: rc\ndate: 2026-10-20\n---\n\n## New\n\n- A thing\n" {
		t.Fatalf("written:\n%s", got)
	}
	for _, text := range []string{"## New\n", "---\nnever closed\n", "\n---\ndraft: true\n---\n"} {
		if n := ParsePublicNotes(text); len(n.Front) > 0 || n.IsDraft() || n.Body != text {
			t.Errorf("%q read as front matter: %+v", text, n)
		}
	}
	if err := checkPublicNotes("---\ndraft: yes\n---\n- A thing\n", ""); err == nil || !strings.Contains(err.Error(), "draft") {
		t.Fatalf("a draft passed: %v", err)
	}
	if err := checkPublicNotes("---\ndate: 2026-10-20\n---\n- A thing\n", ""); err != nil {
		t.Fatalf("ready notes refused: %v", err)
	}
}

func TestInternalRecord(t *testing.T) {
	subjects := []string{
		"feat(#12,#13): the history window",
		"fix(#12): the history scrolls (#12)",
		"chore(release): v1.0.0-1 (rc)",
		"a subject outside the convention",
	}
	tickets, untracked := readRange(subjects)
	if len(tickets) != 2 || tickets[0].Number != 12 || strings.Join(tickets[0].Types, "/") != "feat/fix" || len(tickets[0].Descriptions) != 2 {
		t.Fatalf("tickets %+v", tickets)
	}
	if len(untracked) != 2 {
		t.Fatalf("untracked %v", untracked)
	}
	facts := NotesFacts{
		Tag: "v1.0.0-2", Since: "v1.0.0-1", Subjects: subjects, Repo: "Owner/app", Tickets: tickets, Untracked: untracked,
		Milestone:     &Milestone{Title: "1.0.0", Url: "https://github.com/Owner/app/milestone/1"},
		MilestoneOnly: []MilestoneIssue{{Number: 20, Title: "Closed without a commit", Url: "https://github.com/Owner/app/issues/20"}},
	}
	facts.Tickets[0].Title = "The history window"
	record := InternalRecord(facts)
	for _, want := range []string{
		"## v1.0.0-2 — engineering record",
		"Since **v1.0.0-1**: 4 commits, 2 tickets — 1 chore, 1 feat, 1 fix.",
		"- [#12](https://github.com/Owner/app/issues/12) · `feat/fix` — The history window\n  - the history window\n  - the history scrolls\n",
		"- [#13](https://github.com/Owner/app/issues/13) · `feat`\n",
		"- [#20](https://github.com/Owner/app/issues/20) — Closed without a commit",
		"- a subject outside the convention",
		"**Full diff:** https://github.com/Owner/app/compare/v1.0.0-1...v1.0.0-2",
	} {
		if !strings.Contains(record, want) {
			t.Fatalf("record lacks %q:\n%s", want, record)
		}
	}
}

func TestPrepareWritesTheAgentsNotesAndTheRecord(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	writeFile(t, filepath.Join(f.checkout, ".molten", "project.json"), strings.Replace(fixtureProject, `"firstpublic": "1.0.0",`, `"firstpublic": "1.0.0", "notesagent": ["my-agent", "-p"],`, 1))
	gitIn(t, f.checkout, "commit", "--quiet", "-am", "chore(#1): declare the notes agent")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	f.commitOnDevelop(t, "feat(#2): a second feature")
	answers := []string{"## What this version brings\n\nA second feature (#2).\n", "```markdown\n## What this version brings\n\nA second feature.\n```\n"}
	var prompts []string
	e := f.env()
	e.Agent = func(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error) {
		if strings.Join(argv, " ") != "my-agent -p" {
			t.Fatalf("agent argv %v", argv)
		}
		prompts = append(prompts, prompt)
		answer := answers[0]
		answers = answers[1:]
		return []byte(answer), nil
	}
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	if len(prompts) != 2 || !strings.Contains(prompts[0], "release notes of Fixture for the version v1.0.0-1") || !strings.Contains(prompts[0], "#2") {
		t.Fatalf("prompts %d:\n%s", len(prompts), strings.Join(prompts, "\n----\n"))
	}
	if !strings.Contains(f.out.String(), "ticket reference(s) (#2)") {
		t.Fatalf("the refused attempt was not explained:\n%s", f.out.String())
	}
	notes := ParsePublicNotes(readFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0-1.md")))
	if notes.Body != "## What this version brings\n\nA second feature.\n" || notes.Get(FrontMatterDate) == "" {
		t.Fatalf("public notes %+v", notes)
	}
	record := readFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0-1.internal.md"))
	if !strings.Contains(record, "#2") || !strings.Contains(record, "a second feature") {
		t.Fatalf("record:\n%s", record)
	}

	// Rewrite: the agent fails, the notes come from the commit subjects; MOLTEN_RELEASE_NOTES_AI=off never asks it.
	e.Agent = func(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error) {
		return nil, os.ErrNotExist
	}
	mustRun(t, f, "notes", e.Notes(ctx, "v1.0.0-1", NotesOptions{}))
	if body := ParsePublicNotes(readFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0-1.md"))).Body; body != "## New\n\n- A second feature\n" {
		t.Fatalf("fallback notes:\n%s", body)
	}
	t.Setenv(NotesAiEnv, "off")
	e.Agent = func(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error) {
		t.Fatalf("the agent was asked with %s=off", NotesAiEnv)
		return nil, nil
	}
	mustRun(t, f, "notes off", e.Notes(ctx, "v1.0.0-1", NotesOptions{}))

	mustRun(t, f, "finalize", e.Finalize(ctx, "v1.0.0-1"))
	if !strings.Contains(f.originFile(t, "v1.0.0-1", "releases/v1.0.0-1.internal.md"), "engineering record") {
		t.Fatalf("the record was not committed")
	}
}

func TestFinalizeRefusesDraftAndAuditedNotes(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	f.commitOnDevelop(t, "feat(#2): a second feature")
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	notesPath := filepath.Join(f.worktree(), "releases", "v1.0.0-1.md")
	writeFile(t, notesPath, "---\ndraft: true\n---\n- Written ahead.\n")
	mustFail(t, f, "finalize a draft", e.Finalize(ctx, "v1.0.0-1"), "draft: true")
	mustFail(t, f, "check a draft", e.Notes(ctx, "v1.0.0-1", NotesOptions{Check: true}), "draft: true")
	writeFile(t, notesPath, "- Fixed in 12 commits (#2).\n")
	mustFail(t, f, "finalize audited notes", e.Finalize(ctx, "v1.0.0-1"), "ticket reference")
	writeFile(t, notesPath, "- A second feature.\n")
	mustRun(t, f, "check", e.Notes(ctx, "v1.0.0-1", NotesOptions{Check: true}))
	mustRun(t, f, "finalize", e.Finalize(ctx, "v1.0.0-1"))
}

func TestPrepareKeepsHandWrittenNotes(t *testing.T) {
	f := makeFixture(t)
	ctx := context.Background()
	e := f.env()
	writeFile(t, filepath.Join(f.checkout, "releases", "v1.0.0-1.md"), "---\ndraft: true\n---\n\n## Hand-written\n")
	gitIn(t, f.checkout, "add", "-A")
	gitIn(t, f.checkout, "commit", "--quiet", "-m", "docs(#2): draft the notes")
	gitIn(t, f.checkout, "push", "--quiet", "origin", "develop")
	mustRun(t, f, "promote", e.Promote(ctx, PromoteOptions{Workflows: []string{"ci.yml"}}))
	mustRun(t, f, "prepare", e.Prepare(ctx, "v1.0.0-1"))
	notes := ParsePublicNotes(readFile(t, filepath.Join(f.worktree(), "releases", "v1.0.0-1.md")))
	if !notes.IsDraft() || notes.Get(FrontMatterDate) == "" || notes.Body != "## Hand-written\n" {
		t.Fatalf("kept notes %+v", notes)
	}
	if !strings.Contains(f.out.String(), "Notes kept") || !strings.Contains(f.out.String(), "draft: true") {
		t.Fatalf("output:\n%s", f.out.String())
	}
	if _, err := os.Stat(filepath.Join(f.worktree(), "releases", "v1.0.0-1.internal.md")); err != nil {
		t.Fatalf("no record beside kept notes: %v", err)
	}
}
