// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package checkpoint

import (
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

type fakeClock struct {
	lock sync.Mutex
	t    time.Time
}

func (c *fakeClock) now() time.Time {
	c.lock.Lock()
	defer c.lock.Unlock()
	return c.t
}

func (c *fakeClock) add(d time.Duration) {
	c.lock.Lock()
	defer c.lock.Unlock()
	c.t = c.t.Add(d)
}

func makeTestStore(t *testing.T) (*Store, *fakeClock) {
	t.Helper()
	clock := &fakeClock{t: time.UnixMilli(testAt)}
	s := MakeStore(filepath.Join(t.TempDir(), "molten", "tasks"))
	s.now = clock.now
	return s, clock
}

func setGoal(text string, owner string) func(c *Checkpoint) bool {
	return func(c *Checkpoint) bool {
		sec := c.Section(SectionGoal)
		sec.Body, sec.Owner = text, owner
		return true
	}
}

func TestStoreWritePermissionsAndRedaction(t *testing.T) {
	s, _ := makeTestStore(t)
	var events []molten.TaskChanged
	s.SetOnChange(func(ev molten.TaskChanged) { events = append(events, ev) })
	wrote, err := s.Update("ws-1", OwnerAuto, setGoal("Deploy with GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789", OwnerAuto))
	if err != nil || !wrote {
		t.Fatalf("update: %v %v", wrote, err)
	}
	path, _ := s.Path("ws-1")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "ghp_") || !strings.Contains(string(data), Redacted) {
		t.Fatalf("secret written:\n%s", data)
	}
	if runtime.GOOS != "windows" {
		for p, want := range map[string]os.FileMode{path: fileMode, filepath.Dir(path): dirMode, s.Root(): dirMode} {
			info, err := os.Stat(p)
			if err != nil || info.Mode().Perm() != want {
				t.Fatalf("%s: mode %v, want %v (%v)", p, info.Mode().Perm(), want, err)
			}
		}
	}
	if len(events) != 1 || events[0].WorkspaceId != "ws-1" || events[0].UpdatedBy != OwnerAuto {
		t.Fatalf("events: %+v", events)
	}
	view, err := s.View("ws-1", "")
	if err != nil || !view.Exists || view.Redactions != 1 || view.Path != path || !strings.Contains(view.Markdown, "## Goal") {
		t.Fatalf("view: %+v %v", view, err)
	}
	one, err := s.View("ws-1", "goal")
	if err != nil || len(one.Sections) != 1 || one.Sections[0].Name != SectionGoal {
		t.Fatalf("section view: %+v %v", one, err)
	}
	if _, err := s.View("ws-1", "bogus"); err == nil || !strings.Contains(err.Error(), "Next steps") {
		t.Fatalf("an unknown section lists the valid ones: %v", err)
	}
	entries, _ := os.ReadDir(filepath.Dir(path))
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".tmp-") {
			t.Fatalf("temporary file left: %s", e.Name())
		}
	}
}

func TestStoreHandEditIsRedactedOnRead(t *testing.T) {
	s, _ := makeTestStore(t)
	s.Update("ws-1", OwnerAuto, setGoal("goal", OwnerAuto))
	path, _ := s.Path("ws-1")
	data, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(data), "## Next steps\n", "## Next steps\n\npassword=hunter22\n", 1)), 0o600)
	view, err := s.View("ws-1", "")
	if err != nil || strings.Contains(view.Markdown, "hunter22") || view.Redactions != 1 {
		t.Fatalf("view: %+v %v", view, err)
	}
}

func TestStoreWorkspacesAreSeparate(t *testing.T) {
	s, _ := makeTestStore(t)
	s.Update("ws-a", OwnerAuto, setGoal("goal A", OwnerAuto))
	s.Update("ws-b", OwnerAuto, setGoal("goal B", OwnerAuto))
	a, _, _ := s.Read("ws-a")
	b, _, _ := s.Read("ws-b")
	if a.Section(SectionGoal).Body != "goal A" || b.Section(SectionGoal).Body != "goal B" {
		t.Fatal("two workspaces share a checkpoint")
	}
	for _, bad := range []string{"", "../x", "a/b", ".hidden", strings.Repeat("x", 65)} {
		if _, err := s.Update(bad, OwnerAuto, setGoal("x", OwnerAuto)); err == nil {
			t.Errorf("workspace id %q accepted", bad)
		}
	}
}

func TestStoreHistoryRestoreClear(t *testing.T) {
	s, clock := makeTestStore(t)
	s.Update("ws-1", OwnerUser, setGoal("first", OwnerUser))
	clock.add(time.Second)
	s.Update("ws-1", OwnerUser, setGoal("second", OwnerUser))
	clock.add(time.Second)
	s.Update("ws-1", OwnerUser, setGoal("third", OwnerUser))
	hist, err := s.History("ws-1")
	if err != nil || len(hist) != 2 || hist[0].N != 1 || hist[0].Goal != "second" || hist[1].Goal != "first" {
		t.Fatalf("history: %+v %v", hist, err)
	}
	clock.add(time.Second)
	if err := s.Restore("ws-1", 2); err != nil {
		t.Fatal(err)
	}
	c, _, _ := s.Read("ws-1")
	if c.Section(SectionGoal).Body != "first" || c.UpdatedBy != OwnerUser {
		t.Fatalf("restored: %+v", c.Section(SectionGoal))
	}
	hist, _ = s.History("ws-1")
	if len(hist) != 3 || hist[0].Goal != "third" {
		t.Fatalf("the replaced version goes to the history: %+v", hist)
	}
	if err := s.Restore("ws-1", 9); err == nil {
		t.Fatal("restoring a missing version must fail")
	}
	clock.add(time.Second)
	if err := s.Clear("ws-1"); err != nil {
		t.Fatal(err)
	}
	c, exists, _ := s.Read("ws-1")
	if !exists || !c.Empty() || c.Started != clock.now().UnixMilli() {
		t.Fatalf("cleared: %+v", c)
	}
	hist, _ = s.History("ws-1")
	if len(hist) != 4 || hist[0].Goal != "first" {
		t.Fatalf("clear keeps the previous checkpoint: %+v", hist)
	}
}

func TestStoreHistoryLimits(t *testing.T) {
	s, clock := makeTestStore(t)
	for i := 0; i < MaxVersions+5; i++ {
		s.Update("ws-1", OwnerUser, setGoal(fmt.Sprintf("goal %d", i), OwnerUser))
		clock.add(time.Minute)
	}
	hist, _ := s.History("ws-1")
	if len(hist) != MaxVersions {
		t.Fatalf("history holds %d versions, want %d", len(hist), MaxVersions)
	}
	clock.add(MaxVersionAge + time.Hour)
	s.Update("ws-1", OwnerUser, setGoal("late", OwnerUser))
	hist, _ = s.History("ws-1")
	if len(hist) != 1 {
		t.Fatalf("versions older than 30 days are dropped: %d left", len(hist))
	}
}

func TestStoreAutoVersionsCoalesce(t *testing.T) {
	s, clock := makeTestStore(t)
	for i := 0; i < 10; i++ {
		s.Update("ws-1", OwnerAuto, setGoal(fmt.Sprintf("auto %d", i), OwnerAuto))
		clock.add(10 * time.Second)
	}
	hist, _ := s.History("ws-1")
	if len(hist) != 1 {
		t.Fatalf("auto over auto within %v makes one version, got %d", AutoVersionEvery, len(hist))
	}
	clock.add(AutoVersionEvery)
	s.Update("ws-1", OwnerAuto, setGoal("auto later", OwnerAuto))
	if hist, _ = s.History("ws-1"); len(hist) != 2 {
		t.Fatalf("a new auto version after %v: %d", AutoVersionEvery, len(hist))
	}
	// A hand edit between two auto writes is kept in the history.
	path, _ := s.Path("ws-1")
	data, _ := os.ReadFile(path)
	os.WriteFile(path, []byte(strings.Replace(string(data), "auto later", "edited by hand", 1)), 0o600)
	clock.add(time.Second)
	s.Update("ws-1", OwnerAuto, func(c *Checkpoint) bool {
		return setAuto(c.Section(SectionTicket), "#1", clock.now().UnixMilli())
	})
	hist, _ = s.History("ws-1")
	if len(hist) != 3 || hist[0].Goal != "edited by hand" {
		t.Fatalf("hand edit not archived: %+v", hist)
	}
	c, _, _ := s.Read("ws-1")
	if c.Section(SectionGoal).Body != "edited by hand" || c.Section(SectionGoal).Owner != OwnerUser {
		t.Fatalf("hand edit lost: %+v", c.Section(SectionGoal))
	}
}

func TestStoreSizeCap(t *testing.T) {
	s, _ := makeTestStore(t)
	big := strings.Repeat("word ", MaxCheckpointBytes/4)
	if _, err := s.Update("ws-1", OwnerUser, setGoal(big, OwnerUser)); err != ErrTooLarge {
		t.Fatalf("a user write over the cap: %v", err)
	}
	var lines []string
	for i := 0; i < 5000; i++ {
		lines = append(lines, fmt.Sprintf("- [ ] step %d with some words to make it longer", i))
	}
	if _, err := s.Update("ws-1", OwnerAuto, func(c *Checkpoint) bool {
		return setAuto(c.Section(SectionPlan), strings.Join(lines, "\n"), testAt)
	}); err != nil {
		t.Fatal(err)
	}
	path, _ := s.Path("ws-1")
	info, _ := os.Stat(path)
	if info.Size() > MaxCheckpointBytes {
		t.Fatalf("auto sections are cut to the cap: %d bytes", info.Size())
	}
}

func TestStoreFailedWriteKeepsPrevious(t *testing.T) {
	if runtime.GOOS == "windows" || os.Getuid() == 0 {
		t.Skip("permissions")
	}
	dir := t.TempDir()
	path := filepath.Join(dir, CheckpointFile)
	if err := writeAtomic(path, []byte("kept")); err != nil {
		t.Fatal(err)
	}
	os.Chmod(dir, 0o500)
	defer os.Chmod(dir, dirMode)
	if err := writeAtomic(path, []byte("lost")); err == nil {
		t.Fatal("a write into a read-only folder must fail")
	}
	if data, _ := os.ReadFile(path); string(data) != "kept" {
		t.Fatalf("the previous file must stay: %q", data)
	}
}

func TestStoreConcurrentWriters(t *testing.T) {
	s, _ := makeTestStore(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			for j := 0; j < 20; j++ {
				name := SectionNames[(i+j)%len(SectionNames)]
				s.Update("ws-1", OwnerAuto, func(c *Checkpoint) bool {
					return setAuto(c.Section(name), fmt.Sprintf("writer %d turn %d", i, j), testAt)
				})
				s.View("ws-1", "")
				s.History("ws-1")
			}
		}(i)
	}
	wg.Wait()
	c, exists, err := s.Read("ws-1")
	if err != nil || !exists || c.HandEdited {
		t.Fatalf("after concurrent writes: %+v %v", c, err)
	}
}

func TestStoreSweep(t *testing.T) {
	s, clock := makeTestStore(t)
	s.Update("ws-live", OwnerAuto, setGoal("a", OwnerAuto))
	s.Update("ws-gone", OwnerAuto, setGoal("b", OwnerAuto))
	s.Update("ws-unknown", OwnerAuto, setGoal("c", OwnerAuto))
	exists := func(id string) (bool, error) {
		switch id {
		case "ws-live":
			return true, nil
		case "ws-unknown":
			return false, fmt.Errorf("db busy")
		}
		return false, nil
	}
	s.Sweep(exists)
	if _, err := os.Stat(filepath.Join(s.Root(), "ws-gone")); !os.IsNotExist(err) {
		t.Fatal("a deleted workspace's folder moves away")
	}
	for _, keep := range []string{"ws-live", "ws-unknown"} {
		if _, err := os.Stat(filepath.Join(s.Root(), keep)); err != nil {
			t.Fatalf("%s must stay: %v", keep, err)
		}
	}
	moved, _ := os.ReadDir(filepath.Join(s.Root(), DeletedDir))
	if len(moved) != 1 || !strings.HasPrefix(moved[0].Name(), "ws-gone-") {
		t.Fatalf("deleted: %v", moved)
	}
	clock.add(DeletedKeep + time.Hour)
	s.Sweep(exists)
	if moved, _ = os.ReadDir(filepath.Join(s.Root(), DeletedDir)); len(moved) != 0 {
		t.Fatalf("kept 30 days only: %v", moved)
	}
}

func TestStoreEnsure(t *testing.T) {
	s, _ := makeTestStore(t)
	if err := s.Ensure("ws-1"); err != nil {
		t.Fatal(err)
	}
	view, _ := s.View("ws-1", "")
	if !view.Exists {
		t.Fatal("ensure writes an empty checkpoint")
	}
	s.Update("ws-1", OwnerUser, setGoal("mine", OwnerUser))
	s.Ensure("ws-1")
	c, _, _ := s.Read("ws-1")
	if c.Section(SectionGoal).Body != "mine" {
		t.Fatal("ensure never replaces a checkpoint")
	}
}
