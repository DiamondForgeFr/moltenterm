// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
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
	// The changes come from the choices the developer adjusted in step 2a (#1102), not from a newer template.
	UpdateReasonAdjusted = "adjusted"
	// The developer's uncommitted edits are included as changes to check (#1102).
	UpdateReasonLocal = "local"
	// What a new setup proposes too (#1104): checks on manual steps, the formatter; offered in step 2a only.
	UpdateReasonProposed = "proposed"

	// The working copy's uncommitted edits, listed as changes of their own (#1102): one per release step
	// ("local/rc/prepare"), and one for every edit outside the release steps.
	LocalPrefix  = "local/"
	LocalFileKey = "local/file"

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
	// An uncommitted edit of the working copy (#1102): Before is the committed side, After the working copy's.
	Local bool `json:"local,omitempty"`
}

type CheckRequest struct {
	Dir string `json:"dir"`
	// The developer's choices by change key; a change not named takes its default.
	Choices map[string]bool `json:"choices,omitempty"`
	// List the working copy's uncommitted edits as changes to check, on top of the committed pipeline (#1098, #1102).
	IncludeLocal bool `json:"includelocal,omitempty"`
	// The choices the developer adjusted in step 2a (#1102); nil: the ones the pipeline stands for.
	Options *Options `json:"options,omitempty"`
	// Propose the checks on manual steps and the formatter (#1104), as step 2a does; the Release menu does not.
	Proposals bool `json:"proposals,omitempty"`
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
	// Where the pull request starts and goes (#1098).
	Pr PrPlan `json:"pr"`
	// The choices the check was made with (inferred, or adjusted), and whether the developer adjusted them (#1102).
	Options  *Options `json:"options,omitempty"`
	Adjusted bool     `json:"adjusted,omitempty"`
	// What step 2a draws (#1102): the declared steps with the ones the template adds in place, the removed ones kept.
	Drawn *molten.PipelineRelease `json:"drawn,omitempty"`
	// Where "How this project ships" opens the technical documentation (FR-MC-043); nil when there is none.
	Doc *TechDocLink `json:"doc,omitempty"`
}

type UpdateRequest struct {
	Dir       string          `json:"dir"`
	Base      string          `json:"base"`
	Signature string          `json:"signature"`
	Choices   map[string]bool `json:"choices,omitempty"`
	Options   *Options        `json:"options,omitempty"`
	Proposals bool            `json:"proposals,omitempty"`
	// The update's proposed file with the agent's ticked changes applied (#1099, #1106); "" takes the update as
	// checked. Only the keys the setup sets up are taken from it, onto the checked update, and it must be valid.
	Refined string `json:"refined,omitempty"`
	PrRequest
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

func recordText(rec *Record) ([]byte, error) {
	data, err := json.MarshalIndent(rec, "", "    ")
	if err != nil {
		return nil, err
	}
	return append(data, '\n'), nil
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
// the template no longer writes, when kept, after the step that came before them in the file. prefix names the changes
// ("" for the template's, LocalPrefix for the uncommitted edits).
func mergeChannel(prefix string, channel string, current, proposed []molten.PipelineStep, changes []Change, choices map[string]bool) []molten.PipelineStep {
	byKey := map[string]Change{}
	for _, c := range changes {
		byKey[c.Key] = c
	}
	var rtn []molten.PipelineStep
	for _, p := range proposed {
		kept, inFile := stepById(current, p.Id)
		c, ok := byKey[prefix+channel+"/"+p.Id]
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
		if c, ok := byKey[prefix+channel+"/"+s.Id]; ok && chosen(c, choices) {
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

// keptRelease lays the merged release block out with each step the file already has, unchanged, in its own text (a
// step written on one line stays on one line), so the diff shows the steps that change and nothing else (#1102).
// ok is false when the file's release block is not one it can read step by step. A step only another text has (the
// working copy's, for an included edit) keeps that text.
func keptRelease(current []byte, merged *molten.PipelineRelease, others ...[]byte) (verbatim, bool) {
	channels := map[string][]json.RawMessage{}
	for i, text := range append([][]byte{current}, others...) {
		values, err := topLevelValues(text)
		if err != nil {
			return nil, false
		}
		var read map[string][]json.RawMessage
		if json.Unmarshal(values["release"], &read) != nil {
			if i == 0 {
				return nil, false
			}
			continue
		}
		for key, raws := range read {
			if key != ChannelRc && key != ChannelPublic {
				return nil, false
			}
			channels[key] = append(channels[key], raws...)
		}
	}
	unit := indentUnit(current)
	var out strings.Builder
	out.WriteString("{\n")
	written := 0
	for _, c := range []struct {
		channel string
		steps   []molten.PipelineStep
	}{{ChannelRc, merged.Rc}, {ChannelPublic, merged.Public}} {
		if len(c.steps) == 0 {
			continue
		}
		raws := map[string]json.RawMessage{}
		for _, raw := range channels[c.channel] {
			var s molten.PipelineStep
			if json.Unmarshal(raw, &s) != nil {
				continue
			}
			if key := s.Id + "/" + stepHash(s); raws[key] == nil {
				raws[key] = raw
			}
		}
		if written > 0 {
			out.WriteString(",\n")
		}
		written++
		fmt.Fprintf(&out, "%s%q: [\n", strings.Repeat(unit, 2), c.channel)
		for i, s := range c.steps {
			out.WriteString(strings.Repeat(unit, 3))
			if raw, ok := raws[s.Id+"/"+stepHash(s)]; ok {
				out.Write(raw)
			} else {
				ordered, err := orderedTree(mustEncode(s))
				if err != nil {
					return nil, false
				}
				writePretty(&out, ordered, unit, 3)
			}
			if i < len(c.steps)-1 {
				out.WriteString(",")
			}
			out.WriteString("\n")
		}
		out.WriteString(strings.Repeat(unit, 2) + "]")
	}
	out.WriteString("\n" + unit + "}")
	return verbatim(out.String()), true
}

// keptVersions lays the new versions block out with each field the file already has, unchanged, in its own text and
// order; the new fields come after them. ok is false when the file's block cannot be read.
func keptVersions(current []byte, v *molten.PipelineVersions) (verbatim, bool) {
	values, err := topLevelValues(current)
	if err != nil {
		return nil, false
	}
	raw, ok := values["versions"]
	if !ok {
		return nil, false
	}
	order, err := objectKeys(raw)
	if err != nil {
		return nil, false
	}
	var old map[string]json.RawMessage
	if json.Unmarshal(raw, &old) != nil {
		return nil, false
	}
	encoded := mustEncode(v)
	var nextRaw map[string]json.RawMessage
	if json.Unmarshal(encoded, &nextRaw) != nil {
		return nil, false
	}
	tree, err := orderedTree(encoded)
	if err != nil {
		return nil, false
	}
	obj, ok := tree.(*orderedObject)
	if !ok {
		return nil, false
	}
	next := map[string]any{}
	for i, key := range obj.keys {
		next[key] = obj.values[i]
	}
	keys := []string{}
	for _, key := range order {
		if _, ok := next[key]; ok {
			keys = append(keys, key)
		}
	}
	for _, key := range obj.keys {
		if _, ok := old[key]; !ok {
			keys = append(keys, key)
		}
	}
	unit := indentUnit(current)
	var out strings.Builder
	out.WriteString("{\n")
	for i, key := range keys {
		fmt.Fprintf(&out, "%s%q: ", strings.Repeat(unit, 2), key)
		before, had := old[key]
		switch {
		case had && sameJson(before, nextRaw[key]):
			out.Write(before)
		case had && keptArray(&out, before, nextRaw[key], next[key], unit):
		default:
			writePretty(&out, next[key], unit, 2)
		}
		if i < len(keys)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString(unit + "}")
	return verbatim(out.String()), true
}

// keptArray writes a changed array of the versions block (its files) with each element the file already has in its
// own text; false when either side is not an array.
func keptArray(out *strings.Builder, before, after json.RawMessage, tree any, unit string) bool {
	var olds, news []json.RawMessage
	items, ok := tree.([]any)
	if json.Unmarshal(before, &olds) != nil || json.Unmarshal(after, &news) != nil || !ok || len(items) != len(news) {
		return false
	}
	out.WriteString("[\n")
	for i, item := range news {
		out.WriteString(strings.Repeat(unit, 3))
		written := false
		for _, o := range olds {
			if sameJson(o, item) {
				out.Write(o)
				written = true
				break
			}
		}
		if !written {
			writePretty(out, items[i], unit, 3)
		}
		if i < len(news)-1 {
			out.WriteString(",")
		}
		out.WriteString("\n")
	}
	out.WriteString(strings.Repeat(unit, 2) + "]")
	return true
}

// objectKeys: a JSON object's keys in the order its text writes them.
func objectKeys(raw []byte) ([]string, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if _, err := dec.Token(); err != nil {
		return nil, err
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return nil, err
		}
		key, _ := tok.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return nil, err
		}
	}
	return keys, nil
}

func sameReleases(a, b *molten.PipelineRelease) bool {
	da, _ := json.Marshal(a)
	db, _ := json.Marshal(b)
	return string(da) == string(db)
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

// What a check is made with: the developer's ticks, whether their uncommitted edits are included, and the choices
// they adjusted (nil: inferred from the pipeline).
type checkInput struct {
	choices      map[string]bool
	includeLocal bool
	options      *Options
	// Step 2a (#1102): also propose what #1104 proposes a new setup (checks on manual steps, the formatter); the
	// Release menu's check does not, so it never offers an update for them.
	proposals bool
}

// carryChecks copies the check of each declared manual step onto the template's version of it.
func carryChecks(current, proposed *molten.PipelineRelease) {
	if current == nil || proposed == nil {
		return
	}
	for _, c := range []struct{ cur, prop []molten.PipelineStep }{{current.Rc, proposed.Rc}, {current.Public, proposed.Public}} {
		for i := range c.prop {
			p := &c.prop[i]
			if p.Check != nil || !p.IsManual() {
				continue
			}
			if s, ok := stepById(c.cur, p.Id); ok && s.IsManual() && s.Check != nil {
				check := *s.Check
				p.Check = &check
			}
		}
	}
}

func sameOptions(a, b Options) bool {
	da, _ := json.Marshal(a)
	db, _ := json.Marshal(b)
	return string(da) == string(db)
}

// localChannelChanges lists a channel's uncommitted edits, step by step, in the working copy's order, the removed
// ones last. They are the developer's own: taken by default.
func localChannelChanges(channel string, committed, local []molten.PipelineStep) []Change {
	var rtn []Change
	for _, l := range local {
		key := LocalPrefix + channel + "/" + l.Id
		c, ok := stepById(committed, l.Id)
		if !ok {
			rtn = append(rtn, Change{Key: key, Channel: channel, Id: l.Id, Kind: ChangeAdded, Title: l.Title, After: stepText(l), Take: true, Local: true})
			continue
		}
		if stepHash(c) != stepHash(l) {
			rtn = append(rtn, Change{Key: key, Channel: channel, Id: l.Id, Kind: ChangeChanged, Title: l.Title, Before: stepText(c), After: stepText(l),
				Take: true, Local: true})
		}
	}
	for _, c := range committed {
		if _, ok := stepById(local, c.Id); !ok {
			rtn = append(rtn, Change{Key: LocalPrefix + channel + "/" + c.Id, Channel: channel, Id: c.Id, Kind: ChangeRemoved, Title: c.Title,
				Before: stepText(c), Take: true, Local: true})
		}
	}
	return rtn
}

// differingKeys: the top-level keys, the release block aside, whose values differ (a reformat is no difference).
func differingKeys(a, b map[string]json.RawMessage) []string {
	var rtn []string
	seen := map[string]bool{}
	for _, values := range []map[string]json.RawMessage{a, b} {
		for key := range values {
			if key == "release" || seen[key] {
				continue
			}
			seen[key] = true
			va, inA := a[key]
			vb, inB := b[key]
			if inA != inB || !sameJson(va, vb) {
				rtn = append(rtn, key)
			}
		}
	}
	sort.Strings(rtn)
	return rtn
}

func keysText(values map[string]json.RawMessage, keys []string) string {
	picked := map[string]json.RawMessage{}
	for _, key := range keys {
		if v, ok := values[key]; ok {
			picked[key] = v
		}
	}
	if len(picked) == 0 {
		return ""
	}
	data, err := json.MarshalIndent(picked, "", "    ")
	if err != nil {
		return ""
	}
	return string(data)
}

func releaseBlockOf(p *molten.Pipeline) *molten.PipelineRelease {
	if p == nil || p.Release == nil {
		return &molten.PipelineRelease{}
	}
	return p.Release
}

// withLocalEdits lists the working copy's uncommitted edits as changes (#1102) and returns the pipeline the check
// builds on: the committed file with the ticked edits. Every edit ticked gives the working copy's text as it is; a
// release step left out keeps its committed version, and the edits outside the release steps come as one change.
func withLocalEdits(dir string, b *baseFiles, choices map[string]bool) ([]byte, []Change, error) {
	included := b.IncludedPipeline
	if len(bytes.TrimSpace(b.Pipeline)) == 0 || len(bytes.TrimSpace(included)) == 0 || bytes.Equal(included, b.Pipeline) {
		return included, nil, nil
	}
	committedReport := pipelineReport(dir, b.Pipeline)
	localReport := pipelineReport(dir, included)
	if !committedReport.Valid || !localReport.Valid {
		// The check reports what makes the text invalid.
		return included, nil, nil
	}
	committed, local := releaseBlockOf(committedReport.Pipeline), releaseBlockOf(localReport.Pipeline)
	changes := append(localChannelChanges(ChannelRc, committed.Rc, local.Rc), localChannelChanges(ChannelPublic, committed.Public, local.Public)...)
	committedValues, err := topLevelValues(b.Pipeline)
	if err != nil {
		return nil, nil, err
	}
	localValues, err := topLevelValues(included)
	if err != nil {
		return nil, nil, err
	}
	if keys := differingKeys(committedValues, localValues); len(keys) > 0 {
		changes = append(changes, Change{Key: LocalFileKey, Kind: ChangeChanged, Title: strings.Join(keys, ", "),
			Before: keysText(committedValues, keys), After: keysText(localValues, keys), Take: true, Local: true})
	}
	if len(changes) == 0 {
		return b.Pipeline, nil, nil
	}
	all, file := true, false
	for _, c := range changes {
		all = all && chosen(c, choices)
		file = file || (c.Key == LocalFileKey && chosen(c, choices))
	}
	if all {
		return included, changes, nil
	}
	base := b.Pipeline
	if file {
		base = included
	}
	release := &molten.PipelineRelease{
		Rc:     mergeChannel(LocalPrefix, ChannelRc, committed.Rc, local.Rc, changes, choices),
		Public: mergeChannel(LocalPrefix, ChannelPublic, committed.Public, local.Public, changes, choices),
	}
	var value any = release
	if kept, ok := keptRelease(base, release, b.Pipeline, included); ok {
		value = kept
	}
	text, err := MergeTopLevel(base, nil, []keyValue{{Key: "release", Value: value}})
	if err != nil {
		return nil, nil, err
	}
	return text, changes, nil
}

func (s *Setup) check(ctx context.Context, dir string, b *baseFiles, in checkInput) (*checked, error) {
	current, recordData := b.buildOn(in.includeLocal)
	answer := CheckAnswer{Reasons: []UpdateReason{}, Changes: []Change{}, Template: TemplateVersion, Current: string(b.Pipeline),
		Base: hashOf(b.Pipeline), Errors: []string{}, ValidateWarnings: []string{}, Pr: s.planOf(dir, b, PrKindUpdate, in.includeLocal)}
	var local []Change
	if in.includeLocal {
		var err error
		if current, local, err = withLocalEdits(dir, b, in.choices); err != nil {
			return nil, err
		}
	}
	report := pipelineReport(dir, current)
	f := DetectWith(dir, report)
	if f.HasPipeline && !f.PipelineValid {
		return nil, uimsg.Errorf(uimsg.Make("mission.setup.invalid", "errors", strings.Join(f.PipelineErrors, "; ")),
			"%s is not valid: %s; fix it first (molten project validate)", molten.ProjectPipelineFile, strings.Join(f.PipelineErrors, "; "))
	}
	answer.ReleaseBranch = f.Branches.Release
	if !f.HasPipeline || len(f.Missing) > 0 {
		answer.State = UpdateStateMissing
		return &checked{answer: answer}, nil
	}
	pipeline := report.Pipeline
	ReadRemoteFacts(ctx, s.Run, dir, &f)
	rec := recordFrom(recordData)
	if rec != nil {
		answer.RecordTemplate = rec.Template
	}
	o := InferOptions(f, pipeline)
	if in.options != nil {
		adjusted := *in.options
		// Both channels are declared: an adjustment changes how they run, not whether they exist.
		adjusted.Channels = []string{ChannelRc, ChannelPublic}
		answer.Adjusted = !sameOptions(adjusted, o)
		o = adjusted
	}
	answer.Options = &o
	proposal := Build(f, o, pipeline)
	cur := pipeline.Release
	// A check the file already has stays: the template writes none, and an update never takes one away.
	carryChecks(cur, proposal.Release)
	if in.proposals {
		ProposeChecks(dir, f, o, proposal.Release)
		ProposeFormat(dir, o, pipeline, &proposal)
	}
	var all []Change
	all = append(all, channelChanges(ChannelRc, cur.Rc, proposal.Release.Rc, rec)...)
	all = append(all, channelChanges(ChannelPublic, cur.Public, proposal.Release.Public, rec)...)
	if proposal.Versions != nil {
		all = append(all, Change{Key: VersionsKey, Kind: ChangeVersions, Before: versionsText(pipeline.Versions),
			After: versionsText(proposal.Versions), Take: true})
	}
	var template []Change
	for _, c := range all {
		if !declined(rec, c) {
			template = append(template, c)
		}
	}
	answer.Changes = append(append([]Change{}, local...), template...)
	answer.Reasons = updateReasons(f, pipeline, proposal, template, answer.Adjusted, len(local) > 0)
	answer.State = UpdateStateUpToDate
	if len(answer.Changes) > 0 {
		answer.State = UpdateStateUpdate
	}
	answer.Signature = signatureOf(answer.Changes)
	choices := in.choices
	merged := &molten.PipelineRelease{
		Rc:     mergeChannel("", ChannelRc, cur.Rc, proposal.Release.Rc, template, choices),
		Public: mergeChannel("", ChannelPublic, cur.Public, proposal.Release.Public, template, choices),
	}
	draw := map[string]bool{}
	for _, c := range template {
		draw[c.Key] = c.Kind != ChangeRemoved
	}
	answer.Drawn = &molten.PipelineRelease{
		Rc:     mergeChannel("", ChannelRc, cur.Rc, proposal.Release.Rc, template, draw),
		Public: mergeChannel("", ChannelPublic, cur.Public, proposal.Release.Public, template, draw),
	}
	var versions *molten.PipelineVersions
	for _, c := range template {
		if c.Kind == ChangeVersions && chosen(c, choices) {
			versions = proposal.Versions
		}
	}
	// What does not change keeps its text as written: re-encoding it would show a reformat as a change.
	var values []keyValue
	if versions != nil {
		var value any = versions
		if kept, ok := keptVersions(current, versions); ok {
			value = kept
		}
		values = append(values, keyValue{Key: "versions", Value: value})
	}
	if !sameReleases(merged, cur) {
		var value any = merged
		if kept, ok := keptRelease(current, merged); ok {
			value = kept
		}
		values = append(values, keyValue{Key: "release", Value: value})
	}
	text, err := MergeTopLevel(current, []keyValue{{Key: "schema", Value: molten.PipelineSchema}, {Key: "name", Value: f.Name}}, values)
	if err != nil {
		return nil, err
	}
	answer.Proposed = string(text)
	validated := molten.ValidatePipelineData(dir, text)
	answer.Errors, answer.ValidateWarnings = validated.Errors, validated.Warnings
	return &checked{answer: answer, pipeline: pipeline, proposal: proposal, merged: merged, versions: versions, record: rec, text: text}, nil
}

// updateReasons says why, in the order a developer cares about: their own edits, the protection, the labels, then the
// template or their adjustment.
func updateReasons(f Facts, p *molten.Pipeline, proposal Proposal, changes []Change, adjusted bool, local bool) []UpdateReason {
	rtn := []UpdateReason{}
	if local {
		rtn = append(rtn, UpdateReason{Code: UpdateReasonLocal})
	}
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
	template, customised, proposed := false, false, false
	for _, c := range changes {
		if proposedOnly(c) {
			proposed = true
			continue
		}
		template = template || (c.Kind != ChangeVersions && !c.Customised)
		customised = customised || c.Customised
	}
	switch {
	case template && adjusted:
		rtn = append(rtn, UpdateReason{Code: UpdateReasonAdjusted})
	case template:
		rtn = append(rtn, UpdateReason{Code: UpdateReasonTemplate})
	}
	if proposed {
		rtn = append(rtn, UpdateReason{Code: UpdateReasonProposed})
	}
	if customised {
		rtn = append(rtn, UpdateReason{Code: UpdateReasonCustomised})
	}
	return rtn
}

// proposedOnly: a change that only adds what step 2a proposes (#1104): a check on a manual step, or the formatter.
func proposedOnly(c Change) bool {
	switch c.Kind {
	case ChangeChanged:
		var before, after molten.PipelineStep
		if json.Unmarshal([]byte(c.Before), &before) != nil || json.Unmarshal([]byte(c.After), &after) != nil {
			return false
		}
		if before.Check != nil || after.Check == nil {
			return false
		}
		after.Check = nil
		return stepHash(before) == stepHash(after)
	case ChangeVersions:
		var before, after molten.PipelineVersions
		if c.Before != "" && json.Unmarshal([]byte(c.Before), &before) != nil {
			return false
		}
		if json.Unmarshal([]byte(c.After), &after) != nil || before.Format != "" || after.Format == "" {
			return false
		}
		after.Format = ""
		return versionsText(&before) == versionsText(&after)
	}
	return false
}

// Check compares the release setup with what this version of MoltenTerm writes; nothing is written.
func (s *Setup) Check(ctx context.Context, req CheckRequest) (CheckAnswer, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return CheckAnswer{}, err
	}
	b, err := s.readBase(ctx, dir)
	if err != nil {
		return CheckAnswer{}, err
	}
	if err := b.includable(req.IncludeLocal); err != nil {
		return CheckAnswer{}, err
	}
	c, err := s.check(ctx, dir, b, checkInput{choices: req.Choices, includeLocal: req.IncludeLocal, options: req.Options, proposals: req.Proposals})
	if err != nil {
		return CheckAnswer{}, err
	}
	c.answer.Doc = s.TechDocLinkOf(ctx, dir, b)
	return c.answer, nil
}

// Update opens the pull request of the checked update with the developer's choices (#1098): only when the committed
// file and the list of changes are still the ones they approved, and only a valid pipeline. It answers at once with
// the job; PrState follows it.
func (s *Setup) Update(ctx context.Context, req UpdateRequest) (PrJob, error) {
	dir, err := checkProjectDir(req.Dir)
	if err != nil {
		return PrJob{}, err
	}
	if err := s.checkPrRequest(dir, PrKindUpdate, &req.PrRequest); err != nil {
		return PrJob{}, err
	}
	trunk := molten.ResolvedBranches(dir).Trunk
	job := &PrJob{Dir: dir, Kind: PrKindUpdate, Mode: req.Mode, Target: prTarget(dir, trunk), OnGithub: onGithub(dir), Ref: "origin/" + trunk}
	backend := s.docBackend(ctx, dir, req.Mode)
	return s.startJob(job, techDocSteps(jobSteps(dir, req.PrRequest), backend), func(ctx context.Context, job *PrJob) error {
		b, err := s.prepareBase(ctx, dir, req.Base, req.PrRequest, job)
		if err != nil {
			return err
		}
		c, err := s.check(ctx, dir, b, checkInput{choices: req.Choices, includeLocal: req.IncludeLocal, options: req.Options, proposals: req.Proposals})
		if err != nil {
			return fail(PrFailureFailed, err.Error())
		}
		if c.answer.State != UpdateStateUpdate || c.answer.Signature != req.Signature {
			return fail(PrFailureUpdateChanged, "")
		}
		if len(c.answer.Errors) > 0 {
			return fail(PrFailureInvalid, strings.Join(c.answer.Errors, "; "))
		}
		if req.Refined != "" {
			if err := refineChecked(dir, c, req.Refined); err != nil {
				return err
			}
		}
		files, err := updateFilesOf(c, req.Choices)
		if err != nil {
			return err
		}
		s.withTechDoc(dir, b, nil, &files, PrKindUpdate, req.Mode, backend)
		s.update(job, func(j *PrJob) { j.Files = append([]string{}, files.order...) })
		return s.runPr(ctx, dir, b, files, req.PrRequest, job)
	})
}

// refineChecked puts the agent's ticked changes on the checked update: the owned keys of the refined text onto the
// update's file, validated. A step the agent changed no longer matches the template's, so the record keeps it as the
// developer's, as an edit by hand would be.
func refineChecked(dir string, c *checked, refined string) error {
	if len(refined) > maxPipelineBytes {
		return fail(PrFailureInvalid, fmt.Sprintf("the proposed %s is too large", molten.ProjectPipelineFile))
	}
	merged, _, err := MergeOwned(c.text, []byte(refined), nameOf(dir, c.text))
	if err != nil {
		return fail(PrFailureInvalid, err.Error())
	}
	report := molten.ValidatePipelineData(dir, merged)
	if !report.Valid || report.Pipeline == nil {
		return fail(PrFailureInvalid, strings.Join(report.Errors, "; "))
	}
	c.text = merged
	if report.Pipeline.Release != nil {
		c.merged = report.Pipeline.Release
	}
	return nil
}

// updateFilesOf: the updated pipeline, and the record of the steps MoltenTerm wrote and the changes declined.
func updateFilesOf(c *checked, choices map[string]bool) (prFiles, error) {
	var files prFiles
	files.add(molten.ProjectPipelineFile, c.text)
	rec := recordOf(&molten.Pipeline{Release: c.merged}, releaseHashes(c.proposal.Release), c.record)
	rec.Declined = map[string]string{}
	if c.record != nil {
		for key, hash := range c.record.Declined {
			rec.Declined[key] = hash
		}
	}
	for _, change := range c.answer.Changes {
		// An uncommitted edit left out is the developer's, not a template change to remember as declined.
		if change.Local {
			continue
		}
		if chosen(change, choices) {
			delete(rec.Declined, change.Key)
		} else {
			rec.Declined[change.Key] = changeHash(change)
		}
	}
	data, err := recordText(rec)
	if err != nil {
		return prFiles{}, err
	}
	files.add(RecordFile, data)
	return files, nil
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
