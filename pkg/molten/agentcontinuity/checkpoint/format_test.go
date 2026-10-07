// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
)

const testAt = int64(1791367200000) // 2026-10-07T10:00:00Z

func TestRenderParseRoundTrip(t *testing.T) {
	c := MakeCheckpoint("ws-1")
	c.Started = testAt - 1000
	c.Updated = testAt
	c.UpdatedBy = OwnerAuto
	c.Transcript = molten.TaskTranscript{Agent: "claude", Session: "abc", Path: `/home/me/.claude/projects/x/abc "1".jsonl`}
	setAuto(c.Section(SectionGoal), "Ship the login page", testAt)
	user := c.Section(SectionDecisions)
	user.Body, user.Owner, user.At = "- Use bcrypt\n\n## not a section\n```\n## inside a fence\n```", OwnerUser, testAt
	agent := c.Section(SectionNext)
	agent.Body, agent.Owner, agent.At = "Run the e2e tests", "codex:0199", testAt
	out := c.Render()
	if !strings.Contains(string(out), "# Workspace task") || !strings.HasPrefix(string(out), "---\nworkspace: \"ws-1\"\n") {
		t.Fatalf("header:\n%s", out)
	}
	back := Parse(out)
	if back.Workspace != "ws-1" || back.Started != c.Started || back.Updated != testAt || back.UpdatedBy != OwnerAuto {
		t.Fatalf("front matter: %+v", back)
	}
	if back.Transcript != c.Transcript {
		t.Fatalf("transcript: %+v", back.Transcript)
	}
	if back.HandEdited {
		t.Fatal("a file MoltenTerm wrote is not hand edited")
	}
	if len(back.Sections) != len(SectionNames) {
		t.Fatalf("sections: %+v", back.Sections)
	}
	for i, name := range SectionNames {
		if back.Sections[i].Name != name {
			t.Fatalf("order: %v", back.Sections)
		}
	}
	goal := back.Section(SectionGoal)
	if goal.Owner != OwnerAuto || goal.Body != "Ship the login page" || goal.At != testAt {
		t.Fatalf("goal: %+v", goal)
	}
	dec := back.Section(SectionDecisions)
	if dec.Owner != OwnerUser || !strings.Contains(dec.Body, "### not a section") || !strings.Contains(dec.Body, "## inside a fence") {
		t.Fatalf("decisions: %+v", dec)
	}
	if next := back.Section(SectionNext); next.Owner != "codex:0199" || next.Body != "Run the e2e tests" {
		t.Fatalf("next: %+v", next)
	}
	if string(back.Render()) != string(out) {
		t.Fatalf("not stable:\n%s\n---\n%s", out, back.Render())
	}
}

func TestParseHandEdits(t *testing.T) {
	c := MakeCheckpoint("ws-1")
	setAuto(c.Section(SectionGoal), "Ship the login page", testAt)
	setAuto(c.Section(SectionFiles), "- `a.go`", testAt)
	text := string(c.Render())
	// The user rewrites the goal under its auto comment, adds a section and writes Next steps without a comment.
	text = strings.Replace(text, "Ship the login page", "Ship the login page and the signup page", 1)
	text = strings.Replace(text, "## Next steps\n", "## Next steps\n\nCall Bob first\n", 1)
	text += "\n## My notes\n\nkeep this\n"
	back := Parse([]byte(text))
	if !back.HandEdited {
		t.Fatal("hand edit not seen")
	}
	if goal := back.Section(SectionGoal); goal.Owner != OwnerUser || !strings.Contains(goal.Body, "signup") {
		t.Fatalf("an edited auto section is the user's: %+v", goal)
	}
	if files := back.Section(SectionFiles); files.Owner != OwnerAuto {
		t.Fatalf("an untouched auto section stays auto: %+v", files)
	}
	if next := back.Section(SectionNext); next.Owner != OwnerUser || next.Body != "Call Bob first" {
		t.Fatalf("next: %+v", next)
	}
	extra := back.Section("My notes")
	if extra == nil || !extra.Extra || extra.Body != "keep this" || extra.Owner != OwnerUser {
		t.Fatalf("unknown section: %+v", extra)
	}
	if back.Sections[len(back.Sections)-1].Name != "My notes" {
		t.Fatal("unknown sections come after the fixed ones")
	}
	if !strings.Contains(string(back.Render()), "## My notes") {
		t.Fatal("unknown section dropped")
	}
}

func TestParseToleratesAnyFile(t *testing.T) {
	back := Parse([]byte("Just some notes\n\n## goal\nfinish it\n"))
	if back.Preamble != "Just some notes" {
		t.Fatalf("preamble: %q", back.Preamble)
	}
	if goal := back.Section(SectionGoal); goal.Body != "finish it" || goal.Owner != OwnerUser || goal.Extra {
		t.Fatalf("a known section matches whatever its case: %+v", goal)
	}
	if back.Section(SectionTicket) == nil || back.Section(SectionTicket).Body != "" {
		t.Fatal("a missing section is empty")
	}
	empty := Parse(nil)
	if !empty.Empty() || len(empty.Sections) != len(SectionNames) {
		t.Fatalf("empty: %+v", empty)
	}
	broken := Parse([]byte("---\nworkspace: x\nno end of front matter"))
	if broken.Workspace != "" {
		t.Fatal("an unterminated front matter is text")
	}
}

func TestApplyAutoOwnership(t *testing.T) {
	c := MakeCheckpoint("ws-1")
	in := AutoInput{
		Agent: "claude", SessionId: "s1", TranscriptPath: "/home/me/.claude/projects/x/s1.jsonl", Folder: "/work/app", Home: "/home/me",
		Digest: companion.SessionDigest{
			FirstPrompt: &companion.Prompt{Text: "Build the login page", At: testAt},
			Todos:       []companion.Todo{{Text: "Form", Status: companion.TodoCompleted}, {Text: "Tests", Status: companion.TodoInProgress}, {Text: "Docs", Status: companion.TodoPending}},
			TodosAt:     testAt,
			Files:       []companion.FileInfo{{Path: "/work/app/src/login.go", Kind: companion.FileUpdated, At: testAt}, {Path: "/home/me/notes.md", Kind: companion.FileAdded, At: testAt}},
		},
		Git: GitState{Repo: true, Branch: "feature/42-login", HasUpstream: true, Ahead: 2},
		At:  testAt,
	}
	if !ApplyAuto(c, in) {
		t.Fatal("nothing applied")
	}
	if g := c.Section(SectionGoal); g.Body != "Build the login page" || g.Owner != OwnerAuto {
		t.Fatalf("goal: %+v", g)
	}
	if tk := c.Section(SectionTicket).Body; !strings.Contains(tk, "#42") || !strings.Contains(tk, "feature/42-login") || !strings.Contains(tk, "2 ahead") {
		t.Fatalf("ticket: %q", tk)
	}
	plan := c.Section(SectionPlan).Body
	for _, want := range []string{"1 of 3 done.", "- [x] Form", "- [ ] Tests (in progress)", "- [ ] Docs"} {
		if !strings.Contains(plan, want) {
			t.Fatalf("plan lacks %q: %q", want, plan)
		}
	}
	files := c.Section(SectionFiles).Body
	if !strings.Contains(files, "- `src/login.go` (modified)") || !strings.Contains(files, "- `~/notes.md` (added)") {
		t.Fatalf("files: %q", files)
	}
	if tr := c.Section(SectionTranscript).Body; !strings.Contains(tr, "Claude Code") || !strings.Contains(tr, "`s1`") || !strings.Contains(tr, "~/.claude/projects/x/s1.jsonl") {
		t.Fatalf("transcript: %q", tr)
	}
	if c.Transcript.Session != "s1" || c.Transcript.Agent != "claude" {
		t.Fatalf("pointer: %+v", c.Transcript)
	}
	if ApplyAuto(c, in) {
		t.Fatal("the same observations change nothing")
	}

	// The user writes Goal and Next steps (TC-CONT-009); two more turns follow.
	goal := c.Section(SectionGoal)
	goal.Body, goal.Owner = "My own goal", OwnerUser
	next := c.Section(SectionNext)
	next.Body, next.Owner = "Ask Bob", OwnerUser
	agentDecisions := c.Section(SectionDecisions)
	agentDecisions.Body, agentDecisions.Owner = "Use JWT", "codex:x"
	in.Digest.FirstPrompt = &companion.Prompt{Text: "Another goal", At: testAt + 1}
	in.Digest.Todos = []companion.Todo{{Text: "Form", Status: companion.TodoCompleted}, {Text: "Tests", Status: companion.TodoCompleted}}
	in.Digest.Files = []companion.FileInfo{{Path: "/work/app/src/signup.go", Kind: companion.FileAdded, At: testAt + 5}}
	if !ApplyAuto(c, in) {
		t.Fatal("new files and todos must update")
	}
	if c.Section(SectionGoal).Body != "My own goal" || c.Section(SectionNext).Body != "Ask Bob" || c.Section(SectionDecisions).Body != "Use JWT" {
		t.Fatal("auto overwrote a section the user or an agent wrote")
	}
	if !strings.Contains(c.Section(SectionPlan).Body, "2 of 2 done.") {
		t.Fatalf("plan not updated: %q", c.Section(SectionPlan).Body)
	}
	files = c.Section(SectionFiles).Body
	lines := strings.Split(files, "\n")
	if len(lines) != 3 || !strings.Contains(lines[0], "src/signup.go") || !strings.Contains(files, "src/login.go") {
		t.Fatalf("files merge, newest first: %q", files)
	}
	// A user-owned Files touched is left alone.
	fs := c.Section(SectionFiles)
	fs.Owner = OwnerUser
	in.Digest.Files = []companion.FileInfo{{Path: "/work/app/x.go", At: testAt + 9}}
	ApplyAuto(c, in)
	if strings.Contains(c.Section(SectionFiles).Body, "x.go") {
		t.Fatal("auto wrote a user section")
	}
}

func TestApplyAutoAfterClear(t *testing.T) {
	c := MakeCheckpoint("ws-1")
	c.Started = testAt + 1000
	in := AutoInput{
		Agent: "codex", TranscriptPath: "/p.jsonl",
		Digest: companion.SessionDigest{
			FirstPrompt: &companion.Prompt{Text: "old task", At: testAt},
			Prompts:     []companion.Prompt{{Text: "old task", At: testAt}, {Text: "new task", At: testAt + 2000}},
			Todos:       []companion.Todo{{Text: "old step"}},
			TodosAt:     testAt,
			Files:       []companion.FileInfo{{Path: "/old.go", At: testAt}},
		},
		At: testAt + 3000,
	}
	ApplyAuto(c, in)
	if c.Section(SectionGoal).Body != "new task" {
		t.Fatalf("goal after clear: %q", c.Section(SectionGoal).Body)
	}
	if c.Section(SectionPlan).Body != "" || c.Section(SectionFiles).Body != "" {
		t.Fatal("what came before the clear is not the new task's")
	}
}

func TestTicketFromBranch(t *testing.T) {
	cases := map[string]string{
		"feature/42-login":     "#42",
		"fix/178":              "#178",
		"feature/#7-x":         "#7",
		"fix/ABC-12-crash":     "ABC-12",
		"bugfix/PROJ-9_thing":  "PROJ-9",
		"main":                 "",
		"develop":              "",
		"feature/login-42":     "",
		"rc-1.0.0":             "",
		"feature/2026-10-plan": "#2026",
	}
	for branch, want := range cases {
		if got := TicketFromBranch(branch); got != want {
			t.Errorf("%q: got %q, want %q", branch, got, want)
		}
	}
}
