// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/agentchoice"
	"github.com/wavetermdev/waveterm/pkg/molten/agentdocs"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The release setup's three calls (FR-MC-036): Draft proposes and writes nothing, Refine asks the coding agent for a
// better proposal and writes nothing, Write writes the reviewed text on the developer's click.

const maxPipelineBytes = 1 << 20

type DraftRequest struct {
	Dir string `json:"dir"`
	// nil: the provider's draft with its defaults; set: MoltenTerm's templates with these choices.
	Options *Options `json:"options,omitempty"`
	// The kind the developer confirmed, for the provider's draft.
	Kind string `json:"kind,omitempty"`
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
	Proposal     Proposal                 `json:"proposal"`
	// The file as it is ("" when there is none), its hash, and the proposed text.
	Current  string `json:"current"`
	Base     string `json:"base"`
	Proposed string `json:"proposed"`
	// The proposed file's validation.
	Errors           []string `json:"errors"`
	ValidateWarnings []string `json:"validatewarnings"`
}

type WriteRequest struct {
	Dir  string `json:"dir"`
	Text string `json:"text"`
	Base string `json:"base"`
}

type WriteAnswer struct {
	Path     string   `json:"path"`
	Warnings []string `json:"warnings"`
}

type RefineRequest struct {
	Dir  string `json:"dir"`
	Text string `json:"text"`
}

type RefineAnswer struct {
	Agent            string   `json:"agent"`
	AgentName        string   `json:"agentname"`
	Proposed         string   `json:"proposed"`
	Errors           []string `json:"errors"`
	ValidateWarnings []string `json:"validatewarnings"`
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
	current, err := readCurrent(dir)
	if err != nil {
		return DraftAnswer{}, err
	}
	f := Detect(dir)
	if f.HasPipeline && !f.PipelineValid {
		return DraftAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.invalid", "errors", strings.Join(f.PipelineErrors, "; ")),
			"%s is not valid: %s; fix it first (molten project validate)", molten.ProjectPipelineFile, strings.Join(f.PipelineErrors, "; "))
	}
	ReadRemoteFacts(ctx, s.Run, dir, &f)
	report := molten.ValidatePipeline(dir)
	answer := DraftAnswer{Facts: f, Warnings: []string{}, Current: string(current), Base: hashOf(current),
		DeployTargets: f.DeployTargets()}
	answer.Defaults = DefaultOptions(f)
	if req.Kind != "" {
		answer.Defaults.Kind = req.Kind
	}
	if req.Options != nil {
		answer.Provider = ProviderMoltenTerm
		answer.Options = *req.Options
		answer.Proposal = Build(f, answer.Options, report.Pipeline)
	} else {
		draft, warnings := s.providerDraft(ctx, dir, answer.Defaults.Kind, f)
		answer.Provider, answer.Proposal = draft.Provider, draft.Proposal
		answer.Warnings = append(warnings, draft.Warnings...)
		answer.Defaults.Kind = draft.Kind
		answer.Options = answer.Defaults
	}
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
	proposed, err := proposedText(current, f, answer.Proposal)
	if err != nil {
		return answer, err
	}
	answer.Proposed = string(proposed)
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

// Write writes the reviewed text: only when the file is still the one the draft read, and only a valid pipeline.
func (s *Setup) Write(req WriteRequest) (WriteAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return WriteAnswer{}, err
	}
	current, err := readCurrent(dir)
	if err != nil {
		return WriteAnswer{}, err
	}
	if hashOf(current) != req.Base {
		return WriteAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.changed", "path", molten.ProjectPipelineFile),
			"%s changed since the draft: draft it again", molten.ProjectPipelineFile)
	}
	data := []byte(req.Text)
	if len(data) > maxPipelineBytes {
		return WriteAnswer{}, fmt.Errorf("the proposed %s is too large", molten.ProjectPipelineFile)
	}
	report := molten.ValidatePipelineData(dir, data)
	if !report.Valid {
		return WriteAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.notValid", "errors", strings.Join(report.Errors, "; ")),
			"the proposed %s is not valid: %s", molten.ProjectPipelineFile, strings.Join(report.Errors, "; "))
	}
	folder := filepath.Join(dir, filepath.Dir(molten.ProjectPipelineFile))
	if info, err := os.Lstat(folder); err == nil && !info.IsDir() {
		return WriteAnswer{}, fmt.Errorf("%s is not a folder", folder)
	}
	if err := os.MkdirAll(folder, 0755); err != nil {
		return WriteAnswer{}, err
	}
	path := filepath.Join(dir, molten.ProjectPipelineFile)
	tmp, err := os.CreateTemp(folder, ".project.json.*")
	if err != nil {
		return WriteAnswer{}, err
	}
	defer os.Remove(tmp.Name())
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()
		return WriteAnswer{}, err
	}
	if err := tmp.Chmod(0644); err != nil {
		tmp.Close()
		return WriteAnswer{}, err
	}
	if err := tmp.Close(); err != nil {
		return WriteAnswer{}, err
	}
	if err := os.Rename(tmp.Name(), path); err != nil {
		return WriteAnswer{}, err
	}
	return WriteAnswer{Path: path, Warnings: report.Warnings}, nil
}

// refineArgv is the agent's non-interactive form without a shell, a file writer or the web: it reads the repository and
// answers on its standard output.
func refineArgv(agent string) []string {
	switch agent {
	case molten.AgentIdClaude:
		return []string{"claude", "-p", "--disallowed-tools", "Bash", "Edit", "Write", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"}
	case molten.AgentIdCodex:
		return []string{"codex", "exec", "--sandbox", "read-only", "-"}
	}
	return nil
}

const refinePrompt = `You refine a release pipeline MoltenTerm drafted from this repository (the current folder).
Read the repository (scripts, workflows, RELEASE or CONTRIBUTING notes, the harness files) for what the draft cannot
know: a one-time step (for example a merge -s ours before the first promotion), project-specific scripts, a changelog
convention, an environment approval. Change only what the repository justifies. A step the developer must do by hand
is a manual step ("manual": the instructions, no "run"), never in the prepare phase.

Do not write or change any file: answer with the complete proposed .molten/project.json, as one JSON object, and
nothing else (no explanation, no code fence).

The pipeline format:

%s

The draft:

%s
`

var fenceJsonRegex = regexp.MustCompile("(?s)```(?:json)?\\s*\\n(.*?)\\n?```")

// extractJson takes the JSON object out of the agent's answer: inside a code fence if there is one, else from the first
// brace to the last.
func extractJson(out []byte) []byte {
	text := string(out)
	if m := fenceJsonRegex.FindStringSubmatch(text); m != nil {
		text = m[1]
	}
	start, end := strings.Index(text, "{"), strings.LastIndex(text, "}")
	if start < 0 || end < start {
		return nil
	}
	return []byte(text[start : end+1])
}

// Refine hands the draft to the project's coding agent; its answer is a proposal, never written.
func (s *Setup) Refine(ctx context.Context, req RefineRequest) (RefineAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return RefineAnswer{}, err
	}
	choice := s.ChooseAgent(dir)
	argv := refineArgv(choice.Agent)
	if argv == nil {
		return RefineAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.noAgent"), "%s", agentchoice.NoneText())
	}
	guide, err := agentdocs.Files.ReadFile("pipeline-format.md")
	if err != nil {
		return RefineAnswer{}, err
	}
	out, err := s.Agent(ctx, dir, argv, fmt.Sprintf(refinePrompt, guide, req.Text))
	if err != nil {
		return RefineAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.agentFailed", "agent", choice.AgentName, "detail", err.Error()), "%s could not refine the draft: %v", choice.AgentName, err)
	}
	proposed := extractJson(out)
	if proposed == nil {
		return RefineAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.agentNoJson", "agent", choice.AgentName), "%s answered without a pipeline", choice.AgentName)
	}
	var indented bytes.Buffer
	if json.Indent(&indented, proposed, "", "    ") == nil && !bytes.Contains(proposed, []byte("\n")) {
		proposed = indented.Bytes()
	}
	if !bytes.HasSuffix(proposed, []byte("\n")) {
		proposed = append(proposed, '\n')
	}
	report := molten.ValidatePipelineData(dir, proposed)
	return RefineAnswer{Agent: choice.Agent, AgentName: choice.AgentName, Proposed: string(proposed), Errors: report.Errors, ValidateWarnings: report.Warnings}, nil
}
