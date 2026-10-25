// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/release"
	"github.com/wavetermdev/waveterm/pkg/molten/versions"
)

// The templates per kind (DS-MC-031): an on-premise release is MoltenTerm's release chain (`molten release`), which
// reads everything from the project; a SaaS one deploys to its environments through their workflows. The titles,
// instructions and confirmations written in the file are the pipeline's own text, in English like every pipeline.

// A step the developer does by hand, added in the stepper (FR-MC-037).
type ManualStep struct {
	Id    string `json:"id"`
	Title string `json:"title"`
	Text  string `json:"text"`
	// rc, public, or empty for both.
	Channel string `json:"channel,omitempty"`
	// The id of the step it comes before; empty: before the cut.
	Before string `json:"before,omitempty"`
}

// A dispatch-only workflow run as a step of the public release (or both), e.g. the docs deploy at the tag.
type DispatchChoice struct {
	Workflow string `json:"workflow"`
	Channel  string `json:"channel,omitempty"`
}

type Options struct {
	Kind        string   `json:"kind"`
	Channels    []string `json:"channels"`
	BranchModel string   `json:"branchmodel"`
	Merge       string   `json:"merge"`
	TagPrefix   string   `json:"tagprefix"`
	RcFormat    string   `json:"rcformat"`
	// The changelog files a release updates by hand before the cut.
	Changelogs []string `json:"changelogs"`
	// The trunk's CI workflows that must be green before the promotion.
	CiWorkflows []string         `json:"ciworkflows"`
	Dispatch    []DispatchChoice `json:"dispatch"`
	Notes       bool             `json:"notes"`
	// Where the public notes of a version are written (versions.notes, with {tag}); the draft of `molten release prepare`,
	// reviewed in the release panel before the cut (FR-REL-003).
	NotesPath string `json:"notespath"`
	SyncBack  bool   `json:"syncback"`
	// Close the milestone of a published public release.
	Milestone bool         `json:"milestone"`
	Manual    []ManualStep `json:"manual"`
	// SaaS: the environments deployed to, by name.
	Environments []string `json:"environments"`
	// The pull-request flow's one-time merge -s ours of the release branch into the RC branch (#1046).
	Reconcile bool `json:"reconcile"`
	// The version labels kept (#1046): text entries of versions.files, or a manual step for those without a pattern.
	Labels []LabelChoice `json:"labels"`
	// Step 2b's description (FR-MC-041), empty on the other paths: the trunk and the published branch (the same one:
	// tags on the trunk), the release candidates (none, published, internal) and where the versions are published.
	Trunk   string   `json:"trunk,omitempty"`
	Release string   `json:"release,omitempty"`
	Rc      string   `json:"rc,omitempty"`
	Publish []string `json:"publish,omitempty"`
}

// The proposal: the blocks the setup writes, and the source of each drafted step ("rc/promote", "steps/deploy-prod").
type Proposal struct {
	Release  *molten.PipelineRelease      `json:"release,omitempty"`
	Versions *molten.PipelineVersions     `json:"versions,omitempty"`
	Branches *molten.PipelineBranches     `json:"branches,omitempty"`
	Steps    []molten.PipelineAdapterStep `json:"steps,omitempty"`
	Sources  map[string]Source            `json:"sources"`
}

func sampleTags(prefix string) (string, string) {
	return prefix + "1.2.3-1", prefix + "1.2.3"
}

// DefaultOptions are what a developer who agrees clicks through: everything the repository shows, both channels.
func DefaultOptions(f Facts) Options {
	o := Options{Kind: f.Kind, Channels: []string{}, BranchModel: BranchModelPromote, Merge: MergeCommit,
		TagPrefix: f.TagPrefix, RcFormat: RcFormatNumeric, Changelogs: []string{}, CiWorkflows: []string{},
		Dispatch: []DispatchChoice{}, Notes: f.NotesDeclared, NotesPath: f.NotesPath, SyncBack: true, Milestone: f.OnGithub,
		Manual: []ManualStep{}, Environments: []string{}, Labels: []LabelChoice{}}
	o.Channels = append(o.Channels, f.Missing...)
	if len(o.Channels) == 0 {
		o.Channels = []string{ChannelRc, ChannelPublic}
	}
	if f.Branches.Trunk == f.Branches.Release {
		o.BranchModel = BranchModelSingle
		o.SyncBack = false
	} else if f.Protection.RequiresPr() {
		o.BranchModel = BranchModelRcPr
		// The step does nothing while the release branch is in the RC branch's history, so it stays for good; it is left
		// out only where it would refuse (a release-branch commit with no equivalent on the trunk).
		o.Reconcile = f.Divergence == nil || f.Divergence.NotEquivalent == 0
	}
	// Kept by default: a label of the current version, or one in a top-level file (an agents file lagging behind); an
	// other version deep in the docs is more likely an example than a label.
	for _, l := range f.Labels {
		if l.Version == f.CurrentVersion || !strings.Contains(l.Path, "/") {
			o.Labels = append(o.Labels, LabelChoice{Path: l.Path, Line: l.Line, Pattern: l.Pattern})
		}
	}
	for _, c := range f.Changelogs {
		o.Changelogs = append(o.Changelogs, c.Path)
	}
	for _, wf := range f.Workflows {
		if wf.Role == RoleCi && wf.RunsOnBranch(f.Branches.Trunk) {
			o.CiWorkflows = append(o.CiWorkflows, wf.File)
		}
		if wf.Role == RoleDocs && wf.Dispatch && !wf.Push && len(wf.RequiredInputs) == 0 {
			o.Dispatch = append(o.Dispatch, DispatchChoice{Workflow: wf.File, Channel: ChannelPublic})
		}
	}
	for _, d := range f.DeployTargets() {
		if d.Dispatch {
			o.Environments = appendOnce(o.Environments, d.Environment)
		}
	}
	return o
}

func hasChannel(channels []string, channel string) bool {
	for _, c := range channels {
		if c == channel {
			return true
		}
	}
	return false
}

func shellArg(s string) string {
	if regexp.MustCompile(`^[A-Za-z0-9._/{}-]+$`).MatchString(s) {
		return s
	}
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func workflowByFile(f Facts, file string) (Workflow, bool) {
	for _, wf := range f.Workflows {
		if wf.File == file {
			return wf, true
		}
	}
	return Workflow{}, false
}

var nonIdRegex = regexp.MustCompile(`[^a-z0-9._-]+`)
var dashesRegex = regexp.MustCompile(`-{2,}`)

// StepId makes a pipeline id of any name.
func StepId(name string) string {
	id := strings.Trim(dashesRegex.ReplaceAllString(nonIdRegex.ReplaceAllString(strings.ToLower(name), "-"), "-"), "-._")
	if id == "" {
		return "step"
	}
	return id
}

// tagWorkflows: the workflows the channel's tag starts, and the environments that will ask for an approval.
func tagWorkflows(f Facts, channel string, prefix string) ([]string, []string) {
	rc, public := sampleTags(prefix)
	tag := public
	if channel == ChannelRc {
		tag = rc
	}
	var files, envs []string
	for _, wf := range f.Workflows {
		if wf.Role == RoleCi || !wf.RunsOnTag(tag) {
			continue
		}
		files = append(files, wf.File)
		for _, env := range wf.Environments {
			envs = appendOnce(envs, env)
		}
	}
	return files, envs
}

func finalizeConfirm(f Facts, channel string, prefix string) string {
	files, envs := tagWorkflows(f, channel, prefix)
	var b strings.Builder
	b.WriteString("{tag} is public once pushed")
	if len(files) > 0 {
		fmt.Fprintf(&b, ": %s%s on the tag", strings.Join(files, ", "), startVerb(files))
		if len(envs) > 0 {
			fmt.Fprintf(&b, ", and the environment %s asks for an approval on GitHub", strings.Join(envs, ", "))
		}
	}
	b.WriteString(".")
	return b.String()
}

// where says where a manual step of the cut is done: the release worktree, on the release branch or on the RC branch.
func where(f Facts, o Options) string {
	if o.BranchModel == BranchModelRcPr {
		return fmt.Sprintf("In the release worktree (%s, prepared on the RC branch %s made from %s)", f.ReleaseWorktree, rcBranchDisplay(f), f.Branches.Trunk)
	}
	return fmt.Sprintf("In the release worktree (%s, prepared on %s)", f.ReleaseWorktree, f.Branches.Release)
}

// rcBranchDisplay names the RC branch in the pipeline's text: the release panel puts the release's own version in
// {version}, a candidate's (1.2.0-1) and not the branch's (1.2.0).
func rcBranchDisplay(f Facts) string {
	pattern := f.RcBranchPattern
	if !strings.Contains(pattern, "{version}") {
		pattern = release.DefaultRcBranchPattern
	}
	return strings.ReplaceAll(pattern, "{version}", "X.Y.Z")
}

func changelogStep(path string, id string, at string) molten.PipelineStep {
	return molten.PipelineStep{
		Id:     id,
		Title:  "Write the {version} section of " + path,
		Phase:  "cut",
		Manual: fmt.Sprintf("%s, write the {version} section of %s. The cut commits it with the version.", at, path),
	}
}

// labelsStep: the labels no pattern could match once, bumped by hand before the cut.
func labelsStep(f Facts, o Options) (molten.PipelineStep, bool) {
	var lines []string
	for _, c := range o.Labels {
		if c.Pattern != "" {
			continue
		}
		text := ""
		for _, l := range f.Labels {
			if l.Path == c.Path && l.Line == c.Line {
				text = l.Text
			}
		}
		lines = append(lines, fmt.Sprintf("%s:%d (%s)", c.Path, c.Line, text))
	}
	if len(lines) == 0 {
		return molten.PipelineStep{}, false
	}
	return molten.PipelineStep{Id: "bump-labels", Title: "Bump the version labels to {version}", Phase: "cut",
		Manual: fmt.Sprintf("%s, write {version} in: %s. The cut commits them with the version.", where(f, o), strings.Join(lines, "; "))}, true
}

// insertManual puts the developer's steps in place: before the step they name (else before the cut), in that
// step's phase; a manual step cannot run in the prepare phase, so the prepare steps from it on move to the cut.
func insertManual(steps []molten.PipelineStep, sources map[string]Source, key string, manual []ManualStep, channel string) []molten.PipelineStep {
	for _, m := range manual {
		if m.Channel != "" && m.Channel != channel {
			continue
		}
		at := -1
		for i, s := range steps {
			if s.Id == m.Before {
				at = i
				break
			}
		}
		if at < 0 {
			for i, s := range steps {
				if s.Id == "finalize" || s.Id == "open-pr" {
					at = i
					break
				}
			}
		}
		if at < 0 {
			at = len(steps)
		}
		phase := "cut"
		if at < len(steps) && steps[at].Phase != "" && steps[at].Phase != molten.PipelineReleasePhasePrepare {
			phase = steps[at].Phase
		}
		step := molten.PipelineStep{Id: StepId(m.Id), Title: m.Title, Phase: phase, Manual: m.Text}
		steps = append(steps[:at], append([]molten.PipelineStep{step}, steps[at:]...)...)
		for i := at + 1; i < len(steps); i++ {
			if steps[i].Phase == molten.PipelineReleasePhasePrepare {
				steps[i].Phase = "cut"
			}
		}
		sources[key+"/"+step.Id] = Source{Code: "manualAdded"}
	}
	return steps
}

func onPremiseSteps(f Facts, o Options, channel string, sources map[string]Source) []molten.PipelineStep {
	key := channel
	trunk, release := f.Branches.Trunk, f.Branches.Release
	single := o.BranchModel == BranchModelSingle || trunk == release
	pr := !single && o.BranchModel == BranchModelRcPr
	var steps []molten.PipelineStep
	branchSource := Source{Code: "branches", Path: f.Branches.TrunkFrom + " / " + f.Branches.ReleaseFrom, Detail: trunk + " → " + release}
	if pr {
		return insertManual(prSteps(f, o, channel, sources, branchSource), sources, key, o.Manual, channel)
	}
	if !single {
		run := "molten release promote"
		for _, wf := range o.CiWorkflows {
			run += " --workflow " + shellArg(wf)
		}
		steps = append(steps, molten.PipelineStep{Id: "promote", Title: fmt.Sprintf("Promote %s onto %s once its CI is green", trunk, release),
			Phase: "prepare", PipelineCommand: molten.PipelineCommand{Run: run}})
		src := branchSource
		if len(o.CiWorkflows) > 0 {
			src.Detail += " · " + strings.Join(o.CiWorkflows, ", ")
		}
		sources[key+"/promote"] = src
	}
	steps = append(steps, molten.PipelineStep{Id: "prepare", Title: "Bump the version and draft the notes beside the checkout",
		Phase: "prepare", PipelineCommand: molten.PipelineCommand{Run: "molten release prepare {tag}"}})
	sources[key+"/prepare"] = f.VersionSource
	steps = handSteps(f, o, steps, key, sources)
	files, envs := tagWorkflows(f, channel, o.TagPrefix)
	title := "Commit, tag and push"
	if len(files) > 0 {
		title += ": " + strings.Join(files, ", ") + startVerb(files) + " on the tag"
	}
	steps = append(steps, molten.PipelineStep{Id: "finalize", Title: title, Phase: "cut", Confirm: finalizeConfirm(f, channel, o.TagPrefix),
		PipelineCommand: molten.PipelineCommand{Run: "molten release finalize {tag}"}})
	finalizeSource := Source{Code: "finalizeNoWorkflow"}
	if len(files) > 0 {
		finalizeSource = Source{Code: "finalizeWorkflows", Path: strings.Join(files, ", "), Detail: strings.Join(envs, ", ")}
	}
	sources[key+"/finalize"] = finalizeSource
	steps = afterTag(f, o, channel, steps, sources, branchSource, single)
	return insertManual(steps, sources, key, o.Manual, channel)
}

// handSteps: the changelogs and the labels written by hand before the cut, and the notes' rewrite.
func handSteps(f Facts, o Options, steps []molten.PipelineStep, key string, sources map[string]Source) []molten.PipelineStep {
	at := where(f, o)
	for _, path := range o.Changelogs {
		lang := "en"
		for _, c := range f.Changelogs {
			if c.Path == path {
				lang = c.Lang
			}
		}
		id := "changelog-" + StepId(lang)
		for n := 2; stepIdTaken(steps, id); n++ {
			id = fmt.Sprintf("changelog-%s-%d", StepId(lang), n)
		}
		step := changelogStep(path, id, at)
		steps = append(steps, step)
		sources[key+"/"+step.Id] = Source{Code: "changelog", Path: path}
	}
	if step, ok := labelsStep(f, o); ok {
		steps = append(steps, step)
		sources[key+"/"+step.Id] = Source{Code: "labelsManual"}
	}
	if o.Notes {
		steps = append(steps, molten.PipelineStep{Id: "rewrite-notes", Title: "Rewrite the public notes with the coding agent",
			Notes: true, PipelineCommand: molten.PipelineCommand{Run: "molten release notes {tag}"}})
		sources[key+"/rewrite-notes"] = Source{Code: "notes", Path: molten.ProjectPipelineFile}
	}
	return steps
}

// prSteps: the release reaches a protected release branch by pull request (#1046): the RC branch from the trunk, the
// one-time reconciliation when chosen, the hand steps, the pull request opened, merged once its checks are green and
// the developer confirmed, the tag on its merge commit, then what follows any tag.
func prSteps(f Facts, o Options, channel string, sources map[string]Source, branchSource Source) []molten.PipelineStep {
	key := channel
	trunk, release := f.Branches.Trunk, f.Branches.Release
	rc := rcBranchDisplay(f)
	protectionSource := Source{Code: "protection", Path: release, Detail: protectionSummary(f.Protection)}
	var steps []molten.PipelineStep
	steps = append(steps, molten.PipelineStep{Id: "prepare", Title: fmt.Sprintf("Bump the version and draft the notes on %s, made from %s", rc, trunk),
		Phase: "prepare", PipelineCommand: molten.PipelineCommand{Run: "molten release prepare {tag} --pr"}})
	sources[key+"/prepare"] = f.VersionSource
	// A candidate nothing publishes (no workflow starts on its tag) stays on its RC branch: tagged there, merged into
	// neither the release branch nor the trunk.
	if channel == ChannelRc && !rcPublished(f, o) {
		steps = handSteps(f, o, steps, key, sources)
		steps = append(steps, molten.PipelineStep{Id: "tag", Title: fmt.Sprintf("Commit the candidate on %s and tag it there", rc), Phase: "cut",
			Confirm:         fmt.Sprintf("Pushes %s with the release commit of {tag} and the tag on its head. No publish workflow starts on the tag%s, and nothing reaches %s or %s.", rc, rcRunsNote(f, o), release, trunk),
			PipelineCommand: molten.PipelineCommand{Run: "molten release tag {tag} --rc-branch"}})
		sources[key+"/tag"] = Source{Code: "rcOnBranch", Path: rc}
		return steps
	}
	if o.Reconcile {
		steps = append(steps, molten.PipelineStep{Id: "reconcile", Phase: "prepare",
			Title:           fmt.Sprintf("Reconcile %s into %s when they diverged (merge -s ours; nothing to do otherwise)", release, rc),
			PipelineCommand: molten.PipelineCommand{Run: "molten release reconcile {tag}"}})
		d := f.Divergence
		detail := ""
		if d != nil {
			detail = fmt.Sprintf("%d / %d / %d", d.Ahead, d.Behind, d.ConflictFiles)
		}
		sources[key+"/reconcile"] = Source{Code: "reconcile", Path: release + " / " + trunk, Detail: detail}
	}
	steps = handSteps(f, o, steps, key, sources)
	steps = append(steps, molten.PipelineStep{Id: "open-pr", Title: fmt.Sprintf("Commit the release on %s and open its pull request to %s", rc, release), Phase: "cut",
		Confirm:         fmt.Sprintf("Pushes %s with the release commit of {tag} and opens its pull request to %s.", rc, release),
		PipelineCommand: molten.PipelineCommand{Run: "molten release open-pr {tag}"}})
	sources[key+"/open-pr"] = protectionSource
	method := o.Merge
	if method == "" {
		method = MergeCommit
	}
	checks := "GitHub lets it merge"
	if p := f.Protection; p != nil && len(p.RequiredChecks) > 0 {
		verb := " is"
		if len(p.RequiredChecks) > 1 {
			verb = " are"
		}
		checks = strings.Join(p.RequiredChecks, ", ") + verb + " green"
	}
	steps = append(steps, molten.PipelineStep{Id: "merge-pr", Title: fmt.Sprintf("Merge the pull request into %s once %s", release, checks), Phase: "cut",
		Confirm:         fmt.Sprintf("Merges the pull request of {tag} into %s with a %s once %s.", release, mergeWords(method), checks),
		PipelineCommand: molten.PipelineCommand{Run: "molten release merge-pr {tag} --method " + method}})
	sources[key+"/merge-pr"] = protectionSource
	files, envs := tagWorkflows(f, channel, o.TagPrefix)
	title := "Tag the merge commit and push the tag"
	if len(files) > 0 {
		title += ": " + strings.Join(files, ", ") + startVerb(files) + " on the tag"
	}
	steps = append(steps, molten.PipelineStep{Id: "tag", Title: title, Phase: "cut", Confirm: finalizeConfirm(f, channel, o.TagPrefix),
		PipelineCommand: molten.PipelineCommand{Run: "molten release tag {tag}"}})
	tagSource := Source{Code: "finalizeNoWorkflow"}
	if len(files) > 0 {
		tagSource = Source{Code: "finalizeWorkflows", Path: strings.Join(files, ", "), Detail: strings.Join(envs, ", ")}
	}
	sources[key+"/tag"] = tagSource
	return afterTag(f, o, channel, steps, sources, branchSource, false)
}

// rcRunsNote names the workflows that do run on a candidate kept on its RC branch (its tests, on the tag or the
// branch): " (test.yml runs on it)", or "".
func rcRunsNote(f Facts, o Options) string {
	rcTag, _ := sampleTags(o.TagPrefix)
	branch := strings.ReplaceAll(rcBranchDisplay(f), "X.Y.Z", "1.2.3")
	var files []string
	for _, wf := range f.Workflows {
		if wf.RunsOnTag(rcTag) || wf.RunsOnBranch(branch) {
			files = append(files, wf.File)
		}
	}
	if len(files) == 0 {
		return ""
	}
	verb := " runs"
	if len(files) > 1 {
		verb = " run"
	}
	return " (" + strings.Join(files, ", ") + verb + " on it)"
}

// rcPublished tells whether something consumes the release candidate's tag: a workflow that starts on it.
func rcPublished(f Facts, o Options) bool {
	files, _ := tagWorkflows(f, ChannelRc, o.TagPrefix)
	return len(files) > 0
}

func mergeWords(method string) string {
	switch method {
	case MergeSquash:
		return "squash merge"
	case MergeRebase:
		return "rebase merge"
	}
	return "merge commit"
}

// protectionSummary says in a few words what the release branch's protection asks, for the step's source.
func protectionSummary(p *Protection) string {
	if p == nil || !p.Read {
		return ""
	}
	var parts []string
	if p.PullRequest {
		parts = append(parts, "pull request")
	}
	parts = append(parts, p.RequiredChecks...)
	if p.Bypass != "" {
		parts = append(parts, "bypass: "+p.Bypass)
	}
	return strings.Join(parts, ", ")
}

// afterTag: what follows the tag, in either flow: the milestone, the dispatched workflows, the sync-back.
func afterTag(f Facts, o Options, channel string, steps []molten.PipelineStep, sources map[string]Source, branchSource Source, single bool) []molten.PipelineStep {
	key := channel
	trunk := f.Branches.Trunk
	if channel == ChannelPublic && o.Milestone && f.OnGithub {
		steps = append(steps, molten.PipelineStep{Id: "close-milestone", Title: "Close the milestone once the release is published",
			Phase: "publish", PipelineCommand: molten.PipelineCommand{Run: "molten release close-milestone {tag}"}})
		sources[key+"/close-milestone"] = Source{Code: "milestone"}
	}
	for _, d := range o.Dispatch {
		if d.Channel != "" && d.Channel != channel {
			continue
		}
		wf, ok := workflowByFile(f, d.Workflow)
		if !ok {
			continue
		}
		id := "dispatch-" + StepId(strings.TrimSuffix(strings.TrimSuffix(wf.File, ".yml"), ".yaml"))
		name := wf.Name
		if name == "" {
			name = wf.File
		}
		steps = append(steps, molten.PipelineStep{Id: id, Title: fmt.Sprintf("Run %s at {tag}", name), Phase: "publish",
			PipelineCommand: molten.PipelineCommand{Run: "molten release dispatch " + shellArg(wf.File) + " --ref {tag}"}})
		sources[key+"/"+id] = Source{Code: "dispatch", Path: WorkflowsDir + "/" + wf.File, Detail: strings.Join(wf.Environments, ", ")}
	}
	if o.SyncBack && !single && o.BranchModel == BranchModelRcPr {
		// Only a merge commit makes the release branch part of the trunk's history; squashed or rebased, the branches
		// diverge again (#1046).
		steps = append(steps, molten.PipelineStep{Id: "sync-back", Title: fmt.Sprintf("Merge %s back into %s with a merge commit", f.Branches.Release, trunk),
			Phase:           "back",
			Confirm:         fmt.Sprintf("Opens the pull request of %s (at {tag}) into %s and merges it with a merge commit once its checks are green, never squash or rebase: %s must become part of %s's history, or the branches diverge again.", f.Branches.Release, trunk, f.Branches.Release, trunk),
			PipelineCommand: molten.PipelineCommand{Run: "molten release sync-back {tag} --merge"}})
		sources[key+"/sync-back"] = branchSource
	} else if o.SyncBack && !single {
		steps = append(steps, molten.PipelineStep{Id: "sync-back", Title: fmt.Sprintf("Carry the release commit back to %s by pull request", trunk),
			Phase: "back", PipelineCommand: molten.PipelineCommand{Run: "molten release sync-back {tag}"}})
		sources[key+"/sync-back"] = branchSource
	}
	return steps
}

// saasSteps: one cd step per chosen environment, deploying the release branch through its workflow (FR-MC-035's
// Deploy to); a production-like name asks first.
func saasSteps(f Facts, o Options, sources map[string]Source) []molten.PipelineAdapterStep {
	var rtn []molten.PipelineAdapterStep
	for _, d := range f.DeployTargets() {
		if !d.Dispatch || !hasChannel(o.Environments, d.Environment) {
			continue
		}
		env := StepId(d.Environment)
		id := "deploy-" + env
		rtn = append(rtn, molten.PipelineAdapterStep{Id: id, Title: "Deploy " + f.Branches.Release + " to " + d.Environment, Section: molten.PipelineSectionCd,
			Environment: env, PipelineCommand: molten.PipelineCommand{Run: "molten release dispatch " + shellArg(d.Workflow) + " --ref " + shellArg(f.Branches.Release)}})
		sources["steps/"+id] = Source{Code: "deploy", Path: WorkflowsDir + "/" + d.Workflow, Detail: d.Environment}
	}
	return rtn
}

// Build drafts the proposal from the facts and the developer's choices.
func Build(f Facts, o Options, current *molten.Pipeline) Proposal {
	p := Proposal{Sources: map[string]Source{}}
	if o.TagPrefix == "" {
		o.TagPrefix = versions.DefaultTagPrefix
	}
	if o.Kind == KindSaas {
		steps := saasSteps(f, o, p.Sources)
		if len(steps) > 0 {
			var kept []molten.PipelineAdapterStep
			if current != nil {
				for _, s := range current.Steps {
					if s.Section != molten.PipelineSectionCd || s.Environment == "" || !stepsHaveEnv(steps, s.Environment) {
						kept = append(kept, s)
					}
				}
			}
			p.Steps = append(kept, steps...)
		}
		return p
	}
	release := &molten.PipelineRelease{}
	if current != nil && current.Release != nil {
		*release = *current.Release
	}
	if hasChannel(o.Channels, ChannelRc) {
		release.Rc = onPremiseSteps(f, o, ChannelRc, p.Sources)
	}
	if hasChannel(o.Channels, ChannelPublic) {
		release.Public = onPremiseSteps(f, o, ChannelPublic, p.Sources)
	}
	p.Release = release
	p.Versions = proposedVersions(f, o, current)
	if o.BranchModel == BranchModelSingle && f.Branches.Trunk != f.Branches.Release {
		p.Branches = &molten.PipelineBranches{Trunk: f.Branches.Trunk, Release: f.Branches.Trunk}
	}
	return p
}

func stepsHaveEnv(steps []molten.PipelineAdapterStep, env string) bool {
	for _, s := range steps {
		if s.Environment == env {
			return true
		}
	}
	return false
}

// proposedVersions: the declared block, with the chosen prefix and changelogs; nil when nothing changes.
func proposedVersions(f Facts, o Options, current *molten.Pipeline) *molten.PipelineVersions {
	v := molten.PipelineVersions{}
	if current != nil && current.Versions != nil {
		v = *current.Versions
	}
	before := fmt.Sprintf("%#v", v)
	if len(v.Files) == 0 && len(f.VersionFiles) > 0 {
		v.Files = f.VersionFiles
	}
	if len(v.Files) > 0 {
		v.Files = withLabels(v.Files, o.Labels)
	}
	if o.TagPrefix != versions.DefaultTagPrefix || v.TagPrefix != "" {
		v.TagPrefix = o.TagPrefix
	}
	// The chain always drafts the notes (prepare) and the cut needs them: only where they are written is a choice.
	if o.NotesPath != "" && o.NotesPath != f.NotesPath {
		v.Notes = o.NotesPath
	}
	v.Changelogs = append([]string(nil), o.Changelogs...)
	if len(v.Changelogs) == 0 {
		v.Changelogs = nil
	}
	if fmt.Sprintf("%#v", v) == before {
		return nil
	}
	return &v
}

// withLabels adds the kept labels that have a pattern as text entries, after the declared files (the first file
// holds the project's version); one already declared is not added twice.
func withLabels(files []versions.VersionFile, labels []LabelChoice) []versions.VersionFile {
	rtn := append([]versions.VersionFile(nil), files...)
	for _, l := range labels {
		if l.Pattern == "" {
			continue
		}
		known := false
		for _, f := range rtn {
			known = known || (f.Path == l.Path && f.Pattern == l.Pattern)
		}
		if !known {
			rtn = append(rtn, versions.VersionFile{Path: l.Path, Format: versions.FileFormatText, Pattern: l.Pattern})
		}
	}
	return rtn
}

func stepIdTaken(steps []molten.PipelineStep, id string) bool {
	for _, s := range steps {
		if s.Id == id {
			return true
		}
	}
	return false
}

func startVerb(files []string) string {
	if len(files) == 1 {
		return " starts"
	}
	return " start"
}

type TagWorkflow struct {
	File         string   `json:"file"`
	Name         string   `json:"name,omitempty"`
	Environments []string `json:"environments"`
}

func tagWorkflowList(f Facts, channel string, prefix string) []TagWorkflow {
	files, _ := tagWorkflows(f, channel, prefix)
	rtn := []TagWorkflow{}
	for _, file := range files {
		wf, _ := workflowByFile(f, file)
		envs := wf.Environments
		if envs == nil {
			envs = []string{}
		}
		rtn = append(rtn, TagWorkflow{File: file, Name: wf.Name, Environments: envs})
	}
	return rtn
}

// tagCiList: the CI workflows the channel's sample tag starts (#1101).
func tagCiList(f Facts, channel string, prefix string) []string {
	rc, public := sampleTags(prefix)
	tag := public
	if channel == ChannelRc {
		tag = rc
	}
	rtn := []string{}
	for _, wf := range f.Workflows {
		if wf.Role == RoleCi && wf.RunsOnTag(tag) {
			rtn = append(rtn, wf.File)
		}
	}
	return rtn
}
