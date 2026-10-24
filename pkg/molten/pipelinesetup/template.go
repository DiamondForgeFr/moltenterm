// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"fmt"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
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
		Manual: []ManualStep{}, Environments: []string{}}
	o.Channels = append(o.Channels, f.Missing...)
	if len(o.Channels) == 0 {
		o.Channels = []string{ChannelRc, ChannelPublic}
	}
	if f.Branches.Trunk == f.Branches.Release {
		o.BranchModel = BranchModelSingle
		o.SyncBack = false
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

func changelogStep(path string, id string, release string, worktree string) molten.PipelineStep {
	return molten.PipelineStep{
		Id:     id,
		Title:  "Write the {version} section of " + path,
		Phase:  "cut",
		Manual: fmt.Sprintf("In the release worktree (%s, prepared on %s), write the {version} section of %s. The cut commits it with the version.", worktree, release, path),
	}
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
				if s.Id == "finalize" {
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
	var steps []molten.PipelineStep
	branchSource := Source{Code: "branches", Path: f.Branches.TrunkFrom + " / " + f.Branches.ReleaseFrom, Detail: trunk + " → " + release}
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
		step := changelogStep(path, id, release, f.ReleaseWorktree)
		steps = append(steps, step)
		sources[key+"/"+step.Id] = Source{Code: "changelog", Path: path}
	}
	if o.Notes {
		steps = append(steps, molten.PipelineStep{Id: "rewrite-notes", Title: "Rewrite the public notes with the coding agent",
			Notes: true, PipelineCommand: molten.PipelineCommand{Run: "molten release notes {tag}"}})
		sources[key+"/rewrite-notes"] = Source{Code: "notes", Path: molten.ProjectPipelineFile}
	}
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
	if o.SyncBack && !single {
		steps = append(steps, molten.PipelineStep{Id: "sync-back", Title: fmt.Sprintf("Carry the release commit back to %s by pull request", trunk),
			Phase: "back", PipelineCommand: molten.PipelineCommand{Run: "molten release sync-back {tag}"}})
		sources[key+"/sync-back"] = branchSource
	}
	return insertManual(steps, sources, key, o.Manual, channel)
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
