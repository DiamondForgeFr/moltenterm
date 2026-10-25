// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// The pipeline's technical documentation (FR-MC-043, #1107): the generator on SaaSFoundryAI's pipeline, the
// repository fallback, and the backend adapter with a fake CLI.

func saasFoundryPipeline(t *testing.T) *molten.Pipeline {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "techdoc-saasfoundry-project.json"))
	if err != nil {
		t.Fatal(err)
	}
	var p molten.Pipeline
	if err := json.Unmarshal(data, &p); err != nil {
		t.Fatal(err)
	}
	return &p
}

func saasFoundryDocInput(t *testing.T) TechDocInput {
	t.Helper()
	p := saasFoundryPipeline(t)
	dir := saasFoundryFixture(t)
	f := DetectWith(dir, molten.PipelineReport{Present: true, Valid: true, Pipeline: p})
	f.Branches.Trunk, f.Branches.Release = "develop", "master"
	f.Protection = &Protection{Branch: "master", Read: true, PullRequest: true, RequiredChecks: []string{"CI / Required gate"},
		MergeMethods: []string{"merge"}, Bypass: BypassNever, Sources: []Source{{Code: "ruleset", Detail: "master protection"}}}
	return TechDocInput{Pipeline: p, Facts: f, Repo: "DiamondForgeFr/SaasFoundryAI",
		Change: TechDocChange{Date: "2026-10-25", Kind: TechDocChangeSetup, Author: "Setup test", Branch: "feature/7-release-pipeline", Template: TemplateVersion}}
}

func TestTechDocOfSaaSFoundryAIsPipeline(t *testing.T) {
	in := saasFoundryDocInput(t)
	doc := BuildTechDoc(in)
	if BuildTechDoc(in) != doc {
		t.Fatal("the same pipeline gives another document")
	}
	for _, want := range []string{
		"# Release pipeline: SaaSFoundryAI",
		"do not edit it by hand",
		"```mermaid\nflowchart LR\n",
		"subgraph rc[\"Release candidate\"]",
		"subgraph public[\"Public release\"]",
		"(by hand)\"/]",
		"public_7{{\"Tag the merge commit and push the tag: publish-stable.yml s…\"}}",
		"public_wf_publish_stable_yml[\"publish-stable.yml · approval: npm-production\"]",
		"public_to_npm[(\"npm\")]",
		"a release branch made from the trunk reaches the published branch by pull request (`merge`)",
		"- **Tags:** public `vX.Y.Z`, release candidates `vX.Y.Z-N`.",
		"## Branches and protection",
		"- required checks: `CI / Required gate`;",
		"- `rc-{version}`: the release branches",
		"## Release candidate flow",
		"## Public release flow",
		"| 1 | prepare | Bump the version and draft the notes on rc-X.Y.Z, made from develop | MoltenTerm | `molten release prepare {tag} --pr` | — |",
		"| By hand | In the release worktree (../SaaSFoundry-release",
		"`molten release merge-pr {tag} --method merge`",
		"4 steps: 2 run by MoltenTerm (`molten release`), 2 by hand.",
		"10 steps: 8 run by MoltenTerm (`molten release`), 2 by hand.",
		"- A public release tag starts `publish-stable.yml`, `test.yml`.",
		"| `.github/workflows/deploy-docs.yml` | Deploy Documentation | docs | run by hand (workflow_dispatch) | `github-pages` | GitHub Pages |",
		"| `.github/workflows/publish-stable.yml` | Publish stable package | publish | push of tags `v[0-9]+.[0-9]+.[0-9]+`; run by hand (workflow_dispatch), inputs `tag` | `npm-production` | npm |",
		"Local CI (`molten ci`)",
		"| Build | dist | `npm run build` |",
		"- `npm-production` (`publish-stable.yml`): GitHub applies the environment's protection rules",
		"- npm, published by `publish-stable.yml`.",
		"## Sync-back\n\nMerge master back into develop with a merge commit merges `master` back into `develop`",
		"| `package-lock.json` | json | `version`, `packages..version` |",
		"| `README.md` | text | `\\*\\*v{version}\\*\\*` |",
		"Changelogs, written by hand before the cut and committed with the version: `docs/changelog.md`, `docs/fr/changelog.md`.",
		"First public version: `1.0.0`.",
		techDocHistoryStart + "\n" + techDocHistoryHead + "\n" + techDocHistoryRule + "\n",
		"| 2026-10-25 | Pipeline set up | Setup test | [`feature/7-release-pipeline`](https://github.com/DiamondForgeFr/SaasFoundryAI/pulls?q=is%3Apr+head%3Afeature%2F7-release-pipeline) | 2 |",
	} {
		if !strings.Contains(doc, want) {
			t.Fatalf("the document lacks %q:\n%s", want, doc)
		}
	}
}

// An update keeps the earlier history, newest first, and never repeats a row when the preview is built again.
func TestTechDocUpdateCarriesTheHistory(t *testing.T) {
	in := saasFoundryDocInput(t)
	first := BuildTechDoc(in)
	in.Previous = first
	in.Change = TechDocChange{Date: "2026-11-02", Kind: TechDocChangeUpdate, Author: "Other dev", PrUrl: "https://github.com/DiamondForgeFr/SaasFoundryAI/pull/50", Template: 3}
	in.Pipeline.Release.Public = in.Pipeline.Release.Public[:len(in.Pipeline.Release.Public)-1]
	second := BuildTechDoc(in)
	newRow := "| 2026-11-02 | Pipeline updated | Other dev | [https://github.com/DiamondForgeFr/SaasFoundryAI/pull/50](https://github.com/DiamondForgeFr/SaasFoundryAI/pull/50) | 3 |"
	oldRow := "| 2026-10-25 | Pipeline set up | Setup test |"
	if i, j := strings.Index(second, newRow), strings.Index(second, oldRow); i < 0 || j < 0 || i > j {
		t.Fatalf("history:\n%s", second[strings.Index(second, techDocHistoryStart):])
	}
	if strings.Contains(second, "Merge master back into develop") {
		t.Fatal("the removed step is still documented")
	}
	in.Previous = second
	if again := BuildTechDoc(in); strings.Count(again, newRow) != 1 || strings.Count(again, oldRow) != 1 {
		t.Fatalf("rows repeated:\n%s", again)
	}
}

func TestTechDocEscapesTheModelsText(t *testing.T) {
	in := saasFoundryDocInput(t)
	in.Pipeline.Release.Rc = []molten.PipelineStep{{Id: "odd", Title: "A \"quoted\" | piped\ntitle", Phase: "cut", PipelineCommand: molten.PipelineCommand{Run: "echo `x`"}}}
	doc := BuildTechDoc(in)
	for _, want := range []string{"| A \"quoted\" \\| piped<br>title |", "`` echo `x` ``", "[\"A #quot;quoted#quot; | piped title\"]"} {
		if !strings.Contains(doc, want) {
			t.Fatalf("the document lacks %q:\n%s", want, doc)
		}
	}
	empty := BuildTechDoc(TechDocInput{Pipeline: &molten.Pipeline{Name: "bare"}, Change: TechDocChange{Kind: TechDocChangeSetup}})
	if !strings.Contains(empty, "No release flow is set up.") || strings.Contains(empty, "```mermaid") {
		t.Fatalf("a pipeline without release:\n%s", empty)
	}
}

const sfSrsHelpToday = `Usage: sf srs <action> [args...]

Actions:
  help                                   Print this message
  next-ids --feature <page-url-or-id> [--json] [--manifest]
`

// fakeSf answers sf srs help and sf srs techdoc as the CLI asked on SaasFoundryAI#1112 would; it records the files
// handed to write.
type fakeSf struct {
	lock    sync.Mutex
	help    string
	read    string
	write   string
	failure error
	written []string
}

func (f *fakeSf) runner(next Runner) Runner {
	return func(ctx context.Context, dir string, name string, args ...string) ([]byte, error) {
		if name != "sf" {
			if next == nil {
				return nil, errors.New(name + ": command not found")
			}
			return next(ctx, dir, name, args...)
		}
		f.lock.Lock()
		defer f.lock.Unlock()
		joined := strings.Join(args, " ")
		switch {
		case joined == "srs help":
			return []byte(f.help), nil
		case strings.HasPrefix(joined, "srs techdoc read --topic release-pipeline --json"):
			return []byte(f.read), nil
		case strings.HasPrefix(joined, "srs techdoc write --topic release-pipeline --title Release pipeline --file "):
			if f.failure != nil {
				return nil, f.failure
			}
			data, err := os.ReadFile(args[8])
			if err != nil {
				return nil, err
			}
			f.written = append(f.written, string(data))
			return []byte(f.write), nil
		}
		return nil, errors.New("fake sf: unexpected " + joined)
	}
}

func TestSaaSFoundryDocBackendAdapter(t *testing.T) {
	ctx := context.Background()
	dir := saasFoundryFixture(t)
	sf := &fakeSf{help: sfSrsHelpToday}
	backend := SaaSFoundryDocBackend{Run: sf.runner(nil)}
	if backend.Available(ctx, dir) {
		t.Fatal("today's CLI has no techdoc action")
	}
	if (SaaSFoundryDocBackend{Run: sf.runner(nil)}).Available(ctx, t.TempDir()) {
		t.Fatal("a project without a manifest has no backend")
	}
	sf.help = sfSrsHelpToday + "  techdoc read|write --topic <id> [--json]   Technical documentation pages\n"
	if backend.Available(ctx, dir) {
		t.Fatal("the fixture's manifest declares no SRS or documentation tool")
	}
	writeFiles(t, dir, map[string]string{".saasfoundry.json": `{"tools": {"srs": {"enabled": true, "backend": "notion"}, "docs": {"name": "notion"}}}`})
	if !backend.Available(ctx, dir) {
		t.Fatal("a declared backend with the techdoc action")
	}
	sf.read = `{"schema": 1, "url": "https://app.notion.com/p/abc", "markdown": "# Old\n"}`
	page, err := backend.Read(ctx, dir, TechDocTopicRelease)
	if err != nil || page.Url != "https://app.notion.com/p/abc" || page.Markdown != "# Old\n" {
		t.Fatalf("read: %+v %v", page, err)
	}
	for _, bad := range []string{`{"schema": 2}`, `{"schema": 1, "url": "file:///etc/passwd"}`, `not json`} {
		sf.read = bad
		if _, err := backend.Read(ctx, dir, TechDocTopicRelease); err == nil {
			t.Fatalf("accepted %s", bad)
		}
	}
	sf.write = `{"schema": 1, "url": "https://app.notion.com/p/new"}`
	page, err = backend.Write(ctx, dir, TechDocTopicRelease, TechDocTitle, "# New\n")
	if err != nil || page.Url != "https://app.notion.com/p/new" || len(sf.written) != 1 || sf.written[0] != "# New\n" {
		t.Fatalf("write: %+v %v %v", page, err, sf.written)
	}
}

// Without a backend the document is the repository file of the pull request, previewed against the committed one.
func TestTechDocGoesInThePullRequestWithoutABackend(t *testing.T) {
	dir := protectedRepository(t)
	forge := &fakeForge{}
	s := prSetup(t, forge, protectedRules(t))
	ctx := context.Background()
	draft, err := s.Draft(ctx, DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	before := workingCopy(t, dir)
	plan, err := s.TechDoc(ctx, TechDocRequest{Dir: dir, Text: draft.Proposed})
	if err != nil {
		t.Fatal(err)
	}
	if plan.Backend != TechDocBackendRepository || plan.Path != TechDocPath || plan.Current != "" || len(plan.Warnings) != 0 ||
		!strings.Contains(plan.Proposed, "## Public release flow") || !strings.Contains(plan.Proposed, "`feature/{N}-release-pipeline`") {
		t.Fatalf("plan: %+v", plan)
	}
	job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, PrRequest: PrRequest{Ticket: 7}}))
	if job.Failure != nil {
		t.Fatalf("failure: %+v", job.Failure)
	}
	for _, step := range job.Steps {
		if step.Id == PrStepDoc {
			t.Fatalf("a backend step without a backend: %+v", job.Steps)
		}
	}
	if got := workingCopy(t, dir); got != before {
		t.Fatal("the checkout changed")
	}
	gitIn(t, dir, "fetch", "--quiet", "origin")
	pushed := gitOut(t, dir, "show", "origin/"+job.Branch+":"+TechDocPath)
	if !strings.Contains(pushed, "`feature/7-release-pipeline`") || !strings.Contains(pushed, "| Pipeline set up | Setup test |") {
		t.Fatalf("pushed:\n%s", pushed)
	}
	if !strings.Contains(strings.Join(job.Files, " "), TechDocPath) {
		t.Fatalf("the job's files: %v", job.Files)
	}

	// Merged: the menu links to the file, and the update's preview starts from it.
	mergePr(t, dir, job.Branch)
	check, err := s.Check(ctx, CheckRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	if check.Doc == nil || check.Doc.Backend != TechDocBackendRepository || check.Doc.Path != filepath.Join(dir, TechDocPath) {
		t.Fatalf("link: %+v", check.Doc)
	}
	again, err := s.TechDoc(ctx, TechDocRequest{Dir: dir, Text: check.Proposed, Kind: PrKindUpdate})
	if err != nil {
		t.Fatal(err)
	}
	if again.Current != pushed || !strings.Contains(again.Proposed, "| Pipeline updated |") || !strings.Contains(again.Proposed, "| Pipeline set up |") {
		t.Fatalf("update preview: %+v", again)
	}
}

type fakeDocBackend struct {
	lock     sync.Mutex
	failRead bool
	failure  error
	written  []string
}

func (*fakeDocBackend) Name() string                                   { return "fake" }
func (*fakeDocBackend) Available(ctx context.Context, dir string) bool { return true }

func (b *fakeDocBackend) Read(ctx context.Context, dir string, topic string) (TechDocPage, error) {
	if b.failRead {
		return TechDocPage{}, errors.New("unreachable")
	}
	return TechDocPage{Url: "https://docs.example/release", Markdown: ""}, nil
}

func (b *fakeDocBackend) Write(ctx context.Context, dir string, topic string, title string, markdown string) (TechDocPage, error) {
	b.lock.Lock()
	defer b.lock.Unlock()
	if b.failure != nil {
		return TechDocPage{}, b.failure
	}
	b.written = append(b.written, markdown)
	return TechDocPage{Url: "https://docs.example/release"}, nil
}

// With a backend the document goes there once the pull request is open, with its address; a failed write is the
// step's, never the pull request's.
func TestTechDocGoesToTheBackendAfterThePullRequest(t *testing.T) {
	dir := protectedRepository(t)
	forge := &fakeForge{}
	s := prSetup(t, forge, protectedRules(t))
	backend := &fakeDocBackend{}
	s.DocBackends = []TechDocBackend{backend}
	ctx := context.Background()
	draft, err := s.Draft(ctx, DraftRequest{Dir: dir})
	if err != nil {
		t.Fatal(err)
	}
	plan, err := s.TechDoc(ctx, TechDocRequest{Dir: dir, Text: draft.Proposed})
	if err != nil || plan.Backend != "fake" || plan.Url != "https://docs.example/release" || plan.Path != "" {
		t.Fatalf("plan: %+v %v", plan, err)
	}
	job := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, PrRequest: PrRequest{Ticket: 7}}))
	if job.Failure != nil || job.DocUrl != "https://docs.example/release" {
		t.Fatalf("job: %+v", job)
	}
	if last := job.Steps[len(job.Steps)-1]; last.Id != PrStepDoc || last.State != PrStateDone {
		t.Fatalf("steps: %+v", job.Steps)
	}
	if len(backend.written) != 1 || !strings.Contains(backend.written[0], "https://github.com/DiamondForgeFr/SaasFoundryAI/pull/42") {
		t.Fatalf("written: %v", backend.written)
	}
	gitIn(t, dir, "fetch", "--quiet", "origin")
	if files := gitOut(t, dir, "diff", "--name-only", "origin/develop", "origin/"+job.Branch); strings.Contains(files, TechDocPath) {
		t.Fatalf("the repository file is added beside a backend: %q", files)
	}

	backend.failure = errors.New("the page is locked")
	gitIn(t, dir, "push", "--quiet", "origin", ":refs/heads/"+job.Branch)
	failed := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, PrRequest: PrRequest{Ticket: 7}}))
	if last := failed.Steps[len(failed.Steps)-1]; failed.Failure != nil || failed.PrNumber != 42 || last.State != PrStateFailed || !strings.Contains(last.Info, "locked") {
		t.Fatalf("a failed backend write: %+v", failed)
	}

	// A backend that does not answer at the job: the file keeps the document.
	backend.failRead, backend.failure = true, nil
	gitIn(t, dir, "push", "--quiet", "origin", ":refs/heads/"+job.Branch)
	fallback := waitFor(t, s)(s.Write(WriteRequest{Dir: dir, Text: draft.Proposed, Base: draft.Base, Generated: draft.Generated, PrRequest: PrRequest{Ticket: 7}}))
	if last := fallback.Steps[len(fallback.Steps)-1]; fallback.Failure != nil || last.State != PrStateSkipped || !strings.Contains(strings.Join(fallback.Files, " "), TechDocPath) {
		t.Fatalf("fallback: %+v", fallback)
	}
}
