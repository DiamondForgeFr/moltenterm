// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Step 2b (FR-MC-041): a new npm CLI with no tag and no workflow, described by its developer.

func npmCliRepository(t *testing.T, extra map[string]string) string {
	t.Helper()
	t.Setenv("GIT_CONFIG_GLOBAL", os.DevNull)
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("GIT_AUTHOR_NAME", "Setup test")
	t.Setenv("GIT_AUTHOR_EMAIL", "setup@example.invalid")
	t.Setenv("GIT_COMMITTER_NAME", "Setup test")
	t.Setenv("GIT_COMMITTER_EMAIL", "setup@example.invalid")
	base := t.TempDir()
	dir := filepath.Join(base, "invoice-cli")
	origin := filepath.Join(base, "github-origin.git")
	gitIn(t, base, "init", "--quiet", "--bare", "-b", "develop", origin)
	gitIn(t, base, "init", "--quiet", "-b", "develop", dir)
	files := map[string]string{
		"package.json":      `{ "name": "invoice-cli", "version": "0.1.0", "bin": { "invoice": "bin/invoice.js" } }`,
		"package-lock.json": "{}\n",
		"app.txt":           "one\n",
	}
	for k, v := range extra {
		files[k] = v
	}
	writeFiles(t, dir, files)
	gitIn(t, dir, "add", "-A")
	gitIn(t, dir, "commit", "--quiet", "-m", "chore: bootstrap")
	gitIn(t, dir, "remote", "add", "origin", origin)
	gitIn(t, dir, "push", "--quiet", "origin", "develop", "develop:main")
	gitIn(t, dir, "fetch", "--quiet", "origin")
	return dir
}

func describeSetup(t *testing.T, forge *fakeForge) *Setup {
	t.Helper()
	s := prSetup(t, forge, `[]`)
	s.Providers = []Provider{DetectionProvider{}}
	return s
}

func describedOptions(t *testing.T, s *Setup, dir string, edit func(o *Options)) Options {
	t.Helper()
	first, err := s.Draft(context.Background(), DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	o := first.Options
	o.Trunk, o.Release, o.Rc, o.Publish = "develop", "main", RcPublished, []string{TargetNpm, TargetGithubRelease}
	if edit != nil {
		edit(&o)
	}
	return o
}

func TestDescribedPipelineProposesThePublishWorkflow(t *testing.T) {
	dir := npmCliRepository(t, nil)
	s := describeSetup(t, &fakeForge{})
	ctx := context.Background()
	o := describedOptions(t, s, dir, nil)
	draft, err := s.Draft(ctx, DraftRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	if len(draft.Errors) > 0 {
		t.Fatalf("errors: %v", draft.Errors)
	}
	if strings.Join(draft.Options.Channels, ",") != "rc,public" {
		t.Fatalf("channels: %v", draft.Options.Channels)
	}
	if len(draft.Files) != 1 || draft.Files[0].Path != ".github/workflows/molten-publish.yml" ||
		strings.Join(draft.Files[0].Targets, ",") != "npm,githubrelease" {
		t.Fatalf("files: %+v", draft.Files)
	}
	text := draft.Files[0].Content
	for _, want := range []string{`- "v*"`, "npm ci", "npm publish --provenance --tag next", "--prerelease", `notes="releases/${GITHUB_REF_NAME}.md"`,
		"gh release create \"$GITHUB_REF_NAME\" --verify-tag", "NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}"} {
		if !strings.Contains(text, want) {
			t.Fatalf("the workflow lacks %q:\n%s", want, text)
		}
	}
	if strings.Contains(text, `"!v*-*"`) {
		t.Fatalf("published candidates are excluded:\n%s", text)
	}
	// The steps already count the proposed workflow: the candidate is published, so it is tagged and merged as usual.
	if len(draft.TagWorkflows[ChannelRc]) != 1 || draft.TagWorkflows[ChannelRc][0].File != PublishWorkflowFile {
		t.Fatalf("rc tag workflows: %+v", draft.TagWorkflows)
	}
	public := releaseOf(t, draft.Proposed).Public
	finalize, _ := stepById(public, "finalize")
	if !strings.Contains(finalize.Title, "molten-publish.yml starts on the tag") {
		t.Fatalf("finalize: %+v", finalize)
	}
	if !strings.Contains(strings.Join(draft.BranchNames, ","), "develop") || !strings.Contains(strings.Join(draft.BranchNames, ","), "main") {
		t.Fatalf("branch names: %v", draft.BranchNames)
	}
	if _, err := os.Stat(filepath.Join(dir, ".github")); err == nil {
		t.Fatal("the draft wrote the workflow")
	}
}

func TestDescriptionAnswers(t *testing.T) {
	dir := npmCliRepository(t, nil)
	s := describeSetup(t, &fakeForge{})
	ctx := context.Background()

	internal := describedOptions(t, s, dir, func(o *Options) { o.Rc = RcInternal })
	draft, err := s.Draft(ctx, DraftRequest{Dir: dir, Options: &internal})
	if err != nil {
		t.Fatal(err)
	}
	text := draft.Files[0].Content
	if !strings.Contains(text, `- "!v*-*"`) || strings.Contains(text, "--tag next") || strings.Contains(text, "--prerelease") {
		t.Fatalf("an internal candidate is published:\n%s", text)
	}
	if len(draft.TagWorkflows[ChannelRc]) != 0 || len(draft.TagWorkflows[ChannelPublic]) != 1 {
		t.Fatalf("tag workflows: %+v", draft.TagWorkflows)
	}

	none := describedOptions(t, s, dir, func(o *Options) { o.Rc = RcNone; o.Publish = []string{TargetNpm} })
	draft, err = s.Draft(ctx, DraftRequest{Dir: dir, Options: &none})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(draft.Options.Channels, ",") != "public" || len(releaseOf(t, draft.Proposed).Rc) != 0 {
		t.Fatalf("no candidate: %v", draft.Options.Channels)
	}
	if strings.Contains(draft.Files[0].Content, "github-release") {
		t.Fatalf("an unchosen target:\n%s", draft.Files[0].Content)
	}

	same := describedOptions(t, s, dir, func(o *Options) { o.Trunk, o.Release = "main", "main" })
	draft, err = s.Draft(ctx, DraftRequest{Dir: dir, Options: &same})
	if err != nil {
		t.Fatal(err)
	}
	public := releaseOf(t, draft.Proposed).Public
	if _, ok := stepById(public, "promote"); ok {
		t.Fatalf("the same branch still promotes: %v", stepIds(public))
	}
	if _, ok := stepById(public, "sync-back"); ok {
		t.Fatalf("the same branch syncs back: %v", stepIds(public))
	}
	if !strings.Contains(draft.Proposed, `"trunk": "main"`) || draft.Options.BranchModel != BranchModelSingle {
		t.Fatalf("branches: %s", draft.Proposed)
	}
}

func TestATargetAlreadyPublishedProposesNoFile(t *testing.T) {
	dir := npmCliRepository(t, map[string]string{".github/workflows/release.yml": "name: Release\non:\n  push:\n    tags: ['v*']\njobs:\n  publish:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n"})
	s := describeSetup(t, &fakeForge{})
	o := describedOptions(t, s, dir, func(o *Options) { o.Publish = []string{TargetNpm} })
	draft, err := s.Draft(context.Background(), DraftRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	if len(draft.Files) != 0 {
		t.Fatalf("files: %+v", draft.Files)
	}
}

func TestWriteAddsTheProposedWorkflowToThePullRequest(t *testing.T) {
	dir := npmCliRepository(t, nil)
	forge := &fakeForge{}
	s := describeSetup(t, forge)
	o := describedOptions(t, s, dir, nil)
	draft, err := s.Draft(context.Background(), DraftRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	before := workingCopy(t, dir)
	job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, Files: draft.Files}))
	if job.Failure != nil {
		t.Fatalf("failure: %+v", job.Failure)
	}
	if got := workingCopy(t, dir); got != before {
		t.Fatal("the checkout changed")
	}
	gitIn(t, dir, "fetch", "--quiet", "origin")
	files := gitOut(t, dir, "diff", "--name-only", "origin/develop", "origin/"+job.Branch)
	if files != ".github/workflows/molten-publish.yml\n.molten/project.json\n.molten/release-setup.json\n"+TechDocPath+"\n" {
		t.Fatalf("files: %q", files)
	}
	if pushed := gitOut(t, dir, "show", "origin/"+job.Branch+":.github/workflows/molten-publish.yml"); pushed != draft.Files[0].Content {
		t.Fatalf("pushed:\n%s", pushed)
	}
}

func TestWriteRefusesOtherProposedFiles(t *testing.T) {
	dir := npmCliRepository(t, map[string]string{".github/workflows/ci.yml": "name: CI\non: [push]\njobs:\n  t:\n    runs-on: ubuntu-latest\n    steps:\n      - run: true\n"})
	s := describeSetup(t, &fakeForge{})
	o := describedOptions(t, s, dir, nil)
	draft, err := s.Draft(context.Background(), DraftRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	workflow := draft.Files[0].Content
	for name, files := range map[string][]ProposedFile{
		"outside":  {{Path: ".molten/run.sh", Content: workflow}},
		"escape":   {{Path: ".github/workflows/../../evil.yml", Content: workflow}},
		"not yml":  {{Path: ".github/workflows/publish.sh", Content: workflow}},
		"existing": {{Path: ".github/workflows/ci.yml", Content: workflow}},
		"not wf":   {{Path: ".github/workflows/x.yml", Content: "- a list"}},
		"large":    {{Path: ".github/workflows/x.yml", Content: workflow + strings.Repeat("#", maxProposedFileBytes)}},
		"twice":    {draft.Files[0], draft.Files[0]},
	} {
		job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Files: files}))
		if job.Failure == nil || job.Failure.Code != PrFailureInvalid {
			t.Fatalf("%s: %+v", name, job.Failure)
		}
	}
	if out := gitOut(t, dir, "ls-remote", "--heads", "origin"); strings.Count(out, "\n") != 2 {
		t.Fatalf("a branch was pushed: %s", out)
	}
}

const modelPipeline = `{
    "schema": 1,
    "name": "Model",
    "versions": { "tagprefix": "r" },
    "release": {
        "rc": [
            { "id": "prepare", "title": "Bump", "phase": "prepare", "run": "molten release prepare {tag}" },
            { "id": "check-store", "title": "Check the store page", "phase": "cut", "manual": "Open the store page and check it." },
            { "id": "finalize", "title": "Commit, tag and push", "phase": "cut", "run": "molten release finalize {tag}" }
        ],
        "public": [
            { "id": "prepare", "title": "Bump", "phase": "prepare", "run": "molten release prepare {tag}" },
            { "id": "check-store", "title": "Check the store page", "phase": "cut", "manual": "Open the store page and check it." },
            { "id": "finalize", "title": "Commit, tag and push", "phase": "cut", "run": "molten release finalize {tag}" },
            { "id": "close-milestone", "title": "Close the milestone", "phase": "publish", "run": "molten release close-milestone {tag}" }
        ]
    }
}
`

func TestAnotherProjectAsAModel(t *testing.T) {
	dir := npmCliRepository(t, nil)
	model := npmCliRepository(t, map[string]string{
		".github/workflows/publish.yml": "name: Publish\non:\n  push:\n    tags: ['r*']\njobs:\n  npm:\n    runs-on: ubuntu-latest\n    steps:\n      - run: npm publish\n",
	})
	// Committed on origin's develop; the working copy then says something else, which the model never reads.
	writeFiles(t, model, map[string]string{molten.ProjectPipelineFile: modelPipeline})
	gitIn(t, model, "add", "-A")
	gitIn(t, model, "commit", "--quiet", "-m", "chore(#3): the pipeline")
	gitIn(t, model, "push", "--quiet", "origin", "develop")
	gitIn(t, model, "fetch", "--quiet", "origin")
	writeFiles(t, model, map[string]string{molten.ProjectPipelineFile: strings.Replace(modelPipeline, "check-store", "local-edit", -1)})
	noPipeline := npmCliRepository(t, nil)
	s := describeSetup(t, &fakeForge{})
	s.ProjectDirs = func(context.Context) ([]string, error) {
		return []string{dir, "relative", model, noPipeline, model}, nil
	}
	before := workingCopy(t, model) + workingCopy(t, dir)
	answer, err := s.Models(context.Background(), ModelsRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if len(answer.Models) != 1 || answer.Models[0].Dir != model || answer.Models[0].Name != "Model" || answer.Models[0].Ref != "origin/develop" {
		t.Fatalf("models: %+v", answer.Models)
	}
	o := answer.Models[0].Options
	if o.Rc != RcPublished || o.TagPrefix != "r" || strings.Join(o.Publish, ",") != "npm" || o.Trunk != "develop" || o.Release != "main" {
		t.Fatalf("adapted: %+v", o)
	}
	if len(o.Manual) != 1 || o.Manual[0].Id != "check-store" || o.Manual[0].Channel != "" {
		t.Fatalf("manual: %+v", o.Manual)
	}
	if got := workingCopy(t, model) + workingCopy(t, dir); got != before {
		t.Fatal("a folder changed")
	}
	draft, err := s.Draft(context.Background(), DraftRequest{Dir: dir, Options: &o})
	if err != nil {
		t.Fatal(err)
	}
	if len(draft.Errors) > 0 || len(draft.Files) != 1 || !strings.Contains(draft.Files[0].Content, `- "r*"`) {
		t.Fatalf("the model's draft: %v %+v", draft.Errors, draft.Files)
	}
	if _, ok := stepById(releaseOf(t, draft.Proposed).Rc, "check-store"); !ok {
		t.Fatalf("the model's manual step is missing:\n%s", draft.Proposed)
	}
}
