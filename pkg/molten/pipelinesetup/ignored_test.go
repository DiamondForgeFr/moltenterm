// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// #1146: SaaSFoundryAI's clone ignores .molten/ in .git/info/exclude (shared by its worktrees), and a tracked
// .gitignore can ignore the documentation's folder. The commit still carries every file the developer approved,
// says which rule matched, and a retry after a failure reuses the ticket already created.
func TestIgnoredFilesAreCommittedAndARetryReusesTheTicket(t *testing.T) {
	dir := protectedRepository(t)
	exclude := filepath.Join(dir, ".git", "info", "exclude")
	if err := os.MkdirAll(filepath.Dir(exclude), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(exclude, []byte("# local\n.molten/*.json\n"), 0644); err != nil {
		t.Fatal(err)
	}
	writeFiles(t, dir, map[string]string{".gitignore": ".molten/release-pipeline.md\n"})
	gitIn(t, dir, "add", ".gitignore")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore(#4): ignore the pipeline doc")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")

	forge := &fakeForge{issueNum: "1114"}
	var lock sync.Mutex
	pushFails := true
	inner := forge.runner(t, protectedRules(t))
	s := MakeSetup(func(ctx context.Context, d string, name string, args ...string) ([]byte, error) {
		if name == "git" && strings.Contains(" "+strings.Join(args, " ")+" ", " push ") && strings.Contains(strings.Join(args, " "), "release-pipeline") {
			lock.Lock()
			fails := pushFails
			lock.Unlock()
			if fails {
				return nil, errors.New("git push: the remote end hung up unexpectedly")
			}
		}
		return inner(ctx, d, name, args...)
	}, nil)
	s.TreesDir = t.TempDir()
	ctx := context.Background()
	draft, err := s.Draft(ctx, DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	write := func() PrJob {
		return waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated,
			PrRequest: PrRequest{CreateTicket: true}}))
	}

	failed := write()
	if failed.Failure == nil || failed.Failure.Code != PrFailurePush || failed.Ticket != 1114 {
		t.Fatalf("a forced push failure: %+v %+v", failed.Failure, failed)
	}
	if !stepDone(failed, PrStepCommit) {
		t.Fatalf("the commit was not made: %+v", failed.Steps)
	}
	local, shared := ruleOf(failed, ".git/info/exclude"), ruleOf(failed, ".gitignore")
	if local == nil || local.Pattern != ".molten/*.json" || local.Shared ||
		strings.Join(local.Files, ",") != molten.ProjectPipelineFile+",.molten/release-setup.json" {
		t.Fatalf("the exclude rule: %+v", failed.Ignored)
	}
	if shared == nil || shared.Pattern != ".molten/release-pipeline.md" || !shared.Shared || strings.Join(shared.Files, ",") != TechDocPath {
		t.Fatalf("the .gitignore rule: %+v", failed.Ignored)
	}

	lock.Lock()
	pushFails = false
	lock.Unlock()
	job := write()
	if job.Failure != nil {
		t.Fatalf("the retry: %+v", job.Failure)
	}
	if job.Ticket != 1114 || job.Branch != "feature/1114-release-pipeline" || job.Steps[0].Info != "#1114" {
		t.Fatalf("the retry's ticket: %+v", job)
	}
	if _, issues := forge.calls(); len(issues) != 1 {
		t.Fatalf("a retry created another ticket: %v", issues)
	}
	gitIn(t, dir, "fetch", "--quiet", "origin")
	files := gitOut(t, dir, "diff", "--name-only", "origin/develop", "origin/feature/1114-release-pipeline")
	if files != ".molten/project.json\n"+TechDocPath+"\n.molten/release-setup.json\n" {
		t.Fatalf("files: %q", files)
	}
	if got, _ := os.ReadFile(exclude); string(got) != "# local\n.molten/*.json\n" {
		t.Fatalf("the exclude file changed: %q", got)
	}

	// Once the pull request is open, the next job that asks for a ticket creates a new one.
	if s.createdTicket(dir, PrKindWrite) != 0 {
		t.Fatal("the ticket is still remembered after the pull request")
	}
}

func stepDone(job PrJob, id string) bool {
	for _, step := range job.Steps {
		if step.Id == id {
			return step.State == PrStateDone
		}
	}
	return false
}

func ruleOf(job PrJob, source string) *PrIgnored {
	for i := range job.Ignored {
		if job.Ignored[i].Source == source {
			return &job.Ignored[i]
		}
	}
	return nil
}

func TestIgnoreSourceName(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("no home folder")
	}
	for source, want := range map[string]string{
		".gitignore":                              ".gitignore",
		"docs/.gitignore":                         "docs/.gitignore",
		"/work/app/.git/info/exclude":             ".git/info/exclude",
		filepath.Join(home, ".config/git/ignore"): "~/.config/git/ignore",
		"/etc/gitignore":                          "/etc/gitignore",
	} {
		if got := ignoreSourceName(source); got != want {
			t.Errorf("%s: %s, want %s", source, got, want)
		}
	}
}
