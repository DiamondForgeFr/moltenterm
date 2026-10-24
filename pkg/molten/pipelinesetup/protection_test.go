// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The release setup of a protected, diverged repository shaped like SaaSFoundryAI (#1046): a real git checkout with a
// bare origin, and a fake gh answering GitHub's rules as SaaSFoundryAI's ruleset reads.

func gitIn(t *testing.T, dir string, args ...string) {
	t.Helper()
	cmd := exec.Command("git", args...)
	cmd.Dir = dir
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("git %s: %v\n%s", strings.Join(args, " "), err, out)
	}
}

const readmeLabel = "# SaaSFoundryAI\n\n**v1.0.4**\n\nThe 1.0.4 release, and a long sentence that names 1.0.4 among a lot of other words, which is no label.\n"

const agentsLabel = "# Agents\n\n- Current version: 1.0.0-beta (npm package `saasfoundryai-cli`)\n"

const navLabel = "export const nav = [\n  {\n    text: 'v1.0.4',\n    items: []\n  }\n]\n"

// protectedRepository: develop and master diverged, master's only commit cherry-picked onto develop and changed again
// there, so their merge conflicts while master holds nothing develop lacks.
func protectedRepository(t *testing.T) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Setup test")
	t.Setenv("GIT_AUTHOR_EMAIL", "setup@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Setup test")
	t.Setenv("GIT_COMMITTER_EMAIL", "setup@example.invalid")
	base := t.TempDir()
	dir := filepath.Join(base, "app")
	// Named so that the checkout reads as a GitHub one (onGithub); the fake gh names the real repository.
	origin := filepath.Join(base, "github-origin.git")
	gitIn(t, base, "init", "--quiet", "--bare", "-b", "develop", origin)
	gitIn(t, base, "init", "--quiet", "-b", "develop", dir)
	writeFiles(t, dir, map[string]string{
		".molten/project.json":                 sfPipeline,
		".saasfoundry.json":                    sfManifest,
		"package.json":                         `{ "name": "saasfoundryai", "version": "1.0.4" }`,
		".github/workflows/publish-stable.yml": publishStable,
		".github/workflows/deploy-docs.yml":    deployDocs,
		".github/workflows/test.yml":           testYml,
		"docs/changelog.md":                    "# Changelog\n\n## 1.0.4\n",
		"docs/fr/changelog.md":                 "# Journal\n",
		"docs/.vitepress/config/navigation.ts": navLabel,
		"README.md":                            readmeLabel,
		"AGENTS.md":                            agentsLabel,
		"app.txt":                              "one\n",
	})
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore: bootstrap")
	gitIn(t, dir, "remote", "add", "origin", origin)
	gitIn(t, dir, "push", "--quiet", "origin", "develop", "develop:master")
	writeFiles(t, dir, map[string]string{"app.txt": "fixed\n"})
	gitIn(t, dir, "commit", "--quiet", "-am", "fix(#1): the first line")
	gitIn(t, dir, "checkout", "--quiet", "-b", "hotfix", "origin/master")
	// -x: within the same second, a plain cherry-pick onto the same parent would be the very same commit.
	gitIn(t, dir, "cherry-pick", "-x", "develop")
	gitIn(t, dir, "push", "--quiet", "origin", "HEAD:master")
	gitIn(t, dir, "checkout", "--quiet", "develop")
	writeFiles(t, dir, map[string]string{"app.txt": "fixed again\n"})
	gitIn(t, dir, "commit", "--quiet", "-am", "fix(#2): the first line, again")
	gitIn(t, dir, "push", "--quiet", "origin", "develop")
	gitIn(t, dir, "fetch", "--quiet", "origin")
	return dir
}

// githubAs: git runs for real (origin's URL reads as GitHub's), gh answers from testdata.
func githubAs(t *testing.T, rules string, extra func(path string) ([]byte, bool)) Runner {
	ruleset, err := os.ReadFile(filepath.Join("testdata", "ruleset-protected.json"))
	if err != nil {
		t.Fatal(err)
	}
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		switch name {
		case "git":
			if strings.Join(args, " ") == "config --get remote.origin.url" {
				return []byte("git@github.com:DiamondForgeFr/SaasFoundryAI.git\n"), nil
			}
			cmd := exec.CommandContext(ctx, "git", args...)
			cmd.Dir = dir
			out, err := cmd.Output()
			return out, err
		case "gh":
			path := args[1]
			if extra != nil {
				if out, ok := extra(path); ok {
					return out, nil
				}
			}
			switch {
			case strings.HasSuffix(path, "/rules/branches/master"):
				return []byte(rules), nil
			case strings.HasSuffix(path, "/rulesets/24043198"):
				return ruleset, nil
			case strings.HasSuffix(path, "/branches/master/protection"):
				return nil, errors.New("gh: Branch not protected (HTTP 404)")
			case path == "repos/DiamondForgeFr/SaasFoundryAI":
				return []byte(`{"allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":true,"permissions":{"admin":true}}`), nil
			}
			return nil, errors.New("fake gh: unexpected " + strings.Join(args, " "))
		}
		return nil, errors.New(name + ": command not found")
	}
}

func TestDraftProtectedDivergedRepositoryGoesByPullRequest(t *testing.T) {
	dir := protectedRepository(t)
	rules, err := os.ReadFile(filepath.Join("testdata", "rules-branches-protected.json"))
	if err != nil {
		t.Fatal(err)
	}
	s := MakeSetup(githubAs(t, string(rules), nil), nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	p := answer.Facts.Protection
	if p == nil || !p.Read || !p.PullRequest || strings.Join(p.RequiredChecks, ",") != "CI / Required gate" || !p.Strict || p.Bypass != BypassNever || !p.RequiresPr() {
		t.Fatalf("protection: %+v", p)
	}
	if len(p.Sources) != 1 || p.Sources[0].Path != "Protect release branches and require SaaSFoundry gate" {
		t.Fatalf("protection sources: %+v", p.Sources)
	}
	d := answer.Facts.Divergence
	if d == nil || d.Ahead != 1 || d.Behind != 2 || !d.Conflicts || d.ConflictFiles != 1 || d.NotEquivalent != 0 || !d.Reconcilable() {
		t.Fatalf("divergence: %+v", d)
	}
	if answer.Options.BranchModel != BranchModelRcPr || !answer.Options.Reconcile {
		t.Fatalf("options: %+v", answer.Options)
	}
	for _, m := range answer.BranchModels {
		if m.Id == BranchModelPromote && (m.Allowed || m.Reasons[len(m.Reasons)-1].Code != ReasonProtectedRelease) {
			t.Fatalf("a promotion pushed to the protected branch must be refused: %+v", m)
		}
		if m.Id == BranchModelRcPr && !m.Allowed {
			t.Fatalf("the pull-request model must be offered: %+v", m)
		}
	}
	if len(answer.Errors) > 0 {
		t.Fatalf("the draft is not valid: %v\n%s", answer.Errors, answer.Proposed)
	}
	rc, public := answer.Proposal.Release.Rc, answer.Proposal.Release.Public
	// Nothing starts on a candidate's tag (publish-stable takes vX.Y.Z only): the candidate stays on its RC branch.
	if got := strings.Join(stepIds(rc), ","); got != "prepare,changelog-en,changelog-fr,tag" {
		t.Fatalf("rc steps: %s", got)
	}
	if rc[3].Run != "molten release tag {tag} --rc-branch" || rc[3].Confirm == "" {
		t.Fatalf("rc tag: %+v", rc[3])
	}
	if got := strings.Join(stepIds(public), ","); got != "prepare,reconcile,changelog-en,changelog-fr,open-pr,merge-pr,tag,close-milestone,dispatch-deploy-docs,sync-back" {
		t.Fatalf("public steps: %s", got)
	}
	byId := map[string]molten.PipelineStep{}
	for _, s := range public {
		byId[s.Id] = s
	}
	if byId["prepare"].Run != "molten release prepare {tag} --pr" || byId["reconcile"].Run != "molten release reconcile {tag}" || byId["reconcile"].Phase != "prepare" {
		t.Fatalf("prepare / reconcile: %+v %+v", byId["prepare"], byId["reconcile"])
	}
	if byId["merge-pr"].Run != "molten release merge-pr {tag} --method merge" || !strings.Contains(byId["merge-pr"].Confirm, "CI / Required gate") {
		t.Fatalf("merge-pr: %+v", byId["merge-pr"])
	}
	if byId["sync-back"].Run != "molten release sync-back {tag} --merge" || !strings.Contains(byId["sync-back"].Confirm, "never squash or rebase") {
		t.Fatalf("sync-back: %+v", byId["sync-back"])
	}
	if !answer.Facts.CommitTicket {
		t.Fatal("the commit format requires a ticket")
	}
	if byId["open-pr"].Confirm == "" || byId["tag"].Confirm == "" || !strings.Contains(byId["tag"].Confirm, "npm-production") {
		t.Fatalf("each irreversible step confirms: %+v %+v", byId["open-pr"], byId["tag"])
	}
	if !strings.Contains(byId["changelog-en"].Manual, "RC branch rc-X.Y.Z made from develop") {
		t.Fatalf("the changelog steps point to the RC branch: %s", byId["changelog-en"].Manual)
	}
	for _, s := range public {
		if strings.Contains(s.Run, "finalize") || strings.Contains(s.Run, "promote") {
			t.Fatalf("nothing pushes master directly: %s", s.Run)
		}
	}
	var labels []string
	for _, l := range answer.Facts.Labels {
		labels = append(labels, l.Path+"="+l.Pattern)
	}
	want := []string{
		"AGENTS.md=" + versions.TextLabelPattern("- Current version: ", " (npm package `saasfoundryai-cli`)"),
		"README.md=" + `\*\*v{version}\*\*`,
		"docs/.vitepress/config/navigation.ts=" + `text: 'v{version}',`,
	}
	if strings.Join(labels, "\n") != strings.Join(want, "\n") {
		t.Fatalf("labels:\n%s\nwant:\n%s", strings.Join(labels, "\n"), strings.Join(want, "\n"))
	}
	for _, w := range want {
		if !strings.Contains(answer.Proposed, `"format": "text"`) || !strings.Contains(answer.Proposed, strings.SplitN(w, "=", 2)[0]) {
			t.Fatalf("the labels are not in versions.files:\n%s", answer.Proposed)
		}
	}
}

// A candidate something publishes (a prerelease on npm) still goes to the release branch by pull request.
func TestPublishedCandidateGoesByPullRequest(t *testing.T) {
	dir := protectedRepository(t)
	writeFiles(t, dir, map[string]string{".github/workflows/next.yml": "name: Publish next\non:\n  push:\n    tags: ['v*-*']\njobs:\n  p:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish --tag next\n"})
	rules, _ := os.ReadFile(filepath.Join("testdata", "rules-branches-protected.json"))
	s := MakeSetup(githubAs(t, string(rules), nil), nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(stepIds(answer.Proposal.Release.Rc), ","); got != "prepare,reconcile,changelog-en,changelog-fr,open-pr,merge-pr,tag,sync-back" {
		t.Fatalf("rc steps: %s", got)
	}
}

func TestDraftUnprotectedRepositoryKeepsThePromotion(t *testing.T) {
	dir := protectedRepository(t)
	gitIn(t, dir, "push", "--quiet", "--force", "origin", "develop:master")
	gitIn(t, dir, "fetch", "--quiet", "origin")
	s := MakeSetup(githubAs(t, "[]", nil), nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if answer.Facts.Protection.RequiresPr() || answer.Options.BranchModel != BranchModelPromote || answer.Options.Reconcile {
		t.Fatalf("protection %+v, options %+v", answer.Facts.Protection, answer.Options)
	}
	if got := strings.Join(stepIds(answer.Proposal.Release.Rc), ","); got != "promote,prepare,changelog-en,changelog-fr,finalize,sync-back" {
		t.Fatalf("rc steps: %s", got)
	}
	if answer.Facts.Divergence.Diverged() {
		t.Fatalf("divergence: %+v", answer.Facts.Divergence)
	}
}

func TestBypassableProtectionKeepsThePromotion(t *testing.T) {
	dir := protectedRepository(t)
	rules := `[{"type":"pull_request","parameters":{"allowed_merge_methods":["merge"]},"ruleset_id":7}]`
	s := MakeSetup(githubAs(t, rules, func(path string) ([]byte, bool) {
		if strings.HasSuffix(path, "/rulesets/7") {
			return []byte(`{"name":"main: merge commits only","current_user_can_bypass":"always"}`), true
		}
		return nil, false
	}), nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	p := answer.Facts.Protection
	if p.RequiresPr() || p.Bypass != BypassAlways || strings.Join(p.MergeMethods, ",") != "merge" || answer.Options.BranchModel != BranchModelPromote {
		t.Fatalf("protection %+v, model %s", p, answer.Options.BranchModel)
	}
	for _, m := range answer.Merges {
		if m.Id == MergeSquash && m.Reasons[len(m.Reasons)-1].Code != ReasonProtectionMerge {
			t.Fatalf("a method the rules refuse says so: %+v", m)
		}
	}
}

func TestNotEquivalentCommitWarnsInsteadOfReconciling(t *testing.T) {
	dir := protectedRepository(t)
	gitIn(t, dir, "checkout", "--quiet", "hotfix")
	writeFiles(t, dir, map[string]string{"only-master.txt": "x\n"})
	gitIn(t, dir, "add", "only-master.txt")
	gitIn(t, dir, "commit", "--quiet", "-m", "fix(#3): only on master")
	gitIn(t, dir, "push", "--quiet", "origin", "HEAD:master")
	gitIn(t, dir, "checkout", "--quiet", "develop")
	gitIn(t, dir, "fetch", "--quiet", "origin")
	rules, _ := os.ReadFile(filepath.Join("testdata", "rules-branches-protected.json"))
	s := MakeSetup(githubAs(t, string(rules), nil), nil)
	answer, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	d := answer.Facts.Divergence
	if d.NotEquivalent != 1 || !strings.Contains(d.Samples[0], "only on master") || d.Reconcilable() || answer.Options.Reconcile {
		t.Fatalf("divergence %+v, reconcile %v", d, answer.Options.Reconcile)
	}
	for _, s := range answer.Proposal.Release.Rc {
		if s.Id == "reconcile" {
			t.Fatal("-s ours would drop the commit: no reconcile step")
		}
	}
}

func TestAmbiguousLabelBecomesAManualStep(t *testing.T) {
	dir := t.TempDir()
	writeFiles(t, dir, map[string]string{
		"package.json": `{ "name": "tool", "version": "2.1.0", "private": true }`,
		"README.md":    "v2.1.0\n\nv2.1.0\n",
	})
	f := Detect(dir)
	if len(f.Labels) != 2 || f.Labels[0].Pattern != "" {
		t.Fatalf("labels: %+v", f.Labels)
	}
	o := DefaultOptions(f)
	p := Build(f, o, nil)
	var manual molten.PipelineStep
	for _, s := range p.Release.Rc {
		if s.Id == "bump-labels" {
			manual = s
		}
	}
	if !manual.IsManual() || manual.Phase != "cut" || !strings.Contains(manual.Manual, "README.md:1 (v2.1.0)") || !strings.Contains(manual.Manual, "README.md:3") {
		t.Fatalf("manual step: %+v", manual)
	}
	if len(p.Versions.Files) != 1 {
		t.Fatalf("no text entry for an ambiguous label: %+v", p.Versions.Files)
	}
}
