// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"os"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpreview"
	"github.com/wavetermdev/waveterm/pkg/util/envutil"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"golang.org/x/term"
)

// `molten review show|comments|open|publish|merge|restart` (FR-REV-014). show and comments read the Reviews data and
// the review store, the same data the views show: they are the only review commands an agent should run. open,
// publish, merge and restart hand off to the window of this terminal's workspace (pkg/molten/review/cli.go): it opens
// the PR's Review tab, and its Publish, Validate or Restart work sheet. The terminal prints what the sheet shows, then
// follows the outcome. GitHub gets a review or a merge, and an agent the round's comments, only on the developer's click
// in the sheet (DS-REV-011): a prompt in a terminal can be answered by an agent, so the sheet's click is the
// confirmation. publish, merge and restart refuse in an agent's terminal.

// must match pkg/molten/review (route.go, cli.go, merge.go, publish.go, comments.go, cleanup.go)
const (
	moltenReviewRoute           = "molten:review"
	moltenReviewStateCommand    = "moltenreviewstate"
	moltenReviewHandoffCommand  = "moltenreviewhandoff"
	moltenReviewPlanShownCmd    = "moltenreviewmergeplanshown"
	moltenReviewHandoffOpen     = "open"
	moltenReviewHandoffPublish  = "publish"
	moltenReviewHandoffMerge    = "merge"
	moltenReviewHandoffRestart  = "restart"
	moltenReviewRpcTimeoutMs    = 20000
	moltenReviewMergeMerged     = "merged"
	moltenReviewCommentStaged   = "staged"
	moltenReviewCommentTransl   = "translated"
	moltenReviewCommentProposed = "proposed"

	// The window reads GitHub for the plan: the terminal waits that long for the sheet's plan.
	moltenReviewPlanWait = 90 * time.Second
	// How long the terminal waits for the developer's click in the sheet, then for the merge (GitHub may rebase and
	// wait for CI, up to 45 minutes) and its cleanup.
	moltenReviewClickWait  = 15 * time.Minute
	moltenReviewMergeWait  = 60 * time.Minute
	moltenReviewFollowStep = 2 * time.Second
)

type moltenReviewText struct {
	Lang string `json:"lang,omitempty"`
	Text string `json:"text"`
}

type moltenReviewMessage struct {
	By   string `json:"by"`
	At   int64  `json:"at"`
	Text string `json:"text,omitempty"`
}

type moltenReviewComment struct {
	Id          string                `json:"id"`
	Round       string                `json:"round,omitempty"`
	Anchor      mcpreview.Anchor      `json:"anchor"`
	Subject     string                `json:"subject"`
	Kind        string                `json:"kind"`
	State       string                `json:"state"`
	Original    moltenReviewText      `json:"original"`
	Translation *moltenReviewText     `json:"translation,omitempty"`
	PublishedAs string                `json:"publishedas,omitempty"`
	PublishNote string                `json:"publishnote,omitempty"`
	Author      string                `json:"author"`
	Outdated    bool                  `json:"outdated,omitempty"`
	CreatedAt   int64                 `json:"createdat"`
	Discussion  []moltenReviewMessage `json:"discussion,omitempty"`
}

type moltenReviewRound struct {
	Id          string `json:"id"`
	StartedAt   int64  `json:"startedat"`
	HeadOid     string `json:"headoid"`
	PublishedAt int64  `json:"publishedat,omitempty"`
	GithubUrl   string `json:"githuburl,omitempty"`
	RestartedAt int64  `json:"restartedat,omitempty"`
	// The agent and the worktree Restart work handed the round to (FR-REV-011).
	RestartAgent    string `json:"restartagent,omitempty"`
	RestartWorktree string `json:"restartworktree,omitempty"`
	Lang            string `json:"lang,omitempty"`
}

type moltenReviewMerge struct {
	Method         string             `json:"method,omitempty"`
	State          string             `json:"state"`
	Refused        string             `json:"refused,omitempty"`
	Code           string             `json:"code,omitempty"`
	Error          string             `json:"error,omitempty"`
	Blocking       *moltenReviewCheck `json:"blocking,omitempty"`
	Names          []string           `json:"names,omitempty"`
	MovedFrom      string             `json:"movedfrom,omitempty"`
	MovedTo        string             `json:"movedto,omitempty"`
	Minutes        int                `json:"minutes,omitempty"`
	PlanHead       string             `json:"planhead"`
	Head           string             `json:"head,omitempty"`
	MergedOid      string             `json:"mergedoid,omitempty"`
	Updated        bool               `json:"updated,omitempty"`
	StartedAt      int64              `json:"startedat"`
	EndedAt        int64              `json:"endedat,omitempty"`
	CleanupRunning bool               `json:"cleanuprunning,omitempty"`
}

type moltenReviewLoss struct {
	Changes     []string `json:"changes"`
	ChangeCount int      `json:"changecount"`
	Commits     []struct {
		Sha     string `json:"sha"`
		Subject string `json:"subject"`
	} `json:"commits"`
	CommitCount int `json:"commitcount"`
}

type moltenReviewCleanupStep struct {
	Id     string            `json:"id"`
	State  string            `json:"state"`
	Code   string            `json:"code,omitempty"`
	Error  string            `json:"error,omitempty"`
	Ticket int               `json:"ticket,omitempty"`
	Branch string            `json:"branch,omitempty"`
	Base   string            `json:"base,omitempty"`
	Path   string            `json:"path,omitempty"`
	Loss   *moltenReviewLoss `json:"loss,omitempty"`
	Panels []struct {
		Tab   string `json:"tab,omitempty"`
		Agent string `json:"agent,omitempty"`
	} `json:"panels,omitempty"`
	Updated int `json:"updated,omitempty"`
	Flagged int `json:"flagged,omitempty"`
	Failed  int `json:"failed,omitempty"`
}

type moltenReviewCleanup struct {
	Steps   []moltenReviewCleanupStep `json:"steps"`
	StartAt int64                     `json:"startedat"`
	EndAt   int64                     `json:"endedat"`
}

type moltenReviewPublishNote struct {
	CommentId string `json:"commentid"`
	Note      string `json:"note"`
	Message   string `json:"message,omitempty"`
}

type moltenReviewPublish struct {
	State     string                    `json:"state"`
	Lang      string                    `json:"lang"`
	AsWritten bool                      `json:"aswritten,omitempty"`
	Url       string                    `json:"url,omitempty"`
	Message   string                    `json:"message,omitempty"`
	Notes     []moltenReviewPublishNote `json:"notes,omitempty"`
	StartedAt int64                     `json:"startedat"`
	EndedAt   int64                     `json:"endedat,omitempty"`
}

type moltenReviewState struct {
	Repo     string `json:"repo"`
	Number   int    `json:"number"`
	Briefing *struct {
		HeadOid string `json:"headoid,omitempty"`
		Agent   string `json:"agent,omitempty"`
		At      int64  `json:"at"`
	} `json:"briefing,omitempty"`
	Explanations []any                 `json:"explanations,omitempty"`
	Viewed       map[string]string     `json:"viewed"`
	LastHead     string                `json:"lasthead,omitempty"`
	Rounds       []moltenReviewRound   `json:"rounds"`
	Comments     []moltenReviewComment `json:"comments"`
	Merge        *moltenReviewMerge    `json:"merge,omitempty"`
	Cleanup      *moltenReviewCleanup  `json:"cleanup,omitempty"`
	Summary      *struct {
		Original    moltenReviewText  `json:"original"`
		Translation *moltenReviewText `json:"translation,omitempty"`
	} `json:"summary,omitempty"`
	Publish *moltenReviewPublish `json:"publish,omitempty"`
}

type moltenReviewCheck struct {
	Id      string   `json:"id"`
	State   string   `json:"state"`
	Code    string   `json:"code,omitempty"`
	Count   int      `json:"count,omitempty"`
	Local   int      `json:"local,omitempty"`
	Names   []string `json:"names,omitempty"`
	Base    string   `json:"base,omitempty"`
	PrState string   `json:"prstate,omitempty"`
}

type moltenReviewStep struct {
	Id string `json:"id"`
}

type moltenReviewPlan struct {
	Method     string                    `json:"method,omitempty"`
	Methods    []string                  `json:"methods,omitempty"`
	MethodRule string                    `json:"methodrule,omitempty"`
	Queue      bool                      `json:"queue,omitempty"`
	Title      string                    `json:"title,omitempty"`
	Ticket     int                       `json:"ticket,omitempty"`
	HeadRef    string                    `json:"headref"`
	BaseRef    string                    `json:"baseref"`
	HeadOid    string                    `json:"headoid"`
	Checks     []moltenReviewCheck       `json:"checks"`
	Steps      []moltenReviewStep        `json:"steps"`
	Cleanup    []moltenReviewCleanupStep `json:"cleanup"`
	CanMerge   bool                      `json:"canmerge"`
	Blocking   string                    `json:"blocking,omitempty"`
	Warnings   []string                  `json:"warnings"`
	CreatedAt  int64                     `json:"createdat"`
}

type moltenReviewHandoffResult struct {
	WorkspaceId string `json:"workspaceid"`
	At          int64  `json:"at"`
}

// moltenReviewTarget is a PR of the Reviews list: its row as the view has it, and its review store.
type moltenReviewTarget struct {
	Dir    string
	Repo   string
	Pr     moltenReviewPr
	Row    any
	State  moltenReviewState
	RawSt  any
	Target string
}

var moltenReviewNoWait bool

var moltenReviewShowCmd = &cobra.Command{
	Use:     "show <N>",
	Short:   "a PR's review: its row in the Control room, the briefing, the comments, the rounds, the publish and the merge (read-only)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenReviewShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenReviewCommentsCmd = &cobra.Command{
	Use:     "comments <N>",
	Short:   "a PR's review comments with their state, their lines, the text as written and its translation (read-only)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenReviewCommentsRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenReviewOpenCmd = &cobra.Command{
	Use:     "open <N>",
	Short:   "open the PR's Review tab in this terminal's window",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenReviewOpenRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenReviewPublishCmd = &cobra.Command{
	Use:   "publish <N>",
	Short: "show what Publish review will post, open its sheet in the window, then follow the post (the click is in the sheet)",
	Long: "Prints the staged comments the Publish sheet will post, then opens the PR's Review tab on its Publish sheet in\n" +
		"this terminal's window. GitHub gets the review only when you click Post review in that sheet; the command then\n" +
		"prints the outcome. Refused in a terminal where an agent runs.",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenReviewPublishRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenReviewMergeCmd = &cobra.Command{
	Use:   "merge <N>",
	Short: "open Validate's plan in the window, print the same plan, then follow the merge and its cleanup (the click is in the sheet)",
	Long: "Opens the PR's Review tab on its Validate sheet in this terminal's window, prints the plan the sheet shows\n" +
		"(checks, steps, cleanup, warnings), then follows the merge and the cleanup once you click Merge in that sheet.\n" +
		"Refused in a terminal where an agent runs.",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenReviewMergeRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenReviewRestartCmd = &cobra.Command{
	Use:   "restart <N>",
	Short: "open Restart work's sheet in the window: the last published round goes to an agent on your click there",
	Long: "Opens the PR's Review tab on its Restart work sheet in this terminal's window and prints the round it hands\n" +
		"over. The round's comments go to an agent in the worktree of the PR's branch only when you click Restart work\n" +
		"in that sheet. Refused in a terminal where an agent runs.",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenReviewRestartRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	for _, cmd := range []*cobra.Command{moltenReviewShowCmd, moltenReviewCommentsCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	}
	for _, cmd := range []*cobra.Command{moltenReviewPublishCmd, moltenReviewMergeCmd, moltenReviewRestartCmd} {
		cmd.Flags().BoolVar(&moltenReviewNoWait, "no-wait", false, "open the sheet and print its plan, without following the outcome")
	}
	for _, cmd := range []*cobra.Command{moltenReviewShowCmd, moltenReviewCommentsCmd, moltenReviewOpenCmd,
		moltenReviewPublishCmd, moltenReviewMergeCmd, moltenReviewRestartCmd} {
		moltenReviewCmd.AddCommand(cmd)
	}
}

func moltenReviewNumber(arg string) (int, error) {
	number, err := strconv.Atoi(strings.TrimPrefix(strings.TrimSpace(arg), "#"))
	if err != nil || number <= 0 {
		return 0, fmt.Errorf("%q is not a PR number", arg)
	}
	return number, nil
}

func moltenReviewRequest(command string, data any, out any) (any, error) {
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: moltenReviewRoute, Timeout: moltenReviewRpcTimeoutMs})
	if err != nil {
		return nil, fmt.Errorf("asking MoltenTerm (%s): %w", command, err)
	}
	if out != nil {
		if err := utilfn.ReUnmarshal(out, resp); err != nil {
			return nil, err
		}
	}
	return resp, nil
}

// moltenReviewsSettledAsk reads the Reviews list as `molten review list` does, waiting for GitHub on a first ask.
func moltenReviewsSettledAsk(dir string) (moltenReviewsAnswer, any, error) {
	answer, raw, err := moltenReviewsAskRaw(dir)
	deadline := time.Now().Add(moltenReviewsWait)
	for err == nil && !moltenReviewsSettled(answer) && time.Now().Before(deadline) {
		time.Sleep(moltenReviewsPollStep)
		answer, raw, err = moltenReviewsAskRaw(dir)
	}
	return answer, raw, err
}

// moltenReviewRowOf finds PR number among the list's rows; row is that row as the server sent it.
func moltenReviewRowOf(answer moltenReviewsAnswer, raw any, number int) (moltenReviewPr, any, bool) {
	var rows struct {
		Ready  []any `json:"ready"`
		Drafts []any `json:"drafts"`
	}
	utilfn.ReUnmarshal(&rows, raw)
	all := append(append([]moltenReviewPr{}, answer.Ready...), answer.Drafts...)
	allRaw := append(append([]any{}, rows.Ready...), rows.Drafts...)
	for i, pr := range all {
		if pr.Number != number {
			continue
		}
		var row any
		if i < len(allRaw) {
			row = allRaw[i]
		}
		return pr, row, true
	}
	return moltenReviewPr{}, nil, false
}

func moltenReviewFind(arg string) (moltenReviewTarget, error) {
	var t moltenReviewTarget
	number, err := moltenReviewNumber(arg)
	if err != nil {
		return t, err
	}
	dir, err := moltenReviewProjectDir()
	if err != nil {
		return t, err
	}
	answer, raw, err := moltenReviewsSettledAsk(dir)
	if err != nil {
		return t, err
	}
	if answer.State != "ok" {
		return t, fmt.Errorf("%s", strings.TrimSpace(formatMoltenReviews(answer)))
	}
	pr, row, ok := moltenReviewRowOf(answer, raw, number)
	if !ok {
		return t, fmt.Errorf("PR #%d is not among the open PRs into %s of %s (molten review list)", number, answer.Target, answer.Repo)
	}
	t = moltenReviewTarget{Dir: dir, Repo: answer.Repo, Pr: pr, Row: row, Target: answer.Target}
	t.RawSt, err = moltenReviewRequest(moltenReviewStateCommand, map[string]any{"repo": t.Repo, "number": number}, &t.State)
	if err != nil {
		return t, err
	}
	return t, nil
}

func moltenReviewShowRun(cmd *cobra.Command, args []string) error {
	t, err := moltenReviewFind(args[0])
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"dir": t.Dir, "repo": t.Repo, "target": t.Target, "pr": t.Row, "review": t.RawSt})
	}
	WriteStdout("%s", formatMoltenReviewShow(t))
	return nil
}

func moltenReviewCommentsRun(cmd *cobra.Command, args []string) error {
	t, err := moltenReviewFind(args[0])
	if err != nil {
		return err
	}
	if moltenJson {
		var raw struct {
			Comments []any `json:"comments"`
		}
		utilfn.ReUnmarshal(&raw, t.RawSt)
		if raw.Comments == nil {
			raw.Comments = []any{}
		}
		return moltenWriteJson(map[string]any{"repo": t.Repo, "number": t.Pr.Number, "comments": raw.Comments})
	}
	WriteStdout("%s", formatMoltenReviewComments(t.State.Comments))
	return nil
}

func moltenReviewHandoff(t moltenReviewTarget, action string) (moltenReviewHandoffResult, error) {
	var result moltenReviewHandoffResult
	token := os.Getenv(wshutil.WaveJwtTokenVarName)
	if token == "" {
		return result, fmt.Errorf("molten must run in a MoltenTerm terminal (WAVETERM_JWT is not set)")
	}
	data := map[string]any{"token": token, "action": action, "dir": t.Dir, "number": t.Pr.Number}
	// wavesrv's refusal is the message: it is printed as it is, for the developer and for an agent parsing it.
	resp, err := RpcClient.SendRpcRequest(moltenReviewHandoffCommand, data, &wshrpc.RpcOpts{Route: moltenReviewRoute, Timeout: moltenReviewRpcTimeoutMs})
	if err != nil {
		return result, err
	}
	return result, utilfn.ReUnmarshal(&result, resp)
}

func moltenReviewOpenRun(cmd *cobra.Command, args []string) error {
	t, err := moltenReviewFind(args[0])
	if err != nil {
		return err
	}
	if _, err := moltenReviewHandoff(t, moltenReviewHandoffOpen); err != nil {
		return err
	}
	WriteStdout("the Review tab of PR #%d opens in this terminal's window\n", t.Pr.Number)
	return nil
}

// moltenReviewAgentMarker names the agent session marker of this process's environment, "" when there is none: the
// variables Claude Code, Codex and Gemini CLI set for the commands they run.
func moltenReviewAgentMarker(getenv func(string) string) string {
	var names []string
	for name := range envutil.AgentSessionMarkers {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		if getenv(name) != "" {
			return name
		}
	}
	return ""
}

// moltenReviewGuard refuses publish and merge where an agent may run them: wavesrv refuses them too when it sees an
// agent in this terminal, and the click in the window's sheet stays the only way to post or merge.
func moltenReviewGuard(action string) error {
	if marker := moltenReviewAgentMarker(os.Getenv); marker != "" {
		return fmt.Errorf("molten review %s is refused to agents (%s is set): it is the developer's, from the Review tab of a MoltenTerm window", action, marker)
	}
	// /dev/null is a character device too: only a terminal counts.
	if !term.IsTerminal(int(os.Stdin.Fd())) {
		return fmt.Errorf("molten review %s needs a developer at an interactive terminal: run it in a MoltenTerm terminal, or use the Review tab", action)
	}
	return nil
}

func moltenReviewRestartRun(cmd *cobra.Command, args []string) error {
	if err := moltenReviewGuard("restart"); err != nil {
		return err
	}
	t, err := moltenReviewFind(args[0])
	if err != nil {
		return err
	}
	round, number := moltenReviewLastPublished(t.State.Rounds)
	if round == nil {
		return fmt.Errorf("no review round of PR #%d is published yet: publish your comments first (molten review publish %d)", t.Pr.Number, t.Pr.Number)
	}
	WriteStdout("%s", formatMoltenReviewRestartPlan(t.Pr.Number, *round, number, t.State.Comments))
	handed, err := moltenReviewHandoff(t, moltenReviewHandoffRestart)
	if err != nil {
		return err
	}
	WriteStdout("\nThe Restart work sheet is open in the Review tab of this terminal's window. No agent gets the round until\n" +
		"you click Restart work there.\n")
	if moltenReviewNoWait {
		return nil
	}
	WriteStdout("Waiting for your click in the sheet (Ctrl-C stops waiting, not the sheet)...\n")
	state, err := moltenReviewFollow(t, moltenReviewClickWait, func(state moltenReviewState) bool {
		r, _ := moltenReviewLastPublished(state.Rounds)
		return r != nil && r.RestartedAt >= handed.At
	})
	if err != nil {
		return err
	}
	r, _ := moltenReviewLastPublished(state.Rounds)
	if r == nil || r.RestartedAt < handed.At {
		WriteStdout("The work was not restarted in the last %d minutes; the sheet stays open in the window.\n", int(moltenReviewClickWait.Minutes()))
		return nil
	}
	WriteStdout("%s", formatMoltenReviewRestarted(*r, number))
	return nil
}

// moltenReviewLastPublished is the round Restart work hands over, with its number (1 for the first).
func moltenReviewLastPublished(rounds []moltenReviewRound) (*moltenReviewRound, int) {
	for i := len(rounds) - 1; i >= 0; i-- {
		if rounds[i].PublishedAt != 0 {
			return &rounds[i], i + 1
		}
	}
	return nil, 0
}

func formatMoltenReviewRestartPlan(pr int, round moltenReviewRound, number int, comments []moltenReviewComment) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Restart work on PR #%d: review round %d, published %s", pr, number, moltenReviewTime(round.PublishedAt))
	if round.GithubUrl != "" {
		fmt.Fprintf(&b, " (%s)", round.GithubUrl)
	}
	b.WriteString("\n")
	count := 0
	for _, c := range comments {
		if c.Round == round.Id && c.State == "published" {
			count++
		}
	}
	fmt.Fprintf(&b, "  %d published comments go to an agent in the worktree of the PR's branch, which applies them,\n", count)
	b.WriteString("  commits, pushes and replies on each thread; the ticket keeps its status.\n")
	if round.RestartedAt != 0 {
		fmt.Fprintf(&b, "  Already restarted %s", moltenReviewTime(round.RestartedAt))
		if round.RestartWorktree != "" {
			fmt.Fprintf(&b, " in %s", round.RestartWorktree)
		}
		b.WriteString(": a new click hands it again.\n")
	}
	return b.String()
}

func formatMoltenReviewRestarted(round moltenReviewRound, number int) string {
	agent := round.RestartAgent
	if agent == "" {
		agent = "an agent"
	}
	text := fmt.Sprintf("Review round %d handed to %s", number, agent)
	if round.RestartWorktree != "" {
		text += " in " + round.RestartWorktree
	}
	return text + ". Follow it in the Review tab.\n"
}

func moltenReviewPublishRun(cmd *cobra.Command, args []string) error {
	if err := moltenReviewGuard("publish"); err != nil {
		return err
	}
	t, err := moltenReviewFind(args[0])
	if err != nil {
		return err
	}
	WriteStdout("%s", formatMoltenReviewPublishPlan(t))
	if len(moltenReviewPublishable(t.State)) == 0 && t.State.Summary == nil {
		return fmt.Errorf("there is nothing to publish: stage comments first")
	}
	handed, err := moltenReviewHandoff(t, moltenReviewHandoffPublish)
	if err != nil {
		return err
	}
	WriteStdout("\nThe Publish sheet is open in the Review tab of this terminal's window: it shows the publication language\n" +
		"and asks for the translations still missing. GitHub gets the review only when you click Post review there.\n")
	if moltenReviewNoWait {
		return nil
	}
	WriteStdout("Waiting for your click in the sheet (Ctrl-C stops waiting, not the sheet)...\n")
	publish, err := moltenReviewFollow(t, moltenReviewClickWait, func(state moltenReviewState) bool {
		p := state.Publish
		return p != nil && p.StartedAt >= handed.At && p.EndedAt != 0
	})
	if err != nil {
		return err
	}
	if publish.Publish == nil || publish.Publish.StartedAt < handed.At {
		WriteStdout("No review was posted in the last %d minutes; the sheet stays open in the window.\n", int(moltenReviewClickWait.Minutes()))
		return nil
	}
	WriteStdout("%s", formatMoltenReviewPublished(*publish.Publish))
	return nil
}

// moltenReviewFollow reads the review store until done says so or wait passes; the last state is returned.
func moltenReviewFollow(t moltenReviewTarget, wait time.Duration, done func(state moltenReviewState) bool) (moltenReviewState, error) {
	deadline := time.Now().Add(wait)
	var state moltenReviewState
	for {
		state = moltenReviewState{}
		if _, err := moltenReviewRequest(moltenReviewStateCommand, map[string]any{"repo": t.Repo, "number": t.Pr.Number}, &state); err != nil {
			return state, err
		}
		if done(state) || time.Now().After(deadline) {
			return state, nil
		}
		time.Sleep(moltenReviewFollowStep)
	}
}

func moltenReviewMergeRun(cmd *cobra.Command, args []string) error {
	if err := moltenReviewGuard("merge"); err != nil {
		return err
	}
	t, err := moltenReviewFind(args[0])
	if err != nil {
		return err
	}
	handed, err := moltenReviewHandoff(t, moltenReviewHandoffMerge)
	if err != nil {
		return err
	}
	WriteStdout("Validate's sheet opens in the Review tab of PR #%d in this terminal's window; reading its plan...\n", t.Pr.Number)
	plan, err := moltenReviewShownPlan(t, handed.At)
	if err != nil {
		return err
	}
	if plan == nil {
		return fmt.Errorf("the Validate sheet has no plan yet: read it in the window")
	}
	WriteStdout("%s", formatMoltenReviewPlan(t.Pr.Number, *plan))
	if !plan.CanMerge {
		return nil
	}
	WriteStdout("\nNothing merges until you click Merge in the Validate sheet.\n")
	if moltenReviewNoWait {
		return nil
	}
	WriteStdout("Waiting for your click in the sheet (Ctrl-C stops waiting, not the merge)...\n")
	state, err := moltenReviewFollow(t, moltenReviewClickWait, func(state moltenReviewState) bool {
		return state.Merge != nil && state.Merge.StartedAt >= plan.CreatedAt
	})
	if err != nil {
		return err
	}
	if state.Merge == nil || state.Merge.StartedAt < plan.CreatedAt {
		WriteStdout("No merge was started in the last %d minutes; the sheet stays open in the window.\n", int(moltenReviewClickWait.Minutes()))
		return nil
	}
	started := state.Merge.StartedAt
	WriteStdout("Merge started.\n")
	state, err = moltenReviewFollow(t, moltenReviewMergeWait, func(state moltenReviewState) bool {
		m := state.Merge
		if m == nil || m.StartedAt != started || m.EndedAt == 0 {
			return false
		}
		if m.State != moltenReviewMergeMerged {
			return true
		}
		return !m.CleanupRunning
	})
	if err != nil {
		return err
	}
	WriteStdout("%s", formatMoltenReviewMerged(state, started))
	return nil
}

// moltenReviewShownPlan waits for the plan the window's sheet made after the handoff.
func moltenReviewShownPlan(t moltenReviewTarget, since int64) (*moltenReviewPlan, error) {
	deadline := time.Now().Add(moltenReviewPlanWait)
	for {
		var plan *moltenReviewPlan
		if _, err := moltenReviewRequest(moltenReviewPlanShownCmd, map[string]any{"repo": t.Repo, "number": t.Pr.Number}, &plan); err != nil {
			return nil, err
		}
		if plan != nil && plan.CreatedAt >= since {
			return plan, nil
		}
		if time.Now().After(deadline) {
			return nil, nil
		}
		time.Sleep(moltenReviewFollowStep)
	}
}

func moltenReviewPublishable(state moltenReviewState) []moltenReviewComment {
	var rtn []moltenReviewComment
	for _, c := range state.Comments {
		if c.State == moltenReviewCommentStaged || c.State == moltenReviewCommentTransl {
			rtn = append(rtn, c)
		}
	}
	return rtn
}

func moltenReviewShort(oid string) string {
	if len(oid) > 7 {
		return oid[:7]
	}
	return oid
}

func moltenReviewWhere(a mcpreview.Anchor) string {
	if a.Path == "" {
		return "the whole PR"
	}
	lines := fmt.Sprintf("%d", a.Line)
	if a.StartLine > 0 && a.StartLine != a.Line {
		lines = fmt.Sprintf("%d-%d", a.StartLine, a.Line)
	}
	side := ""
	if a.Side == mcpreview.SideLeft {
		side = " (base)"
	}
	return fmt.Sprintf("%s:%s%s", a.Path, lines, side)
}

func moltenReviewIndent(text string, prefix string) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	return prefix + strings.Join(lines, "\n"+prefix)
}

func moltenReviewLang(t moltenReviewText) string {
	if t.Lang == "" {
		return ""
	}
	return " [" + t.Lang + "]"
}

func formatMoltenReviewComment(sb *strings.Builder, c moltenReviewComment) {
	state := c.State
	if c.Outdated {
		state += ", outdated"
	}
	fmt.Fprintf(sb, "- %s  %s  %s (%s)  id %s\n", state, c.Kind, moltenReviewWhere(c.Anchor), c.Author, c.Id)
	fmt.Fprintf(sb, "  as written%s:\n%s\n", moltenReviewLang(c.Original), moltenReviewIndent(c.Original.Text, "    "))
	if c.Translation != nil && strings.TrimSpace(c.Translation.Text) != "" {
		fmt.Fprintf(sb, "  translation%s:\n%s\n", moltenReviewLang(*c.Translation), moltenReviewIndent(c.Translation.Text, "    "))
	} else {
		sb.WriteString("  translation: none\n")
	}
	if c.PublishedAs != "" {
		fmt.Fprintf(sb, "  published as %s\n", c.PublishedAs)
	}
	if c.PublishNote != "" {
		fmt.Fprintf(sb, "  publish note: %s\n", c.PublishNote)
	}
	if len(c.Discussion) > 0 {
		fmt.Fprintf(sb, "  discussion: %d messages\n", len(c.Discussion))
	}
}

func formatMoltenReviewComments(comments []moltenReviewComment) string {
	if len(comments) == 0 {
		return "no review comments\n"
	}
	var sb strings.Builder
	fmt.Fprintf(&sb, "%d review comments\n", len(comments))
	for _, c := range comments {
		formatMoltenReviewComment(&sb, c)
	}
	return sb.String()
}

func moltenReviewCountByState(comments []moltenReviewComment) string {
	counts := map[string]int{}
	var states []string
	for _, c := range comments {
		if counts[c.State] == 0 {
			states = append(states, c.State)
		}
		counts[c.State]++
	}
	if len(states) == 0 {
		return "none"
	}
	parts := make([]string, 0, len(states))
	for _, s := range states {
		parts = append(parts, fmt.Sprintf("%d %s", counts[s], s))
	}
	return strings.Join(parts, ", ")
}

func moltenReviewTime(ms int64) string {
	if ms == 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04")
}

func formatMoltenReviewShow(t moltenReviewTarget) string {
	var sb strings.Builder
	pr, st := t.Pr, t.State
	title := pr.Title
	if pr.TicketTitle != "" {
		title = pr.TicketTitle
	}
	fmt.Fprintf(&sb, "PR #%d  %s\n", pr.Number, title)
	if pr.Ticket > 0 {
		fmt.Fprintf(&sb, "ticket:   #%d\n", pr.Ticket)
	}
	fmt.Fprintf(&sb, "branch:   %s into %s (%s)\n", pr.Branch, t.Target, t.Repo)
	if pr.Draft {
		sb.WriteString("draft:    yes (in testing)\n")
	}
	fmt.Fprintf(&sb, "url:      %s\n", pr.Url)
	merge := moltenReviewMergeWords[pr.Merge]
	if merge == "" {
		merge = "merge state pending"
	}
	report := moltenReviewReportWords[pr.Report.State]
	if report == "" {
		report = "test report unknown"
	}
	fmt.Fprintf(&sb, "status:   %s, %s, %s\n", formatMoltenReviewCi(pr), report, merge)
	if st.Briefing != nil {
		fmt.Fprintf(&sb, "briefing: %s on %s (%s)\n", st.Briefing.Agent, moltenReviewShort(st.Briefing.HeadOid), moltenReviewTime(st.Briefing.At))
	} else {
		sb.WriteString("briefing: none\n")
	}
	if len(st.Explanations) > 0 {
		fmt.Fprintf(&sb, "explanations: %d\n", len(st.Explanations))
	}
	fmt.Fprintf(&sb, "viewed:   %d files\n", len(st.Viewed))
	fmt.Fprintf(&sb, "comments: %s (molten review comments %d)\n", moltenReviewCountByState(st.Comments), pr.Number)
	proposals := 0
	for _, c := range st.Comments {
		if c.State == moltenReviewCommentProposed {
			proposals++
		}
	}
	if proposals > 0 {
		fmt.Fprintf(&sb, "proposals: %d from the review session\n", proposals)
	}
	for _, r := range st.Rounds {
		state := "not published"
		if r.PublishedAt != 0 {
			state = "published " + moltenReviewTime(r.PublishedAt)
			if r.GithubUrl != "" {
				state += " " + r.GithubUrl
			}
		}
		if r.RestartedAt != 0 {
			state += ", work restarted " + moltenReviewTime(r.RestartedAt)
		}
		fmt.Fprintf(&sb, "round:    on %s, %s\n", moltenReviewShort(r.HeadOid), state)
	}
	if p := st.Publish; p != nil {
		fmt.Fprintf(&sb, "publish:  %s in %s (%s)", p.State, p.Lang, moltenReviewTime(p.StartedAt))
		if p.Message != "" {
			fmt.Fprintf(&sb, ": %s", p.Message)
		}
		sb.WriteString("\n")
	}
	if m := st.Merge; m != nil {
		fmt.Fprintf(&sb, "merge:    %s (%s)", m.State, moltenReviewTime(m.StartedAt))
		if text := moltenReviewMergeText(*m); text != "" {
			fmt.Fprintf(&sb, ": %s", text)
		}
		sb.WriteString("\n")
	}
	if c := st.Cleanup; c != nil {
		sb.WriteString("cleanup:\n")
		formatMoltenReviewCleanupSteps(&sb, c.Steps)
	}
	return sb.String()
}

func formatMoltenReviewPublishPlan(t moltenReviewTarget) string {
	var sb strings.Builder
	comments := moltenReviewPublishable(t.State)
	fmt.Fprintf(&sb, "Publish review of PR #%d (%s): %d staged comments\n", t.Pr.Number, t.Repo, len(comments))
	for _, c := range comments {
		formatMoltenReviewComment(&sb, c)
	}
	if s := t.State.Summary; s != nil {
		fmt.Fprintf(&sb, "summary, as written%s:\n%s\n", moltenReviewLang(s.Original), moltenReviewIndent(s.Original.Text, "    "))
		if s.Translation != nil && strings.TrimSpace(s.Translation.Text) != "" {
			fmt.Fprintf(&sb, "summary, translation%s:\n%s\n", moltenReviewLang(*s.Translation), moltenReviewIndent(s.Translation.Text, "    "))
		}
	}
	return sb.String()
}

func formatMoltenReviewPublished(p moltenReviewPublish) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Publish review: %s in %s", p.State, p.Lang)
	if p.Url != "" {
		fmt.Fprintf(&sb, ", %s", p.Url)
	}
	sb.WriteString("\n")
	if p.Message != "" {
		fmt.Fprintf(&sb, "%s\n", p.Message)
	}
	for _, n := range p.Notes {
		fmt.Fprintf(&sb, "- comment %s: %s", n.CommentId, n.Note)
		if n.Message != "" {
			fmt.Fprintf(&sb, " (%s)", n.Message)
		}
		sb.WriteString("\n")
	}
	return sb.String()
}

var moltenReviewCheckMarks = map[string]string{
	"ok":      "ok  ",
	"info":    "info",
	"warn":    "warn",
	"pending": "wait",
	"fail":    "FAIL",
}

// must match frontend/moltenterm-shell/review/review-cleanup.ts
var moltenReviewCleanupLabels = map[string]string{
	"pr":              "PR merged",
	"ticket-close":    "Ticket closed",
	"ticket-done":     "Ticket moved to Done",
	"review-worktree": "Review worktree removed",
	"agent-worktree":  "Agent worktree removed",
	"local-branch":    "Local branch deleted",
	"remote-branch":   "Remote branch deleted",
	"other-prs":       "Other open PRs brought up to date",
}

func formatMoltenReviewCleanupSteps(sb *strings.Builder, steps []moltenReviewCleanupStep) {
	for _, s := range steps {
		label := moltenReviewCleanupLabels[s.Id]
		if label == "" {
			label = s.Id
		}
		fmt.Fprintf(sb, "  %-8s %s", s.State, label)
		if detail := moltenReviewCleanupDetail(s); detail != "" {
			fmt.Fprintf(sb, ": %s", detail)
		}
		sb.WriteString("\n")
	}
}

func formatMoltenReviewPlan(number int, plan moltenReviewPlan) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "Validate PR #%d", number)
	if plan.Title != "" {
		fmt.Fprintf(&sb, "  %s", plan.Title)
	}
	fmt.Fprintf(&sb, "\n%s into %s, head %s\n", plan.HeadRef, plan.BaseRef, moltenReviewShort(plan.HeadOid))
	sb.WriteString("checks:\n")
	for _, c := range plan.Checks {
		mark := moltenReviewCheckMarks[c.State]
		if mark == "" {
			mark = c.State
		}
		fmt.Fprintf(&sb, "  %s %s", mark, moltenReviewCheckLabel(c))
		if detail := moltenReviewCheckDetail(c); detail != "" {
			fmt.Fprintf(&sb, ": %s", detail)
		}
		sb.WriteString("\n")
	}
	if line := moltenReviewMethodLine(plan); line != "" {
		fmt.Fprintf(&sb, "%s\n", line)
	}
	sb.WriteString("steps:\n")
	for i, s := range plan.Steps {
		fmt.Fprintf(&sb, "  %d. %s\n", i+1, moltenReviewStepText(s.Id, plan))
	}
	if len(plan.Cleanup) > 0 {
		sb.WriteString("then the cleanup:\n")
		formatMoltenReviewCleanupSteps(&sb, plan.Cleanup)
	}
	// Warnings name their checks by id: the check's label is what the sheet asks to confirm.
	for _, w := range plan.Warnings {
		label := moltenReviewCheckLabel(moltenReviewCheck{Id: w})
		fmt.Fprintf(&sb, "warning: %s (the sheet asks you to confirm it before Merge)\n", label)
	}
	if !plan.CanMerge {
		reason := plan.Blocking
		for _, c := range plan.Checks {
			if c.Id == plan.Blocking {
				reason = moltenReviewCheckLabel(c)
				if detail := moltenReviewCheckDetail(c); detail != "" {
					reason += " (" + detail + ")"
				}
			}
		}
		fmt.Fprintf(&sb, "cannot merge: %s\n", reason)
	}
	return sb.String()
}

func formatMoltenReviewMerged(state moltenReviewState, started int64) string {
	var sb strings.Builder
	m := state.Merge
	if m == nil || m.StartedAt != started {
		return "the merge's outcome could not be read: see the Review tab\n"
	}
	if m.EndedAt == 0 {
		fmt.Fprintf(&sb, "The merge is still %s after %d minutes: follow it in the Review tab.\n", m.State, int(moltenReviewMergeWait.Minutes()))
		return sb.String()
	}
	fmt.Fprintf(&sb, "Merge: %s", m.State)
	if m.MergedOid != "" {
		fmt.Fprintf(&sb, " as %s", moltenReviewShort(m.MergedOid))
	}
	if text := moltenReviewMergeText(*m); text != "" {
		fmt.Fprintf(&sb, ": %s", text)
	}
	sb.WriteString("\n")
	if c := state.Cleanup; c != nil && c.StartAt >= started {
		sb.WriteString("cleanup:\n")
		formatMoltenReviewCleanupSteps(&sb, c.Steps)
	}
	return sb.String()
}
