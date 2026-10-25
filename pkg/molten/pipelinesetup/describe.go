// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// Step 2b of the pipeline setup stepper (FR-MC-041): the developer describes the pipeline they want (the trunk, the
// published branch, where it is published, whether release candidates are published, kept internal or not made), or
// takes another linked project's committed pipeline as a model. A target no workflow publishes on the tag yet gets the
// missing workflow, proposed as a file of the same pull request (decision on #1093). Nothing here writes.

const (
	RcNone      = "none"
	RcPublished = "published"
	RcInternal  = "internal"

	FromStandard = "standard"
	FromModel    = "model"
	FromWords    = "words"
	// A template saved at step 4 of another setup (FR-MC-042).
	FromTemplate = "template"

	PublishWorkflowFile = "molten-publish.yml"

	maxProposedFileBytes = 64 << 10
	maxBranchNames       = 200
	maxModels            = 20
)

// The targets MoltenTerm can write a publish workflow for.
var DescribeTargets = []string{TargetNpm, TargetGithubRelease}

// A file the setup proposes beside .molten/project.json, shown whole at step 3 and added by the same pull request.
type ProposedFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
	// What it publishes (target ids).
	Targets []string `json:"targets"`
}

type ModelsRequest struct {
	Dir string `json:"dir"`
}

// A linked project whose committed pipeline can serve as a model, with its choices adapted to the project set up.
type ModelProject struct {
	Dir  string `json:"dir"`
	Name string `json:"name"`
	// Where its pipeline was read ("origin/develop").
	Ref     string  `json:"ref"`
	Options Options `json:"options"`
}

type ModelsAnswer struct {
	Models []ModelProject `json:"models"`
}

var branchNameRegex = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._/-]*$`)
var safeNotesRegex = regexp.MustCompile(`^[A-Za-z0-9._/{}-]+$`)
var proposedFileRegex = regexp.MustCompile(`^\.github/workflows/[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$`)

func validBranchName(name string) bool {
	return len(name) <= 200 && branchNameRegex.MatchString(name) && !strings.Contains(name, "..") && !strings.HasSuffix(name, "/") && !strings.HasSuffix(name, ".lock")
}

// Described: the options come from step 2b.
func (o Options) Described() bool {
	return o.Rc != ""
}

func validRc(rc string) bool {
	return rc == RcNone || rc == RcPublished || rc == RcInternal
}

// applyDescription turns step 2b's answers into the template's choices and facts: the branches, the channels, and the
// publish workflow proposed for the targets no workflow publishes yet (added to the facts, so the steps and the
// diagram count it). It returns the proposed files and whether the branches differ from the project's.
func applyDescription(dir string, f *Facts, o *Options) ([]ProposedFile, bool) {
	if !o.Described() {
		return nil, false
	}
	if !validRc(o.Rc) {
		o.Rc = RcInternal
	}
	resolved := f.Branches
	if validBranchName(o.Trunk) {
		f.Branches.Trunk = o.Trunk
	}
	if validBranchName(o.Release) {
		f.Branches.Release = o.Release
	}
	if f.Branches.Trunk == f.Branches.Release {
		o.BranchModel = BranchModelSingle
		o.SyncBack = false
	} else if o.BranchModel == BranchModelSingle {
		o.BranchModel = BranchModelPromote
	}
	o.Kind = KindOnPremise
	o.Channels = []string{ChannelRc, ChannelPublic}
	if o.Rc == RcNone {
		o.Channels = []string{ChannelPublic}
	}
	changed := f.Branches.Trunk != resolved.Trunk || f.Branches.Release != resolved.Release
	targets := missingTargets(*f, *o)
	if len(targets) == 0 {
		return nil, changed
	}
	rel := WorkflowsDir + "/" + PublishWorkflowFile
	if _, err := os.Lstat(filepath.Join(dir, filepath.FromSlash(rel))); err == nil {
		return nil, changed
	}
	if _, known := workflowByFile(*f, PublishWorkflowFile); known {
		return nil, changed
	}
	text := publishWorkflowText(dir, targets, *o)
	wf, ok := ParseWorkflow(PublishWorkflowFile, []byte(text))
	if !ok {
		return nil, changed
	}
	f.Workflows = append(f.Workflows, wf)
	return []ProposedFile{{Path: rel, Content: text, Targets: targets}}, changed
}

// publishedBy: the workflow that already publishes the target on a public tag, "" when none does.
func publishedBy(f Facts, target string, prefix string) string {
	_, public := sampleTags(prefix)
	for _, wf := range f.Workflows {
		if !wf.RunsOnTag(public) {
			continue
		}
		for _, ship := range wf.Ships {
			if ship == target {
				return wf.File
			}
		}
	}
	return ""
}

// missingTargets: the chosen targets MoltenTerm can publish and no workflow does on the tag yet.
func missingTargets(f Facts, o Options) []string {
	prefix := o.TagPrefix
	if prefix == "" {
		prefix = versions.DefaultTagPrefix
	}
	var rtn []string
	for _, target := range DescribeTargets {
		if hasChannel(o.Publish, target) && publishedBy(f, target, prefix) == "" {
			rtn = append(rtn, target)
		}
	}
	return rtn
}

// publishWorkflowText is the workflow MoltenTerm proposes: it runs on the version tags the release chain pushes (every
// one when candidates are published, the public ones only otherwise); a candidate goes to npm's next dist-tag and is
// a GitHub pre-release.
func publishWorkflowText(dir string, targets []string, o Options) string {
	prefix := o.TagPrefix
	if !regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._/-]*$`).MatchString(prefix) {
		prefix = versions.DefaultTagPrefix
	}
	rcPublished := o.Rc == RcPublished
	var b strings.Builder
	b.WriteString("# Proposed by MoltenTerm's pipeline setup: publishes each version the release chain tags.\n")
	b.WriteString("name: Publish\n\non:\n  push:\n    tags:\n")
	fmt.Fprintf(&b, "      - \"%s*\"\n", prefix)
	if !rcPublished {
		fmt.Fprintf(&b, "      - \"!%s*-*\"\n", prefix)
	}
	b.WriteString("\npermissions:\n  contents: read\n\njobs:\n")
	if hasChannel(targets, TargetNpm) {
		install := "npm install --no-audit --no-fund"
		if fileExists(filepath.Join(dir, "package-lock.json")) || fileExists(filepath.Join(dir, "npm-shrinkwrap.json")) {
			install = "npm ci"
		}
		b.WriteString("  npm:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: read\n      id-token: write\n    steps:\n")
		b.WriteString("      - uses: actions/checkout@v4\n")
		b.WriteString("      - uses: actions/setup-node@v4\n        with:\n          node-version: 22\n          registry-url: https://registry.npmjs.org\n")
		fmt.Fprintf(&b, "      - run: %s\n", install)
		b.WriteString("      - name: Publish to npm\n")
		if rcPublished {
			b.WriteString("        run: |\n          if [[ \"$GITHUB_REF_NAME\" == *-* ]]; then\n            npm publish --provenance --tag next\n          else\n            npm publish --provenance\n          fi\n")
		} else {
			b.WriteString("        run: npm publish --provenance\n")
		}
		b.WriteString("        env:\n          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}\n")
	}
	if hasChannel(targets, TargetGithubRelease) {
		notes := o.NotesPath
		if notes == "" || !safeNotesRegex.MatchString(notes) || strings.Contains(notes, "..") {
			notes = DefaultNotesPath
		}
		notes = strings.ReplaceAll(notes, "{tag}", "${GITHUB_REF_NAME}")
		if hasChannel(targets, TargetNpm) {
			b.WriteString("\n")
		}
		b.WriteString("  github-release:\n    runs-on: ubuntu-latest\n    permissions:\n      contents: write\n    steps:\n")
		b.WriteString("      - uses: actions/checkout@v4\n")
		b.WriteString("      - name: GitHub Release with the version's notes\n        run: |\n")
		fmt.Fprintf(&b, "          notes=\"%s\"\n", notes)
		b.WriteString("          flags=()\n")
		if rcPublished {
			b.WriteString("          if [[ \"$GITHUB_REF_NAME\" == *-* ]]; then flags+=(--prerelease); fi\n")
		}
		b.WriteString("          if [ -f \"$notes\" ]; then flags+=(--notes-file \"$notes\"); else flags+=(--generate-notes); fi\n")
		b.WriteString("          gh release create \"$GITHUB_REF_NAME\" --verify-tag --title \"$GITHUB_REF_NAME\" \"${flags[@]}\"\n")
		b.WriteString("        env:\n          GH_TOKEN: ${{ github.token }}\n")
	}
	return b.String()
}

// checkProposedFiles: only new workflow files MoltenTerm could have proposed are written beside the pipeline.
func checkProposedFiles(files []ProposedFile) error {
	seen := map[string]bool{}
	for _, file := range files {
		if !proposedFileRegex.MatchString(file.Path) {
			return fail(PrFailureInvalid, fmt.Sprintf("%s is not a workflow file the setup proposes", file.Path))
		}
		if seen[file.Path] {
			return fail(PrFailureInvalid, fmt.Sprintf("%s is proposed twice", file.Path))
		}
		seen[file.Path] = true
		if len(file.Content) > maxProposedFileBytes {
			return fail(PrFailureInvalid, fmt.Sprintf("the proposed %s is too large", file.Path))
		}
		if _, ok := ParseWorkflow(filepath.Base(file.Path), []byte(file.Content)); !ok {
			return fail(PrFailureInvalid, fmt.Sprintf("the proposed %s is not a workflow", file.Path))
		}
	}
	return nil
}

// checkNewFiles refuses a proposed file the base commit already has: the setup adds workflows, it never replaces one.
func (s *Setup) checkNewFiles(ctx context.Context, dir string, commit string, files []ProposedFile) error {
	if commit == "" {
		return nil
	}
	for _, file := range files {
		data, err := s.committedFile(ctx, dir, commit, file.Path)
		if err != nil || data != nil {
			return fail(PrFailureInvalid, fmt.Sprintf("%s already exists: the setup does not replace a workflow", file.Path))
		}
	}
	return nil
}

// branchNames lists the repository's branches, local and origin's, for step 2b's questions.
func (s *Setup) branchNames(ctx context.Context, dir string, f Facts) []string {
	set := map[string]bool{f.Branches.Trunk: true, f.Branches.Release: true}
	if out, err := s.git(ctx, dir, "for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"); err == nil {
		for _, line := range strings.Split(string(out), "\n") {
			name := strings.TrimSpace(line)
			if rest, ok := strings.CutPrefix(name, "refs/heads/"); ok {
				name = rest
			} else if rest, ok := strings.CutPrefix(name, "refs/remotes/origin/"); ok {
				name = rest
			} else {
				continue
			}
			if name == "HEAD" || !validBranchName(name) || len(set) >= maxBranchNames {
				continue
			}
			set[name] = true
		}
	}
	rtn := []string{}
	for name := range set {
		if name != "" {
			rtn = append(rtn, name)
		}
	}
	sort.Strings(rtn)
	return rtn
}

// Models lists the other linked projects whose committed pipeline has release steps, each with its choices adapted to
// the project at Dir; both are only read.
func (s *Setup) Models(ctx context.Context, req ModelsRequest) (ModelsAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return ModelsAnswer{}, err
	}
	answer := ModelsAnswer{Models: []ModelProject{}}
	if s.ProjectDirs == nil {
		return answer, nil
	}
	dirs, err := s.ProjectDirs(ctx)
	if err != nil {
		return ModelsAnswer{}, err
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return ModelsAnswer{}, err
	}
	here := DetectWith(dir, pipelineReport(dir, b.Pipeline))
	seen := map[string]bool{dir: true}
	for _, other := range dirs {
		if other == "" || !filepath.IsAbs(other) {
			continue
		}
		other = filepath.Clean(other)
		if seen[other] {
			continue
		}
		seen[other] = true
		if m, ok := s.modelOf(ctx, other, here); ok {
			answer.Models = append(answer.Models, m)
		}
		if len(answer.Models) >= maxModels {
			break
		}
	}
	return answer, nil
}

// modelOf reads a project's committed pipeline (never its working copy's) and adapts its choices.
func (s *Setup) modelOf(ctx context.Context, dir string, here Facts) (ModelProject, bool) {
	if _, err := checkProjectDir(dir); err != nil {
		return ModelProject{}, false
	}
	b, err := s.readBase(ctx, dir)
	if err != nil || b.Commit == "" || b.Pipeline == nil {
		return ModelProject{}, false
	}
	report := pipelineReport(dir, b.Pipeline)
	p := report.Pipeline
	if !report.Valid || p == nil || p.Release == nil || (len(p.Release.Rc) == 0 && len(p.Release.Public) == 0) {
		return ModelProject{}, false
	}
	f := DetectWith(dir, report)
	name := p.Name
	if name == "" {
		name = filepath.Base(dir)
	}
	return ModelProject{Dir: dir, Name: name, Ref: b.Ref, Options: AdaptModel(here, f, p)}, true
}

// AdaptModel takes a model project's choices for the project described: its flow (branch model, merge, tag prefix,
// candidates, where it publishes, notes, sync-back, milestone) and its own manual steps; the files stay the project's.
func AdaptModel(here Facts, model Facts, p *molten.Pipeline) Options {
	mo := InferOptions(model, p)
	o := DefaultOptions(here)
	o.Kind = KindOnPremise
	o.Merge = mo.Merge
	o.TagPrefix = model.TagPrefix
	o.Notes = mo.Notes
	o.Milestone = mo.Milestone && here.OnGithub
	o.Trunk = here.Branches.Trunk
	o.Release = here.Branches.Release
	modelSingle := model.Branches.Trunk == model.Branches.Release
	if modelSingle {
		o.Release = o.Trunk
	} else if o.Release == o.Trunk {
		o.Release = model.Branches.Release
	}
	o.BranchModel = mo.BranchModel
	if modelSingle {
		o.BranchModel = BranchModelSingle
	}
	o.SyncBack = mo.SyncBack && !modelSingle
	o.Reconcile = false
	switch {
	case len(p.Release.Rc) == 0:
		o.Rc = RcNone
	case rcPublished(model, mo):
		o.Rc = RcPublished
	default:
		o.Rc = RcInternal
	}
	o.Publish = []string{}
	for _, target := range DescribeTargets {
		if publishedBy(model, target, model.TagPrefix) == "" {
			continue
		}
		if target == TargetNpm && !hasTarget(here, TargetNpm) {
			continue
		}
		if target == TargetGithubRelease && !here.OnGithub {
			continue
		}
		o.Publish = append(o.Publish, target)
	}
	o.Manual = modelManualSteps(p.Release)
	return o
}

func hasTarget(f Facts, id string) bool {
	for _, t := range f.Targets {
		if t.Id == id {
			return true
		}
	}
	return false
}

// modelManualSteps: the model's hand steps the template does not write itself (its changelogs and labels are its own
// files), on the channels that have them.
func modelManualSteps(r *molten.PipelineRelease) []ManualStep {
	rtn := []ManualStep{}
	index := map[string]int{}
	for _, c := range []struct {
		channel string
		steps   []molten.PipelineStep
	}{{ChannelRc, r.Rc}, {ChannelPublic, r.Public}} {
		for _, s := range c.steps {
			if s.Manual == "" || strings.HasPrefix(s.Id, "changelog-") || s.Id == "bump-labels" {
				continue
			}
			if i, ok := index[s.Id]; ok {
				rtn[i].Channel = ""
				continue
			}
			index[s.Id] = len(rtn)
			title := s.Title
			if title == "" {
				title = s.Id
			}
			rtn = append(rtn, ManualStep{Id: s.Id, Title: title, Text: s.Manual, Channel: c.channel})
		}
	}
	return rtn
}
