// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package reviewsession

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewlang"
)

// Translation for publication (FR-REV-010, DS-REV-008): Publish review hands the staged comments not yet in the
// publication language to the session; they become review_context's translate and one line is typed into the agent's
// terminal through the guarded path Ask the AI takes. The agent gives each translation with review_set_translation,
// accepted only for an item of the latest request.

const (
	translateLinePrefix = "MoltenTerm: translate"
	translateNote       = "Translate each item's text into the publication language for the PR's author and give it " +
		"with review_set_translation (commentid = the item's id). Keep code identifiers, paths, quoted code and markdown " +
		"unchanged; keep the meaning, the tone and the kind (a change request stays one). Translate only, add nothing."
	maxTranslateItems = 500
)

type translateInfo struct {
	Lang     string                    `json:"lang"`
	LangName string                    `json:"langname,omitempty"`
	Items    []mcpreview.TranslateItem `json:"items"`
	Note     string                    `json:"note"`
}

// TranslateLine is the line typed to ask for the translations.
func TranslateLine(req mcpreview.TranslateRequest) string {
	what := fmt.Sprintf("%d review comments", len(req.Items))
	if len(req.Items) == 1 {
		what = "1 review text"
	}
	name := req.LangName
	if name == "" {
		name = reviewlang.Name(req.Lang)
	}
	return fmt.Sprintf("%s %s into %s (%s) for publication on GitHub. review_context lists them under translate; give "+
		"each one with review_set_translation, keeping code identifiers, paths and quoted code unchanged.",
		translateLinePrefix, what, name, reviewlang.Normalize(req.Lang))
}

// Translate asks the PR's session for the translations (wavesrv's review service calls it); when the
// sessions were not started or the PR has none, the result says the session ended.
func Translate(ctx context.Context, req mcpreview.TranslateRequest) (mcpreview.AskResult, error) {
	manager := liveManager.Load()
	if manager == nil {
		return askSessionEnded(), nil
	}
	return manager.Translate(ctx, req)
}

// Translate keeps the request in the session and types its line into the agent's terminal.
func (m *Manager) Translate(ctx context.Context, req mcpreview.TranslateRequest) (mcpreview.AskResult, error) {
	m.ensureLoaded(ctx)
	if reviewlang.Normalize(req.Lang) == "" {
		return mcpreview.AskResult{}, errors.New("the publication language is missing")
	}
	if len(req.Items) == 0 {
		return mcpreview.AskResult{}, errors.New("there is nothing to translate")
	}
	if len(req.Items) > maxTranslateItems {
		return mcpreview.AskResult{}, errors.New(mcpreview.ErrTooLarge)
	}
	for _, item := range req.Items {
		if item.Id == "" || strings.TrimSpace(item.Text) == "" {
			return mcpreview.AskResult{}, errors.New("each text to translate needs its id and text")
		}
		if len(item.Text) > mcpreview.MaxResultBytes {
			return mcpreview.AskResult{}, errors.New(mcpreview.ErrTooLarge)
		}
	}
	s := m.find(req.SessionKey)
	if s == nil {
		return askSessionEnded(), nil
	}
	if m.env.TypePrompt == nil {
		return askCannotType(), nil
	}
	kept := req
	kept.Items = append([]mcpreview.TranslateItem(nil), req.Items...)
	m.setTranslation(s, &kept)
	line := TranslateLine(req)
	out := m.typeLine(ctx, s, line)
	return mcpreview.AskResult{Sent: out.Sent, Submitted: out.Submitted, Busy: out.Retry && !out.Starting, Starting: out.Starting, Line: line, Message: out.Message, Reason: out.Reason, Program: out.Program}, nil
}

func (m *Manager) setTranslation(s *session, req *mcpreview.TranslateRequest) {
	m.lock.Lock()
	defer m.lock.Unlock()
	s.translation = req
}

func (m *Manager) translationOf(s *session) *translateInfo {
	m.lock.Lock()
	defer m.lock.Unlock()
	if s.translation == nil {
		return nil
	}
	name := s.translation.LangName
	if name == "" {
		name = reviewlang.Name(s.translation.Lang)
	}
	return &translateInfo{Lang: reviewlang.Normalize(s.translation.Lang), LangName: name, Items: s.translation.Items, Note: translateNote}
}

// translationLang is the language of the latest request when it names the item, "" otherwise. The caller holds m.lock.
func translationLang(s *session, id string) string {
	if s.translation == nil {
		return ""
	}
	for _, item := range s.translation.Items {
		if item.Id == id {
			return reviewlang.Normalize(s.translation.Lang)
		}
	}
	return ""
}
