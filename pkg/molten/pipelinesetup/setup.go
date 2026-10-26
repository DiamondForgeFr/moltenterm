// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The release setup's three calls (FR-MC-036): Draft proposes and writes nothing, Refine asks the coding agent for a
// better proposal and writes nothing, Write opens a pull request with the reviewed text on the developer's click
// (#1098): the folder opened is never written.

const maxPipelineBytes = 1 << 20

type DraftRequest struct {
	Dir string `json:"dir"`
	// nil: the provider's draft with its defaults; set: MoltenTerm's templates with these choices.
	Options *Options `json:"options,omitempty"`
	// The kind the developer confirmed, for the provider's draft.
	Kind string `json:"kind,omitempty"`
	// Build on the working copy's uncommitted pipeline instead of the committed one (#1098).
	IncludeLocal bool `json:"includelocal,omitempty"`
}

type DraftAnswer struct {
	Provider string   `json:"provider"`
	Warnings []string `json:"warnings"`
	Facts    Facts    `json:"facts"`
	// The choices the provider's draft stands for; Options are the ones this proposal was built with.
	Defaults      Options        `json:"defaults"`
	Options       Options        `json:"options"`
	RcFormats     []Choice       `json:"rcformats"`
	BranchModels  []Choice       `json:"branchmodels"`
	Merges        []Choice       `json:"merges"`
	DeployTargets []DeployTarget `json:"deploytargets"`
	// The workflows each channel's tag starts, with their environments, for the diagram.
	TagWorkflows map[string][]TagWorkflow `json:"tagworkflows"`
	// The CI workflows each channel's tag starts too (its tests), which the existing pipeline's diagram draws (#1101).
	TagCi    map[string][]string `json:"tagci"`
	Proposal Proposal            `json:"proposal"`
	// The committed file ("" when there is none), its hash, and the proposed text.
	Current  string `json:"current"`
	Base     string `json:"base"`
	Proposed string `json:"proposed"`
	// The proposed file's validation.
	Errors           []string `json:"errors"`
	ValidateWarnings []string `json:"validatewarnings"`
	// The hash of each release step the template drafted ("rc/prepare"), handed back to Write (#1086).
	Generated map[string]string `json:"generated"`
	// Step 2b (FR-MC-041): the files proposed beside the pipeline (the missing publish workflow), handed back to Write,
	// and the repository's branch names for the questions.
	Files       []ProposedFile `json:"files"`
	BranchNames []string       `json:"branchnames"`
	// The base commit already holds .molten/release-setup.json: step 3 lists it as updated, not new (#1104).
	RecordExists bool `json:"recordexists"`
	// Where the pull request starts and goes (#1098).
	Pr PrPlan `json:"pr"`
}

type WriteRequest struct {
	Dir  string `json:"dir"`
	Text string `json:"text"`
	Base string `json:"base"`
	// The draft's Generated: the steps written as the template drafted them are recorded as MoltenTerm's (#1086).
	Generated map[string]string `json:"generated,omitempty"`
	// The draft's Files: new workflows only, checked again (FR-MC-041).
	Files []ProposedFile `json:"files,omitempty"`
	PrRequest
}

type RefineRequest struct {
	Dir string `json:"dir"`
	// The draft the changes are proposed on.
	Text string `json:"text"`
	// What the developer asks for, in their words; empty: the agent checks the draft against the repository.
	Request string `json:"request,omitempty"`
	// An answer the developer pasted from another agent (#1099): read like the project's agent's, nothing runs.
	Answer string `json:"answer,omitempty"`
}

type RefineAnswer struct {
	// Empty when the answer was pasted.
	Agent     string `json:"agent"`
	AgentName string `json:"agentname"`
	// The changes offered, each ticked by default, and the ones MoltenTerm does not offer with their reason (#1099).
	Changes  []StepChange     `json:"changes"`
	Rejected []RejectedChange `json:"rejected"`
	// The draft with every offered change applied, and its validation.
	Proposed         string   `json:"proposed"`
	Errors           []string `json:"errors"`
	ValidateWarnings []string `json:"validatewarnings"`
}

type ApplyRequest struct {
	Dir     string       `json:"dir"`
	Text    string       `json:"text"`
	Changes []StepChange `json:"changes"`
	// The keys of the changes the developer ticked.
	Chosen []string `json:"chosen"`
}

type ApplyAnswer struct {
	Proposed         string   `json:"proposed"`
	Errors           []string `json:"errors"`
	ValidateWarnings []string `json:"validatewarnings"`
}

type PromptRequest struct {
	Dir     string `json:"dir"`
	Text    string `json:"text"`
	Request string `json:"request,omitempty"`
}

type PromptAnswer struct {
	Prompt string `json:"prompt"`
}

// AgentRunner runs a coding agent CLI with the prompt on its standard input and returns its standard output.
type AgentRunner func(ctx context.Context, dir string, argv []string, prompt string) ([]byte, error)

type Setup struct {
	Providers []Provider
	// Runs gh and git for what the files cannot say (the release branch's protection, the divergence); nil skips it.
	Run   Runner
	Agent AgentRunner
	// Which coding agent refines (agentchoice.Resolve); tests replace it.
	ChooseAgent func(dir string) agentchoice.Choice
	// Where the pull requests' worktrees go: MoltenTerm's data, never beside the project (#1098).
	TreesDir string
	// Where the stepper's answers are kept per project (FR-MC-038); "" keeps none.
	AnswersDir string
	// The folders of the projects linked to a workspace, for "another project as a model" (FR-MC-041); nil lists none.
	ProjectDirs func(ctx context.Context) ([]string, error)
	// Where the technical documentation goes (FR-MC-043); nil: SaaSFoundryAI's backend, else the repository file.
	DocBackends []TechDocBackend
	// Where the pipeline templates are kept on this computer (FR-MC-042); "" keeps none.
	TemplatesDir string

	jobLock sync.Mutex
	jobs    map[string]*PrJob
	// The ticket a job created, per project and kind, until its pull request is made: a retry reuses it (#1146).
	createdTickets map[string]int
}

// MakeSetup: SaaSFoundryAI's CLI first, MoltenTerm's detection as the fallback.
func MakeSetup(run Runner, agent AgentRunner) *Setup {
	return &Setup{
		Providers:   []Provider{SaaSFoundryProvider{Run: run}, DetectionProvider{}},
		Run:         run,
		Agent:       agent,
		ChooseAgent: func(dir string) agentchoice.Choice { return agentchoice.Resolve(dir, "") },
	}
}

func hashOf(data []byte) string {
	if data == nil {
		return ""
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func checkProjectDir(dir string) (string, error) {
	if dir == "" || !filepath.IsAbs(dir) {
		return "", fmt.Errorf("not an absolute folder: %q", dir)
	}
	info, err := os.Stat(dir)
	if err != nil || !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", dir)
	}
	return filepath.Clean(dir), nil
}

func readCurrent(dir string) ([]byte, error) {
	path := filepath.Join(dir, molten.ProjectPipelineFile)
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, uimsg.Errorf(uimsg.Make("mission.setup.notRegular", "path", molten.ProjectPipelineFile), "%s is not a regular file: it is not written through a link", molten.ProjectPipelineFile)
	}
	if info.Size() > maxPipelineBytes {
		return nil, fmt.Errorf("%s is too large", molten.ProjectPipelineFile)
	}
	return os.ReadFile(path)
}

// Draft proposes the release pipeline; nothing is written.
func (s *Setup) Draft(ctx context.Context, req DraftRequest) (DraftAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return DraftAnswer{}, err
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return DraftAnswer{}, err
	}
	if err := b.includable(req.IncludeLocal); err != nil {
		return DraftAnswer{}, err
	}
	current, _ := b.buildOn(req.IncludeLocal)
	report := pipelineReport(dir, current)
	f := DetectWith(dir, report)
	if f.HasPipeline && !f.PipelineValid {
		return DraftAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.invalid", "errors", strings.Join(f.PipelineErrors, "; ")),
			"%s is not valid: %s; fix it first (molten project validate)", molten.ProjectPipelineFile, strings.Join(f.PipelineErrors, "; "))
	}
	ReadRemoteFacts(ctx, s.Run, dir, &f)
	var described *Options
	files := []ProposedFile{}
	branchesChanged := false
	if req.Options != nil {
		o := *req.Options
		var proposed []ProposedFile
		proposed, branchesChanged = applyDescription(dir, &f, &o)
		files = append(files, proposed...)
		described = &o
	}
	answer := DraftAnswer{Facts: f, Warnings: []string{}, Current: string(b.Pipeline), Base: hashOf(b.Pipeline),
		DeployTargets: f.DeployTargets(), Pr: s.planOf(dir, b, PrKindWrite, req.IncludeLocal), Files: files,
		BranchNames: s.branchNames(ctx, dir, f)}
	answer.Defaults = DefaultOptions(f)
	if req.Kind != "" {
		answer.Defaults.Kind = req.Kind
	}
	if described != nil {
		answer.Provider = ProviderMoltenTerm
		answer.Options = *described
		answer.Proposal = Build(f, answer.Options, report.Pipeline)
		if branchesChanged {
			answer.Proposal.Branches = &molten.PipelineBranches{Trunk: f.Branches.Trunk, Release: f.Branches.Release}
		}
	} else {
		draft, warnings := s.providerDraft(ctx, dir, answer.Defaults.Kind, f)
		answer.Provider, answer.Proposal = draft.Provider, draft.Proposal
		answer.Warnings = append(warnings, draft.Warnings...)
		answer.Defaults.Kind = draft.Kind
		answer.Options = answer.Defaults
	}
	if answer.Options.Kind != KindSaas {
		ProposeChecks(dir, f, answer.Options, answer.Proposal.Release)
		ProposeFormat(dir, answer.Options, report.Pipeline, &answer.Proposal)
	}
	answer.RecordExists = b.Record != nil
	answer.RcFormats = EvaluateChoices([]string{RcFormatNumeric, RcFormatRcDot}, RcFormatRules, f.TargetIds())
	models := []string{BranchModelPromote, BranchModelSingle, BranchModelRcPr}
	answer.BranchModels = EvaluateChoices(models, BranchModelRules, f.TargetIds())
	answer.Merges = EvaluateChoices([]string{MergeCommit, MergeSquash, MergeRebase}, MergeRules, f.TargetIds())
	if f.Branches.Trunk == f.Branches.Release {
		for i := range answer.BranchModels {
			if answer.BranchModels[i].Id == BranchModelRcPr {
				answer.BranchModels[i].Allowed = false
				answer.BranchModels[i].Reasons = append(answer.BranchModels[i].Reasons, ChoiceReason{Code: ReasonSingleBranch, Refuses: true})
			}
		}
	}
	applyProtection(answer.BranchModels, answer.Merges, f.Protection)
	prefix := answer.Options.TagPrefix
	if prefix == "" {
		prefix = f.TagPrefix
	}
	answer.TagWorkflows = map[string][]TagWorkflow{ChannelRc: tagWorkflowList(f, ChannelRc, prefix), ChannelPublic: tagWorkflowList(f, ChannelPublic, prefix)}
	answer.TagCi = map[string][]string{ChannelRc: tagCiList(f, ChannelRc, prefix), ChannelPublic: tagCiList(f, ChannelPublic, prefix)}
	proposed, err := proposedText(current, f, answer.Proposal)
	if err != nil {
		return answer, err
	}
	answer.Proposed = string(proposed)
	answer.Generated = releaseHashes(answer.Proposal.Release)
	check := molten.ValidatePipelineData(dir, proposed)
	answer.Errors, answer.ValidateWarnings = check.Errors, check.Warnings
	return answer, nil
}

// providerDraft asks the first available provider; a provider that fails hands over to the next, and says so.
func (s *Setup) providerDraft(ctx context.Context, dir string, kind string, f Facts) (*ProviderDraft, []string) {
	warnings := []string{}
	for _, p := range s.Providers {
		if !p.Available(ctx, dir) {
			continue
		}
		if detection, ok := p.(DetectionProvider); ok {
			detection.Facts = &f
			p = detection
		}
		draft, err := p.Draft(ctx, dir, kind)
		if err == nil {
			return draft, warnings
		}
		warnings = append(warnings, fmt.Sprintf("%s: %v", p.Name(), err))
	}
	draft, _ := DetectionProvider{Facts: &f}.Draft(ctx, dir, kind)
	return draft, warnings
}

func proposedText(current []byte, f Facts, p Proposal) ([]byte, error) {
	var values []keyValue
	if p.Versions != nil {
		values = append(values, keyValue{Key: "versions", Value: p.Versions})
	}
	if p.Branches != nil {
		values = append(values, keyValue{Key: "branches", Value: p.Branches})
	}
	if p.Release != nil {
		values = append(values, keyValue{Key: "release", Value: p.Release})
	}
	if p.Steps != nil {
		values = append(values, keyValue{Key: "steps", Value: p.Steps})
	}
	base := []keyValue{{Key: "schema", Value: molten.PipelineSchema}, {Key: "name", Value: f.Name}}
	return MergeTopLevel(current, base, values)
}

// nameOf: the name a new file starts with, as the draft gives it (Detect's name without a pipeline); an existing
// file keeps its own.
func nameOf(dir string, current []byte) string {
	return filepath.Base(dir)
}

// writeFilesOf: the reviewed text merged onto the base (only the keys the setup sets up change, whoever wrote the text),
// validated, with the record of the steps the template wrote.
func writeFilesOf(dir string, current []byte, text string, generated map[string]string, proposed []ProposedFile) (prFiles, error) {
	if len(text) > maxPipelineBytes {
		return prFiles{}, fmt.Errorf("the proposed %s is too large", molten.ProjectPipelineFile)
	}
	if err := checkProposedFiles(proposed); err != nil {
		return prFiles{}, err
	}
	merged, _, err := MergeOwned(current, []byte(text), nameOf(dir, current))
	if err != nil {
		return prFiles{}, fail(PrFailureInvalid, err.Error())
	}
	report := molten.ValidatePipelineData(dir, merged)
	if !report.Valid {
		return prFiles{}, fail(PrFailureInvalid, strings.Join(report.Errors, "; "))
	}
	var files prFiles
	files.add(molten.ProjectPipelineFile, merged)
	if rec := recordOf(report.Pipeline, generated, nil); rec != nil {
		data, err := recordText(rec)
		if err != nil {
			return prFiles{}, err
		}
		files.add(RecordFile, data)
	}
	for _, file := range proposed {
		files.add(file.Path, []byte(file.Content))
	}
	return files, nil
}

// Write opens the pull request of the reviewed text (#1098): only when the committed file is still the one the draft
// read, and only a valid pipeline. It answers at once with the job; PrState follows it.
func (s *Setup) Write(req WriteRequest) (PrJob, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return PrJob{}, err
	}
	if err := s.checkPrRequest(dir, PrKindWrite, &req.PrRequest); err != nil {
		return PrJob{}, err
	}
	trunk := SetupBranches(dir).Trunk
	job := &PrJob{Dir: dir, Kind: PrKindWrite, Mode: req.Mode, Target: prTarget(dir, trunk), OnGithub: onGithub(dir), Ref: "origin/" + trunk}
	backend := s.docBackend(context.Background(), dir, req.Mode)
	return s.startJob(job, techDocSteps(jobSteps(dir, req.PrRequest), backend), func(ctx context.Context, job *PrJob) error {
		b, err := s.prepareBase(ctx, dir, req.Base, req.PrRequest, job)
		if err != nil {
			return err
		}
		current, _ := b.buildOn(req.IncludeLocal)
		files, err := writeFilesOf(dir, current, req.Text, req.Generated, req.Files)
		if err != nil {
			return err
		}
		if err := s.checkNewFiles(ctx, dir, b.Commit, req.Files); err != nil {
			return err
		}
		s.withTechDoc(dir, b, current, &files, PrKindWrite, req.Mode, backend)
		s.update(job, func(j *PrJob) { j.Files = append([]string{}, files.order...) })
		return s.runPr(ctx, dir, b, files, req.PrRequest, job)
	})
}

// writeProjectFile replaces a file of the project atomically, never through a link.
func writeProjectFile(dir string, rel string, data []byte) (string, error) {
	path := filepath.Join(dir, filepath.FromSlash(rel))
	folder := filepath.Dir(path)
	if info, err := os.Lstat(folder); err == nil && !info.IsDir() {
		return "", fmt.Errorf("%s is not a folder", folder)
	}
	if err := os.MkdirAll(folder, 0755); err != nil {
		return "", err
	}
	if info, err := os.Lstat(path); err == nil && !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a regular file: it is not written through a link", rel)
	}
	tmp, err := os.CreateTemp(folder, "."+filepath.Base(path)+".*")
	if err != nil {
		return "", err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Chmod(0644); err != nil {
		tmp.Close()
		return "", err
	}
	if err := tmp.Close(); err != nil {
		return "", err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return "", err
	}
	return path, nil
}

// refineArgv is the thin adapter of each agent MoltenTerm knows a read-only, non-interactive form of: no shell, no file
// writer, no web; the prompt on its standard input, the answer on its standard output. Any other agentic CLI takes the
// same prompt through the generic path (Prompt, then the pasted answer): MoltenTerm never starts an agent it cannot
// hold to reading.
func refineArgv(agent string) []string {
	switch agent {
	case molten.AgentIdClaude:
		return []string{"claude", "-p", "--disallowed-tools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"}
	case molten.AgentIdCodex:
		return []string{"codex", "exec", "--sandbox", "read-only", "-"}
	}
	return nil
}

// must match the contract in StepChange and decodeChange (#1099)
const refinePrompt = `You help set up the release pipeline MoltenTerm drafted for this repository (the current folder).
Read the repository (scripts, workflows, RELEASE or CONTRIBUTING notes, the harness files) for what the draft cannot
know: a one-time step (for example a merge -s ours before the first promotion), project-specific scripts, a changelog
convention, an environment approval. Propose only what the repository or the developer's request justifies. A step
the developer must do by hand is a manual step ("manual": the instructions, no "run"), never in the prepare phase.

Do not write or change any file, and never answer with a whole .molten/project.json: answer with a list of changes to
the draft's release steps and versions block, which the developer approves one by one. Answer one JSON object and
nothing else (no explanation around it, no code fence):

{"changes": [
  {"op": "add", "channel": "rc" or "public", "after": "<id of the step it follows>", "step": {<the new step>}, "why": "<one sentence>"},
  {"op": "change", "channel": "rc" or "public", "id": "<step id>", "step": {<the step's complete new text>}, "why": "..."},
  {"op": "remove", "channel": "rc" or "public", "id": "<step id>", "why": "..."},
  {"op": "versions", "versions": {<only the fields to set: tagprefix, notes, firstpublic, files, changelogs>}, "why": "..."}
]}

An added step may give "before" instead of "after"; with neither it goes after the last step of its phase. A step
present in both channels is one change per channel. Nothing else of the file can change: ci, builds, steps, launch,
branches, name or notesagent are refused. No change needed: {"changes": []}.

The developer's request:

%s

The pipeline format:

%s

The draft:

%s
`

var fenceJsonRegex = regexp.MustCompile("(?s)```(?:json)?\\s*\\n(.*?)\\n?```")

func refinePromptOf(text string, request string) (string, error) {
	guide, err := agentdocs.Files.ReadFile("pipeline-format.md")
	if err != nil {
		return "", err
	}
	request = strings.TrimSpace(request)
	if request == "" {
		request = "(none: check the draft against the repository)"
	}
	return fmt.Sprintf(refinePrompt, request, guide, text), nil
}

func checkDraftText(text string) error {
	if len(text) > maxPipelineBytes {
		return fmt.Errorf("the draft is too large")
	}
	if strings.TrimSpace(text) == "" {
		return fmt.Errorf("there is no draft")
	}
	return nil
}

// Prompt is the request any agentic CLI answers (#1099): the developer runs it in the agent of their choice and pastes
// the answer back into Refine.
func (s *Setup) Prompt(req PromptRequest) (PromptAnswer, error) {
	if _, err := checkProjectDir(req.Dir); err != nil {
		return PromptAnswer{}, err
	}
	if err := checkDraftText(req.Text); err != nil {
		return PromptAnswer{}, err
	}
	prompt, err := refinePromptOf(req.Text, req.Request)
	return PromptAnswer{Prompt: prompt}, err
}

// Refine asks the project's coding agent (or reads the answer pasted from another one) for changes to the draft; the
// changes are proposals, never written, and no whole file is ever taken (#1099).
func (s *Setup) Refine(ctx context.Context, req RefineRequest) (RefineAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return RefineAnswer{}, err
	}
	if err := checkDraftText(req.Text); err != nil {
		return RefineAnswer{}, err
	}
	answer := RefineAnswer{}
	out := []byte(req.Answer)
	name := ""
	if strings.TrimSpace(req.Answer) == "" {
		choice := s.ChooseAgent(dir)
		argv := refineArgv(choice.Agent)
		if argv == nil {
			return RefineAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.noAgent"), "%s", agentchoice.NoneText())
		}
		prompt, err := refinePromptOf(req.Text, req.Request)
		if err != nil {
			return RefineAnswer{}, err
		}
		answer.Agent, answer.AgentName, name = choice.Agent, choice.AgentName, choice.AgentName
		if out, err = s.Agent(ctx, dir, argv, prompt); err != nil {
			return RefineAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.agentFailed", "agent", name, "detail", err.Error()), "%s could not refine the draft: %v", name, err)
		}
	}
	raws, err := ParseChanges(out)
	if err != nil {
		return RefineAnswer{}, answerError(err, name)
	}
	answer.Changes, answer.Rejected, err = CheckChanges(dir, []byte(req.Text), raws)
	if err != nil {
		return RefineAnswer{}, err
	}
	applied, err := s.Apply(ApplyRequest{Dir: dir, Text: req.Text, Changes: answer.Changes, Chosen: ChangeKeysOf(answer.Changes)})
	if err != nil {
		return RefineAnswer{}, err
	}
	answer.Proposed, answer.Errors, answer.ValidateWarnings = applied.Proposed, applied.Errors, applied.ValidateWarnings
	return answer, nil
}

// answerError: an answer that is a whole file is refused as such, nothing of it taken (the #1091 rewrite); name is ""
// for a pasted answer.
func answerError(err error, name string) error {
	whole := errors.Is(err, errWholeFile)
	switch {
	case name == "" && whole:
		return uimsg.Errorf(uimsg.Make("mission.setup.pastedWholeFile"), "the pasted answer is a whole pipeline file, not step changes: nothing of it is taken")
	case name == "":
		return uimsg.Errorf(uimsg.Make("mission.setup.pastedNoChanges"), "the pasted answer holds no list of changes")
	case whole:
		return uimsg.Errorf(uimsg.Make("mission.setup.agentWholeFile", "agent", name), "%s answered with a whole pipeline file instead of step changes: nothing of it is taken", name)
	}
	return uimsg.Errorf(uimsg.Make("mission.setup.agentNoChanges", "agent", name), "%s answered without a list of changes", name)
}

// ChangeKeysOf lists the changes' keys, in order.
func ChangeKeysOf(changes []StepChange) []string {
	rtn := []string{}
	for _, c := range changes {
		rtn = append(rtn, c.Key)
	}
	return rtn
}

// Apply writes the ticked changes into the draft's text, checked again; nothing is written to the project.
func (s *Setup) Apply(req ApplyRequest) (ApplyAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return ApplyAnswer{}, err
	}
	if err := checkDraftText(req.Text); err != nil {
		return ApplyAnswer{}, err
	}
	changes, err := chosenChanges(dir, []byte(req.Text), req.Changes, req.Chosen)
	if err != nil {
		return ApplyAnswer{}, err
	}
	proposed, err := applyChanges([]byte(req.Text), changes)
	if err != nil {
		return ApplyAnswer{}, err
	}
	report := molten.ValidatePipelineData(dir, proposed)
	return ApplyAnswer{Proposed: string(proposed), Errors: report.Errors, ValidateWarnings: report.Warnings}, nil
}
