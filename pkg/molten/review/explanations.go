// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"fmt"
	"slices"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
)

// The review session's answers to the developer's questions (FR-REV-006, DS-REV-007): kept with the PR so a reopened
// Review tab shows them again, on their lines. A follow-up the agent posts with an earlier answer's id replaces it in
// place; any other answer is added, newest last.

// A PR keeps its latest answers only.
const maxExplanations = 200

// Explanation is one answer card of the AI panel. Anchor is nil for an answer about the whole PR.
type Explanation struct {
	Id         string            `json:"id"`
	Question   string            `json:"question,omitempty"`
	Markdown   string            `json:"markdown"`
	Anchor     *mcpreview.Anchor `json:"anchor,omitempty"`
	Depth      string            `json:"depth,omitempty"`
	Sources    []string          `json:"sources,omitempty"`
	Related    []string          `json:"related,omitempty"`
	Principles []string          `json:"principles,omitempty"`
	// HeadOid: the head the session reviewed when the agent answered.
	HeadOid string `json:"headoid,omitempty"`
	Agent   string `json:"agent,omitempty"`
	At      int64  `json:"at"`
	// UpdatedAt: set when a follow-up replaced the answer.
	UpdatedAt int64 `json:"updatedat,omitempty"`
}

func explanationOf(post mcpreview.Post) Explanation {
	return Explanation{
		Id: post.Id, Question: post.Question, Markdown: post.Markdown, Anchor: post.Anchor, Depth: post.Depth,
		Sources: post.Sources, Related: post.Related, Principles: post.Principles, HeadOid: post.HeadOid,
		Agent: post.Agent, At: post.At,
	}
}

// SetExplanation adds an answer, or replaces the one with its id (a follow-up), keeping its first time and, when the
// follow-up names none, its question and its lines.
func (s *Store) SetExplanation(k PrKey, e Explanation) (State, bool, error) {
	if e.Id == "" || strings.TrimSpace(e.Markdown) == "" {
		return State{}, false, fmt.Errorf("the explanation needs an id and a text")
	}
	if err := checkOid(e.HeadOid, "headoid"); err != nil {
		return State{}, false, err
	}
	return s.update(k, func(state *State) bool {
		i := slices.IndexFunc(state.Explanations, func(x Explanation) bool { return x.Id == e.Id })
		if i < 0 {
			state.Explanations = append(state.Explanations, e)
			if len(state.Explanations) > maxExplanations {
				state.Explanations = state.Explanations[len(state.Explanations)-maxExplanations:]
			}
			return true
		}
		old := state.Explanations[i]
		e.UpdatedAt, e.At = e.At, old.At
		if e.Question == "" {
			e.Question = old.Question
		}
		if e.Anchor == nil {
			e.Anchor = old.Anchor
		}
		state.Explanations[i] = e
		return true
	})
}
