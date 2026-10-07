// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/baseds"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/companion"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Regressions from the adversarial review of #178.

func TestUnclosedFenceDoesNotSwallowSections(t *testing.T) {
	s, clock := makeTestStore(t)
	fence := strings.Repeat("`", 3)
	in := AutoInput{
		Agent: "claude", TranscriptPath: "/p.jsonl",
		Digest: companion.SessionDigest{FirstPrompt: &companion.Prompt{Text: fence + "go fmt.Println(x)" + fence + " fails, fix it", At: testAt}},
		Git:    GitState{Repo: true, Branch: "feature/1-x"},
	}
	s.Update("ws-1", OwnerUser, func(c *Checkpoint) bool {
		d := c.Section(SectionDecisions)
		d.Body, d.Owner = fence+"\nunclosed code\n", OwnerUser
		return true
	})
	sizes := []int{}
	for i := 0; i < 4; i++ {
		clock.add(time.Minute)
		in.At = clock.now().UnixMilli()
		s.Update("ws-1", OwnerAuto, func(c *Checkpoint) bool { return ApplyAuto(c, in) })
		path, _ := s.Path("ws-1")
		info, _ := os.Stat(path)
		sizes = append(sizes, int(info.Size()))
	}
	c, _, _ := s.Read("ws-1")
	if c.Section(SectionGoal).Owner != OwnerAuto || !strings.HasPrefix(c.Section(SectionGoal).Body, fence) {
		t.Fatalf("goal: %+v", c.Section(SectionGoal))
	}
	if !strings.Contains(c.Section(SectionTicket).Body, "#1") || !strings.Contains(c.Section(SectionDecisions).Body, "unclosed code") {
		t.Fatalf("sections swallowed:\n%s", c.Render())
	}
	if sizes[len(sizes)-1] != sizes[1] {
		t.Fatalf("the file grows on each update: %v", sizes)
	}
}

func TestHandEditOfAgentSectionIsSeen(t *testing.T) {
	c := MakeCheckpoint("ws-1")
	sec := c.Section(SectionNext)
	sec.Body, sec.Owner, sec.At = "Run e2e", "claude:abc", testAt
	text := strings.Replace(string(c.Render()), "Run e2e", "Run e2e, then ship", 1)
	back := Parse([]byte(text))
	if !back.HandEdited || back.Section(SectionNext).Owner != OwnerUser {
		t.Fatalf("a hand edit of an agent's section: %+v", back.Section(SectionNext))
	}
}

func TestEmptyFrontMatterKeepsBody(t *testing.T) {
	back := Parse([]byte("---\n---\n## Goal\nmy goal\n"))
	if back.Section(SectionGoal).Body != "my goal" {
		t.Fatalf("goal: %q", back.Section(SectionGoal).Body)
	}
}

func TestAutoWriteOverCapIsRefused(t *testing.T) {
	s, _ := makeTestStore(t)
	path, _ := s.Path("ws-1")
	os.MkdirAll(filepath.Dir(path), 0o700)
	big := "## Decisions\n\n" + strings.Repeat("a decision line\n", MaxCheckpointBytes/10)
	os.WriteFile(path, []byte(big), 0o600)
	_, err := s.Update("ws-1", OwnerAuto, func(c *Checkpoint) bool {
		return setAuto(c.Section(SectionTicket), "#1", testAt)
	})
	if err != ErrTooLarge {
		t.Fatalf("an auto write over the cap: %v", err)
	}
	if data, _ := os.ReadFile(path); string(data) != big {
		t.Fatal("the user's file must stay as it was")
	}
}

func TestHistoryIsRedactedAndNotFlooded(t *testing.T) {
	s, clock := makeTestStore(t)
	s.Update("ws-1", OwnerUser, setGoal("my goal", OwnerUser))
	path, _ := s.Path("ws-1")
	data, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(data), "my goal", "my goal DB_PASSWORD=hunter22", 1)), 0o600)
	clock.add(time.Second)
	s.Update("ws-1", OwnerAuto, func(c *Checkpoint) bool { return setAuto(c.Section(SectionTicket), "#1", testAt) })
	hist, _ := s.History("ws-1")
	for _, v := range hist {
		data, _ := os.ReadFile(filepath.Join(filepath.Dir(path), HistoryDir, versionName(v.At)))
		if strings.Contains(string(data), "hunter22") {
			t.Fatal("an archived hand edit keeps its secret")
		}
	}
	before := len(hist)
	for i := 0; i < MaxVersions+5; i++ {
		clock.add(time.Second)
		s.Clear("ws-1")
	}
	hist, _ = s.History("ws-1")
	if len(hist) != before+1 {
		t.Fatalf("repeated clears flood the history: %d versions, had %d", len(hist), before)
	}
}

func versionName(at int64) string {
	return strconv.FormatInt(at, 10) + ".md"
}

func TestHistoryLinkIsNotFollowed(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlinks")
	}
	s, _ := makeTestStore(t)
	s.Update("ws-1", OwnerUser, setGoal("a", OwnerUser))
	outside := t.TempDir()
	victim := filepath.Join(outside, "1.md")
	os.WriteFile(victim, []byte("x"), 0o600)
	hist := filepath.Join(s.Root(), "ws-1", HistoryDir)
	os.RemoveAll(hist)
	os.Symlink(outside, hist)
	for i := 0; i < MaxVersions+2; i++ {
		s.Update("ws-1", OwnerUser, setGoal("b"+strconv.Itoa(i), OwnerUser))
	}
	if _, err := os.Stat(victim); err != nil {
		t.Fatal("pruning followed a linked history folder")
	}
}

func TestUpdaterAppliesTriggersInOrder(t *testing.T) {
	store, clock := makeTestStore(t)
	u := MakeUpdater(store)
	u.now = clock.now
	sched := &fakeScheduler{}
	u.afterFunc = sched.after
	u.workspaceOf = func(string) (string, error) { return "ws-1", nil }
	u.Trigger("z-later-id")
	clock.add(time.Second)
	u.Trigger("a-earlier-id")
	order := u.takePending("ws-1")
	if len(order) != 2 || order[0] != "z-later-id" || order[1] != "a-earlier-id" {
		t.Fatalf("panes are applied in trigger order: %v", order)
	}
}

func TestRouteRefusesUnstampedSources(t *testing.T) {
	s, _ := makeTestStore(t)
	l := &routeLink{store: s, output: make(chan []byte, 1), localSource: func(string, baseds.LinkId) bool { return false }}
	l.answer(wshutil.RpcMessage{Command: molten.TaskReadCommand, ReqId: "r1", Source: "tab:x", Data: map[string]any{"workspaceid": "ws-1"}}, 7)
	out := string(<-l.output)
	if !strings.Contains(out, "local terminals only") {
		t.Fatalf("a source not on its link must be refused: %s", out)
	}
}
