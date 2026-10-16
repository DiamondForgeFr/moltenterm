// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/molten/reviewlang"
	"github.com/wavetermdev/waveterm/pkg/molten/uimsg"
)

// The publication language and the translations (FR-REV-010 AC1, AC2, DS-REV-008). The publication language is the
// project's (.saasfoundry.json language.tickets), else the review:publishlanguage setting, else the one the project's
// pull requests and README are written in, else English. Publish review asks the review session to translate the
// staged comments that are in another language (and the summary); the agent's translations, and the developer's own
// edits of them, are kept with each comment. A developer's edit is never replaced by the agent's.

const (
	EventTranslated = "translated"
	EventPublished  = "published"

	// The publication language is read again after this long (the PR history may say more).
	languageTtl = 10 * time.Minute
	// The recent pull requests the language is detected from.
	languagePrCount = 20
)

// Summary is the next review's optional summary in the developer's language, and its translation.
type Summary struct {
	Original    CommentText  `json:"original"`
	Translation *CommentText `json:"translation,omitempty"`
}

// PublishInfoRequest asks for the publication language of a PR's project.
type PublishInfoRequest struct {
	PrKey
	Dir string `json:"dir"`
}

// TranslateRequest is the Publish sheet asking the session for the translations; All asks again for those the agent
// already gave (never the developer's own).
type TranslateRequest struct {
	PrKey
	Dir string `json:"dir"`
	All bool   `json:"all,omitempty"`
}

type TranslateResult struct {
	mcpreview.AskResult
	Language reviewlang.Resolution `json:"language"`
	// Count: the texts sent; 0 when none needs a translation (nothing was typed).
	Count int `json:"count"`
}

// TranslationRequest is the developer's own translation of a comment (Id) or of the summary (mcpreview.SummaryId);
// an empty text clears it.
type TranslationRequest struct {
	PrKey
	Id   string `json:"id"`
	Text string `json:"text"`
	Lang string `json:"lang"`
}

// SummaryRequest sets the next review's summary in the developer's language; an empty text removes it.
type SummaryRequest struct {
	PrKey
	Text string `json:"text"`
	Lang string `json:"lang,omitempty"`
}

type languageEntry struct {
	res reviewlang.Resolution
	at  time.Time
}

type languageCache struct {
	lock    sync.Mutex
	entries map[string]languageEntry
}

func (c *languageCache) get(key string, now time.Time) (reviewlang.Resolution, bool) {
	c.lock.Lock()
	defer c.lock.Unlock()
	e, ok := c.entries[key]
	if !ok || now.Sub(e.at) > languageTtl {
		return reviewlang.Resolution{}, false
	}
	return e.res, true
}

func (c *languageCache) put(key string, res reviewlang.Resolution, now time.Time) {
	c.lock.Lock()
	defer c.lock.Unlock()
	if c.entries == nil {
		c.entries = map[string]languageEntry{}
	}
	c.entries[key] = languageEntry{res: res, at: now}
}

// PublicationLanguage resolves the PR's publication language. The pull requests are read through the developer's gh
// only when neither the project nor the setting names a language, and at most once every languageTtl.
func (s *Service) PublicationLanguage(ctx context.Context, req PublishInfoRequest) (reviewlang.Resolution, error) {
	if err := req.check(); err != nil {
		return reviewlang.Resolution{}, err
	}
	if err := checkDir(req.Dir); err != nil {
		return reviewlang.Resolution{}, err
	}
	setting := ""
	if s.publishSetting != nil {
		setting = s.publishSetting()
	}
	key := req.Dir + "\x00" + strings.ToLower(req.Repo) + "\x00" + setting
	now := time.Now()
	if res, ok := s.languages.get(key, now); ok {
		return res, nil
	}
	res := reviewlang.Resolve(reviewlang.Inputs{
		ProjectDir: req.Dir,
		ReadFile:   s.readFile,
		Setting:    setting,
		Texts:      func() []string { return s.prTexts(ctx, req.Dir, req.Repo) },
	})
	s.languages.put(key, res, now)
	return res, nil
}

// prTexts: the titles and bodies of the repository's recent pull requests, nothing when gh cannot read them.
func (s *Service) prTexts(ctx context.Context, dir string, repo string) []string {
	var prs []struct {
		Title string `json:"title"`
		Body  string `json:"body"`
	}
	out, err := s.ghCall(ctx, dir, "pr", "list", "--repo", repo, "--state", "all", "--limit", strconv.Itoa(languagePrCount), "--json", "title,body")
	if err != nil || decodeJson(out, &prs) != nil {
		return nil
	}
	var rtn []string
	for _, pr := range prs {
		rtn = append(rtn, pr.Title, pr.Body)
	}
	return rtn
}

// publishable: the comments the next review takes (staged, translated), in their order.
func publishable(state *State) []*Comment {
	var rtn []*Comment
	for i := range state.Comments {
		c := &state.Comments[i]
		if c.State == CommentStateStaged || c.State == CommentStateTranslated {
			rtn = append(rtn, c)
		}
	}
	return rtn
}

// whereOf names the lines a comment lands on, for the agent and the sheet.
func whereOf(c *Comment) string {
	a := c.Anchor
	lines := fmt.Sprintf("line %d", a.Line)
	if a.StartLine > 0 && a.StartLine != a.Line {
		lines = fmt.Sprintf("lines %d-%d", a.StartLine, a.Line)
	}
	side := "head"
	if a.Side == mcpreview.SideLeft {
		side = "base"
	}
	what := "line comment"
	if c.Subject == SubjectFile || c.Outdated {
		what = "file comment"
	}
	return fmt.Sprintf("%s, %s side, %s (%s)", a.Path, side, lines, what)
}

// needsTranslation: a text in another language than the publication's, without a translation in it (or, with all,
// with only the agent's).
func needsTranslation(original CommentText, translation *CommentText, lang string, all bool) bool {
	if reviewlang.Same(original.Lang, lang) {
		return false
	}
	if translation == nil || strings.TrimSpace(translation.Text) == "" || !reviewlang.Same(translation.Lang, lang) {
		return true
	}
	return all && !translation.EditedByUser
}

// Translate asks the review session to translate the staged comments not yet in the publication language (AC1).
func (s *Service) Translate(ctx context.Context, req TranslateRequest) (TranslateResult, error) {
	res, err := s.PublicationLanguage(ctx, PublishInfoRequest{PrKey: req.PrKey, Dir: req.Dir})
	if err != nil {
		return TranslateResult{}, err
	}
	state, err := s.store.Get(req.PrKey)
	if err != nil {
		return TranslateResult{}, err
	}
	var items []mcpreview.TranslateItem
	for _, c := range publishable(&state) {
		if !needsTranslation(c.Original, c.Translation, res.Lang, req.All) {
			continue
		}
		items = append(items, mcpreview.TranslateItem{Id: c.Id, Kind: c.Kind, Where: whereOf(c), Text: c.Original.Text, Lang: c.Original.Lang})
	}
	if sum := state.Summary; sum != nil && needsTranslation(sum.Original, sum.Translation, res.Lang, req.All) {
		items = append(items, mcpreview.TranslateItem{Id: mcpreview.SummaryId, Where: "the review's summary", Text: sum.Original.Text, Lang: sum.Original.Lang})
	}
	rtn := TranslateResult{Language: res, Count: len(items)}
	if len(items) == 0 {
		return rtn, nil
	}
	if s.translate == nil {
		return TranslateResult{}, noSessionError()
	}
	ask, err := s.translate(ctx, mcpreview.TranslateRequest{
		SessionKey: mcpreview.SessionKey{Repo: req.Repo, Number: req.Number},
		Lang:       res.Lang, LangName: res.Name, Items: items,
	})
	if err != nil {
		return TranslateResult{}, err
	}
	rtn.AskResult = ask
	return rtn, nil
}

// SetTranslation keeps a translation of a comment or of the summary: the agent's (byUser false), which never replaces
// the developer's, or the developer's (an empty text clears it).
func (s *Store) SetTranslation(k PrKey, id string, text string, lang string, byUser bool) (State, bool, error) {
	text = strings.TrimSpace(text)
	if len(text) > maxCommentBytes {
		return State{}, false, uimsg.Errorf(uimsg.Make("review.translationtoolong"), "the translation is too long (64 KB at most)")
	}
	if id == "" {
		return State{}, false, fmt.Errorf("the comment's id is required")
	}
	lang = reviewlang.Normalize(lang)
	if text != "" && lang == "" {
		return State{}, false, fmt.Errorf("the translation's language is required")
	}
	by := MessageByAgent
	if byUser {
		by = MessageByDeveloper
	}
	var setErr error
	state, changed, err := s.update(k, func(state *State) bool {
		if id == mcpreview.SummaryId {
			sum := state.Summary
			if sum == nil {
				setErr = uimsg.Errorf(uimsg.Make("review.nosummary"), "the review has no summary")
				return false
			}
			if !byUser && sum.Translation != nil && sum.Translation.EditedByUser {
				return false
			}
			if text == "" {
				changed := sum.Translation != nil
				sum.Translation = nil
				return changed
			}
			next := CommentText{Lang: lang, Text: text, EditedByUser: byUser}
			if sum.Translation != nil && *sum.Translation == next {
				return false
			}
			sum.Translation = &next
			return true
		}
		c := findComment(state, id)
		if c == nil {
			setErr = noCommentError(id)
			return false
		}
		if c.State != CommentStateStaged && c.State != CommentStateTranslated {
			if byUser {
				setErr = uimsg.Errorf(uimsg.Make("review.onlystagedtranslated"), "only a staged comment is translated (this one is %s)", c.State)
			}
			return false
		}
		if !byUser && c.Translation != nil && c.Translation.EditedByUser {
			return false
		}
		now := s.now().UnixMilli()
		if text == "" {
			if c.Translation == nil {
				return false
			}
			c.Translation = nil
			c.State = CommentStateStaged
			c.UpdatedAt = now
			addEvent(c, now, EventTranslated, by, "")
			return true
		}
		next := CommentText{Lang: lang, Text: text, EditedByUser: byUser}
		if c.Translation != nil && *c.Translation == next {
			return false
		}
		c.Translation = &next
		c.State = CommentStateTranslated
		c.UpdatedAt = now
		addEvent(c, now, EventTranslated, by, text)
		return true
	})
	if setErr != nil {
		return state, false, setErr
	}
	return state, changed, err
}

// SetSummary sets the next review's summary; a new text drops the translation of the old one.
func (s *Store) SetSummary(req SummaryRequest) (State, bool, error) {
	text := strings.TrimSpace(req.Text)
	if len(text) > maxCommentBytes {
		return State{}, false, uimsg.Errorf(uimsg.Make("review.summarytoolong"), "the summary is too long (64 KB at most)")
	}
	return s.update(req.PrKey, func(state *State) bool {
		if text == "" {
			changed := state.Summary != nil
			state.Summary = nil
			return changed
		}
		if state.Summary != nil && state.Summary.Original.Text == text {
			return false
		}
		state.Summary = &Summary{Original: CommentText{Lang: req.Lang, Text: text}}
		return true
	})
}
