// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package molten

import "sort"

// Learning workflows (FR-LRN-001 to FR-LRN-004, MANIFESTO principle 9): what the developer adjusted in a guided
// workflow, kept per workflow by wavesrv in MoltenTerm's data folder (pkg/molten/learning). The windows and
// `molten learn` reach the store through a leaf of wavesrv's router; these names are shared with wsh and with the
// frontend (frontend/moltenterm-shell/learning).

// must match frontend/moltenterm-shell/learning/learning-model.ts
const (
	LearningRoute = "molten:learning"
	// LearningEvent is published, scoped to the workflow and to LearningAllScope, after each change of a workflow.
	LearningEvent    = "molten:learning"
	LearningAllScope = "all"

	LearningListCommand     = "moltenlearninglist"
	LearningDefaultsCommand = "moltenlearningdefaults"
	LearningRecordCommand   = "moltenlearningrecord"
	LearningForgetCommand   = "moltenlearningforget"
	LearningEditCommand     = "moltenlearningedit"
	LearningResetCommand    = "moltenlearningreset"

	LearningWorkflowPipelineSetup = "pipeline-setup"
	LearningWorkflowMorphDesign   = "morph-design"

	// What an item says: an answer given to a question, a step the developer skips, a correction of what the
	// workflow proposed, an option preferred among several.
	LearningKindAnswer     = "answer"
	LearningKindSkip       = "skip"
	LearningKindCorrection = "correction"
	LearningKindPreference = "preference"
	// LearningKindDone is only recorded, never stored: the developer did the step, so it is no longer skipped.
	LearningKindDone = "done"

	// Who recorded an item: the view of a window, an agent through `molten learn`, or the developer editing it.
	LearningByView  = "view"
	LearningByAgent = "agent"
	LearningByUser  = "user"

	LearningConfidenceLow    = "low"
	LearningConfidenceMedium = "medium"
	LearningConfidenceHigh   = "high"

	// A step skipped in this many runs in a row is folded; an answer is offered from the first time it is seen.
	LearningFoldAfterSeen = 2
	// Seen counts at which the confidence rises.
	LearningMediumSeen = 2
	LearningHighSeen   = 3

	LearningMaxItems = 200
	LearningMaxKey   = 64
	LearningMaxValue = 200
	LearningMaxRun   = 80
)

// LearningWorkflows lists the workflows that learn; a new workflow adds its constant here with its view.
var LearningWorkflows = []string{LearningWorkflowPipelineSetup, LearningWorkflowMorphDesign}

// LearningValueKinds are the kinds that hold a value, so offer a prefill.
var LearningValueKinds = []string{LearningKindAnswer, LearningKindCorrection, LearningKindPreference}

// LearningSource says where an item comes from: the run that last confirmed it, when, and who recorded it.
type LearningSource struct {
	Run string `json:"run,omitempty"`
	At  int64  `json:"at"`
	By  string `json:"by"`
}

// LearningItem is one thing learned. Id is "<kind>:<key>". Seen counts the runs that confirmed it; First is when it
// was first seen. Proposed is what the workflow proposed, for a correction. Edited: the developer changed the value.
type LearningItem struct {
	Id         string         `json:"id"`
	Kind       string         `json:"kind"`
	Key        string         `json:"key"`
	Value      string         `json:"value,omitempty"`
	Proposed   string         `json:"proposed,omitempty"`
	Seen       int            `json:"seen"`
	Confidence string         `json:"confidence"`
	First      int64          `json:"first"`
	Source     LearningSource `json:"source"`
	Edited     bool           `json:"edited,omitempty"`
}

// LearningRequest is the data of every learning command. Id names an item (forget, edit); Value is the new value of
// an edit or the value of a record; Run labels the run that adjusts (at most LearningMaxRun characters).
type LearningRequest struct {
	Workflow string `json:"workflow,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Key      string `json:"key,omitempty"`
	Value    string `json:"value,omitempty"`
	Proposed string `json:"proposed,omitempty"`
	Run      string `json:"run,omitempty"`
	Id       string `json:"id,omitempty"`
}

// LearningWorkflow is the items of one workflow, the most recently seen first.
type LearningWorkflow struct {
	Workflow string         `json:"workflow"`
	Items    []LearningItem `json:"items"`
}

// LearningList is every workflow that learns, those with nothing included.
type LearningList struct {
	Workflows []LearningWorkflow `json:"workflows"`
}

// LearningDefaults is what a workflow reads when it starts: the answers to prefill and the steps to fold.
type LearningDefaults struct {
	Workflow string         `json:"workflow"`
	Prefill  []LearningItem `json:"prefill"`
	Folded   []LearningItem `json:"folded"`
}

// LearningRecorded answers a record: the item as stored, none when the record cleared a skipped step.
type LearningRecorded struct {
	Item    *LearningItem `json:"item,omitempty"`
	Cleared bool          `json:"cleared,omitempty"`
}

// LearningChanged is the data of LearningEvent.
type LearningChanged struct {
	Workflow string `json:"workflow"`
}

// LearningItemId builds an item's id.
func LearningItemId(kind string, key string) string {
	return kind + ":" + key
}

// LearningConfidenceOf is the confidence a number of sightings gives.
func LearningConfidenceOf(seen int) string {
	switch {
	case seen >= LearningHighSeen:
		return LearningConfidenceHigh
	case seen >= LearningMediumSeen:
		return LearningConfidenceMedium
	}
	return LearningConfidenceLow
}

// LearningHoldsValue tells whether a kind carries a value.
func LearningHoldsValue(kind string) bool {
	for _, k := range LearningValueKinds {
		if k == kind {
			return true
		}
	}
	return false
}

// LearningDefaultsOf reads the defaults of a workflow's items: every value item is offered, most seen first, and a
// skip seen LearningFoldAfterSeen times is folded.
func LearningDefaultsOf(workflow string, items []LearningItem) LearningDefaults {
	d := LearningDefaults{Workflow: workflow, Prefill: []LearningItem{}, Folded: []LearningItem{}}
	for _, item := range items {
		switch {
		case LearningHoldsValue(item.Kind):
			d.Prefill = append(d.Prefill, item)
		case item.Kind == LearningKindSkip && item.Seen >= LearningFoldAfterSeen:
			d.Folded = append(d.Folded, item)
		}
	}
	sort.SliceStable(d.Prefill, func(i, j int) bool {
		a, b := d.Prefill[i], d.Prefill[j]
		if a.Seen != b.Seen {
			return a.Seen > b.Seen
		}
		if a.Source.At != b.Source.At {
			return a.Source.At > b.Source.At
		}
		return a.Key < b.Key
	})
	sort.SliceStable(d.Folded, func(i, j int) bool { return d.Folded[i].Key < d.Folded[j].Key })
	return d
}
