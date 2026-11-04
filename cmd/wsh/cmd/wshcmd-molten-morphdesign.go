// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten morph design` (FR-MORPH-019, DS-MORPH-016): the mod design view /morph opens, a tab with a guiding panel
// beside a terminal. The agent opens it, then keeps the panel in step with the conversation: the step, a question
// with choices, the plan, the draft. What the developer decides in the panel reaches the agent as a line in its
// prompt. The output is for agents, whichever CLI: English, plain text or JSON. Exit codes: 2 for bad usage, 1 for any
// other failure.

const (
	moltenMorphTimeoutMs = 20000
	// The window answers a hand-off within a moment; this many looks, a poll apart, bound the wait for a missing one.
	moltenMorphOpenLooks = 50
	moltenMorphOpenPoll  = 200 * time.Millisecond
	// A choice's detail follows its label after this separator: --choice "Every minute::Fresh, but busy".
	moltenMorphDetailSep = "::"
)

var (
	moltenMorphMod        string
	moltenMorphName       string
	moltenMorphSay        string
	moltenMorphDone       bool
	moltenMorphSkipped    bool
	moltenMorphTodo       bool
	moltenMorphChoices    []string
	moltenMorphRecommend  string
	moltenMorphIcons      bool
	moltenMorphStepFlag   string
	moltenMorphQuestion   string
	moltenMorphNoLearn    bool
	moltenMorphSummary    string
	moltenMorphMoltenPart []string
	moltenMorphAgentPart  []string
	moltenMorphAccesses   []string
	moltenMorphWaits      []string
	moltenMorphDraftState string
	moltenMorphNote       string
	moltenMorphCommands   []string
	moltenMorphBoxes      []string
)

var moltenMorphCmd = &cobra.Command{
	Use:   "morph",
	Short: "what /morph builds: the mod design view",
}

var moltenMorphDesignCmd = &cobra.Command{
	Use:   "design <mod-id> [--name <title>]",
	Short: "open the mod design view: a tab with a guiding panel beside a terminal (a second call focuses it)",
	Long: "/morph opens a dedicated tab for the mod you design with the developer: a terminal on the left, a guiding panel on " +
		"the right. You keep the panel in step with the conversation with the commands below; what the developer decides in " +
		"the panel reaches your prompt as a line. The panel never blocks: every step can be skipped or done in the terminal. " +
		"Details: morph-design.md in the folder `molten docs` prints.",
	Args:    cobra.MaximumNArgs(1),
	RunE:    moltenLearnWrap(moltenMorphDesignRun),
	Example: "  molten morph design branch-box --name \"Branch box\"\n  molten morph design step plan --say \"Here is what I will build\"",
}

var moltenMorphDesignOpenCmd = &cobra.Command{
	Use:   "open <mod-id> [--name <title>]",
	Short: "the same as molten morph design <mod-id>, for a mod whose id is also a command name",
	Args:  cobra.ExactArgs(1),
	RunE:  moltenLearnWrap(moltenMorphDesignRun),
}

var moltenMorphDesignShowCmd = &cobra.Command{
	Use:   "show [--mod <id>]",
	Short: "the design as the panel shows it: steps, questions with the developer's answers, plan, draft, who receives the clicks",
	Args:  cobra.NoArgs,
	RunE:  moltenLearnWrap(moltenMorphShowRun),
}

var moltenMorphDesignStepCmd = &cobra.Command{
	Use:   "step <need|questions|plan|preview|adjust|finish|validate|collect> [--say <sentence>] [--done|--skipped|--todo]",
	Short: "make a step the current one in the panel, with a sentence in plain words; or settle it",
	Long: "Without --done, --skipped or --todo the step becomes the current one and the steps before it that nobody settled are " +
		"passed. --say is one plain sentence shown under the step (for need: the request in your own words). --done and " +
		"--skipped settle a step without making it current.",
	Args: cobra.ExactArgs(1),
	RunE: moltenLearnWrap(moltenMorphStepRun),
}

var moltenMorphDesignAskCmd = &cobra.Command{
	Use:   "ask <key> <question> --choice <label> [--choice <label>…] [--recommend <label>] [--icons] [--step <step>]",
	Short: "ask one question in the panel; the developer's pick arrives as a line in your prompt",
	Long: "The key is a short id (lowercase letters, digits, . _ -) that names the question; it is also how the answer is " +
		"learned for the next design. Give two to four --choice labels, the one you recommend first; --choice " +
		"\"label::detail\" adds a line under a label. --icons: the labels are Font Awesome icon names, drawn as icons. A " +
		"question asked again with the same key replaces the first.",
	Args: cobra.ExactArgs(2),
	RunE: moltenLearnWrap(moltenMorphAskRun),
}

var moltenMorphDesignAnswerCmd = &cobra.Command{
	Use:   "answer <key> <value> [--question <text>] [--step <step>] [--no-learn]",
	Short: "show in the panel what the developer answered in the terminal",
	Long: "Use it when the developer answered in the terminal, so the panel shows it and nothing is asked twice. It also records " +
		"the answer in the memory of the morph-design workflow (molten learn), so the next design starts from it; --no-learn " +
		"records nothing.",
	Args: cobra.ExactArgs(2),
	RunE: moltenLearnWrap(moltenMorphAnswerRun),
}

var moltenMorphDesignPlanCmd = &cobra.Command{
	Use:   "plan --summary <text> [--molten-part <line>…] [--agent-part <line>…] [--access <line>…] [--wait <line>…]",
	Short: "show the plan in the panel: what goes where, what the mod will access, what waits; the developer agrees there",
	Args:  cobra.NoArgs,
	RunE:  moltenLearnWrap(moltenMorphPlanRun),
}

var moltenMorphDesignDraftCmd = &cobra.Command{
	Use:   "draft [--state none|sample|real] [--note <text>] [--command <name>…] [--box <title>…]",
	Short: "tell the panel what the draft draws today: its commands and boxes, and whether it shows sample data",
	Args:  cobra.NoArgs,
	RunE:  moltenLearnWrap(moltenMorphDraftRun),
}

func init() {
	moltenCmd.AddCommand(moltenMorphCmd)
	moltenMorphCmd.AddCommand(moltenMorphDesignCmd)
	moltenMorphDesignCmd.Flags().StringVar(&moltenMorphName, "name", "", "the mod's name as the developer reads it (the tab's title)")
	moltenMorphDesignOpenCmd.Flags().StringVar(&moltenMorphName, "name", "", "the mod's name as the developer reads it (the tab's title)")
	moltenMorphDesignStepCmd.Flags().StringVar(&moltenMorphSay, "say", "", "one plain sentence shown under the step")
	moltenMorphDesignStepCmd.Flags().BoolVar(&moltenMorphDone, "done", false, "settle the step: done")
	moltenMorphDesignStepCmd.Flags().BoolVar(&moltenMorphSkipped, "skipped", false, "settle the step: skipped (for example, the developer said to just do it)")
	moltenMorphDesignStepCmd.Flags().BoolVar(&moltenMorphTodo, "todo", false, "bring the step back to do")
	moltenMorphDesignAskCmd.Flags().StringArrayVar(&moltenMorphChoices, "choice", nil, "a choice: label, or label::detail (repeat)")
	moltenMorphDesignAskCmd.Flags().StringVar(&moltenMorphRecommend, "recommend", "", "the label you recommend")
	moltenMorphDesignAskCmd.Flags().BoolVar(&moltenMorphIcons, "icons", false, "the labels are Font Awesome icon names")
	moltenMorphDesignAskCmd.Flags().StringVar(&moltenMorphStepFlag, "step", "", "the step the question belongs to (default: questions)")
	moltenMorphDesignAnswerCmd.Flags().StringVar(&moltenMorphQuestion, "question", "", "the question's text, when it was not asked in the panel")
	moltenMorphDesignAnswerCmd.Flags().StringVar(&moltenMorphStepFlag, "step", "", "the step the answer belongs to (default: questions)")
	moltenMorphDesignAnswerCmd.Flags().BoolVar(&moltenMorphNoLearn, "no-learn", false, "do not record the answer in the workflow's memory")
	moltenMorphDesignPlanCmd.Flags().StringVar(&moltenMorphSummary, "summary", "", "the request in your words and the plan, scaled to how precise it was")
	moltenMorphDesignPlanCmd.Flags().StringArrayVar(&moltenMorphMoltenPart, "molten-part", nil, "a piece that goes in the MoltenTerm part (repeat)")
	moltenMorphDesignPlanCmd.Flags().StringArrayVar(&moltenMorphAgentPart, "agent-part", nil, "a piece that goes in the agent part (repeat)")
	moltenMorphDesignPlanCmd.Flags().StringArrayVar(&moltenMorphAccesses, "access", nil, "one thing the mod will access: a file, a setting, a service, a program (repeat)")
	moltenMorphDesignPlanCmd.Flags().StringArrayVar(&moltenMorphWaits, "wait", nil, "a piece the installed version cannot do yet, with its story (repeat)")
	moltenMorphDesignDraftCmd.Flags().StringVar(&moltenMorphDraftState, "state", "", "none, sample (invented data) or real (default: sample)")
	moltenMorphDesignDraftCmd.Flags().StringVar(&moltenMorphNote, "note", "", "one sentence about the draft")
	moltenMorphDesignDraftCmd.Flags().StringArrayVar(&moltenMorphCommands, "command", nil, "a command the draft adds (repeat)")
	moltenMorphDesignDraftCmd.Flags().StringArrayVar(&moltenMorphBoxes, "box", nil, "a box the draft draws next to a terminal (repeat)")
	for _, cmd := range []*cobra.Command{moltenMorphDesignCmd, moltenMorphDesignOpenCmd, moltenMorphDesignShowCmd, moltenMorphDesignStepCmd,
		moltenMorphDesignAskCmd, moltenMorphDesignAnswerCmd, moltenMorphDesignPlanCmd, moltenMorphDesignDraftCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		cmd.SetFlagErrorFunc(func(_ *cobra.Command, err error) error {
			moltenLearnFail(moltenLearnUsageError{msg: err.Error()})
			return nil
		})
		if cmd != moltenMorphDesignCmd && cmd != moltenMorphDesignOpenCmd {
			cmd.Flags().StringVar(&moltenMorphMod, "mod", "", "the mod's id, when several designs are open (default: this tab's, else the one you drive)")
		}
	}
	for _, cmd := range []*cobra.Command{moltenMorphDesignOpenCmd, moltenMorphDesignShowCmd, moltenMorphDesignStepCmd, moltenMorphDesignAskCmd,
		moltenMorphDesignAnswerCmd, moltenMorphDesignPlanCmd, moltenMorphDesignDraftCmd} {
		moltenMorphDesignCmd.AddCommand(cmd)
	}
}

// moltenMorphCaller sends a command to wavesrv; the tests give it a fake.
type moltenMorphCaller func(command string, req molten.MorphDesignRequest, out any) error

func moltenMorphCall(command string, req molten.MorphDesignRequest, out any) error {
	resp, err := RpcClient.SendRpcRequest(command, req, &wshrpc.RpcOpts{Route: molten.MorphDesignRoute, Timeout: moltenMorphTimeoutMs})
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

func moltenMorphUsage(format string, args ...any) error {
	return moltenLearnUsageError{msg: fmt.Sprintf(format, args...)}
}

func moltenMorphDesignRun(cmd *cobra.Command, args []string) error {
	if len(args) != 1 {
		return moltenMorphUsage("name the mod: molten morph design <mod-id> [--name <title>]")
	}
	cwd, err := os.Getwd()
	if err != nil {
		return fmt.Errorf("this terminal's folder is unknown: %w", err)
	}
	return runMoltenMorphOpen(moltenMorphCall, time.Sleep, args[0], moltenMorphName, cwd, moltenJson, WrappedStdout)
}

// runMoltenMorphOpen asks for the design, then looks for the window's answer: the design's Opened holds the hand-off
// once the tab is there, so an agent learns whether the view opened and goes on in the terminal when it did not.
func runMoltenMorphOpen(call moltenMorphCaller, sleep func(time.Duration), mod string, name string, cwd string, asJson bool, stdout io.Writer) error {
	if !molten.MorphModIdRegex.MatchString(mod) {
		return moltenMorphUsage("invalid mod id %q: use lowercase letters, digits, \".\", \"_\" or \"-\", starting with a letter or digit", mod)
	}
	var opened molten.MorphDesignOpened
	if err := call(molten.MorphDesignOpenCommand, molten.MorphDesignRequest{Mod: mod, Name: name, Cwd: cwd}, &opened); err != nil {
		return err
	}
	design := opened.Design
	shown := design.Opened == opened.HandoffId
	for look := 0; !shown && look < moltenMorphOpenLooks; look++ {
		sleep(moltenMorphOpenPoll)
		if err := call(molten.MorphDesignShowCommand, molten.MorphDesignRequest{Mod: mod}, &design); err != nil {
			return err
		}
		shown = design.Opened == opened.HandoffId
	}
	if asJson {
		if err := moltenWriteJsonTo(stdout, map[string]any{"design": design, "shown": shown}); err != nil {
			return err
		}
	} else if shown {
		fmt.Fprintf(stdout, "The design view of %s is open in this window, beside a terminal. Keep it in step with molten morph design step|ask|answer|plan|draft; the developer's choices arrive as lines in your prompt.\n", mod)
	}
	if !shown {
		return fmt.Errorf("the design view did not open: no MoltenTerm window of this workspace answered. Go on in this terminal, with the same steps")
	}
	return nil
}

func moltenMorphShowRun(cmd *cobra.Command, args []string) error {
	return runMoltenMorphShow(moltenMorphCall, moltenMorphMod, moltenJson, WrappedStdout)
}

func runMoltenMorphShow(call moltenMorphCaller, mod string, asJson bool, stdout io.Writer) error {
	var design molten.MorphDesign
	if err := call(molten.MorphDesignShowCommand, molten.MorphDesignRequest{Mod: mod}, &design); err != nil {
		return err
	}
	if asJson {
		return moltenWriteJsonTo(stdout, design)
	}
	fmt.Fprint(stdout, formatMoltenMorphDesign(design))
	return nil
}

func moltenMorphStepRun(cmd *cobra.Command, args []string) error {
	state, err := moltenMorphStepState(moltenMorphDone, moltenMorphSkipped, moltenMorphTodo)
	if err != nil {
		return err
	}
	return runMoltenMorphChange(moltenMorphCall, molten.MorphDesignStepCommand,
		molten.MorphDesignRequest{Mod: moltenMorphMod, Step: args[0], Say: moltenMorphSay, State: state}, moltenJson, WrappedStdout,
		func(d molten.MorphDesign) string {
			if state == "" {
				return fmt.Sprintf("The panel is on the step %s.\n", args[0])
			}
			return fmt.Sprintf("The step %s is %s in the panel.\n", args[0], state)
		})
}

func moltenMorphStepState(done bool, skipped bool, todo bool) (string, error) {
	state := ""
	for _, s := range []struct {
		on   bool
		name string
	}{{done, molten.MorphStepDone}, {skipped, molten.MorphStepSkipped}, {todo, molten.MorphStepTodo}} {
		if !s.on {
			continue
		}
		if state != "" {
			return "", moltenMorphUsage("give at most one of --done, --skipped and --todo")
		}
		state = s.name
	}
	return state, nil
}

// parseMoltenMorphChoices reads --choice values: "label" or "label::detail".
func parseMoltenMorphChoices(values []string) ([]molten.MorphDesignChoice, error) {
	choices := []molten.MorphDesignChoice{}
	for _, value := range values {
		label, detail, _ := strings.Cut(value, moltenMorphDetailSep)
		if strings.TrimSpace(label) == "" {
			return nil, moltenMorphUsage("--choice takes a label, got %q", value)
		}
		choices = append(choices, molten.MorphDesignChoice{Label: strings.TrimSpace(label), Detail: strings.TrimSpace(detail)})
	}
	return choices, nil
}

func moltenMorphAskRun(cmd *cobra.Command, args []string) error {
	choices, err := parseMoltenMorphChoices(moltenMorphChoices)
	if err != nil {
		return err
	}
	if len(choices) == 0 {
		return moltenMorphUsage("give the choices to pick from with --choice <label> (two to four, the one you recommend first)")
	}
	kind := molten.MorphKindChoice
	if moltenMorphIcons {
		kind = molten.MorphKindIcon
	}
	req := molten.MorphDesignRequest{
		Mod: moltenMorphMod, Key: args[0], Text: args[1], Kind: kind, Choices: choices, Recommended: moltenMorphRecommend, Step: moltenMorphStepFlag,
	}
	return runMoltenMorphChange(moltenMorphCall, molten.MorphDesignAskCommand, req, moltenJson, WrappedStdout, func(d molten.MorphDesign) string {
		return fmt.Sprintf("The question %s is in the panel with %d choices: the developer's pick arrives as a line in your prompt.\n", args[0], len(choices))
	})
}

func moltenMorphAnswerRun(cmd *cobra.Command, args []string) error {
	req := molten.MorphDesignRequest{Mod: moltenMorphMod, Key: args[0], Value: args[1], Text: moltenMorphQuestion, Step: moltenMorphStepFlag}
	return runMoltenMorphAnswer(moltenMorphCall, moltenLearnCall, req, !moltenMorphNoLearn, moltenJson, WrappedStdout, WrappedStderr)
}

// runMoltenMorphAnswer shows the answer in the panel, then remembers it in the workflow's memory: the answer is the
// developer's, so the next design starts from it. A memory that cannot take it never fails the answer.
func runMoltenMorphAnswer(call moltenMorphCaller, learn moltenLearnCaller, req molten.MorphDesignRequest, remember bool, asJson bool, stdout io.Writer, stderr io.Writer) error {
	var design molten.MorphDesign
	if err := call(molten.MorphDesignAnswerCommand, req, &design); err != nil {
		return err
	}
	learned := false
	if remember {
		record := molten.LearningRequest{Workflow: molten.LearningWorkflowMorphDesign, Kind: molten.LearningKindAnswer, Key: req.Key, Value: req.Value, Run: design.Mod}
		var recorded molten.LearningRecorded
		if err := learn(molten.LearningRecordCommand, record, &recorded); err != nil {
			fmt.Fprintf(stderr, "molten: the answer is in the panel but was not remembered: %v\n", err)
		} else {
			learned = true
		}
	}
	if asJson {
		return moltenWriteJsonTo(stdout, map[string]any{"design": design, "learned": learned})
	}
	if learned {
		fmt.Fprintf(stdout, "The panel shows the answer to %s, and it is remembered for the next design.\n", req.Key)
		return nil
	}
	fmt.Fprintf(stdout, "The panel shows the answer to %s.\n", req.Key)
	return nil
}

func moltenMorphPlanRun(cmd *cobra.Command, args []string) error {
	if strings.TrimSpace(moltenMorphSummary) == "" {
		return moltenMorphUsage("give the plan's summary with --summary <text>")
	}
	plan := molten.MorphDesignPlan{
		Summary: moltenMorphSummary, MoltenPart: moltenMorphMoltenPart, AgentPart: moltenMorphAgentPart,
		Accesses: moltenMorphAccesses, Waits: moltenMorphWaits,
	}
	return runMoltenMorphChange(moltenMorphCall, molten.MorphDesignPlanCommand, molten.MorphDesignRequest{Mod: moltenMorphMod, Plan: &plan},
		moltenJson, WrappedStdout, func(d molten.MorphDesign) string {
			return "The plan is in the panel: the developer agrees there, or says so in the terminal. Wait for it before you create anything.\n"
		})
}

func moltenMorphDraftRun(cmd *cobra.Command, args []string) error {
	draft := molten.MorphDesignDraft{State: moltenMorphDraftState, Note: moltenMorphNote, Commands: moltenMorphCommands, Boxes: moltenMorphBoxes}
	return runMoltenMorphChange(moltenMorphCall, molten.MorphDesignDraftCommand, molten.MorphDesignRequest{Mod: moltenMorphMod, Draft: &draft},
		moltenJson, WrappedStdout, func(d molten.MorphDesign) string {
			return "The preview shows what the draft draws today.\n"
		})
}

// runMoltenMorphChange sends one change of the design and prints a line saying what the panel shows now.
func runMoltenMorphChange(call moltenMorphCaller, command string, req molten.MorphDesignRequest, asJson bool, stdout io.Writer, said func(d molten.MorphDesign) string) error {
	var design molten.MorphDesign
	if err := call(command, req, &design); err != nil {
		return err
	}
	if asJson {
		return moltenWriteJsonTo(stdout, design)
	}
	fmt.Fprint(stdout, said(design))
	return nil
}

func moltenMorphStepLabel(step molten.MorphDesignStep, current string) string {
	switch {
	case step.Id == current && step.State == molten.MorphStepTodo:
		return "current"
	case step.State == molten.MorphStepTodo:
		return "to do"
	case step.By != "":
		return step.State + " (" + step.By + ")"
	}
	return step.State
}

// formatMoltenMorphDesign is what `show` prints: the design as the panel draws it, so an agent reads what the
// developer sees and answered.
func formatMoltenMorphDesign(d molten.MorphDesign) string {
	var sb strings.Builder
	title := d.Mod
	if d.Name != "" {
		title = fmt.Sprintf("%s (%s)", d.Mod, moltenPrintable(d.Name))
	}
	fmt.Fprintf(&sb, "design of %s, folder %s\n", title, moltenPrintable(d.Dir))
	if d.TabId == "" {
		sb.WriteString("view: not open in a window yet\n")
	} else {
		sb.WriteString("view: open\n")
	}
	fmt.Fprintf(&sb, "current step: %s\n", d.Current)
	sb.WriteString("steps:\n")
	for _, step := range d.Steps {
		fmt.Fprintf(&sb, "  %-9s %s", step.Id, moltenMorphStepLabel(step, d.Current))
		if step.Say != "" {
			fmt.Fprintf(&sb, " - %s", moltenPrintable(step.Say))
		}
		sb.WriteString("\n")
	}
	if len(d.Questions) > 0 {
		sb.WriteString("questions:\n")
	}
	for _, q := range d.Questions {
		fmt.Fprintf(&sb, "  %s [%s]: %s\n", q.Key, q.Step, moltenPrintable(q.Text))
		if q.Answer != "" {
			fmt.Fprintf(&sb, "    answered by the developer (%s): %s\n", q.AnsweredBy, moltenPrintable(q.Answer))
			continue
		}
		for i, c := range q.Choices {
			mark := ""
			if c.Label == q.Recommended {
				mark = " (recommended)"
			}
			fmt.Fprintf(&sb, "    %d) %s%s\n", i+1, moltenPrintable(c.Label), mark)
		}
		sb.WriteString("    not answered yet\n")
	}
	if d.Plan != nil {
		sb.WriteString("plan:\n")
		fmt.Fprintf(&sb, "  summary: %s\n", moltenPrintable(d.Plan.Summary))
		for _, part := range []struct {
			title string
			items []string
		}{{"MoltenTerm part", d.Plan.MoltenPart}, {"agent part", d.Plan.AgentPart}, {"accesses", d.Plan.Accesses}, {"waits", d.Plan.Waits}} {
			for _, item := range part.items {
				fmt.Fprintf(&sb, "  %s: %s\n", part.title, moltenPrintable(item))
			}
		}
		if d.Plan.Agreed {
			fmt.Fprintf(&sb, "  the developer agreed (%s)\n", d.Plan.AgreedBy)
		} else {
			sb.WriteString("  the developer has not agreed yet\n")
		}
	}
	fmt.Fprintf(&sb, "draft: %s", d.Draft.State)
	if len(d.Draft.Commands) > 0 {
		fmt.Fprintf(&sb, ", commands: %s", strings.Join(moltenPrintableList(d.Draft.Commands), ", "))
	}
	if len(d.Draft.Boxes) > 0 {
		fmt.Fprintf(&sb, ", boxes: %s", strings.Join(moltenPrintableList(d.Draft.Boxes), ", "))
	}
	sb.WriteString("\n")
	if d.Outcome != "" {
		fmt.Fprintf(&sb, "the developer decided in the panel: %s\n", d.Outcome)
	}
	if d.Agent == nil {
		sb.WriteString("clicks go to: no agent runs here to take them; the developer's choices stay in this design\n")
	} else {
		fmt.Fprintf(&sb, "clicks go to: %s\n", moltenPrintable(strings.TrimSpace(d.Agent.FirstName+" "+d.Agent.Agent)))
	}
	if d.Told != nil {
		fmt.Fprintf(&sb, "last click: %s\n", d.Told.Status)
	}
	return sb.String()
}
