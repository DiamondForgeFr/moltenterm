// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

// Agent proposals as step changes (#1099, FR-MC-039): whatever coding agent helps, it answers with a list of changes to
// the draft's release steps and versions block, never a file. MoltenTerm checks each change on its own, lists the ones
// it cannot take with their reason, and applies only the ones the developer ticks. The contract is the same for every
// agentic CLI: the adapters only differ in how the prompt reaches the agent.

const (
	ChangeOpAdd      = "add"
	ChangeOpChange   = "change"
	ChangeOpRemove   = "remove"
	ChangeOpVersions = "versions"

	// Why a proposed change is not offered, read by the frontend as mc.setup.proposal.rejected.<code>.
	RejectOutside   = "outside"
	RejectMalformed = "malformed"
	RejectMissing   = "missing"
	RejectExists    = "exists"
	RejectConflict  = "conflict"
	RejectUnchanged = "unchanged"
	RejectCommand   = "command"
	RejectInvalid   = "invalid"
	RejectTooMany   = "toomany"

	maxProposedChanges = 40
	maxRejectedText    = 300
)

// The versions fields a proposal may set. notesagent is an argv the release runs to write the notes: an agent may not
// choose which program runs later, so it is refused (the developer's own edit only).
var proposalVersionFields = map[string]bool{"tagprefix": true, "notes": true, "firstpublic": true, "files": true, "changelogs": true}

// The pipeline's other top-level keys: a change that names one is outside what the setup proposes.
var pipelineTopKeys = map[string]bool{"schema": true, "name": true, "group": true, "dependson": true, "icon": true, "branches": true,
	"ci": true, "builds": true, "release": true, "steps": true, "launch": true}

var (
	errWholeFile = errors.New("the answer is a whole pipeline file, not a list of changes")
	errNoChanges = errors.New("the answer holds no list of changes")
)

// StepChange is one change the agent proposes, as checked by MoltenTerm: the frontend shows it and sends it back to
// Apply, which checks it again.
type StepChange struct {
	Key     string `json:"key"`
	Op      string `json:"op"`
	Channel string `json:"channel,omitempty"`
	Id      string `json:"id,omitempty"`
	// Where an added step goes: after or before a step of its channel; neither: after the last step of its phase.
	After  string               `json:"after,omitempty"`
	Before string               `json:"before,omitempty"`
	Step   *molten.PipelineStep `json:"step,omitempty"`
	// The versions fields to set, the others stay.
	Versions json.RawMessage `json:"versions,omitempty"`
	Why      string          `json:"why,omitempty"`
	// For the card: the step's title, and the text before and after (as the file writes them).
	Title   string `json:"title,omitempty"`
	OldText string `json:"oldtext,omitempty"`
	NewText string `json:"newtext,omitempty"`
}

// RejectedChange is a proposed change MoltenTerm does not offer: its text as the agent wrote it, and why.
type RejectedChange struct {
	Text   string `json:"text"`
	Code   string `json:"code"`
	Detail string `json:"detail,omitempty"`
}

type agentChange struct {
	Op       string          `json:"op"`
	Channel  string          `json:"channel,omitempty"`
	Id       string          `json:"id,omitempty"`
	After    string          `json:"after,omitempty"`
	Before   string          `json:"before,omitempty"`
	Step     json.RawMessage `json:"step,omitempty"`
	Versions json.RawMessage `json:"versions,omitempty"`
	Why      string          `json:"why,omitempty"`
}

// present: a value was given ("null" is none).
func present(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && string(trimmed) != "null"
}

// changeJson takes the agent's JSON out of its answer: inside a code fence if there is one, else from the first brace
// or bracket to the last one of the same kind.
func changeJson(out []byte) []byte {
	text := string(out)
	if m := fenceJsonRegex.FindStringSubmatch(text); m != nil {
		text = m[1]
	}
	obj, list := strings.Index(text, "{"), strings.Index(text, "[")
	open, close := "{", "}"
	if list >= 0 && (obj < 0 || list < obj) {
		open, close = "[", "]"
	}
	start, end := strings.Index(text, open), strings.LastIndex(text, close)
	if start < 0 || end < start {
		return nil
	}
	return []byte(text[start : end+1])
}

// ParseChanges reads the agent's answer: {"changes": [...]}, or the list alone. A whole pipeline file is refused, so
// nothing of it is taken.
func ParseChanges(out []byte) ([]json.RawMessage, error) {
	data := changeJson(out)
	if data == nil {
		return nil, errNoChanges
	}
	var list []json.RawMessage
	if json.Unmarshal(data, &list) == nil {
		return list, nil
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(data, &obj); err != nil {
		return nil, errNoChanges
	}
	if raw, ok := obj["changes"]; ok {
		if err := json.Unmarshal(raw, &list); err != nil {
			return nil, errNoChanges
		}
		return list, nil
	}
	for key := range obj {
		if pipelineTopKeys[key] || key == "versions" {
			return nil, errWholeFile
		}
	}
	return nil, errNoChanges
}

func compactText(raw json.RawMessage) string {
	var b bytes.Buffer
	text := string(raw)
	if json.Compact(&b, raw) == nil {
		text = b.String()
	}
	if len(text) > maxRejectedText {
		text = text[:maxRejectedText] + "…"
	}
	return text
}

func strictDecode(raw json.RawMessage, into any) error {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(into); err != nil {
		return err
	}
	if dec.More() {
		return errors.New("more than one value")
	}
	return nil
}

// unknownField names the field strictDecode refused, "" for another error.
func unknownField(err error) string {
	field, ok := strings.CutPrefix(err.Error(), "json: unknown field ")
	if !ok {
		return ""
	}
	return strings.Trim(field, `"`)
}

func reject(raw json.RawMessage, code string, detail string) *RejectedChange {
	return &RejectedChange{Text: compactText(raw), Code: code, Detail: detail}
}

// decodeChange turns one entry of the agent's list into a StepChange, or says why it is not one.
func decodeChange(raw json.RawMessage) (StepChange, *RejectedChange) {
	var loose struct {
		Op string `json:"op"`
	}
	if err := json.Unmarshal(raw, &loose); err != nil {
		return StepChange{}, reject(raw, RejectMalformed, err.Error())
	}
	switch loose.Op {
	case ChangeOpAdd, ChangeOpChange, ChangeOpRemove, ChangeOpVersions:
	default:
		return StepChange{}, reject(raw, RejectOutside, loose.Op)
	}
	var a agentChange
	if err := strictDecode(raw, &a); err != nil {
		if field := unknownField(err); pipelineTopKeys[field] || field == "file" || field == "path" || field == "key" {
			return StepChange{}, reject(raw, RejectOutside, field)
		}
		return StepChange{}, reject(raw, RejectMalformed, err.Error())
	}
	c := StepChange{Op: a.Op, Channel: a.Channel, Id: a.Id, After: a.After, Before: a.Before, Why: strings.TrimSpace(a.Why)}
	switch a.Op {
	case ChangeOpAdd, ChangeOpChange, ChangeOpRemove:
		if a.Channel != ChannelRc && a.Channel != ChannelPublic {
			return StepChange{}, reject(raw, RejectMalformed, fmt.Sprintf("channel %q is neither rc nor public", a.Channel))
		}
		if present(a.Versions) {
			return StepChange{}, reject(raw, RejectMalformed, "a step change carries no versions")
		}
	case ChangeOpVersions:
		if present(a.Step) || a.Channel != "" || a.Id != "" {
			return StepChange{}, reject(raw, RejectMalformed, "a versions change carries only versions")
		}
	}
	if a.Op == ChangeOpAdd || a.Op == ChangeOpChange {
		if !present(a.Step) {
			return StepChange{}, reject(raw, RejectMalformed, "no step")
		}
		var step molten.PipelineStep
		if err := strictDecode(a.Step, &step); err != nil {
			return StepChange{}, reject(raw, RejectMalformed, err.Error())
		}
		if a.Op == ChangeOpAdd && c.Id == "" {
			c.Id = step.Id
		}
		if step.Id == "" {
			step.Id = c.Id
		}
		if step.Id != c.Id {
			return StepChange{}, reject(raw, RejectMalformed, fmt.Sprintf("the step's id %q is not %q", step.Id, c.Id))
		}
		c.Step = &step
	}
	if a.Op != ChangeOpVersions && c.Id == "" {
		return StepChange{}, reject(raw, RejectMalformed, "no step id")
	}
	if a.Op == ChangeOpRemove && present(a.Step) {
		return StepChange{}, reject(raw, RejectMalformed, "a removal carries no step")
	}
	if a.Op != ChangeOpAdd && (a.After != "" || a.Before != "") {
		return StepChange{}, reject(raw, RejectMalformed, "only an added step has a place")
	}
	if a.After != "" && a.Before != "" {
		return StepChange{}, reject(raw, RejectMalformed, "after and before are both set")
	}
	if a.Op == ChangeOpVersions {
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(a.Versions, &fields); err != nil || len(fields) == 0 {
			return StepChange{}, reject(raw, RejectMalformed, "versions is not an object of fields")
		}
		names := make([]string, 0, len(fields))
		for name := range fields {
			names = append(names, name)
		}
		sort.Strings(names)
		for _, name := range names {
			if name == "notesagent" {
				return StepChange{}, reject(raw, RejectCommand, name)
			}
			if !proposalVersionFields[name] {
				return StepChange{}, reject(raw, RejectMalformed, "unknown versions field "+name)
			}
		}
		c.Versions = a.Versions
	}
	return c, nil
}

func channelSteps(r *molten.PipelineRelease, channel string) []molten.PipelineStep {
	if r == nil {
		return nil
	}
	if channel == ChannelRc {
		return r.Rc
	}
	return r.Public
}

func setChannelSteps(r *molten.PipelineRelease, channel string, steps []molten.PipelineStep) {
	if channel == ChannelRc {
		r.Rc = steps
		return
	}
	r.Public = steps
}

// placeOf: where an added step goes when its anchor is not in the channel, after the last step of its phase, before the
// first step of a later phase, or last.
func placeOf(steps []molten.PipelineStep, step molten.PipelineStep) int {
	phase := slicesIndex(molten.PipelineReleasePhases, step.Phase)
	if phase < 0 {
		return len(steps)
	}
	phases := molten.ReleaseStepPhase(steps)
	at := -1
	for i := range steps {
		p := slicesIndex(molten.PipelineReleasePhases, phases[i])
		if p == phase {
			at = i + 1
		}
		if p > phase && at < 0 {
			return i
		}
	}
	if at >= 0 {
		return at
	}
	return len(steps)
}

func slicesIndex(list []string, value string) int {
	for i, v := range list {
		if v == value {
			return i
		}
	}
	return -1
}

func copyRelease(r *molten.PipelineRelease) *molten.PipelineRelease {
	if r == nil {
		return &molten.PipelineRelease{}
	}
	return &molten.PipelineRelease{Rc: append([]molten.PipelineStep(nil), r.Rc...), Public: append([]molten.PipelineStep(nil), r.Public...)}
}

func copyVersions(v *molten.PipelineVersions) (*molten.PipelineVersions, error) {
	rtn := &molten.PipelineVersions{}
	if v == nil {
		return rtn, nil
	}
	data, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return rtn, json.Unmarshal(data, rtn)
}

// applyOne applies a checked change to the release and versions blocks. A step to change or remove that is gone, or
// an added step already there, is an error: the caller checked it against the same blocks.
func applyOne(rel *molten.PipelineRelease, ver **molten.PipelineVersions, c StepChange) error {
	if c.Op == ChangeOpVersions {
		next, err := copyVersions(*ver)
		if err != nil {
			return err
		}
		if err := strictDecode(c.Versions, next); err != nil {
			return err
		}
		*ver = next
		return nil
	}
	steps := channelSteps(rel, c.Channel)
	i := indexOf(steps, c.Id)
	switch c.Op {
	case ChangeOpAdd:
		if i >= 0 {
			return fmt.Errorf("%s/%s already exists", c.Channel, c.Id)
		}
		at := -1
		if c.After != "" {
			if j := indexOf(steps, c.After); j >= 0 {
				at = j + 1
			}
		} else if c.Before != "" {
			at = indexOf(steps, c.Before)
		}
		if at < 0 {
			at = placeOf(steps, *c.Step)
		}
		steps = append(steps[:at], append([]molten.PipelineStep{*c.Step}, steps[at:]...)...)
	case ChangeOpChange:
		if i < 0 {
			return fmt.Errorf("%s/%s does not exist", c.Channel, c.Id)
		}
		steps[i] = *c.Step
	case ChangeOpRemove:
		if i < 0 {
			return fmt.Errorf("%s/%s does not exist", c.Channel, c.Id)
		}
		steps = append(steps[:i], steps[i+1:]...)
	}
	setChannelSteps(rel, c.Channel, steps)
	return nil
}

func readPipelineText(text []byte) (*molten.Pipeline, error) {
	var p molten.Pipeline
	if err := json.Unmarshal(text, &p); err != nil {
		return nil, fmt.Errorf("the draft is not a JSON object: %w", err)
	}
	return &p, nil
}

// applyChanges writes the changes into the draft's text: only the release and versions keys change, in the file's own
// layout, everything else byte for byte.
func applyChanges(text []byte, changes []StepChange) ([]byte, error) {
	p, err := readPipelineText(text)
	if err != nil {
		return nil, err
	}
	rel, ver := copyRelease(p.Release), p.Versions
	releaseChanged, versionsChanged := false, false
	for _, c := range changes {
		if err := applyOne(rel, &ver, c); err != nil {
			return nil, err
		}
		releaseChanged = releaseChanged || c.Op != ChangeOpVersions
		versionsChanged = versionsChanged || c.Op == ChangeOpVersions
	}
	var values []keyValue
	if versionsChanged {
		values = append(values, keyValue{Key: "versions", Value: ver})
	}
	if releaseChanged {
		values = append(values, keyValue{Key: "release", Value: rel})
	}
	return MergeTopLevel(text, nil, values)
}

func newErrors(base, now []string) []string {
	known := map[string]bool{}
	for _, e := range base {
		known[e] = true
	}
	var rtn []string
	for _, e := range now {
		if !known[e] {
			rtn = append(rtn, e)
		}
	}
	return rtn
}

// CheckChanges checks the agent's changes one by one against the draft: a change is offered only when it applies on
// its own and leaves a valid pipeline; two changes of one step keep the first.
func CheckChanges(dir string, text []byte, raws []json.RawMessage) ([]StepChange, []RejectedChange, error) {
	p, err := readPipelineText(text)
	if err != nil {
		return nil, nil, err
	}
	baseErrors := molten.ValidatePipelineData(dir, text).Errors
	offered, rejected := []StepChange{}, []RejectedChange{}
	touched := map[string]bool{}
	for n, raw := range raws {
		if n >= maxProposedChanges {
			rejected = append(rejected, RejectedChange{Text: fmt.Sprintf("%d", len(raws)-n), Code: RejectTooMany})
			break
		}
		c, r := decodeChange(raw)
		if r == nil {
			r = checkAgainst(dir, text, p, baseErrors, touched, &c, raw)
		}
		if r != nil {
			rejected = append(rejected, *r)
			continue
		}
		c.Key = strconv.Itoa(len(offered) + 1)
		touched[c.Channel+"/"+c.Id] = true
		offered = append(offered, c)
	}
	return offered, rejected, nil
}

func checkAgainst(dir string, text []byte, p *molten.Pipeline, baseErrors []string, touched map[string]bool, c *StepChange, raw json.RawMessage) *RejectedChange {
	target := c.Channel + "/" + c.Id
	if touched[target] {
		return reject(raw, RejectConflict, target)
	}
	if c.Op != ChangeOpVersions {
		steps := channelSteps(p.Release, c.Channel)
		current, exists := stepById(steps, c.Id)
		switch {
		case c.Op == ChangeOpAdd && exists:
			return reject(raw, RejectExists, target)
		case c.Op != ChangeOpAdd && !exists:
			return reject(raw, RejectMissing, target)
		case c.Op == ChangeOpChange && stepHash(current) == stepHash(*c.Step):
			return reject(raw, RejectUnchanged, target)
		}
		c.Title = c.Id
		if exists {
			c.OldText, c.Title = stepText(current), titleOr(current.Title, c.Id)
		}
		if c.Step != nil {
			c.NewText, c.Title = stepText(*c.Step), titleOr(c.Step.Title, c.Id)
		}
	}
	applied, err := applyChanges(text, []StepChange{*c})
	if err != nil {
		return reject(raw, RejectMalformed, err.Error())
	}
	if c.Op == ChangeOpVersions {
		after, _ := readPipelineText(applied)
		c.OldText, c.NewText = versionsText(p.Versions), versionsText(after.Versions)
		if c.OldText == c.NewText {
			return reject(raw, RejectUnchanged, "versions")
		}
	}
	if errs := newErrors(baseErrors, molten.ValidatePipelineData(dir, applied).Errors); len(errs) > 0 {
		return reject(raw, RejectInvalid, strings.Join(errs, "; "))
	}
	return nil
}

func titleOr(title, id string) string {
	if strings.TrimSpace(title) != "" {
		return title
	}
	return id
}

// chosenChanges: the offered changes the developer ticked, checked again against the draft (the list comes back from
// the frontend), in their order.
func chosenChanges(dir string, text []byte, changes []StepChange, chosen []string) ([]StepChange, error) {
	want := map[string]bool{}
	for _, key := range chosen {
		want[key] = true
	}
	var raws []json.RawMessage
	for _, c := range changes {
		if !want[c.Key] {
			continue
		}
		raw, err := json.Marshal(agentChange{Op: c.Op, Channel: c.Channel, Id: c.Id, After: c.After, Before: c.Before,
			Step: mustStep(c.Step), Versions: c.Versions, Why: c.Why})
		if err != nil {
			return nil, err
		}
		raws = append(raws, raw)
	}
	offered, rejected, err := CheckChanges(dir, text, raws)
	if err != nil {
		return nil, err
	}
	if len(rejected) > 0 {
		return nil, fmt.Errorf("a change is no longer valid: %s (%s)", rejected[0].Text, rejected[0].Code)
	}
	return offered, nil
}

func mustStep(s *molten.PipelineStep) json.RawMessage {
	if s == nil {
		return nil
	}
	data, _ := json.Marshal(s)
	return data
}
