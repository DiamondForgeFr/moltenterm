// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"fmt"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// `molten review` (FR-REV-001, FR-REV-014): the pull requests waiting for review, the same list as the Reviews view,
// read by wavesrv from Mission Control's collector through the developer's gh. The other review commands are in
// wshcmd-molten-reviewactions.go.

// must match pkg/molten/mission/reviews.go and frontend/moltenterm-shell/reviews/reviews-model.ts
const (
	moltenReviewsCommand = "moltenmissionreviews"
	moltenReviewsView    = "molten-reviews"
	// GitHub is read in the background: a first ask waits for it this long at most.
	moltenReviewsWait     = 20 * time.Second
	moltenReviewsPollStep = time.Second
)

type moltenReviewPr struct {
	Number      int    `json:"number"`
	Title       string `json:"title"`
	Url         string `json:"url"`
	Branch      string `json:"branch"`
	Draft       bool   `json:"draft,omitempty"`
	UpdatedAt   string `json:"updatedat"`
	Ticket      int    `json:"ticket,omitempty"`
	TicketTitle string `json:"tickettitle,omitempty"`
	Merge       string `json:"merge"`
	Ci          struct {
		State   string `json:"state"`
		Success int    `json:"success"`
		Failure int    `json:"failure"`
		Pending int    `json:"pending"`
	} `json:"ci"`
	Report struct {
		State string `json:"state"`
	} `json:"report"`
	Unpublished int `json:"unpublished"`
}

type moltenReviewsAnswer struct {
	Dir          string           `json:"dir"`
	State        string           `json:"state,omitempty"`
	Message      string           `json:"message,omitempty"`
	Repo         string           `json:"repo,omitempty"`
	Target       string           `json:"target,omitempty"`
	Ready        []moltenReviewPr `json:"ready"`
	Drafts       []moltenReviewPr `json:"drafts"`
	PrsError     string           `json:"prserror,omitempty"`
	ReportsAt    int64            `json:"reportsat,omitempty"`
	ReportsError string           `json:"reportserror,omitempty"`
}

var moltenReviewOpen bool

var moltenReviewCmd = &cobra.Command{
	Use:   "review",
	Short: "the pull requests waiting for your review, as MoltenTerm's Reviews view and Review tab show them",
	Long: "Read-only, for agents too: list, show, comments. open hands the Review tab to this terminal's window.\n" +
		"publish and merge open their sheet in the window and print its plan: GitHub gets a review or a merge only on\n" +
		"your click in that sheet, and both refuse in a terminal where an agent runs. Local MoltenTerm terminals only.",
}

var moltenReviewListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the project's pull requests waiting for review (--open shows the Reviews view)",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenReviewListRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenReviewListCmd.Flags().BoolVar(&moltenJson, "json", false, "print the list as JSON")
	moltenReviewListCmd.Flags().BoolVar(&moltenReviewOpen, "open", false, "open the Reviews view in this tab")
	moltenReviewCmd.AddCommand(moltenReviewListCmd)
	moltenCmd.AddCommand(moltenReviewCmd)
}

// The workspace's linked project, as the view shows it; else the project of the terminal's folder.
func moltenReviewProjectDir() (string, error) {
	if linked := moltenCiLinkedDir(); linked != "" {
		return linked, nil
	}
	return moltenCiProjectDir()
}

// moltenReviewsAskRaw also returns the answer as wavesrv sent it: --json prints it whole, as the view gets it.
func moltenReviewsAskRaw(dir string) (moltenReviewsAnswer, any, error) {
	var answer moltenReviewsAnswer
	resp, err := RpcClient.SendRpcRequest(moltenReviewsCommand, map[string]any{"dir": dir}, &wshrpc.RpcOpts{Route: moltenMissionRoute, Timeout: moltenCiRpcTimeoutMs})
	if err != nil {
		return answer, nil, fmt.Errorf("asking MoltenTerm for the reviews: %w", err)
	}
	return answer, resp, utilfn.ReUnmarshal(&answer, resp)
}

// moltenReviewsSettled: GitHub was read, and the test reports too when there are PRs to report on.
func moltenReviewsSettled(answer moltenReviewsAnswer) bool {
	if answer.State == "" {
		return false
	}
	if answer.State != "ok" || len(answer.Ready)+len(answer.Drafts) == 0 {
		return true
	}
	return answer.ReportsAt != 0 || answer.ReportsError != ""
}

func moltenReviewListRun(cmd *cobra.Command, args []string) error {
	dir, err := moltenReviewProjectDir()
	if err != nil {
		return err
	}
	answer, raw, err := moltenReviewsSettledAsk(dir)
	if err != nil {
		return err
	}
	if moltenReviewOpen {
		if err := moltenReviewOpenView(); err != nil {
			return err
		}
	}
	if moltenJson {
		return moltenWriteJson(raw)
	}
	WriteStdout("%s", formatMoltenReviews(answer))
	return nil
}

func moltenReviewOpenView() error {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("molten must run in a MoltenTerm terminal to open the Reviews view (WAVETERM_TABID is not set)")
	}
	// A Reviews view already in the tab takes the focus, as the rail's button does.
	if blocks, err := wshclient.BlocksListCommand(RpcClient, wshrpc.BlocksListRequest{}, nil); err == nil {
		for _, b := range blocks {
			if b.TabId != tabId || b.Meta.GetString(waveobj.MetaKey_View, "") != moltenReviewsView {
				continue
			}
			return wshclient.SetBlockFocusCommand(RpcClient, b.BlockId, &wshrpc.RpcOpts{Route: wshutil.MakeTabRouteId(tabId)})
		}
	}
	_, err := wshclient.CreateBlockCommand(RpcClient, wshrpc.CommandCreateBlockData{
		TabId:    tabId,
		BlockDef: &waveobj.BlockDef{Meta: map[string]any{waveobj.MetaKey_View: moltenReviewsView}},
		Focused:  true,
	}, nil)
	if err != nil {
		return fmt.Errorf("opening the Reviews view: %w", err)
	}
	return nil
}

var moltenReviewMergeWords = map[string]string{
	"clean":     "clean",
	"behind":    "behind: will be rebased",
	"conflicts": "conflicts",
	"blocked":   "blocked",
	"failing":   "checks failing",
}

var moltenReviewReportWords = map[string]string{
	"present": "test report",
	"missing": "no test report",
}

func formatMoltenReviewCi(pr moltenReviewPr) string {
	var parts []string
	if pr.Ci.Failure > 0 {
		parts = append(parts, fmt.Sprintf("%d failing", pr.Ci.Failure))
	}
	if pr.Ci.Pending > 0 {
		parts = append(parts, fmt.Sprintf("%d running", pr.Ci.Pending))
	}
	if pr.Ci.Success > 0 {
		parts = append(parts, fmt.Sprintf("%d passed", pr.Ci.Success))
	}
	if len(parts) == 0 {
		return "CI: none"
	}
	return "CI " + strings.Join(parts, ", ")
}

func formatMoltenReviewRows(w *tabwriter.Writer, prs []moltenReviewPr) {
	for _, pr := range prs {
		ticket, title := "-", pr.Title
		if pr.Ticket > 0 {
			ticket = fmt.Sprintf("#%d", pr.Ticket)
			if pr.TicketTitle != "" {
				title = pr.TicketTitle
			}
		}
		merge := moltenReviewMergeWords[pr.Merge]
		if merge == "" {
			merge = "merge state pending"
		}
		report := moltenReviewReportWords[pr.Report.State]
		if report == "" {
			report = "test report unknown"
		}
		extra := ""
		if pr.Unpublished > 0 {
			extra = fmt.Sprintf("\t%d unpublished", pr.Unpublished)
		}
		fmt.Fprintf(w, "  %s\t%s\tPR #%d\t%s\t%s\t%s\t%s%s\n", ticket, moltenReviewClip(title, 60), pr.Number, pr.Branch, formatMoltenReviewCi(pr), report, merge, extra)
	}
}

func moltenReviewClip(text string, max int) string {
	runes := []rune(text)
	if len(runes) <= max {
		return text
	}
	return string(runes[:max-1]) + "…"
}

func formatMoltenReviews(answer moltenReviewsAnswer) string {
	var sb strings.Builder
	switch answer.State {
	case "":
		return "GitHub has not answered yet: try again in a moment\n"
	case "nogh":
		return "gh is not installed: install the GitHub CLI, then run gh auth login\n"
	case "loggedout":
		return "gh is logged out: run gh auth login\n"
	case "norepo":
		return "this project has no GitHub remote\n"
	case "error":
		return fmt.Sprintf("GitHub could not be read: %s\n", answer.Message)
	}
	if answer.PrsError != "" {
		fmt.Fprintf(&sb, "the pull requests could not be read: %s\n", answer.PrsError)
	}
	fmt.Fprintf(&sb, "waiting for review into %s (%s): %d\n", answer.Target, answer.Repo, len(answer.Ready))
	w := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	formatMoltenReviewRows(w, answer.Ready)
	w.Flush()
	if len(answer.Drafts) > 0 {
		fmt.Fprintf(&sb, "in testing (drafts): %d\n", len(answer.Drafts))
		w = tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
		formatMoltenReviewRows(w, answer.Drafts)
		w.Flush()
	}
	if answer.ReportsError != "" {
		fmt.Fprintf(&sb, "the test reports could not be read: %s\n", answer.ReportsError)
	}
	return sb.String()
}
