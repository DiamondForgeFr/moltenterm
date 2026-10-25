// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// Updating an existing release setup (FR-MC-036, #1086): the pipeline the template wrote once is checked again against
// what the current template writes for the same choices and the repository's facts of today (the release branch's
// protection included). The developer sees every change and approves it; a step they edited or added is kept unless
// they choose the new version.

const (
	// 1: the first template (#1030); 2: the pull-request flow, the reconciliation and the version labels (#1046).
	TemplateVersion = 2

	// What MoltenTerm wrote: the template version and a short hash of each step it wrote as drafted.
	RecordFile = ".molten/release-setup.json"

	UpdateStateMissing  = "missing"
	UpdateStateUpdate   = "update"
	UpdateStateUpToDate = "uptodate"

	ChangeAdded    = "added"
	ChangeRemoved  = "removed"
	ChangeChanged  = "changed"
	ChangeVersions = "versions"

	VersionsKey = "versions"

	// Why an update is offered, read by the frontend as mc.setup.update.reason.<code>.
	UpdateReasonProtected = "protected"
	UpdateReasonLabels    = "labels"
	UpdateReasonTemplate  = "template"
	// Steps the developer edited or added differ from the template: kept unless they choose otherwise, and a choice
	// written once is not offered again.
	UpdateReasonCustomised = "customised"

	maxRecordBytes = 256 << 10
	hashChars      = 12
)

type Record struct {
	Template int               `json:"template"`
	Steps    map[string]string `json:"steps"`
	// The template's versions the developer declined (the hash of the change's new side): not offered again until the
	// template writes something else there.
	Declined map[string]string `json:"declined,omitempty"`
}

type UpdateReason struct {
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

// A change the update makes: a release step added, removed or changed ("rc/prepare"), or the versions block.
type Change struct {
	Key     string `json:"key"`
	Channel string `json:"channel,omitempty"`
	Id      string `json:"id,omitempty"`
	Kind    string `json:"kind"`
	// The step's title (the new one when there is one), and both versions as the file writes them.
	Title  string `json:"title,omitempty"`
	Before string `json:"before,omitempty"`
	After  string `json:"after,omitempty"`
	// The developer edited or added it: kept unless they choose the new version.
	Customised bool `json:"customised"`
	// The default choice: take the template's version (add, remove, replace) or keep the file's.
	Take bool `json:"take"`
}

type CheckRequest struct {
	Dir string `json:"dir"`
	// The developer's choices by change key; a change not named takes its default.
	Choices map[string]bool `json:"choices,omitempty"`
}

type CheckAnswer struct {
	State   string         `json:"state"`
	Reasons []UpdateReason `json:"reasons"`
	Changes []Change       `json:"changes"`
	// The record's template version, 0 when the pipeline was written before MoltenTerm kept one.
	RecordTemplate int    `json:"recordtemplate"`
	Template       int    `json:"template"`
	ReleaseBranch  string `json:"releasebranch"`
	// The file as it is, its hash, and the file with the choices applied.
	Current  string `json:"current"`
	Base     string `json:"base"`
	Proposed string `json:"proposed"`
	// Names the list of changes: the update refuses to write when the list is no longer the one shown.
	Signature        string   `json:"signature"`
	Errors           []string `json:"errors"`
	ValidateWarnings []string `json:"validatewarnings"`
}

type UpdateRequest struct {
	Dir       string          `json:"dir"`
	Base      string          `json:"base"`
	Signature string          `json:"signature"`
	Choices   map[string]bool `json:"choices,omitempty"`
}

type UpdateAnswer struct {
	Path     string   `json:"path"`
	Warnings []string `json:"warnings"`
}

func stepHash(s molten.PipelineStep) string {
	data, _ := json.Marshal(s)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:hashChars]
}

func releaseHashes(r *molten.PipelineRelease) map[string]string {
	rtn := map[string]string{}
	if r == nil {
		return rtn
	}
	for _, c := range []struct {
		channel string
		steps   []molten.PipelineStep
	}{{ChannelRc, r.Rc}, {ChannelPublic, r.Public}} {
		for _, s := range c.steps {
			rtn[c.channel+"/"+s.Id] = stepHash(s)
		}
	}
	return rtn
}

// recordOf: the written steps that are the template's text, by their hash in generated, or in the previous record.
func recordOf(p *molten.Pipeline, generated map[string]string, previous *Record) *Record {
	if p == nil || p.Release == nil {
		return nil
	}
	rec := &Record{Template: TemplateVersion, Steps: map[string]string{}}
	for key, hash := range releaseHashes(p.Release) {
		if generated[key] == hash || (previous != nil && previous.Steps[key] == hash) {
			rec.Steps[key] = hash
		}
	}
	return rec
}

// changeHash names a change's new side: the declined step, the removal, or the versions block.
func changeHash(c Change) string {
	if c.Kind == ChangeRemoved {
		return "removed"
	}
	sum := sha256.Sum256([]byte(c.After))
	return hex.EncodeToString(sum[:])[:hashChars]
}

func declined(rec *Record, c Change) bool {
	return rec != nil && rec.Declined[c.Key] != "" && rec.Declined[c.Key] == changeHash(c)
}

func readRecord(dir string) *Record {
	path := filepath.Join(dir, filepath.FromSlash(RecordFile))
	info, err := os.Lstat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() > maxRecordBytes {
		return nil
	}
	var rec Record
	if !readJson(path, &rec) || rec.Template <= 0 {
		return nil
	}
	if rec.Steps == nil {
		rec.Steps = map[string]string{}
	}
	return &rec
}

func writeRecord(dir string, rec *Record) error {
	if rec == nil {
		return nil
	}
	data, err := json.MarshalIndent(rec, "", "    ")
	if err != nil {
		return err
	}
	_, err = writeProjectFile(dir, RecordFile, append(data, '\n'))
	return err
}

// templateIds are the ids the template writes; a step with another id is the developer's.
var templateIds = map[string]bool{"promote": true, "prepare": true, "reconcile": true, "finalize": true, "open-pr": true,
	"merge-pr": true, "tag": true, "rewrite-notes": true, "bump-labels": true, "close-milestone": true, "sync-back": true}

func templateId(id string) bool {
	return templateIds[id] || strings.HasPrefix(id, "changelog-") || strings.HasPrefix(id, "dispatch-")
}

// looksGenerated: without a record, a template id that runs MoltenTerm's release chain, or a hand step in the
// template's words, is the template's.
func looksGenerated(s molten.PipelineStep) bool {
	if !templateId(s.Id) || s.Cwd != "" || len(s.Env) > 0 {
		return false
	}
	if s.IsManual() {
		return strings.HasPrefix(s.Manual, "In the release worktree (")
	}
	return strings.HasPrefix(s.Run, "molten release ")
}

func generatedStep(key string, s molten.PipelineStep, rec *Record) bool {
	if rec != nil {
		return rec.Steps[key] == stepHash(s)
	}
	return looksGenerated(s)
}

func allSteps(r *molten.PipelineRelease) []molten.PipelineStep {
	if r == nil {
		return nil
	}
	return append(append([]molten.PipelineStep{}, r.Rc...), r.Public...)
}

func stepById(steps []molten.PipelineStep, id string) (molten.PipelineStep, bool) {
	for _, s := range steps {
		if s.Id == id {
			return s, true
		}
	}
	return molten.PipelineStep{}, false
}

// runArgs: the words of a step's command after a flag ("--workflow ci.yml --workflow 'a b.yml'").
func runArgs(run string, flag string) []string {
	var rtn []string
	words := strings.Fields(run)
	for i := 0; i+1 < len(words); i++ {
		if words[i] == flag {
			rtn = append(rtn, strings.Trim(words[i+1], "'\""))
		}
	}
	return rtn
}

// InferOptions reads back the choices an existing release block stands for, then applies what the facts of today
// require: a release branch that takes pull requests only switches the flow to the pull-request model.
func InferOptions(f Facts, p *molten.Pipeline) Options {
	o := DefaultOptions(f)
	o.Channels = []string{ChannelRc, ChannelPublic}
	if p == nil || p.Release == nil {
		return o
	}
	steps := allSteps(p.Release)
	has := func(id string) bool {
		_, ok := stepById(steps, id)
		return ok
	}
	single := f.Branches.Trunk == f.Branches.Release
	if !single && (has("open-pr") || has("merge-pr")) {
		o.BranchModel = BranchModelRcPr
		o.Reconcile = has("reconcile")
	}
	if merge, ok := stepById(steps, "merge-pr"); ok {
		if methods := runArgs(merge.Run, "--method"); len(methods) > 0 {
			o.Merge = methods[0]
		}
	}
	if promote, ok := stepById(steps, "promote"); ok {
		o.CiWorkflows = runArgs(promote.Run, "--workflow")
		if o.CiWorkflows == nil {
			o.CiWorkflows = []string{}
		}
	}
	o.Milestone = has("close-milestone") && f.OnGithub
	o.Notes = has("rewrite-notes")
	o.SyncBack = has("sync-back") && !single
	o.Dispatch = []DispatchChoice{}
	for _, d := range dispatchesOf(p.Release) {
		o.Dispatch = append(o.Dispatch, d)
	}
	o.Changelogs = []string{}
	if p.Versions != nil && len(p.Versions.Changelogs) > 0 {
		o.Changelogs = append(o.Changelogs, p.Versions.Changelogs...)
	} else {
		for _, s := range steps {
			if path, ok := strings.CutPrefix(s.Title, "Write the {version} section of "); ok && strings.HasPrefix(s.Id, "changelog-") {
				o.Changelogs = appendOnce(o.Changelogs, path)
			}
		}
	}
	return o
}

// dispatchesOf: the workflows the release dispatches, each on the channels whose steps run it.
func dispatchesOf(r *molten.PipelineRelease) []DispatchChoice {
	channels := map[string][]string{}
	var order []string
	for _, c := range []struct {
		channel string
		steps   []molten.PipelineStep
	}{{ChannelRc, r.Rc}, {ChannelPublic, r.Public}} {
		for _, s := range c.steps {
			rest, ok := strings.CutPrefix(s.Run, "molten release dispatch ")
			if !ok || !strings.HasPrefix(s.Id, "dispatch-") {
				continue
			}
			words := strings.Fields(rest)
			if len(words) == 0 {
				continue
			}
			file := strings.Trim(words[0], "'\"")
			if _, known := channels[file]; !known {
				order = append(order, file)
			}
			channels[file] = appendOnce(channels[file], c.channel)
		}
	}
	var rtn []DispatchChoice
	for _, file := range order {
		channel := ""
		if len(channels[file]) == 1 {
			channel = channels[file][0]
		}
		rtn = append(rtn, DispatchChoice{Workflow: file, Channel: channel})
	}
	return rtn
}

func stepText(s molten.PipelineStep) string {
	data, _ := json.MarshalIndent(s, "", "    ")
	return string(data)
}

func versionsText(v *molten.PipelineVersions) string {
	if v == nil {
		return ""
	}
	data, _ := json.MarshalIndent(v, "", "    ")
	return string(data)
}

// channelChanges compares a channel's steps with the template's, in the template's order, the removed ones last.
func channelChanges(channel string, current, proposed []molten.PipelineStep, rec *Record) []Change {
	var rtn []Change
	for _, p := range proposed {
		key := channel + "/" + p.Id
		c, ok := stepById(current, p.Id)
		if !ok {
			rtn = append(rtn, Change{Key: key, Channel: channel, Id: p.Id, Kind: ChangeAdded, Title: p.Title, After: stepText(p), Take: true})
			continue
		}
		if stepHash(c) == stepHash(p) {
			continue
		}
		custom := !generatedStep(key, c, rec)
		rtn = append(rtn, Change{Key: key, Channel: channel, Id: p.Id, Kind: ChangeChanged, Title: p.Title, Before: stepText(c), After: stepText(p),
			Customised: custom, Take: !custom})
	}
	for _, c := range current {
		if _, ok := stepById(proposed, c.Id); ok {
			continue
		}
		key := channel + "/" + c.Id
		custom := !generatedStep(key, c, rec)
		rtn = append(rtn, Change{Key: key, Channel: channel, Id: c.Id, Kind: ChangeRemoved, Title: c.Title, Before: stepText(c),
			Customised: custom, Take: !custom})
	}
	return rtn
}

func chosen(c Change, choices map[string]bool) bool {
	if take, ok := choices[c.Key]; ok {
		return take
	}
	return c.Take
}

// mergeChannel applies the choices: the template's steps in its order, a change kept as the file has it, and the steps
// the template no longer writes, when kept, after the step that came before them in the file.
func mergeChannel(channel string, current, proposed []molten.PipelineStep, changes []Change, choices map[string]bool) []molten.PipelineStep {
	byKey := map[string]Change{}
	for _, c := range changes {
		byKey[c.Key] = c
	}
	var rtn []molten.PipelineStep
	for _, p := range proposed {
		kept, inFile := stepById(current, p.Id)
		c, ok := byKey[channel+"/"+p.Id]
		switch {
		case ok && chosen(c, choices):
			rtn = append(rtn, p)
		case inFile:
			// Unchanged, kept, or a change declined at an earlier update.
			rtn = append(rtn, kept)
		}
	}
	for i, s := range current {
		if _, ok := stepById(proposed, s.Id); ok {
			continue
		}
		if c, ok := byKey[channel+"/"+s.Id]; ok && chosen(c, choices) {
			continue
		}
		at := 0
		for j := i - 1; j >= 0; j-- {
			if k := indexOf(rtn, current[j].Id); k >= 0 {
				at = k + 1
				break
			}
		}
		rtn = append(rtn[:at], append([]molten.PipelineStep{s}, rtn[at:]...)...)
	}
	return rtn
}

func indexOf(steps []molten.PipelineStep, id string) int {
	for i, s := range steps {
		if s.Id == id {
			return i
		}
	}
	return -1
}

func signatureOf(changes []Change) string {
	data, _ := json.Marshal(changes)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])[:hashChars]
}

type checked struct {
	answer   CheckAnswer
	pipeline *molten.Pipeline
	proposal Proposal
	merged   *molten.PipelineRelease
	versions *molten.PipelineVersions
	record   *Record
	text     []byte
}

func (s *Setup) check(ctx context.Context, dir string, choices map[string]bool) (*checked, error) {
	current, err := readCurrent(dir)
	if err != nil {
		return nil, err
	}
	answer := CheckAnswer{Reasons: []UpdateReason{}, Changes: []Change{}, Template: TemplateVersion, Current: string(current),
		Base: hashOf(current), Errors: []string{}, ValidateWarnings: []string{}}
	f := Detect(dir)
	if f.HasPipeline && !f.PipelineValid {
		return nil, uimsg.Errorf(uimsg.Make("mission.setup.invalid", "errors", strings.Join(f.PipelineErrors, "; ")),
			"%s is not valid: %s; fix it first (molten project validate)", molten.ProjectPipelineFile, strings.Join(f.PipelineErrors, "; "))
	}
	answer.ReleaseBranch = f.Branches.Release
	if !f.HasPipeline || len(f.Missing) > 0 {
		answer.State = UpdateStateMissing
		return &checked{answer: answer}, nil
	}
	pipeline := molten.ValidatePipeline(dir).Pipeline
	ReadRemoteFacts(ctx, s.Run, dir, &f)
	rec := readRecord(dir)
	if rec != nil {
		answer.RecordTemplate = rec.Template
	}
	o := InferOptions(f, pipeline)
	proposal := Build(f, o, pipeline)
	cur := pipeline.Release
	answer.Changes = append(answer.Changes, channelChanges(ChannelRc, cur.Rc, proposal.Release.Rc, rec)...)
	answer.Changes = append(answer.Changes, channelChanges(ChannelPublic, cur.Public, proposal.Release.Public, rec)...)
	if proposal.Versions != nil {
		answer.Changes = append(answer.Changes, Change{Key: VersionsKey, Kind: ChangeVersions, Before: versionsText(pipeline.Versions),
			After: versionsText(proposal.Versions), Take: true})
	}
	var pending []Change
	for _, c := range answer.Changes {
		if !declined(rec, c) {
			pending = append(pending, c)
		}
	}
	answer.Changes = pending
	if answer.Changes == nil {
		answer.Changes = []Change{}
	}
	answer.Reasons = updateReasons(f, pipeline, proposal, answer.Changes)
	answer.State = UpdateStateUpToDate
	if len(answer.Changes) > 0 {
		answer.State = UpdateStateUpdate
	}
	answer.Signature = signatureOf(answer.Changes)
	merged := &molten.PipelineRelease{
		Rc:     mergeChannel(ChannelRc, cur.Rc, proposal.Release.Rc, answer.Changes, choices),
		Public: mergeChannel(ChannelPublic, cur.Public, proposal.Release.Public, answer.Changes, choices),
	}
	var versions *molten.PipelineVersions
	for _, c := range answer.Changes {
		if c.Kind == ChangeVersions && chosen(c, choices) {
			versions = proposal.Versions
		}
	}
	text, err := proposedText(current, f, Proposal{Release: merged, Versions: versions})
	if err != nil {
		return nil, err
	}
	answer.Proposed = string(text)
	report := molten.ValidatePipelineData(dir, text)
	answer.Errors, answer.ValidateWarnings = report.Errors, report.Warnings
	return &checked{answer: answer, pipeline: pipeline, proposal: proposal, merged: merged, versions: versions, record: rec, text: text}, nil
}

// updateReasons says why, in the order a developer cares about: the protection first, the labels, then the template.
func updateReasons(f Facts, p *molten.Pipeline, proposal Proposal, changes []Change) []UpdateReason {
	rtn := []UpdateReason{}
	if len(changes) == 0 {
		return rtn
	}
	_, hadPr := stepById(allSteps(p.Release), "open-pr")
	if f.Protection.RequiresPr() && !hadPr {
		rtn = append(rtn, UpdateReason{Code: UpdateReasonProtected, Detail: f.Branches.Release})
	}
	if proposal.Versions != nil {
		before := 0
		if p.Versions != nil {
			before = len(p.Versions.Files)
		}
		if added := len(proposal.Versions.Files) - before; added > 0 {
			rtn = append(rtn, UpdateReason{Code: UpdateReasonLabels, Detail: fmt.Sprintf("%d", added)})
		}
	}
	template, customised := false, false
	for _, c := range changes {
		template = template || (c.Kind != ChangeVersions && !c.Customised)
		customised = customised || c.Customised
	}
	if template {
		rtn = append(rtn, UpdateReason{Code: UpdateReasonTemplate})
	}
	if customised {
		rtn = append(rtn, UpdateReason{Code: UpdateReasonCustomised})
	}
	return rtn
}

// Check compares the release setup with what this version of MoltenTerm writes; nothing is written.
func (s *Setup) Check(ctx context.Context, req CheckRequest) (CheckAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return CheckAnswer{}, err
	}
	c, err := s.check(ctx, dir, req.Choices)
	if err != nil {
		return CheckAnswer{}, err
	}
	return c.answer, nil
}

// Update writes the checked update with the developer's choices: only when the file and the list of changes are still
// the ones they approved, and only a valid pipeline.
func (s *Setup) Update(ctx context.Context, req UpdateRequest) (UpdateAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return UpdateAnswer{}, err
	}
	c, err := s.check(ctx, dir, req.Choices)
	if err != nil {
		return UpdateAnswer{}, err
	}
	if c.answer.Base != req.Base {
		return UpdateAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.changed", "path", molten.ProjectPipelineFile),
			"%s changed since the draft: draft it again", molten.ProjectPipelineFile)
	}
	if c.answer.State != UpdateStateUpdate || c.answer.Signature != req.Signature {
		return UpdateAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.updateChanged"), "the update changed since it was shown: check it again")
	}
	if len(c.answer.Errors) > 0 {
		return UpdateAnswer{}, uimsg.Errorf(uimsg.Make("mission.setup.notValid", "errors", strings.Join(c.answer.Errors, "; ")),
			"the proposed %s is not valid: %s", molten.ProjectPipelineFile, strings.Join(c.answer.Errors, "; "))
	}
	path, err := writeProjectFile(dir, molten.ProjectPipelineFile, c.text)
	if err != nil {
		return UpdateAnswer{}, err
	}
	answer := UpdateAnswer{Path: path, Warnings: c.answer.ValidateWarnings}
	rec := recordOf(&molten.Pipeline{Release: c.merged}, releaseHashes(c.proposal.Release), c.record)
	rec.Declined = map[string]string{}
	if c.record != nil {
		for key, hash := range c.record.Declined {
			rec.Declined[key] = hash
		}
	}
	for _, change := range c.answer.Changes {
		if chosen(change, req.Choices) {
			delete(rec.Declined, change.Key)
		} else {
			rec.Declined[change.Key] = changeHash(change)
		}
	}
	if err := writeRecord(dir, rec); err != nil {
		answer.Warnings = append(answer.Warnings, fmt.Sprintf("%s: %v", RecordFile, err))
	}
	return answer, nil
}

// ChangeKeys lists the keys of the changes, sorted, for tests and logs.
func ChangeKeys(changes []Change) []string {
	var rtn []string
	for _, c := range changes {
		rtn = append(rtn, c.Kind+":"+c.Key)
	}
	sort.Strings(rtn)
	return rtn
}
