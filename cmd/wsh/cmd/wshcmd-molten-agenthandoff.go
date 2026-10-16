// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/handoffwire"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// Handing work to another agent by first name from a shell (FR-CONT-015 AC5): `molten agent list` shows the active
// agents first, `molten agent send` does what the send_to_agent MCP tool does. Both carry this pane's WAVETERM_JWT to
// wavesrv's handoff route, which takes the sender from it.

const (
	moltenHandoffListTimeoutMs = 8000
	// The send waits up to 50 seconds for the developer's answer, then types the prompt, or returns "pending" while the
	// request stays open (#790).
	moltenHandoffSendTimeoutMs = 80000
)

var moltenAgentListActive bool

var moltenAgentSendGoal string
var moltenAgentSendContext string
var moltenAgentSendFiles []string
var moltenAgentSendLinks []string
var moltenAgentSendTabs []int64
var moltenAgentSendReply bool
var moltenAgentSendBrief string

var moltenAgentSendCmd = &cobra.Command{
	Use:   "send <first-name>",
	Short: "hand work to another agent by its first name: MoltenTerm writes the brief and types a prompt in its terminal",
	Long: "Hand work to another agent running in MoltenTerm, by its first name (see molten agent list). MoltenTerm writes\n" +
		"the brief as Markdown in its data folder (never in a project) and types \"[From <you> · <agent> · <project>]\n" +
		"<goal>\" with the brief's path in the receiver's terminal, when its prompt is idle. The first send between two\n" +
		"agents asks the developer. --brief takes the brief as JSON ({goal, context, files: [{path, project, lines,\n" +
		"excerpt, note}], links: [{url, title, kind, tabid, note}], reply}), from a file or - for stdin; the other\n" +
		"options add to it.",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenAgentSendRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenAgentListCmd.Flags().BoolVar(&moltenAgentListActive, "active", false, "list only the agents running now, with their first names")
	moltenAgentSendCmd.Flags().StringVar(&moltenAgentSendGoal, "goal", "", "what the receiver must do, and the expected result")
	moltenAgentSendCmd.Flags().StringVar(&moltenAgentSendContext, "context", "", "what was done so far, decisions and why, constraints, open questions")
	moltenAgentSendCmd.Flags().StringArrayVar(&moltenAgentSendFiles, "file", nil, "a file the receiver needs: path, or path:40-60 to quote lines (repeatable)")
	moltenAgentSendCmd.Flags().StringArrayVar(&moltenAgentSendLinks, "link", nil, "a ticket, pull request, SRS page or URL (repeatable)")
	moltenAgentSendCmd.Flags().Int64SliceVar(&moltenAgentSendTabs, "tab", nil, "one of your agent's MoltenTerm browser tabs, by id: the receiver opens its page in its own panel (repeatable)")
	moltenAgentSendCmd.Flags().BoolVar(&moltenAgentSendReply, "reply", false, "you expect the receiver to answer you")
	moltenAgentSendCmd.Flags().StringVar(&moltenAgentSendBrief, "brief", "", "the brief as JSON, in a file or - for stdin")
	moltenAgentSendCmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	moltenAgentCmd.AddCommand(moltenAgentSendCmd)
}

func moltenHandoffRequest(command string, data any, timeoutMs int, out any) error {
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: handoffwire.RouteId, Timeout: int64(timeoutMs)})
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

// moltenHandoffError keeps wavesrv's sentence.
func moltenHandoffError(err error) string {
	return strings.TrimSpace(err.Error())
}

func moltenHandoffToken() (string, error) {
	token := os.Getenv(wshutil.WaveJwtTokenVarName)
	if token == "" {
		return "", fmt.Errorf("molten agent must run in a MoltenTerm terminal (%s is not set)", wshutil.WaveJwtTokenVarName)
	}
	return token, nil
}

// moltenActiveAgents lists the agents running now; an error says why they could not be read.
func moltenActiveAgents() (handoffwire.ListResult, error) {
	var list handoffwire.ListResult
	token, err := moltenHandoffToken()
	if err != nil {
		return list, err
	}
	err = moltenHandoffRequest(handoffwire.ListCommand, handoffwire.ListRequest{Token: token}, moltenHandoffListTimeoutMs, &list)
	return list, err
}

func formatMoltenActiveAgents(list handoffwire.ListResult) string {
	if len(list.Agents) == 0 {
		return "No agent is running in MoltenTerm.\n"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "NAME\tAGENT\tSTATE\tPROJECT\tWORKSPACE\tTAB\n")
	for _, a := range list.Agents {
		name := a.FirstName
		if a.You {
			name += " (you)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\t%s\n", name, a.AgentName, moltenDash(a.State), moltenDash(a.Project), moltenDash(a.Workspace), moltenDash(a.Tab))
	}
	tw.Flush()
	return sb.String()
}

func moltenDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// moltenSendFileRef reads "path" or "path:40-60"; a colon followed by something else stays in the path.
func moltenSendFileRef(arg string) handoffwire.FileRef {
	if i := strings.LastIndex(arg, ":"); i > 0 {
		lines := arg[i+1:]
		if lines != "" && strings.Trim(lines, "0123456789-") == "" {
			return handoffwire.FileRef{Path: arg[:i], Lines: lines}
		}
	}
	return handoffwire.FileRef{Path: arg}
}

func moltenReadSendBrief(source string, stdin io.Reader) (handoffwire.Brief, error) {
	var brief handoffwire.Brief
	if source == "" {
		return brief, nil
	}
	var data []byte
	var err error
	if source == "-" {
		data, err = io.ReadAll(io.LimitReader(stdin, 4<<20))
	} else {
		data, err = os.ReadFile(source)
	}
	if err != nil {
		return brief, fmt.Errorf("reading the brief: %w", err)
	}
	if err := json.Unmarshal(data, &brief); err != nil {
		return brief, fmt.Errorf("the brief is not valid JSON: %w", err)
	}
	return brief, nil
}

// moltenBuildSendBrief merges --brief with the other options.
func moltenBuildSendBrief(stdin io.Reader) (handoffwire.Brief, error) {
	brief, err := moltenReadSendBrief(moltenAgentSendBrief, stdin)
	if err != nil {
		return brief, err
	}
	if moltenAgentSendGoal != "" {
		brief.Goal = moltenAgentSendGoal
	}
	if moltenAgentSendContext != "" {
		brief.Context = moltenAgentSendContext
	}
	for _, f := range moltenAgentSendFiles {
		brief.Files = append(brief.Files, moltenSendFileRef(f))
	}
	for _, l := range moltenAgentSendLinks {
		brief.Links = append(brief.Links, handoffwire.LinkRef{Url: l})
	}
	for _, t := range moltenAgentSendTabs {
		brief.Links = append(brief.Links, handoffwire.LinkRef{TabId: t, Kind: handoffwire.LinkKindBrowser})
	}
	brief.Reply = brief.Reply || moltenAgentSendReply
	if strings.TrimSpace(brief.Goal) == "" {
		return brief, fmt.Errorf("say what the receiver must do with --goal (or a goal in --brief)")
	}
	return brief, nil
}

func moltenAgentSendRun(cmd *cobra.Command, args []string) error {
	token, err := moltenHandoffToken()
	if err != nil {
		return err
	}
	brief, err := moltenBuildSendBrief(os.Stdin)
	if err != nil {
		return err
	}
	var result handoffwire.SendResult
	err = moltenHandoffRequest(handoffwire.SendCommand, handoffwire.SendRequest{Token: token, To: args[0], Brief: brief}, moltenHandoffSendTimeoutMs, &result)
	if err != nil {
		return fmt.Errorf("%s", moltenHandoffError(err))
	}
	if moltenJson {
		return moltenWriteJson(result)
	}
	WriteStdout("%s\n", result.Message)
	return nil
}
