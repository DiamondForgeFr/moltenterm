// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package morphdesign

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten"
)

func openStore(t *testing.T) (*Store, *[]molten.MorphDesign) {
	t.Helper()
	published := []molten.MorphDesign{}
	var lock sync.Mutex
	s := MakeStore(func(d molten.MorphDesign) {
		lock.Lock()
		defer lock.Unlock()
		published = append(published, d)
	})
	if _, err := s.Open("branch-box", "Branch box", "/work/app", "ws-1"); err != nil {
		t.Fatal(err)
	}
	return s, &published
}

func stepState(d molten.MorphDesign, id string) string {
	return d.Steps[molten.MorphStepIndex(id)].State
}

func twoChoices() []molten.MorphDesignChoice {
	return []molten.MorphDesignChoice{{Label: "Just me"}, {Label: "My team", Detail: "Shared in the project"}}
}

func TestOpenValidatesTheModAndKeepsAnExistingDesign(t *testing.T) {
	s, published := openStore(t)
	for _, bad := range []string{"", "Branch Box", "-box", "a b", strings.Repeat("a", 65)} {
		if _, err := s.Open(bad, "", "/work", "ws-1"); err == nil {
			t.Errorf("the mod id %q was accepted", bad)
		}
	}
	d, _ := s.Get("branch-box")
	if d.Current != molten.MorphStepNeed || len(d.Steps) != len(molten.MorphDesignSteps) || d.Draft.State != molten.MorphDraftNone {
		t.Fatalf("a new design: %+v", d)
	}
	if _, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "audience", Text: "Who?", Choices: twoChoices()}); err != nil {
		t.Fatal(err)
	}
	again, err := s.Open("branch-box", "", "", "")
	if err != nil || again.Name != "Branch box" || again.Dir != "/work/app" || len(again.Questions) != 1 {
		t.Fatalf("a second open must keep the design: %+v %v", again, err)
	}
	if len(*published) == 0 {
		t.Fatal("a change was not published")
	}
}

func TestSetStepMovesTheCurrentStepAndPassesTheOnesBeforeIt(t *testing.T) {
	s, _ := openStore(t)
	d, err := s.SetStep("branch-box", molten.MorphStepPlan, "", "Here is the plan")
	if err != nil {
		t.Fatal(err)
	}
	if d.Current != molten.MorphStepPlan || stepState(d, molten.MorphStepNeed) != molten.MorphStepDone || stepState(d, molten.MorphStepQuestions) != molten.MorphStepDone {
		t.Fatalf("the steps before the plan are passed: %+v", d.Steps)
	}
	if got := d.Steps[molten.MorphStepIndex(molten.MorphStepPlan)].Say; got != "Here is the plan" {
		t.Fatalf("the sentence under the step: %q", got)
	}
	if stepState(d, molten.MorphStepPreview) != molten.MorphStepTodo {
		t.Fatal("a step after the current one stays to do")
	}
	if _, err := s.SetStep("branch-box", "nonsense", "", ""); err == nil {
		t.Error("an unknown step was accepted")
	}
	if _, err := s.SetStep("branch-box", molten.MorphStepPlan, "finished", ""); err == nil {
		t.Error("an unknown state was accepted")
	}
}

func TestAStepTheDeveloperSkippedStaysSkippedWhenTheAgentMovesOn(t *testing.T) {
	s, _ := openStore(t)
	if _, err := s.SkipStep("branch-box", molten.MorphStepQuestions, molten.MorphActionSkip); err != nil {
		t.Fatal(err)
	}
	d, err := s.SetStep("branch-box", molten.MorphStepPlan, "", "")
	if err != nil {
		t.Fatal(err)
	}
	if stepState(d, molten.MorphStepQuestions) != molten.MorphStepSkipped || d.Steps[molten.MorphStepIndex(molten.MorphStepQuestions)].By != molten.MorphByPanel {
		t.Fatalf("the developer's skip was overwritten: %+v", d.Steps)
	}
	if d, _ = s.SkipStep("branch-box", molten.MorphStepQuestions, molten.MorphActionUnskip); stepState(d, molten.MorphStepQuestions) != molten.MorphStepTodo {
		t.Fatal("an unskipped step is to do again")
	}
}

func TestSettlingTheCurrentStepMovesToTheNextOneToDo(t *testing.T) {
	s, _ := openStore(t)
	d, err := s.SetStep("branch-box", molten.MorphStepNeed, molten.MorphStepDone, "")
	if err != nil || d.Current != molten.MorphStepQuestions {
		t.Fatalf("done on the current step: %+v %v", d, err)
	}
	d, err = s.SkipStep("branch-box", molten.MorphStepQuestions, molten.MorphActionTerminal)
	if err != nil || d.Current != molten.MorphStepPlan {
		t.Fatalf("done in the terminal moves on: %+v %v", d, err)
	}
	if st := d.Steps[molten.MorphStepIndex(molten.MorphStepQuestions)]; st.State != molten.MorphStepDone || st.By != molten.MorphByTerminal {
		t.Fatalf("done in the terminal: %+v", st)
	}
}

func TestAskChecksTheQuestionAndBringsItsStepInView(t *testing.T) {
	s, _ := openStore(t)
	bad := map[string]molten.MorphDesignQuestion{
		"no key":          {Text: "Who?", Choices: twoChoices()},
		"key with spaces": {Key: "my key", Text: "Who?", Choices: twoChoices()},
		"no text":         {Key: "a", Choices: twoChoices()},
		"no choice":       {Key: "a", Text: "Who?"},
		"twin choices":    {Key: "a", Text: "Who?", Choices: []molten.MorphDesignChoice{{Label: "x"}, {Label: "x"}}},
		"empty choice":    {Key: "a", Text: "Who?", Choices: []molten.MorphDesignChoice{{Label: " "}}},
		"too many":        {Key: "a", Text: "Who?", Choices: make([]molten.MorphDesignChoice, molten.MorphDesignMaxChoices+1)},
		"unknown kind":    {Key: "a", Text: "Who?", Kind: "free", Choices: twoChoices()},
		"unknown step":    {Key: "a", Text: "Who?", Step: "later", Choices: twoChoices()},
		"icon name":       {Key: "a", Text: "Which?", Kind: molten.MorphKindGlyphs, Choices: []molten.MorphDesignChoice{{Label: "A Clock"}}},
		"recommend":       {Key: "a", Text: "Who?", Choices: twoChoices(), Recommended: "Nobody"},
	}
	for name, q := range bad {
		if _, err := s.Ask("branch-box", q); err == nil {
			t.Errorf("%s: the question was accepted", name)
		}
	}
	d, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "audience", Text: "  Who\nwill use it? ", Choices: twoChoices(), Recommended: "Just me"})
	if err != nil {
		t.Fatal(err)
	}
	q := d.Questions[0]
	if q.Text != "Who will use it?" || q.Step != molten.MorphStepQuestions || q.Kind != molten.MorphKindChoice || d.Current != molten.MorphStepQuestions {
		t.Fatalf("the question: %+v current %s", q, d.Current)
	}
	icons, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "icon", Step: molten.MorphStepFinish, Kind: molten.MorphKindGlyphs, Text: "Which icon?",
		Choices: []molten.MorphDesignChoice{{Label: "code-branch"}, {Label: "clock"}}})
	if err != nil || icons.Current != molten.MorphStepFinish {
		t.Fatalf("an icon question brings the finishing step in view: %+v %v", icons, err)
	}
	later, _ := s.SetStep("branch-box", molten.MorphStepAdjust, "", "")
	if again, _ := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "refresh", Text: "How often?", Choices: twoChoices()}); again.Current != later.Current {
		t.Fatalf("a question must not take the panel back from a later step: %s", again.Current)
	}
}

func TestAskAgainWithTheSameKeyReplacesTheQuestionAndItsAnswer(t *testing.T) {
	s, _ := openStore(t)
	q := molten.MorphDesignQuestion{Key: "audience", Text: "Who?", Choices: twoChoices()}
	if _, err := s.Ask("branch-box", q); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Choose("branch-box", "audience", "Just me"); err != nil {
		t.Fatal(err)
	}
	q.Text = "Who exactly?"
	d, err := s.Ask("branch-box", q)
	if err != nil || len(d.Questions) != 1 || d.Questions[0].Text != "Who exactly?" || d.Questions[0].Answer != "" {
		t.Fatalf("a replaced question starts unanswered: %+v %v", d.Questions, err)
	}
}

func TestTheDeveloperPicksOneOfTheChoicesOnly(t *testing.T) {
	s, _ := openStore(t)
	if _, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "audience", Text: "Who?", Choices: twoChoices()}); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Choose("branch-box", "audience", "Everybody"); err == nil {
		t.Error("a label that is not a choice was accepted")
	}
	if _, err := s.Choose("branch-box", "missing", "Just me"); err == nil {
		t.Error("an unknown question was accepted")
	}
	d, err := s.Choose("branch-box", "audience", "My team")
	if err != nil || d.Questions[0].Answer != "My team" || d.Questions[0].AnsweredBy != molten.MorphByPanel {
		t.Fatalf("the pick: %+v %v", d.Questions, err)
	}
}

func TestAnswerShowsWhatWasSaidInTheTerminal(t *testing.T) {
	s, _ := openStore(t)
	if _, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "audience", Text: "Who?", Choices: twoChoices()}); err != nil {
		t.Fatal(err)
	}
	d, err := s.Answer("branch-box", "audience", "My whole company", "", "")
	if err != nil || d.Questions[0].Answer != "My whole company" || d.Questions[0].AnsweredBy != molten.MorphByTerminal {
		t.Fatalf("an answer typed in the terminal: %+v %v", d.Questions, err)
	}
	d, err = s.Answer("branch-box", "category", "Tools", "Which category?", molten.MorphStepFinish)
	if err != nil || len(d.Questions) != 2 || d.Questions[1].Text != "Which category?" || d.Questions[1].Step != molten.MorphStepFinish || len(d.Questions[1].Choices) != 0 {
		t.Fatalf("a question never asked in the panel is added as answered: %+v %v", d.Questions, err)
	}
	for name, args := range map[string][3]string{"no value": {"audience", " ", ""}, "bad key": {"Not A Key", "x", ""}, "bad step": {"audience", "x", "later"}} {
		if _, err := s.Answer("branch-box", args[0], args[1], "", args[2]); err == nil {
			t.Errorf("%s: the answer was accepted", name)
		}
	}
}

func TestThePlanNeedsASummaryAndRestartsTheAgreement(t *testing.T) {
	s, _ := openStore(t)
	if _, err := s.SetPlan("branch-box", molten.MorphDesignPlan{Summary: " "}); err == nil {
		t.Error("a plan without a summary was accepted")
	}
	if _, err := s.Decide("branch-box", molten.MorphActionAgree); err == nil {
		t.Error("there is no plan to agree to yet")
	}
	plan := molten.MorphDesignPlan{
		Summary:    "A box that shows the branch.",
		MoltenPart: []string{"the command", " ", "the box"},
		Accesses:   []string{"the branch name"},
	}
	d, err := s.SetPlan("branch-box", plan)
	if err != nil || d.Current != molten.MorphStepPlan || len(d.Plan.MoltenPart) != 2 || d.Plan.AgentPart == nil || d.Plan.Waits == nil {
		t.Fatalf("the plan: %+v %v", d.Plan, err)
	}
	d, err = s.Decide("branch-box", molten.MorphActionAgree)
	if err != nil || !d.Plan.Agreed || d.Plan.AgreedBy != molten.MorphByPanel || stepState(d, molten.MorphStepPlan) != molten.MorphStepDone {
		t.Fatalf("the agreement: %+v %v", d.Plan, err)
	}
	if d, _ = s.SetPlan("branch-box", plan); d.Plan.Agreed {
		t.Error("a new plan needs a new agreement")
	}
}

func TestTheDraftDefaultsToSampleAndBoundsItsLists(t *testing.T) {
	s, _ := openStore(t)
	if _, err := s.SetDraft("branch-box", molten.MorphDesignDraft{State: "finished"}); err == nil {
		t.Error("an unknown draft state was accepted")
	}
	commands := make([]string, molten.MorphDesignMaxItems+5)
	for i := range commands {
		commands[i] = fmt.Sprintf("cmd%d", i)
	}
	d, err := s.SetDraft("branch-box", molten.MorphDesignDraft{Commands: commands, Boxes: []string{"Branch"}})
	if err != nil || d.Draft.State != molten.MorphDraftSample || len(d.Draft.Commands) != molten.MorphDesignMaxItems || d.Current != molten.MorphStepPreview {
		t.Fatalf("the draft: %+v %v", d.Draft, err)
	}
}

func TestValidateAndGiveUpAreTheDevelopersDecisions(t *testing.T) {
	s, _ := openStore(t)
	d, err := s.Decide("branch-box", molten.MorphActionGiveUp)
	if err != nil || d.Outcome != molten.MorphOutcomeGaveUp {
		t.Fatalf("give up: %+v %v", d, err)
	}
	d, err = s.Decide("branch-box", molten.MorphActionValidate)
	if err != nil || d.Outcome != molten.MorphOutcomeValidated || stepState(d, molten.MorphStepValidate) != molten.MorphStepDone {
		t.Fatalf("validate: %+v %v", d, err)
	}
	if _, err := s.Decide("branch-box", "maybe"); err == nil {
		t.Error("an unknown decision was accepted")
	}
}

func TestACommandOnAMissingDesignNamesHowToOpenIt(t *testing.T) {
	s, _ := openStore(t)
	_, err := s.SetStep("other-mod", molten.MorphStepPlan, "", "")
	if err == nil || !strings.Contains(err.Error(), "molten morph design other-mod") {
		t.Fatalf("got %v", err)
	}
}

func TestTheStoreKeepsAtMostSomeDesignsAndDropsTheOldest(t *testing.T) {
	s, _ := openStore(t)
	for i := 0; i < molten.MorphDesignMaxDesigns; i++ {
		if _, err := s.Open(fmt.Sprintf("mod-%d", i), "", "/work", "ws-1"); err != nil {
			t.Fatal(err)
		}
	}
	if got := len(s.Mods()); got != molten.MorphDesignMaxDesigns {
		t.Fatalf("%d designs", got)
	}
	if _, ok := s.Get("branch-box"); ok {
		t.Error("the oldest design stayed")
	}
}

func TestACopyIsNeverTheStoredDesign(t *testing.T) {
	s, _ := openStore(t)
	if _, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: "audience", Text: "Who?", Choices: twoChoices()}); err != nil {
		t.Fatal(err)
	}
	d, _ := s.Get("branch-box")
	d.Questions[0].Choices[0].Label = "changed"
	d.Steps[0].State = "changed"
	again, _ := s.Get("branch-box")
	if again.Questions[0].Choices[0].Label == "changed" || again.Steps[0].State == "changed" {
		t.Fatal("a caller changed the stored design through its copy")
	}
}

func TestParallelChangesKeepTheDesignWhole(t *testing.T) {
	s, _ := openStore(t)
	var wg sync.WaitGroup
	for i := 0; i < 8; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			key := fmt.Sprintf("q%d", i)
			if _, err := s.Ask("branch-box", molten.MorphDesignQuestion{Key: key, Text: "Which?", Choices: twoChoices()}); err != nil {
				t.Error(err)
			}
			if _, err := s.Choose("branch-box", key, "Just me"); err != nil {
				t.Error(err)
			}
		}(i)
	}
	wg.Wait()
	d, _ := s.Get("branch-box")
	if len(d.Questions) != 8 {
		t.Fatalf("%d questions", len(d.Questions))
	}
	for _, q := range d.Questions {
		if q.Answer != "Just me" {
			t.Errorf("%s: %+v", q.Key, q)
		}
	}
}
