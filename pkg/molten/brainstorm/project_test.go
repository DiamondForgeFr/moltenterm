// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package brainstorm

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/buildchannel"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
)

// testGit runs the real git, with no prompt and no system configuration.
func testGit(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.Dir = dir
	cmd.Env = append(os.Environ(), "GIT_TERMINAL_PROMPT=0", "GIT_CONFIG_NOSYSTEM=1")
	return cmd.Output()
}

// gitCalls records what a create asks git: the folders and the arguments, never a model's text.
type gitCalls struct {
	lock  sync.Mutex
	calls [][]string
}

func (g *gitCalls) run(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
	g.lock.Lock()
	g.calls = append(g.calls, append([]string{dir, name}, args...))
	g.lock.Unlock()
	return testGit(ctx, dir, name, args...)
}

func (g *gitCalls) all() [][]string {
	g.lock.Lock()
	defer g.lock.Unlock()
	return append([][]string{}, g.calls...)
}

// projectFixture is an open brainstorm that concluded (synthetic data) and a parent folder for its project.
type projectFixture struct {
	*fixture
	s      *Service
	parent string
	git    *gitCalls
}

func concludedTurn(key string, brief BriefDraft) TurnRequest {
	b := block(concludeOp("first-pass", brief), proposeOp("make-it", ActionProject))
	return TurnRequest{Key: key, You: "That's it, I think: the idea is clear for me.", Brokk: "The idea is clear: a first pass is ready.", Block: &b, At: 2000}
}

func makeProjectFixture(t *testing.T) *projectFixture {
	t.Helper()
	f := makeFixture(t)
	parent := filepath.Join(t.TempDir(), "Projects")
	if err := os.Mkdir(parent, 0o755); err != nil {
		t.Fatal(err)
	}
	s := f.service()
	git := &gitCalls{}
	s.UseProjects(func() string { return parent }, git.run)
	s.Turn(openingTurn())
	return &projectFixture{fixture: f, s: s, parent: parent, git: git}
}

func (p *projectFixture) conclude(t *testing.T) State {
	t.Helper()
	got := p.s.Turn(concludedTurn("t2", sampleBrief()))
	if !got.Applied {
		t.Fatalf("the conclusion was not applied: %+v", got)
	}
	return got.State
}

func (p *projectFixture) request(name string) ProjectRequest {
	state := p.s.State()
	swap := state.Swap
	return ProjectRequest{Name: name, Swap: &swap, Id: state.Brainstorm.Id}
}

// AC14, AC-1 (#2250): his conclusion writes brief.json and brief.md in the folder, and the brainstorm becomes clear.
func TestConcludeWritesTheBriefAndMakesItClear(t *testing.T) {
	t.Parallel()
	p := makeProjectFixture(t)
	state := p.conclude(t)
	if state.Brainstorm.State != StateClear || state.Brief == nil || state.Brief.Slug != "forge-notes" || state.Geargrim {
		t.Fatalf("state %+v, brief %+v", state.Brainstorm, state.Brief)
	}
	dir := state.Brainstorm.Dir
	for _, name := range []string{BriefFile, BriefMarkdownFile} {
		if _, err := os.Stat(filepath.Join(dir, name)); err != nil {
			t.Errorf("%s: %v", name, err)
		}
	}
	saved, err := p.store.Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	if saved.Info.State != StateClear || saved.Brief == nil || saved.Brief.Brainstorm != saved.Info.Id || saved.Info.Language != "en" {
		t.Errorf("the folder reads back %q, brief %+v, language %q", saved.Info.State, saved.Brief, saved.Info.Language)
	}
	// A finish after it marks it finished; a promoted one stays promoted whatever comes.
	if got := stateAfter(StateClear, block(Op{Op: OpFinish}), 0, false, true); got != StateDone {
		t.Errorf("finish on a clear brainstorm: %q", got)
	}
	if got := stateAfter(StateDone, block(), 1, false, true); got != StateClear {
		t.Errorf("growth of a finished one with a brief: %q", got)
	}
	if got := stateAfter(StatePromoted, block(Op{Op: OpFinish}), 1, true, true); got != StatePromoted {
		t.Errorf("a promoted one: %q", got)
	}
}

// AC-1: a bad brief drops his block whole, with a log line that holds none of it; nothing is written.
func TestABadBriefIsDroppedWithAContentFreeLog(t *testing.T) {
	t.Parallel()
	p := makeProjectFixture(t)
	bad := sampleBrief()
	bad.Problem = strings.Repeat("secret plan ", 60)
	got := p.s.Turn(concludedTurn("t2", bad))
	if got.Applied || !got.Dropped || got.State.Brief != nil || got.State.Brainstorm.State != StateOpen {
		t.Fatalf("a bad brief: %+v", got)
	}
	if _, err := os.Stat(filepath.Join(got.State.Brainstorm.Dir, BriefFile)); !os.IsNotExist(err) {
		t.Errorf("brief.json: %v", err)
	}
	p.lock.Lock()
	defer p.lock.Unlock()
	if len(p.logs) == 0 {
		t.Fatal("nothing was logged")
	}
	for _, line := range p.logs {
		if strings.Contains(line, "secret") {
			t.Errorf("the log quotes the brief: %q", line)
		}
	}
}

// DS-BOSS-010 (#2250): the brainstorm's language comes from what the developer wrote, else the interface's.
func TestTheBrainstormTakesTheDevelopersLanguage(t *testing.T) {
	t.Parallel()
	if got := DetectLanguage([]string{"J'ai une idée d'app vidéo pour les enfants : celles d'aujourd'hui ne me conviennent pas."}); got != "fr" {
		t.Errorf("French: %q", got)
	}
	if got := DetectLanguage([]string{"I have an idea for a video app for kids: the ones out there don't suit me."}); got != "en" {
		t.Errorf("English: %q", got)
	}
	if got := DetectLanguage([]string{"OK", "Go"}); got != "" {
		t.Errorf("a few words say %q", got)
	}
	f := makeFixture(t)
	s := f.service()
	s.UseLanguage(func() string { return "fr" })
	b := block(centre("forge", "Forge"))
	got := s.Turn(TurnRequest{Key: "t1", You: "Forge?", Brokk: "Forge.", Block: &b, At: 1000})
	saved, err := f.store.Load(got.State.Brainstorm.Dir)
	if err != nil || saved.Info.Language != "fr" {
		t.Errorf("a short message takes the interface's language: %q, %v", saved.Info.Language, err)
	}
	if got := languageOf(nil, "Not A Tag"); got != FallbackLanguage {
		t.Errorf("no language at all: %q", got)
	}
}

// AC-3, AC15: one create makes the folder, starts git in it, writes docs/brainstorm.md untracked, and the brainstorm
// is promoted; linked keeps the workspace.
func TestCreateMakesAGitProjectWithTheCopy(t *testing.T) {
	t.Parallel()
	p := makeProjectFixture(t)
	p.conclude(t)
	preview := p.s.ProjectPreview(p.request(""))
	want := filepath.Join(p.parent, "forge-notes")
	if preview.Error != "" || preview.Preview.Refusal != "" || preview.Preview.Path != want || preview.Preview.Docs != "docs/brainstorm.md" {
		t.Fatalf("preview %+v", preview)
	}
	if _, err := os.Stat(want); !os.IsNotExist(err) {
		t.Fatalf("the preview made something: %v", err)
	}
	got := p.s.ProjectCreate(p.request(""))
	if got.Error != "" || got.Dir != want {
		t.Fatalf("create %+v", got)
	}
	if info, err := os.Stat(filepath.Join(want, ".git")); err != nil || !info.IsDir() {
		t.Fatalf("no repository: %v", err)
	}
	copyText, err := os.ReadFile(filepath.Join(want, "docs", "brainstorm.md"))
	if err != nil {
		t.Fatal(err)
	}
	for _, line := range []string{"# A safe video app for children", "## Forge Notes", "### Problem", "## The thought", "_Question_ · For which ages?", "## The conversation", "> I have an app idea: videos for kids."} {
		if !strings.Contains(string(copyText), line) {
			t.Errorf("docs/brainstorm.md lacks %q:\n%s", line, copyText)
		}
	}
	status, err := testGit(context.Background(), want, "git", "status", "--porcelain", "--untracked-files=all")
	if err != nil || strings.TrimSpace(string(status)) != "?? docs/brainstorm.md" {
		t.Errorf("git status %q, %v: the copy must be there and not committed", status, err)
	}
	if log, err := testGit(context.Background(), want, "git", "rev-list", "--all"); err != nil || strings.TrimSpace(string(log)) != "" {
		t.Errorf("a commit was made: %q", log)
	}
	state := got.State
	if state.Brainstorm.State != StatePromoted || state.Brainstorm.PromotedTo == nil || state.Brainstorm.PromotedTo.Dir != want || state.Brainstorm.PromotedTo.Workspace != "" {
		t.Fatalf("promoted %+v", state.Brainstorm)
	}
	linked := p.s.ProjectLinked(LinkedRequest{Id: state.Brainstorm.Id, Dir: want, Workspace: "8f6c2a1e-0d4b-4e2a-9b1c-3f5d7e9a1b2c"})
	if linked.Error != "" || linked.State.Brainstorm.PromotedTo.Workspace != "8f6c2a1e-0d4b-4e2a-9b1c-3f5d7e9a1b2c" {
		t.Fatalf("linked %+v", linked)
	}
	saved, err := p.store.Load(state.Brainstorm.Dir)
	if err != nil || saved.Info.State != StatePromoted || saved.Info.PromotedTo == nil || saved.Info.PromotedTo.Workspace == "" {
		t.Errorf("brainstorm.json reads back %+v, %v", saved.Info, err)
	}
	if bad := p.s.ProjectLinked(LinkedRequest{Id: state.Brainstorm.Id, Dir: p.parent, Workspace: "x"}); bad.Error == "" {
		t.Error("a link to another folder was kept")
	}
	// No model text reached git: the folders MoltenTerm built and fixed arguments only.
	for _, call := range p.git.all() {
		if (call[0] != p.parent && call[0] != want) || call[1] != "git" {
			t.Errorf("git ran in %q", call[0])
		}
		args := strings.Join(call[2:], " ")
		if args != "rev-parse --git-dir" && args != "init --quiet" {
			t.Errorf("git was asked %q", args)
		}
	}
}

// AC-2: an empty folder already there is used as it is; the developer's own name replaces the slug.
func TestCreateUsesAnEmptyFolderAndTheDevelopersName(t *testing.T) {
	t.Parallel()
	p := makeProjectFixture(t)
	p.conclude(t)
	want := filepath.Join(p.parent, "Forge.Notes_2")
	if err := os.Mkdir(want, 0o755); err != nil {
		t.Fatal(err)
	}
	preview := p.s.ProjectPreview(p.request("Forge.Notes_2"))
	if preview.Preview.Refusal != "" || !preview.Preview.Exists || preview.Preview.Path != want {
		t.Fatalf("preview %+v", preview.Preview)
	}
	if got := p.s.ProjectCreate(p.request("Forge.Notes_2")); got.Error != "" || got.Dir != want {
		t.Fatalf("create %+v", got)
	}
}

// AC-4 (#2250): the refusals, each before anything is made: a path that exists and is not empty, a path inside
// another repository, a bad name, no parent folder. A model's text never makes a path.
func TestCreateRefusals(t *testing.T) {
	t.Parallel()
	cases := []struct {
		name    string
		prepare func(t *testing.T, p *projectFixture) ProjectRequest
		refusal string
	}{
		{"not empty", func(t *testing.T, p *projectFixture) ProjectRequest {
			if err := os.MkdirAll(filepath.Join(p.parent, "forge-notes"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(p.parent, "forge-notes", "README.md"), []byte("mine"), 0o644); err != nil {
				t.Fatal(err)
			}
			return p.request("")
		}, RefusalNotEmpty},
		{"a file of that name", func(t *testing.T, p *projectFixture) ProjectRequest {
			if err := os.WriteFile(filepath.Join(p.parent, "forge-notes"), []byte("mine"), 0o644); err != nil {
				t.Fatal(err)
			}
			return p.request("")
		}, RefusalNotEmpty},
		{"inside another repository", func(t *testing.T, p *projectFixture) ProjectRequest {
			if _, err := testGit(context.Background(), p.parent, "git", "init", "--quiet"); err != nil {
				t.Fatal(err)
			}
			return p.request("")
		}, RefusalInRepo},
		{"a path in the name", func(t *testing.T, p *projectFixture) ProjectRequest {
			return p.request("../outside")
		}, RefusalBadName},
		{"a dot name", func(t *testing.T, p *projectFixture) ProjectRequest {
			return p.request("..")
		}, RefusalBadName},
		{"a name ending with a dot", func(t *testing.T, p *projectFixture) ProjectRequest {
			return p.request("forge.")
		}, RefusalBadName},
		{"no parent chosen", func(t *testing.T, p *projectFixture) ProjectRequest {
			p.s.UseProjects(func() string { return "" }, nil)
			return p.request("")
		}, RefusalNoParent},
		{"a parent that is gone", func(t *testing.T, p *projectFixture) ProjectRequest {
			req := p.request("")
			req.Parent = filepath.Join(p.parent, "gone")
			return req
		}, RefusalNoParent},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			t.Parallel()
			p := makeProjectFixture(t)
			p.conclude(t)
			req := c.prepare(t, p)
			before := listTree(t, p.parent)
			preview := p.s.ProjectPreview(req)
			got := p.s.ProjectCreate(req)
			if preview.Preview.Refusal != c.refusal || got.Error != c.refusal || got.Dir != "" {
				t.Fatalf("preview %q, create %q, want %q", preview.Preview.Refusal, got.Error, c.refusal)
			}
			if after := listTree(t, p.parent); !slices.Equal(before, after) {
				t.Errorf("a refused create changed the parent folder: %v, then %v", before, after)
			}
			if state := p.s.State(); state.Brainstorm.State != StateClear || state.Brainstorm.PromotedTo != nil {
				t.Errorf("a refused create promoted it: %+v", state.Brainstorm)
			}
			if _, err := os.Stat(filepath.Join(filepath.Dir(p.parent), "outside")); !os.IsNotExist(err) {
				t.Errorf("a folder was made outside the parent: %v", err)
			}
		})
	}
}

func listTree(t *testing.T, root string) []string {
	t.Helper()
	var out []string
	_ = filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err == nil {
			out = append(out, path)
		}
		return nil
	})
	return out
}

// A create never writes over a file, and never runs before a conclusion or for another brainstorm.
func TestCreateNeedsTheBriefAndTheSameBrainstorm(t *testing.T) {
	t.Parallel()
	p := makeProjectFixture(t)
	if got := p.s.ProjectCreate(p.request("")); got.Error != RefusalNoBrief {
		t.Errorf("before the conclusion: %+v", got)
	}
	p.conclude(t)
	other := p.request("")
	swap := *other.Swap + 1
	other.Swap = &swap
	if got := p.s.ProjectCreate(other); !got.Stale {
		t.Errorf("another brainstorm's create: %+v", got)
	}
	stranger := p.request("")
	stranger.Id = "0123456789abcdef"
	if got := p.s.ProjectCreate(stranger); !got.Stale {
		t.Errorf("another folder's create: %+v", got)
	}
	if entries, _ := os.ReadDir(p.parent); len(entries) != 0 {
		t.Errorf("refused creates made %v", entries)
	}
	if err := writeExclusive(filepath.Join(p.parent, "kept.md"), []byte("first")); err != nil {
		t.Fatal(err)
	}
	if err := writeExclusive(filepath.Join(p.parent, "kept.md"), []byte("second")); err == nil {
		t.Error("an existing file was written over")
	}
	if data, _ := os.ReadFile(filepath.Join(p.parent, "kept.md")); string(data) != "first" {
		t.Errorf("the file holds %q", data)
	}
}

// AC-6 and the security rationale: the project's commands answer MoltenTerm's windows alone, and never on a release.
func TestProjectCommandsAreForWindowsOnly(t *testing.T) {
	t.Parallel()
	e := routetest.Make(t)
	p := makeProjectFixture(t)
	p.conclude(t)
	link, err := localroute.MakeLink(e.Router, p.s.route(func() bool { return buildchannel.BrainstormAllowed(buildchannel.Gold) }))
	if err != nil {
		t.Fatal(err)
	}
	notUi := append([]routetest.From{e.Terminal()}, e.Forged()...)
	for _, command := range []string{ProjectPreviewCommand, ProjectCreateCommand, ProjectLinkedCommand} {
		routetest.MustRefuseWith(t, link, notUi, command, map[string]any{"name": "forge-notes"}, "MoltenTerm windows only")
	}
	for _, channel := range []string{buildchannel.RC, buildchannel.Public} {
		e := routetest.Make(t)
		refused, err := localroute.MakeLink(e.Router, p.s.route(func() bool { return buildchannel.BrainstormAllowed(channel) }))
		if err != nil {
			t.Fatal(err)
		}
		for _, command := range []string{ProjectPreviewCommand, ProjectCreateCommand, ProjectLinkedCommand} {
			if _, errStr := routetest.Ask(t, refused, e.Window(), command, map[string]any{}); !strings.Contains(errStr, buildchannel.BrainstormRefusal) {
				t.Errorf("%q on channel %q: %q, want the plain refusal", command, channel, errStr)
			}
		}
	}
	if entries, _ := os.ReadDir(p.parent); len(entries) != 0 {
		t.Errorf("a refused route made %v", entries)
	}
	if _, errStr := routetest.Ask(t, link, e.Window(), ProjectPreviewCommand, map[string]any{}); errStr != "" {
		t.Errorf("a window's preview: %s", errStr)
	}
}

func TestProjectsDirExpandsTheHomeFolder(t *testing.T) {
	t.Parallel()
	home := filepath.Join(string(filepath.Separator), "home", "dev")
	cases := map[string]string{
		"":            "",
		"~":           home,
		"~/Projects":  filepath.Join(home, "Projects"),
		"relative":    "",
		home + "/x/.": filepath.Join(home, "x"),
	}
	for setting, want := range cases {
		if got := ProjectsDir(setting, home); got != want {
			t.Errorf("ProjectsDir(%q) = %q, want %q", setting, got, want)
		}
	}
}

// DS-BOSS-010 (#2250): the four states; any other one read from a folder is in progress, and a promotedto changed by
// hand into anything else is none.
func TestStatesAndPromotionReadBack(t *testing.T) {
	t.Parallel()
	for _, state := range []string{StateOpen, StateDone, StateClear, StatePromoted} {
		if checkedState(state) != state {
			t.Errorf("%q read back as %q", state, checkedState(state))
		}
	}
	if checkedState("archived") != StateOpen || checkedState("") != StateOpen {
		t.Error("an unknown state is not in progress")
	}
	if checkedPromotion(&Promotion{Dir: "relative/x"}) != nil {
		t.Error("a relative project folder was kept")
	}
	if got := checkedPromotion(&Promotion{Dir: "/p/x/", Workspace: "<b>", At: 5}); got == nil || got.Dir != "/p/x" || got.Workspace != "" {
		t.Errorf("promotion %+v", got)
	}
}
