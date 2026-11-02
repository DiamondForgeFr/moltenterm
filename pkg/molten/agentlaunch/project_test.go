// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package agentlaunch

import (
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/BurntSushi/toml"
	"github.com/wavetermdev/waveterm/pkg/molten"
)

// A client folder holding the documents and, inside it, the app's repository (FR-SHELL-105).
type clientTree struct {
	fakeTree
	folder string
	repo   string
}

func makeClientTree(t *testing.T) clientTree {
	t.Helper()
	tree := makeFakeTree(t)
	folder := filepath.Join(tree.home, "clients", "ofpis")
	repo := filepath.Join(folder, "app")
	mkdirAll(t, filepath.Join(folder, "docs"))
	mkdirAll(t, filepath.Join(repo, ".git"))
	return clientTree{fakeTree: tree, folder: folder, repo: repo}
}

func mkdirAll(t *testing.T, dir string) {
	t.Helper()
	if err := os.MkdirAll(dir, 0755); err != nil {
		t.Fatal(err)
	}
}

func (c clientTree) places() ProjectPlaces { return ProjectPlaces{Folder: c.folder, Repo: c.repo} }

func (c clientTree) ctxAt(cwd string, args ...string) LaunchContext {
	ctx := c.ctx(args...)
	ctx.Cwd = cwd
	ctx.Project = c.places()
	ctx.MoltenPath = "/data/bin/molten"
	ctx.CodexSystemConfig = filepath.Join(filepath.Dir(c.home), "etc-codex", "config.toml")
	return ctx
}

// FR-SHELL-036 (#1777): started from the client folder, Claude Code starts in the repository with the folder as an
// extra directory and the start note, before the user's own arguments.
func TestClaudeProjectFromTheFolder(t *testing.T) {
	c := makeClientTree(t)
	plan := claudeAdapter{}.PlanProject(c.ctxAt(c.folder, "fix the tests"))
	if plan.StartDir != c.repo {
		t.Errorf("starts in %q, want the repository %q", plan.StartDir, c.repo)
	}
	note := ProjectNote(c.places())
	want := []string{"--add-dir=" + c.folder, "--append-system-prompt=" + note}
	if !slices.Equal(plan.Args, want) {
		t.Errorf("args %q, want %q", plan.Args, want)
	}
	if kinds := itemKinds(plan.Added); !slices.Equal(kinds, []string{molten.IntegrationProjectStart, molten.IntegrationProjectFolder, molten.IntegrationProjectNote}) {
		t.Errorf("added %v", kinds)
	}
	if len(plan.Skipped) != 0 {
		t.Errorf("skipped %v", plan.Skipped)
	}
	if !strings.Contains(note, c.folder) || !strings.Contains(note, c.repo) {
		t.Errorf("the note names both places: %q", note)
	}
}

// From the repository the run stays where it is and gets the same two arguments: the client's context is one --add-dir
// away; from a folder of the client that is neither, the terminal's folder is kept.
func TestClaudeProjectFromInsideTheProject(t *testing.T) {
	c := makeClientTree(t)
	for _, cwd := range []string{c.repo, filepath.Join(c.repo, "src"), filepath.Join(c.folder, "docs")} {
		mkdirAll(t, cwd)
		plan := claudeAdapter{}.PlanProject(c.ctxAt(cwd))
		if plan.StartDir != "" {
			t.Errorf("%s: the terminal's folder is kept, got %q", cwd, plan.StartDir)
		}
		if len(plan.Args) != 2 || plan.Args[0] != "--add-dir="+c.folder {
			t.Errorf("%s: args %q", cwd, plan.Args)
		}
		if slices.Contains(itemKinds(plan.Added), molten.IntegrationProjectStart) {
			t.Errorf("%s: nothing was started elsewhere", cwd)
		}
	}
}

// Nothing is added for a terminal outside the project, for a folder that is its own repository, for a repository
// outside the folder, and when the repository is gone (which the report says).
func TestProjectAddsNothingWhenItDoesNotApply(t *testing.T) {
	c := makeClientTree(t)
	other := filepath.Join(filepath.Dir(c.home), "elsewhere")
	mkdirAll(t, other)
	own := c.ctxAt(c.folder)
	own.Project = ProjectPlaces{Folder: c.folder, Repo: c.folder}
	outsideRepo := c.ctxAt(c.folder)
	outsideRepo.Project = ProjectPlaces{Folder: c.folder, Repo: other}
	unlinked := c.ctxAt(c.folder)
	unlinked.Project = ProjectPlaces{}
	cases := map[string]LaunchContext{
		"another folder": c.ctxAt(other),
		"folder is repo": own,
		"repo outside":   outsideRepo,
		"no project":     unlinked,
	}
	for name, ctx := range cases {
		for _, a := range []ProjectAdapter{claudeAdapter{}, codexAdapter{}} {
			plan := a.PlanProject(ctx)
			if len(plan.Args) != 0 || plan.StartDir != "" || len(plan.Added) != 0 || len(plan.Skipped) != 0 {
				t.Errorf("%s: %T added %+v", name, a, plan)
			}
		}
	}

	gone := c.ctxAt(c.folder)
	gone.Project = ProjectPlaces{Folder: c.folder, Repo: filepath.Join(c.folder, "deleted")}
	for _, a := range []ProjectAdapter{claudeAdapter{}, codexAdapter{}} {
		plan := a.PlanProject(gone)
		if len(plan.Args) != 0 || plan.StartDir != "" || len(plan.Added) != 0 {
			t.Errorf("%T: a repository that is gone adds nothing: %+v", a, plan)
		}
		if len(plan.Skipped) != 1 || plan.Skipped[0].Kind != molten.IntegrationProjectFolder || !strings.Contains(plan.Skipped[0].Reason, "was not found") {
			t.Errorf("%T: the report says why: %+v", a, plan.Skipped)
		}
	}
}

// What the user passed is theirs: the same directory, or their own start prompt, leaves the matching item out.
func TestClaudeProjectLeavesTheUsersOwnAlone(t *testing.T) {
	c := makeClientTree(t)
	cases := []struct {
		name        string
		args        []string
		wantArgs    int
		skippedKind string
	}{
		{"same directory", []string{"--add-dir", c.folder, "go"}, 1, molten.IntegrationProjectFolder},
		{"same directory with =", []string{"--add-dir=" + c.folder}, 1, molten.IntegrationProjectFolder},
		{"an ancestor", []string{"--add-dir", filepath.Dir(c.folder)}, 1, molten.IntegrationProjectFolder},
		{"one of several", []string{"--add-dir", "/nowhere", c.folder, "--model", "x"}, 1, molten.IntegrationProjectFolder},
		{"another directory", []string{"--add-dir", "/nowhere"}, 2, ""},
		{"own start prompt", []string{"--append-system-prompt", "be brief"}, 1, molten.IntegrationProjectNote},
		{"own start prompt file", []string{"--append-system-prompt-file=/x"}, 1, molten.IntegrationProjectNote},
	}
	for _, tc := range cases {
		plan := claudeAdapter{}.PlanProject(c.ctxAt(c.folder, tc.args...))
		if len(plan.Args) != tc.wantArgs {
			t.Errorf("%s: args %q", tc.name, plan.Args)
		}
		got := ""
		if len(plan.Skipped) > 0 {
			got = plan.Skipped[0].Kind
		}
		if got != tc.skippedKind {
			t.Errorf("%s: skipped %q, want %q", tc.name, got, tc.skippedKind)
		}
		if tc.skippedKind != "" && !strings.Contains(plan.Skipped[0].Reason, "already yours") {
			t.Errorf("%s: reason %q", tc.name, plan.Skipped[0].Reason)
		}
	}
}

// The project's arguments go first, in their = form, so a prompt after them is not read as one more directory.
func TestClaudeProjectArgumentsPrecedeTheGeneratedOnes(t *testing.T) {
	c := makeClientTree(t)
	ctx := c.ctxAt(c.folder, "fix the tests")
	plan, err := claudeAdapter{}.Plan(ctx)
	if err != nil {
		t.Fatal(err)
	}
	merged := plan.WithProject(claudeAdapter{}.PlanProject(ctx), ctx.Args)
	paths := make([]string, len(merged.Files))
	for i := range paths {
		paths[i] = "/launch/file" + string(rune('0'+i))
	}
	args := merged.MakeArgs(paths)
	if len(args) < 4 || args[0] != "--add-dir="+c.folder || !strings.HasPrefix(args[1], "--append-system-prompt=") {
		t.Fatalf("args %q", args)
	}
	if args[len(args)-1] != "fix the tests" || !slices.Contains(args, "--settings") {
		t.Errorf("the user's prompt stays last and the integration stays: %q", args)
	}
	if merged.StartDir != c.repo {
		t.Errorf("start dir %q", merged.StartDir)
	}
	if !slices.Contains(itemKinds(merged.Added), molten.IntegrationStateHooks) || !slices.Contains(itemKinds(merged.Added), molten.IntegrationProjectFolder) {
		t.Errorf("both the integration and the project are reported: %v", itemKinds(merged.Added))
	}
}

// A plan that stepped aside takes nothing of the project; one that makes no arguments of its own still gets them.
func TestWithProject(t *testing.T) {
	pp := ProjectPlan{Args: []string{"--add-dir=/x"}, ShownArgs: []string{"--add-dir=/x"}, StartDir: "/x/app"}
	aside := LaunchPlan{StepAside: "off"}.WithProject(pp, []string{"hi"})
	if aside.MakeArgs != nil || aside.StartDir != "" {
		t.Errorf("stepped aside: %+v", aside)
	}
	bare := LaunchPlan{}.WithProject(pp, []string{"hi"})
	if got := bare.MakeArgs(nil); !slices.Equal(got, []string{"--add-dir=/x", "hi"}) {
		t.Errorf("args %q", got)
	}
	if bare.StartDir != "/x/app" || !slices.Equal(bare.ShownArgs, pp.ShownArgs) {
		t.Errorf("plan %+v", bare)
	}
	if untouched := (LaunchPlan{}).WithProject(ProjectPlan{}, []string{"hi"}); untouched.MakeArgs != nil {
		t.Errorf("nothing to add leaves the plan as it was")
	}
}

// FR-SHELL-038 (#1777): Codex gets the same through its documented --add-dir and a valid TOML developer_instructions.
func TestCodexProjectFromTheFolder(t *testing.T) {
	c := makeClientTree(t)
	plan := codexAdapter{}.PlanProject(c.ctxAt(c.folder, "fix it"))
	if plan.StartDir != c.repo {
		t.Errorf("starts in %q", plan.StartDir)
	}
	if len(plan.Args) != 4 || plan.Args[0] != "--add-dir" || plan.Args[1] != c.folder || plan.Args[2] != "-c" {
		t.Fatalf("args %q", plan.Args)
	}
	var doc map[string]any
	if _, err := toml.Decode(plan.Args[3], &doc); err != nil {
		t.Fatalf("the override is not valid TOML: %v: %q", err, plan.Args[3])
	}
	if doc["developer_instructions"] != ProjectNote(c.places()) {
		t.Errorf("note %v", doc["developer_instructions"])
	}
	if kinds := itemKinds(plan.Added); !slices.Equal(kinds, []string{molten.IntegrationProjectStart, molten.IntegrationProjectFolder, molten.IntegrationProjectNote}) {
		t.Errorf("added %v", kinds)
	}
	inside := codexAdapter{}.PlanProject(c.ctxAt(c.repo))
	if inside.StartDir != "" || len(inside.Args) != 4 {
		t.Errorf("from the repository: %+v", inside)
	}
}

func TestCodexProjectLeavesTheUsersOwnAlone(t *testing.T) {
	c := makeClientTree(t)
	own := codexAdapter{}.PlanProject(c.ctxAt(c.folder, "--add-dir", c.folder))
	if slices.Contains(own.Args, "--add-dir") || own.Skipped[0].Kind != molten.IntegrationProjectFolder {
		t.Errorf("their --add-dir: %+v", own)
	}
	flag := codexAdapter{}.PlanProject(c.ctxAt(c.folder, "-c", `developer_instructions="be brief"`))
	if slices.Contains(flag.Args, "-c") || len(flag.Skipped) != 1 || flag.Skipped[0].Kind != molten.IntegrationProjectNote {
		t.Errorf("their -c: %+v", flag)
	}

	c.write(t, c.codexConfig(), "developer_instructions = \"be brief\"\n")
	user := codexAdapter{}.PlanProject(c.ctxAt(c.folder))
	if slices.Contains(user.Args, "-c") || len(user.Skipped) != 1 || !strings.Contains(user.Skipped[0].Reason, "already yours") {
		t.Errorf("their config.toml: %+v", user)
	}
	if !slices.Contains(user.Args, "--add-dir") {
		t.Errorf("the folder is still added: %+v", user)
	}
}

// Codex reads the project files of the folder it starts in: a .codex/config.toml in the repository counts.
func TestCodexProjectReadsTheRepositorysConfig(t *testing.T) {
	c := makeClientTree(t)
	c.write(t, filepath.Join(c.repo, ".codex", "config.toml"), "developer_instructions = \"repo rules\"\n")
	plan := codexAdapter{}.PlanProject(c.ctxAt(c.folder))
	if slices.Contains(plan.Args, "-c") {
		t.Errorf("the repository's own developer_instructions is kept: %+v", plan.Args)
	}
}
