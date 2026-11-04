// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

// Package morphdesign holds the mod design view's state (FR-MORPH-019): one design per mod, driven by the agent
// through `molten morph design` and by the developer's clicks in the panel, and published to the windows on each
// change. The panel shows and relays; it grants nothing (DS-MORPH-015).
package morphdesign

import (
	"fmt"
	"slices"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

const (
	maxPlanSummary = 1200
	maxPlanItem    = 300
	maxDraftItem   = 120
	maxNote        = 300
	maxAnswer      = 200
)

// Store keeps the designs in memory: a window that reloads reads them again, a restart of wavesrv starts over (the
// draft itself lives in the mod's folder).
type Store struct {
	lock     sync.Mutex
	designs  map[string]*molten.MorphDesign
	now      func() time.Time
	onChange func(molten.MorphDesign)
}

// MakeStore returns a store that calls onChange with the design after each change, outside its lock.
func MakeStore(onChange func(molten.MorphDesign)) *Store {
	return &Store{designs: map[string]*molten.MorphDesign{}, now: time.Now, onChange: onChange}
}

func cleanLine(text string, max int) string {
	text = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) && !unicode.IsSpace(r) {
			return -1
		}
		return r
	}, text)
	text = strings.Join(strings.Fields(text), " ")
	if utf8.RuneCountInString(text) <= max {
		return text
	}
	return string([]rune(text)[:max-1]) + "…"
}

func cleanList(items []string, max int, maxLen int) []string {
	rtn := []string{}
	for _, item := range items {
		item = cleanLine(item, maxLen)
		if item == "" {
			continue
		}
		if len(rtn) == max {
			break
		}
		rtn = append(rtn, item)
	}
	return rtn
}

func cloneDesign(d molten.MorphDesign) molten.MorphDesign {
	d.Steps = slices.Clone(d.Steps)
	d.Questions = slices.Clone(d.Questions)
	for i := range d.Questions {
		d.Questions[i].Choices = slices.Clone(d.Questions[i].Choices)
	}
	if d.Plan != nil {
		plan := *d.Plan
		plan.MoltenPart = slices.Clone(plan.MoltenPart)
		plan.AgentPart = slices.Clone(plan.AgentPart)
		plan.Accesses = slices.Clone(plan.Accesses)
		plan.Waits = slices.Clone(plan.Waits)
		d.Plan = &plan
	}
	d.Draft.Commands = slices.Clone(d.Draft.Commands)
	d.Draft.Boxes = slices.Clone(d.Draft.Boxes)
	if d.Agent != nil {
		agent := *d.Agent
		d.Agent = &agent
	}
	if d.Told != nil {
		told := *d.Told
		d.Told = &told
	}
	return d
}

func makeDesign(mod string, now int64) *molten.MorphDesign {
	steps := make([]molten.MorphDesignStep, len(molten.MorphDesignSteps))
	for i, id := range molten.MorphDesignSteps {
		steps[i] = molten.MorphDesignStep{Id: id, State: molten.MorphStepTodo}
	}
	return &molten.MorphDesign{
		Mod: mod, Current: molten.MorphStepNeed, Steps: steps, Questions: []molten.MorphDesignQuestion{},
		Draft:   molten.MorphDesignDraft{State: molten.MorphDraftNone, Commands: []string{}, Boxes: []string{}},
		Updated: now,
	}
}

func (s *Store) apply(mod string, fn func(d *molten.MorphDesign) error) (molten.MorphDesign, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	d := s.designs[mod]
	if d == nil {
		return molten.MorphDesign{}, fmt.Errorf("no design is open for the mod %q: open it with molten morph design %s", mod, mod)
	}
	if err := fn(d); err != nil {
		return molten.MorphDesign{}, err
	}
	d.Updated = s.now().UnixMilli()
	return cloneDesign(*d), nil
}

func (s *Store) mutate(mod string, fn func(d *molten.MorphDesign) error) (molten.MorphDesign, error) {
	d, err := s.apply(mod, fn)
	if err != nil {
		return molten.MorphDesign{}, err
	}
	if s.onChange != nil {
		s.onChange(d)
	}
	return d, nil
}

// Get returns a copy of the design, false when none is open for the mod.
func (s *Store) Get(mod string) (molten.MorphDesign, bool) {
	s.lock.Lock()
	defer s.lock.Unlock()
	d := s.designs[mod]
	if d == nil {
		return molten.MorphDesign{}, false
	}
	return cloneDesign(*d), true
}

// Mods lists the open designs' mod ids, the most recently changed first.
func (s *Store) Mods() []string {
	s.lock.Lock()
	defer s.lock.Unlock()
	mods := make([]string, 0, len(s.designs))
	for mod := range s.designs {
		mods = append(mods, mod)
	}
	sort.Slice(mods, func(i, j int) bool {
		a, b := s.designs[mods[i]], s.designs[mods[j]]
		if a.Updated != b.Updated {
			return a.Updated > b.Updated
		}
		return mods[i] < mods[j]
	})
	return mods
}

// evictOldest drops the least recently changed design once the store is full; the caller holds the lock.
func (s *Store) evictOldest() {
	if len(s.designs) < molten.MorphDesignMaxDesigns {
		return
	}
	oldest := ""
	for mod, d := range s.designs {
		if oldest == "" || d.Updated < s.designs[oldest].Updated {
			oldest = mod
		}
	}
	delete(s.designs, oldest)
}

// Open makes the design of a mod, or finds it again: a second call keeps the steps, the questions and the plan, and
// only completes the name and the folder.
func (s *Store) Open(mod string, name string, dir string, workspaceId string) (molten.MorphDesign, error) {
	if !molten.MorphModIdRegex.MatchString(mod) {
		return molten.MorphDesign{}, fmt.Errorf("invalid mod id %q: use lowercase letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit", mod)
	}
	d, err := s.openLocked(mod, name, dir, workspaceId)
	if err != nil {
		return molten.MorphDesign{}, err
	}
	if s.onChange != nil {
		s.onChange(d)
	}
	return d, nil
}

func (s *Store) openLocked(mod string, name string, dir string, workspaceId string) (molten.MorphDesign, error) {
	s.lock.Lock()
	defer s.lock.Unlock()
	d := s.designs[mod]
	if d == nil {
		s.evictOldest()
		d = makeDesign(mod, s.now().UnixMilli())
		s.designs[mod] = d
	}
	if name = cleanLine(name, molten.MorphDesignMaxLabel); name != "" {
		d.Name = name
	}
	if dir != "" {
		d.Dir = dir
	}
	if workspaceId != "" {
		d.WorkspaceId = workspaceId
	}
	d.Updated = s.now().UnixMilli()
	return cloneDesign(*d), nil
}

// SetTab records the tab the window made or found for the design, and the hand-off it answered.
func (s *Store) SetTab(mod string, tabId string, handoffId string) (molten.MorphDesign, error) {
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		d.TabId = tabId
		d.Opened = handoffId
		return nil
	})
}

func stepOf(d *molten.MorphDesign, step string) (*molten.MorphDesignStep, error) {
	i := molten.MorphStepIndex(step)
	if i < 0 {
		return nil, fmt.Errorf("unknown step %q: use %s", step, strings.Join(molten.MorphDesignSteps, ", "))
	}
	return &d.Steps[i], nil
}

// moveTo makes step the current one. The steps before it that nobody settled are passed: done, by the agent. A step
// the developer skipped or did in the terminal keeps its state.
func moveTo(d *molten.MorphDesign, step string) {
	i := molten.MorphStepIndex(step)
	for j := 0; j < i; j++ {
		if d.Steps[j].State == molten.MorphStepTodo {
			d.Steps[j].State = molten.MorphStepDone
			d.Steps[j].By = molten.MorphByAgent
		}
	}
	d.Current = step
}

// advanceTo moves the design forward only: an agent that asks a question or shows the plan brings its step in view,
// but never takes the panel back from a later one.
func advanceTo(d *molten.MorphDesign, step string) {
	if molten.MorphStepIndex(d.Current) >= molten.MorphStepIndex(step) {
		return
	}
	moveTo(d, step)
}

// nextTodo is the first step after step that is still to do; the current step when none is.
func nextTodo(d *molten.MorphDesign, step string) string {
	for j := molten.MorphStepIndex(step) + 1; j < len(d.Steps); j++ {
		if d.Steps[j].State == molten.MorphStepTodo {
			return d.Steps[j].Id
		}
	}
	return step
}

// SetStep is the agent's `step`: with no state the step becomes the current one (to do again if it was settled);
// done and skipped settle it.
func (s *Store) SetStep(mod string, step string, state string, say string) (molten.MorphDesign, error) {
	if state != "" && state != molten.MorphStepDone && state != molten.MorphStepSkipped && state != molten.MorphStepTodo {
		return molten.MorphDesign{}, fmt.Errorf("unknown step state %q: use done, skipped or todo", state)
	}
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		st, err := stepOf(d, step)
		if err != nil {
			return err
		}
		if say = cleanLine(say, molten.MorphDesignMaxText); say != "" || state == "" {
			st.Say = say
		}
		switch state {
		case "":
			moveTo(d, step)
			st.State, st.By = molten.MorphStepTodo, ""
		case molten.MorphStepTodo:
			st.State, st.By = molten.MorphStepTodo, ""
		default:
			st.State, st.By = state, molten.MorphByAgent
			if d.Current == step {
				d.Current = nextTodo(d, step)
			}
		}
		return nil
	})
}

func checkKey(key string) error {
	if !molten.MorphKeyRegex.MatchString(key) {
		return fmt.Errorf("invalid question key %q: use lowercase letters, digits, \".\", \"_\" or \"-\" (at most %d characters)", key, molten.MorphDesignMaxKey)
	}
	return nil
}

func cleanChoices(kind string, choices []molten.MorphDesignChoice) ([]molten.MorphDesignChoice, error) {
	if len(choices) == 0 {
		return nil, fmt.Errorf("a question needs at least one choice (--choice)")
	}
	if len(choices) > molten.MorphDesignMaxChoices {
		return nil, fmt.Errorf("a question takes at most %d choices", molten.MorphDesignMaxChoices)
	}
	rtn := make([]molten.MorphDesignChoice, 0, len(choices))
	seen := map[string]bool{}
	for _, c := range choices {
		label := cleanLine(c.Label, molten.MorphDesignMaxLabel)
		if label == "" {
			return nil, fmt.Errorf("a choice cannot be empty")
		}
		if kind == molten.MorphKindIcon && !molten.MorphIconRegex.MatchString(label) {
			return nil, fmt.Errorf("%q is not a Font Awesome icon name (lowercase letters, digits and \"-\")", label)
		}
		if seen[label] {
			return nil, fmt.Errorf("the choice %q is given twice", label)
		}
		seen[label] = true
		rtn = append(rtn, molten.MorphDesignChoice{Label: label, Detail: cleanLine(c.Detail, molten.MorphDesignMaxText)})
	}
	return rtn, nil
}

// Ask is the agent's `ask`: one question with the choices to pick from, replacing the question of the same key.
func (s *Store) Ask(mod string, q molten.MorphDesignQuestion) (molten.MorphDesign, error) {
	if err := checkKey(q.Key); err != nil {
		return molten.MorphDesign{}, err
	}
	q.Text = cleanLine(q.Text, molten.MorphDesignMaxText)
	if q.Text == "" {
		return molten.MorphDesign{}, fmt.Errorf("a question needs its text")
	}
	if q.Kind == "" {
		q.Kind = molten.MorphKindChoice
	}
	if q.Kind != molten.MorphKindChoice && q.Kind != molten.MorphKindIcon {
		return molten.MorphDesign{}, fmt.Errorf("unknown question kind %q: use choice or icon", q.Kind)
	}
	if q.Step == "" {
		q.Step = molten.MorphStepQuestions
	}
	choices, err := cleanChoices(q.Kind, q.Choices)
	if err != nil {
		return molten.MorphDesign{}, err
	}
	q.Choices = choices
	if q.Recommended = cleanLine(q.Recommended, molten.MorphDesignMaxLabel); q.Recommended != "" &&
		!slices.ContainsFunc(choices, func(c molten.MorphDesignChoice) bool { return c.Label == q.Recommended }) {
		return molten.MorphDesign{}, fmt.Errorf("the recommended choice %q is not one of the choices", q.Recommended)
	}
	q.Answer, q.AnsweredBy = "", ""
	if molten.MorphStepIndex(q.Step) < 0 {
		return molten.MorphDesign{}, fmt.Errorf("unknown step %q: use %s", q.Step, strings.Join(molten.MorphDesignSteps, ", "))
	}
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		i := slices.IndexFunc(d.Questions, func(e molten.MorphDesignQuestion) bool { return e.Key == q.Key })
		switch {
		case i >= 0:
			d.Questions[i] = q
		case len(d.Questions) >= molten.MorphDesignMaxQuestions:
			return fmt.Errorf("a design takes at most %d questions", molten.MorphDesignMaxQuestions)
		default:
			d.Questions = append(d.Questions, q)
		}
		advanceTo(d, q.Step)
		return nil
	})
}

// Answer is the agent's `answer`: the developer answered in the terminal. A question that was never asked in the panel
// is added as already answered, so the panel shows everything the design settled.
func (s *Store) Answer(mod string, key string, value string, text string, step string) (molten.MorphDesign, error) {
	if err := checkKey(key); err != nil {
		return molten.MorphDesign{}, err
	}
	if value = cleanLine(value, maxAnswer); value == "" {
		return molten.MorphDesign{}, fmt.Errorf("an answer cannot be empty")
	}
	if step == "" {
		step = molten.MorphStepQuestions
	}
	if molten.MorphStepIndex(step) < 0 {
		return molten.MorphDesign{}, fmt.Errorf("unknown step %q: use %s", step, strings.Join(molten.MorphDesignSteps, ", "))
	}
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		i := slices.IndexFunc(d.Questions, func(e molten.MorphDesignQuestion) bool { return e.Key == key })
		if i < 0 {
			if len(d.Questions) >= molten.MorphDesignMaxQuestions {
				return fmt.Errorf("a design takes at most %d questions", molten.MorphDesignMaxQuestions)
			}
			if text = cleanLine(text, molten.MorphDesignMaxText); text == "" {
				text = key
			}
			d.Questions = append(d.Questions, molten.MorphDesignQuestion{
				Key: key, Step: step, Text: text, Kind: molten.MorphKindChoice, Choices: []molten.MorphDesignChoice{},
			})
			i = len(d.Questions) - 1
		}
		d.Questions[i].Answer, d.Questions[i].AnsweredBy = value, molten.MorphByTerminal
		return nil
	})
}

func (s *Store) SetPlan(mod string, plan molten.MorphDesignPlan) (molten.MorphDesign, error) {
	clean := molten.MorphDesignPlan{
		Summary:    cleanLine(plan.Summary, maxPlanSummary),
		MoltenPart: cleanList(plan.MoltenPart, molten.MorphDesignMaxItems, maxPlanItem),
		AgentPart:  cleanList(plan.AgentPart, molten.MorphDesignMaxItems, maxPlanItem),
		Accesses:   cleanList(plan.Accesses, molten.MorphDesignMaxItems, maxPlanItem),
		Waits:      cleanList(plan.Waits, molten.MorphDesignMaxItems, maxPlanItem),
	}
	if clean.Summary == "" {
		return molten.MorphDesign{}, fmt.Errorf("a plan needs its summary (--summary)")
	}
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		d.Plan = &clean
		d.Outcome = ""
		advanceTo(d, molten.MorphStepPlan)
		return nil
	})
}

func (s *Store) SetDraft(mod string, draft molten.MorphDesignDraft) (molten.MorphDesign, error) {
	if draft.State == "" {
		draft.State = molten.MorphDraftSample
	}
	if draft.State != molten.MorphDraftNone && draft.State != molten.MorphDraftSample && draft.State != molten.MorphDraftReal {
		return molten.MorphDesign{}, fmt.Errorf("unknown draft state %q: use none, sample or real", draft.State)
	}
	clean := molten.MorphDesignDraft{
		State:    draft.State,
		Note:     cleanLine(draft.Note, maxNote),
		Commands: cleanList(draft.Commands, molten.MorphDesignMaxItems, maxDraftItem),
		Boxes:    cleanList(draft.Boxes, molten.MorphDesignMaxItems, maxDraftItem),
	}
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		d.Draft = clean
		advanceTo(d, molten.MorphStepPreview)
		return nil
	})
}

// Choose is the developer's click on a choice: the question's answer, from the panel.
func (s *Store) Choose(mod string, key string, label string) (molten.MorphDesign, error) {
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		i := slices.IndexFunc(d.Questions, func(e molten.MorphDesignQuestion) bool { return e.Key == key })
		if i < 0 {
			return fmt.Errorf("the design of %q has no question %q", mod, key)
		}
		if !slices.ContainsFunc(d.Questions[i].Choices, func(c molten.MorphDesignChoice) bool { return c.Label == label }) {
			return fmt.Errorf("%q is not one of the choices of the question %q", label, key)
		}
		d.Questions[i].Answer, d.Questions[i].AnsweredBy = label, molten.MorphByPanel
		return nil
	})
}

// SkipStep is the developer's gesture on a step: skip it, bring it back, or say they do it in the terminal. Nothing
// here stops the agent: the step is only marked.
func (s *Store) SkipStep(mod string, step string, action string) (molten.MorphDesign, error) {
	if action != molten.MorphActionSkip && action != molten.MorphActionUnskip && action != molten.MorphActionTerminal {
		return molten.MorphDesign{}, fmt.Errorf("unknown step action %q", action)
	}
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		st, err := stepOf(d, step)
		if err != nil {
			return err
		}
		switch action {
		case molten.MorphActionUnskip:
			st.State, st.By = molten.MorphStepTodo, ""
			return nil
		case molten.MorphActionSkip:
			st.State, st.By = molten.MorphStepSkipped, molten.MorphByPanel
		default:
			st.State, st.By = molten.MorphStepDone, molten.MorphByTerminal
		}
		if d.Current == step {
			d.Current = nextTodo(d, step)
		}
		return nil
	})
}

// Decide is the developer's click on the plan or on the validation: agree, validate, or give up.
func (s *Store) Decide(mod string, action string) (molten.MorphDesign, error) {
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		switch action {
		case molten.MorphActionAgree:
			if d.Plan == nil {
				return fmt.Errorf("there is no plan to agree to yet")
			}
			d.Plan.Agreed, d.Plan.AgreedBy = true, molten.MorphByPanel
			d.Steps[molten.MorphStepIndex(molten.MorphStepPlan)].State = molten.MorphStepDone
			d.Steps[molten.MorphStepIndex(molten.MorphStepPlan)].By = molten.MorphByPanel
			if d.Current == molten.MorphStepPlan {
				d.Current = nextTodo(d, molten.MorphStepPlan)
			}
		case molten.MorphActionValidate:
			d.Outcome = molten.MorphOutcomeValidated
			d.Steps[molten.MorphStepIndex(molten.MorphStepValidate)].State = molten.MorphStepDone
			d.Steps[molten.MorphStepIndex(molten.MorphStepValidate)].By = molten.MorphByPanel
		case molten.MorphActionGiveUp:
			d.Outcome = molten.MorphOutcomeGaveUp
		default:
			return fmt.Errorf("unknown decision %q", action)
		}
		return nil
	})
}

// SetTold records what became of the developer's last click, for the panel to say.
func (s *Store) SetTold(mod string, told molten.MorphDesignTold) (molten.MorphDesign, error) {
	return s.mutate(mod, func(d *molten.MorphDesign) error {
		d.Told = &told
		return nil
	})
}

// SetDriver records the agent that last drove the design, the one the panel's clicks go to first.
func (s *Store) SetDriver(mod string, blockId string) {
	s.lock.Lock()
	defer s.lock.Unlock()
	if d := s.designs[mod]; d != nil {
		d.Driver = blockId
	}
}

// Driver returns the block of the agent that last drove the design.
func (s *Store) Driver(mod string) string {
	s.lock.Lock()
	defer s.lock.Unlock()
	if d := s.designs[mod]; d != nil {
		return d.Driver
	}
	return ""
}
