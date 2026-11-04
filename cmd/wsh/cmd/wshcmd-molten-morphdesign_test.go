// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"bytes"
	"encoding/json"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
)

type morphCall struct {
	command string
	req     molten.MorphDesignRequest
}

// fakeMorph answers the design commands in order, one answer per call; a call past the answers repeats the last one.
func fakeMorph(t *testing.T, answers ...any) (moltenMorphCaller, *[]morphCall) {
	t.Helper()
	calls := []morphCall{}
	return func(command string, req molten.MorphDesignRequest, out any) error {
		calls = append(calls, morphCall{command, req})
		answer := answers[min(len(calls), len(answers))-1]
		if err, isErr := answer.(error); isErr {
			return err
		}
		return utilfn.ReUnmarshal(out, answer)
	}, &calls
}

func TestParseMoltenMorphChoices(t *testing.T) {
	got, err := parseMoltenMorphChoices([]string{"Just me", " My team :: Shared in the project ", "a::b::c"})
	want := []molten.MorphDesignChoice{{Label: "Just me"}, {Label: "My team", Detail: "Shared in the project"}, {Label: "a", Detail: "b::c"}}
	if err != nil || len(got) != 3 || got[0] != want[0] || got[1] != want[1] || got[2] != want[2] {
		t.Fatalf("got %+v %v", got, err)
	}
	for _, bad := range []string{"", "  ", "::detail"} {
		if _, err := parseMoltenMorphChoices([]string{bad}); !isLearnUsage(err) {
			t.Errorf("%q: %v, want bad usage", bad, err)
		}
	}
}

// molten morph design <id> opens the design; a command name goes to its command; open names a mod whose id is one.
func TestMorphDesignCommandsAreRouted(t *testing.T) {
	for _, c := range []struct {
		args []string
		use  string
		rest []string
	}{
		{[]string{"morph", "design", "branch-box"}, "design", []string{"branch-box"}},
		{[]string{"morph", "design", "show"}, "show", nil},
		{[]string{"morph", "design", "step", "plan"}, "step", []string{"plan"}},
		{[]string{"morph", "design", "ask", "audience", "Who?"}, "ask", []string{"audience", "Who?"}},
		{[]string{"morph", "design", "answer", "audience", "Me"}, "answer", []string{"audience", "Me"}},
		{[]string{"morph", "design", "plan"}, "plan", nil},
		{[]string{"morph", "design", "draft"}, "draft", nil},
		{[]string{"morph", "design", "open", "show"}, "open", []string{"show"}},
	} {
		found, rest, err := moltenCmd.Find(c.args)
		if err != nil || strings.Fields(found.Use)[0] != c.use || strings.Join(rest, "|") != strings.Join(c.rest, "|") {
			t.Errorf("%v: %v %v %v, want %s %v", c.args, found.Use, rest, err, c.use, c.rest)
		}
	}
}

func TestMoltenMorphStepStateTakesAtMostOneFlag(t *testing.T) {
	for _, c := range []struct {
		done, skipped, todo bool
		want                string
	}{{false, false, false, ""}, {true, false, false, "done"}, {false, true, false, "skipped"}, {false, false, true, "todo"}} {
		if got, err := moltenMorphStepState(c.done, c.skipped, c.todo); err != nil || got != c.want {
			t.Errorf("%+v: %q %v", c, got, err)
		}
	}
	if _, err := moltenMorphStepState(true, true, false); !isLearnUsage(err) {
		t.Errorf("two states: %v, want bad usage", err)
	}
}

func openedAnswer(opened string) molten.MorphDesignOpened {
	return molten.MorphDesignOpened{Design: molten.MorphDesign{Mod: "branch-box", Opened: opened}, HandoffId: "h-1"}
}

func TestOpenSaysTheViewIsOpenWhenTheWindowAnswered(t *testing.T) {
	call, calls := fakeMorph(t, openedAnswer("h-1"))
	var out bytes.Buffer
	slept := 0
	if err := runMoltenMorphOpen(call, func(time.Duration) { slept++ }, "branch-box", "Branch box", "/work/app", false, &out); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].command != molten.MorphDesignOpenCommand || slept != 0 {
		t.Fatalf("calls %+v, slept %d", *calls, slept)
	}
	if got := (*calls)[0].req; got.Mod != "branch-box" || got.Name != "Branch box" || got.Cwd != "/work/app" {
		t.Fatalf("the request: %+v", got)
	}
	for _, want := range []string{"branch-box", "molten morph design step|ask|answer|plan|draft", "choices arrive as lines in your prompt"} {
		if !strings.Contains(out.String(), want) {
			t.Errorf("the output lacks %q: %s", want, out.String())
		}
	}
}

func TestOpenWaitsForTheWindowThenGivesUpWithAMessageToGoOnInTheTerminal(t *testing.T) {
	call, calls := fakeMorph(t, openedAnswer(""), molten.MorphDesign{Mod: "branch-box", Opened: "h-0"}, molten.MorphDesign{Mod: "branch-box", Opened: "h-1"})
	var out bytes.Buffer
	slept := 0
	if err := runMoltenMorphOpen(call, func(time.Duration) { slept++ }, "branch-box", "", "/work", false, &out); err != nil {
		t.Fatal(err)
	}
	if slept != 2 || len(*calls) != 3 || (*calls)[1].command != molten.MorphDesignShowCommand {
		t.Fatalf("it looks again until the window answers: slept %d, calls %+v", slept, *calls)
	}

	never, neverCalls := fakeMorph(t, openedAnswer(""), molten.MorphDesign{Mod: "branch-box", Opened: "h-0"})
	slept = 0
	out.Reset()
	err := runMoltenMorphOpen(never, func(time.Duration) { slept++ }, "branch-box", "", "/work", false, &out)
	if err == nil || !strings.Contains(err.Error(), "did not open") || !strings.Contains(err.Error(), "Go on in this terminal") {
		t.Fatalf("a window that never answers: %v", err)
	}
	if slept != moltenMorphOpenLooks || len(*neverCalls) != 1+moltenMorphOpenLooks {
		t.Fatalf("it gave up after %d looks (%d calls)", slept, len(*neverCalls))
	}
	if out.Len() != 0 {
		t.Fatalf("a failed open printed %q", out.String())
	}
}

func TestOpenChecksTheModIdBeforeAskingAnything(t *testing.T) {
	call, calls := fakeMorph(t, openedAnswer("h-1"))
	for _, bad := range []string{"", "Branch Box", "-x", "a b"} {
		if err := runMoltenMorphOpen(call, func(time.Duration) {}, bad, "", "/work", false, &bytes.Buffer{}); !isLearnUsage(err) {
			t.Errorf("%q: %v, want bad usage", bad, err)
		}
	}
	if len(*calls) != 0 {
		t.Fatalf("a bad id reached wavesrv: %+v", *calls)
	}
}

func TestOpenAsJsonSaysWhetherTheViewWasShown(t *testing.T) {
	call, _ := fakeMorph(t, openedAnswer("h-1"))
	var out bytes.Buffer
	if err := runMoltenMorphOpen(call, func(time.Duration) {}, "branch-box", "", "/work", true, &out); err != nil {
		t.Fatal(err)
	}
	var got struct {
		Design molten.MorphDesign `json:"design"`
		Shown  bool               `json:"shown"`
	}
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || !got.Shown || got.Design.Mod != "branch-box" {
		t.Fatalf("json %q: %+v %v", out.String(), got, err)
	}
}

func TestAnswerIsRememberedForTheNextDesign(t *testing.T) {
	design := molten.MorphDesign{Mod: "branch-box"}
	call, calls := fakeMorph(t, design)
	var learned []molten.LearningRequest
	learn := func(command string, req molten.LearningRequest, out any) error {
		if command != molten.LearningRecordCommand {
			t.Fatalf("learn command %s", command)
		}
		learned = append(learned, req)
		return nil
	}
	var out, errOut bytes.Buffer
	req := molten.MorphDesignRequest{Key: "audience", Value: "My team"}
	if err := runMoltenMorphAnswer(call, learn, req, true, false, &out, &errOut); err != nil {
		t.Fatal(err)
	}
	if len(*calls) != 1 || (*calls)[0].command != molten.MorphDesignAnswerCommand {
		t.Fatalf("calls %+v", *calls)
	}
	want := molten.LearningRequest{Workflow: "morph-design", Kind: molten.LearningKindAnswer, Key: "audience", Value: "My team", Run: "branch-box"}
	if len(learned) != 1 || learned[0] != want {
		t.Fatalf("learned %+v, want %+v", learned, want)
	}
	if !strings.Contains(out.String(), "remembered") || errOut.Len() != 0 {
		t.Fatalf("stdout %q stderr %q", out.String(), errOut.String())
	}

	learned = nil
	out.Reset()
	if err := runMoltenMorphAnswer(call, learn, req, false, false, &out, &errOut); err != nil || len(learned) != 0 || strings.Contains(out.String(), "remembered") {
		t.Fatalf("--no-learn: learned %+v out %q err %v", learned, out.String(), err)
	}
}

func TestAnswerStillWorksWhenTheMemoryRefusesIt(t *testing.T) {
	call, _ := fakeMorph(t, molten.MorphDesign{Mod: "branch-box"})
	learn := func(string, molten.LearningRequest, any) error { return errors.New("a value that looks like a credential is refused") }
	var out, errOut bytes.Buffer
	if err := runMoltenMorphAnswer(call, learn, molten.MorphDesignRequest{Key: "token", Value: "x"}, true, false, &out, &errOut); err != nil {
		t.Fatalf("the answer must not fail: %v", err)
	}
	if !strings.Contains(errOut.String(), "was not remembered") || strings.Contains(out.String(), "remembered for the next design") {
		t.Fatalf("stdout %q stderr %q", out.String(), errOut.String())
	}

	failing, _ := fakeMorph(t, errors.New("no design is open"))
	if err := runMoltenMorphAnswer(failing, learn, molten.MorphDesignRequest{Key: "a", Value: "b"}, true, false, &out, &errOut); err == nil {
		t.Fatal("an answer to a missing design must fail")
	}
}

func TestChangesPrintWhatThePanelShowsOrTheDesignAsJson(t *testing.T) {
	design := molten.MorphDesign{Mod: "branch-box", Current: "plan"}
	call, calls := fakeMorph(t, design)
	var out bytes.Buffer
	said := func(d molten.MorphDesign) string { return "the panel is on " + d.Current + "\n" }
	if err := runMoltenMorphChange(call, molten.MorphDesignStepCommand, molten.MorphDesignRequest{Step: "plan"}, false, &out, said); err != nil || out.String() != "the panel is on plan\n" {
		t.Fatalf("%q %v", out.String(), err)
	}
	out.Reset()
	if err := runMoltenMorphChange(call, molten.MorphDesignStepCommand, molten.MorphDesignRequest{Step: "plan"}, true, &out, said); err != nil {
		t.Fatal(err)
	}
	var got molten.MorphDesign
	if err := json.Unmarshal(out.Bytes(), &got); err != nil || got.Current != "plan" || len(*calls) != 2 {
		t.Fatalf("json %q: %+v %v", out.String(), got, err)
	}
	failing, _ := fakeMorph(t, errors.New("wavesrv refused"))
	if err := runMoltenMorphChange(failing, molten.MorphDesignStepCommand, molten.MorphDesignRequest{}, false, &out, said); err == nil || err.Error() != "wavesrv refused" {
		t.Fatalf("an error must come out as wavesrv gave it: %v", err)
	}
}

func TestShowPrintsTheDesignAsThePanelDrawsIt(t *testing.T) {
	design := molten.MorphDesign{
		Mod: "branch-box", Name: "Branch box", Dir: "/work/app", TabId: "tab-1", Current: molten.MorphStepPlan,
		Steps: []molten.MorphDesignStep{
			{Id: "need", State: "done", By: "agent", Say: "A box that shows the branch"},
			{Id: "questions", State: "skipped", By: "panel"},
			{Id: "plan", State: "todo"},
			{Id: "preview", State: "todo"},
		},
		Questions: []molten.MorphDesignQuestion{
			{Key: "audience", Step: "questions", Text: "Who will use it?", Choices: []molten.MorphDesignChoice{{Label: "Just me"}, {Label: "My team"}}, Recommended: "Just me"},
			{Key: "refresh", Step: "questions", Text: "How often?", Answer: "Every minute", AnsweredBy: "panel"},
		},
		Plan:    &molten.MorphDesignPlan{Summary: "A box next to the terminal.", MoltenPart: []string{"the command"}, Accesses: []string{"the branch name"}, Agreed: true, AgreedBy: "panel"},
		Draft:   molten.MorphDesignDraft{State: "sample", Commands: []string{"branch"}, Boxes: []string{"Branch"}},
		Agent:   &molten.MorphDesignAgent{BlockId: "b1", FirstName: "Marion", Agent: "claude-code"},
		Told:    &molten.MorphDesignTold{Status: "sent"},
		Outcome: "validated",
	}
	got := formatMoltenMorphDesign(design)
	for _, want := range []string{
		"design of branch-box (Branch box), folder /work/app",
		"view: open",
		"current step: plan",
		"need      done (agent) - A box that shows the branch",
		"questions skipped (panel)",
		"plan      current",
		"preview   to do",
		"audience [questions]: Who will use it?",
		"1) Just me (recommended)",
		"2) My team",
		"not answered yet",
		"answered by the developer (panel): Every minute",
		"summary: A box next to the terminal.",
		"MoltenTerm part: the command",
		"accesses: the branch name",
		"the developer agreed (panel)",
		"draft: sample, commands: branch, boxes: Branch",
		"the developer decided in the panel: validated",
		"clicks go to: Marion claude-code",
		"last click: sent",
	} {
		if !strings.Contains(got, want) {
			t.Errorf("the design lacks %q:\n%s", want, got)
		}
	}
	bare := formatMoltenMorphDesign(molten.MorphDesign{Mod: "x", Current: "need", Draft: molten.MorphDesignDraft{State: "none"}})
	for _, want := range []string{"view: not open in a window yet", "clicks go to: no agent runs here to take them", "draft: none"} {
		if !strings.Contains(bare, want) {
			t.Errorf("the bare design lacks %q:\n%s", want, bare)
		}
	}
}

func TestShowPrintsOnlyPrintableText(t *testing.T) {
	got := formatMoltenMorphDesign(molten.MorphDesign{Mod: "x", Name: "Box\x1b[31m red", Current: "need", Draft: molten.MorphDesignDraft{State: "none"},
		Questions: []molten.MorphDesignQuestion{{Key: "a", Step: "questions", Text: "Who\x07?", Choices: []molten.MorphDesignChoice{{Label: "A\x1b[0mB"}}}}})
	if strings.ContainsAny(got, "\x1b\x07") {
		t.Fatalf("a control character reached the terminal: %q", got)
	}
}
