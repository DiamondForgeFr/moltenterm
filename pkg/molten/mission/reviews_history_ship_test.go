// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package mission

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestPrSummary(t *testing.T) {
	cases := []struct {
		name string
		body string
		want string
	}{
		{"summary section", "Resolves #1\n\n## Summary\n\n- **Cards** open the [ticket](https://x) in `one` click.\n- more", "Cards open the ticket in one click."},
		{"what section", "## What\n\nThe dialog lists the changes.", "The dialog lists the changes."},
		{"first prose", "Resolves #12\n\nThe texts cite AGENTS.md first.\n\nmore", "The texts cite AGENTS.md first."},
		{"signature block skipped", "<!-- molten\nagents: x\n-->\nPlain line.", "Plain line."},
		{"empty", "", ""},
	}
	for _, c := range cases {
		if got := prSummary(c.body); got != c.want {
			t.Errorf("%s: prSummary = %q, want %q", c.name, got, c.want)
		}
	}
	long := strings.Repeat("a", 300)
	if got := prSummary(long); len([]rune(got)) != prSummaryMaxRunes || !strings.HasSuffix(got, "…") {
		t.Errorf("a long line is cut to %d runes with an ellipsis, got %d", prSummaryMaxRunes, len([]rune(got)))
	}
}

func TestBehaviourChange(t *testing.T) {
	if got := behaviourChange("feat(#1): cards", "## Summary\n\nA new card.", []string{"enhancement"}); got != nil {
		t.Fatalf("no signal flags nothing, got %+v", got)
	}
	got := behaviourChange("feat(#1): cards", "", []string{"Behaviour change"})
	if got == nil || got.From != BehaviourFromLabel || got.Label != "Behaviour change" {
		t.Fatalf("a label flags, got %+v", got)
	}
	got = behaviourChange("fix(#2): x", "## Summary\n\nx\n\n## Behaviour change\n\nEscape now closes the dialog without asking.\n\n## Tests", nil)
	if got == nil || got.From != BehaviourFromSection || got.Verify != "Escape now closes the dialog without asking." {
		t.Fatalf("a section flags with what to verify, got %+v", got)
	}
	got = behaviourChange("fix(#2): x", "**Breaking change:** the setting is renamed.", nil)
	if got == nil || got.Verify != "the setting is renamed." {
		t.Fatalf("a bold lead flags with its text, got %+v", got)
	}
	got = behaviourChange("fix(#2): x", "BREAKING CHANGE: the old key is gone", []string{"breaking"})
	if got == nil || got.From != BehaviourFromLabel || got.Verify != "the old key is gone" {
		t.Fatalf("a label and a footer combine, got %+v", got)
	}
	got = behaviourChange("feat(#3)!: new layout", "", nil)
	if got == nil || got.From != BehaviourFromBreaking {
		t.Fatalf("a ! title flags, got %+v", got)
	}
	if got := behaviourChange("feat(#3): we discuss a breaking change idea", "No behaviour change here.", nil); got != nil {
		t.Fatalf("prose never flags, got %+v", got)
	}
}

func TestHistoryTicketParents(t *testing.T) {
	var issue ghHistoryIssue
	raw := `{"number":3,"title":"Task","url":"u3","issueType":{"name":"Task"},"parent":{"number":2,"title":"Story","url":"u2","issueType":{"name":"Story"},"parent":{"number":1,"title":"Epic","url":"u1","issueType":{"name":"Epic"}}}}`
	if err := json.Unmarshal([]byte(raw), &issue); err != nil {
		t.Fatal(err)
	}
	ticket := ticketOfIssue(issue)
	if len(ticket.Parents) != 2 || ticket.Parents[0].Number != 2 || ticket.Parents[1].Type != "Epic" {
		t.Fatalf("parents nearest first, got %+v", ticket.Parents)
	}
	if !strings.Contains(historyIssueFields(true), "parent{") || strings.Contains(historyIssueFields(false), "parent") {
		t.Fatal("the parents come with the issue types only")
	}
}

func TestMakeHistoryPrReadsSummaryAndFlag(t *testing.T) {
	var pr ghHistoryPr
	raw := `{"number":9,"title":"fix(#4): x","body":"## Summary\n\nOne line.\n\n## Behaviour change\n\nCheck the menu.","labels":{"nodes":[{"name":"bug"}]}}`
	if err := json.Unmarshal([]byte(raw), &pr); err != nil {
		t.Fatal(err)
	}
	row := makeHistoryPr(pr, nil)
	if row.Summary != "One line." || len(row.Labels) != 1 || row.Behaviour == nil || row.Behaviour.Verify != "Check the menu." {
		t.Fatalf("got %+v", row)
	}
}
