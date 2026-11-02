// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/wconfig"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"golang.org/x/term"
)

// `molten session` (FR-SHELL-021, DS-SHELL-022): the Sessions view from the command line, for people and coding
// agents. It asks wavesrv's sessions route the same plain commands the view does (pkg/molten/sessions/route.go), so
// the list, the show and the end follow the view's rules; ids are the list's short ids (or any unique prefix).

const moltenSessionTimeoutMs = 20000

var moltenSessionYes bool

var moltenSessionCmd = &cobra.Command{
	Use:   "session",
	Short: "the terminal sessions that keep running across restarts: list, show, end",
}

var moltenSessionListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the running sessions (the Sessions view as a table; --json for scripts)",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenSessionListRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenSessionShowCmd = &cobra.Command{
	Use:     "show <id>",
	Short:   "focus the session's pane, or open a pane attached to it in this tab when none shows it",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenSessionShowRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenSessionEndCmd = &cobra.Command{
	Use:     "end <id>",
	Short:   "end a session (asks first unless --yes; never the session this command runs in)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenSessionEndRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenSessionListCmd.Flags().BoolVar(&moltenJson, "json", false, "print the sessions as JSON")
	moltenSessionEndCmd.Flags().BoolVar(&moltenSessionYes, "yes", false, "end it without asking")
	moltenSessionCmd.AddCommand(moltenSessionListCmd, moltenSessionShowCmd, moltenSessionEndCmd)
	moltenCmd.AddCommand(moltenSessionCmd)
}

func moltenSessionRequest(command string, data any, out any) error {
	res, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: molten.DurableSessionsRoute, Timeout: moltenSessionTimeoutMs})
	if err != nil {
		return err
	}
	if out == nil {
		return nil
	}
	raw, err := json.Marshal(res)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

func moltenSessionList() (molten.DurableSessionsData, error) {
	var data molten.DurableSessionsData
	if err := moltenSessionRequest(molten.DurableSessionsListCommand, nil, &data); err != nil {
		return data, fmt.Errorf("could not read the sessions: %w", err)
	}
	return data, nil
}

// moltenSessionResolve finds the session an id names; an unknown or ambiguous id fails with the list of ids.
func moltenSessionResolve(arg string) (molten.DurableSession, error) {
	data, err := moltenSessionList()
	if err != nil {
		return molten.DurableSession{}, err
	}
	ids := make([]string, 0, len(data.Sessions))
	for _, s := range data.Sessions {
		ids = append(ids, s.Id)
	}
	id, err := molten.ResolveSessionId(arg, ids)
	if err != nil {
		return molten.DurableSession{}, fmt.Errorf("%v; %s", err, moltenSessionIdsText(data.Sessions))
	}
	for _, s := range data.Sessions {
		if s.Id == id {
			return s, nil
		}
	}
	return molten.DurableSession{}, fmt.Errorf("no running session has the id %q", arg)
}

func moltenSessionIdsText(sessions []molten.DurableSession) string {
	if len(sessions) == 0 {
		return "no session is running"
	}
	shorts := make([]string, 0, len(sessions))
	for _, s := range sessions {
		shorts = append(shorts, s.ShortId)
	}
	sort.Strings(shorts)
	return "running sessions: " + strings.Join(shorts, ", ")
}

func moltenSessionCallerBlockId() string {
	if claims, err := wshutil.ExtractUnverifiedRpcContext(os.Getenv(wshutil.WaveJwtTokenVarName)); err == nil && claims != nil && claims.BlockId != "" {
		return claims.BlockId
	}
	if RpcContext.BlockId != "" {
		return RpcContext.BlockId
	}
	return os.Getenv("WAVETERM_BLOCKID")
}

func moltenSessionListRun(cmd *cobra.Command, args []string) error {
	data, err := moltenSessionList()
	if err != nil {
		return err
	}
	if moltenJson {
		if data.Sessions == nil {
			data.Sessions = []molten.DurableSession{}
		}
		return moltenWriteJson(data)
	}
	WriteStdout("%s", formatMoltenSessions(data.Sessions, moltenSessionCallerBlockId(), time.Now()))
	return nil
}

func moltenSessionAge(ms int64, now time.Time) string {
	if ms <= 0 {
		return ""
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "now"
	case d < time.Hour:
		return fmt.Sprintf("%dm", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh", int(d.Hours()))
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func moltenSessionWhere(s molten.DurableSession) string {
	if !s.Shown {
		switch s.Reason {
		case molten.SessionReasonOlderVersion:
			return "no pane (older version)"
		case molten.SessionReasonEnding:
			return "ending"
		}
		return "no pane"
	}
	parts := []string{}
	if s.WorkspaceName != "" {
		parts = append(parts, s.WorkspaceName)
	}
	if s.TabName != "" {
		parts = append(parts, wconfig.ViewNameText(s.TabName))
	}
	if len(parts) == 0 {
		return "in a pane"
	}
	return strings.Join(parts, " · ")
}

func moltenSessionWhat(s molten.DurableSession) string {
	what := s.Command
	if s.AgentName != "" {
		what = s.AgentName
		if s.AgentState != "" {
			what += " (" + s.AgentState + ")"
		}
	}
	if what == "" {
		what = "shell"
	}
	return what
}

func moltenSessionFolder(s molten.DurableSession) string {
	folder := s.Folder
	if home, err := os.UserHomeDir(); err == nil && home != "" && strings.HasPrefix(folder, home) {
		folder = "~" + strings.TrimPrefix(folder, home)
	}
	if s.Worktree != nil && s.Worktree.Branch != "" {
		folder += " [" + s.Worktree.Branch + "]"
	}
	return folder
}

// formatMoltenSessions is the Sessions view's rows as a table: id, host, what runs, where, folder, last output. The
// session this command runs in is marked with *.
func formatMoltenSessions(sessions []molten.DurableSession, callerBlockId string, now time.Time) string {
	if len(sessions) == 0 {
		return "No session is running.\n"
	}
	header := []string{"ID", "HOST", "RUNNING", "WHERE", "FOLDER", "OUTPUT"}
	rows := [][]string{header}
	for _, s := range sessions {
		id := s.ShortId
		if callerBlockId != "" && s.BlockId == callerBlockId {
			id += "*"
		}
		host := s.Connection
		if host == "" {
			host = "local"
		}
		if s.ConnState != "" && s.ConnState != molten.SessionConnConnected {
			host += " (" + s.ConnState + ")"
		}
		rows = append(rows, []string{id, host, moltenSessionWhat(s), moltenSessionWhere(s), moltenSessionFolder(s), moltenSessionAge(s.LastOutputAt, now)})
	}
	widths := make([]int, len(header))
	for _, row := range rows {
		for i, cell := range row {
			widths[i] = max(widths[i], len([]rune(cell)))
		}
	}
	var sb strings.Builder
	for _, row := range rows {
		for i, cell := range row {
			if i == len(row)-1 {
				sb.WriteString(cell)
				break
			}
			sb.WriteString(cell)
			sb.WriteString(strings.Repeat(" ", widths[i]-len([]rune(cell))+2))
		}
		sb.WriteString("\n")
	}
	if callerBlockId != "" {
		for _, s := range sessions {
			if s.BlockId == callerBlockId {
				sb.WriteString("* this terminal\n")
				break
			}
		}
	}
	return sb.String()
}

func moltenSessionShowRun(cmd *cobra.Command, args []string) error {
	s, err := moltenSessionResolve(args[0])
	if err != nil {
		return err
	}
	req := molten.DurableSessionRequest{Id: s.Id, TabId: getTabIdFromEnv()}
	var loc molten.SessionLocation
	if err := moltenSessionRequest(molten.DurableSessionsShowCommand, req, &loc); err != nil {
		return err
	}
	if loc.Created {
		WriteStdout("Session %s attached to a new pane.\n", s.ShortId)
		return nil
	}
	WriteStdout("Session %s shown in %s.\n", s.ShortId, moltenSessionWhere(s))
	return nil
}

func moltenSessionEndRun(cmd *cobra.Command, args []string) error {
	s, err := moltenSessionResolve(args[0])
	if err != nil {
		return err
	}
	caller := moltenSessionCallerBlockId()
	if caller != "" && s.BlockId == caller {
		return fmt.Errorf("session %s is the one this command runs in: type exit instead", s.ShortId)
	}
	if !s.CanEnd {
		return fmt.Errorf("session %s cannot be ended from here", s.ShortId)
	}
	if !moltenSessionYes {
		if !term.IsTerminal(int(os.Stdin.Fd())) {
			return fmt.Errorf("ending session %s stops %s: run it again with --yes", s.ShortId, moltenSessionWhat(s))
		}
		WriteStdout("End session %s (%s, %s)? It stops what runs in it. [y/N] ", s.ShortId, moltenSessionWhat(s), moltenSessionWhere(s))
		answer, _ := bufio.NewReader(os.Stdin).ReadString('\n')
		if a := strings.ToLower(strings.TrimSpace(answer)); a != "y" && a != "yes" {
			return fmt.Errorf("session %s left running", s.ShortId)
		}
	}
	req := molten.DurableSessionRequest{Id: s.Id, CallerBlockId: caller}
	var res molten.DurableSessionEndResult
	if err := moltenSessionRequest(molten.DurableSessionsEndCommand, req, &res); err != nil {
		return err
	}
	if res.Pending {
		WriteStdout("Session %s ends once its host is reachable again.\n", s.ShortId)
		return nil
	}
	WriteStdout("Session %s ended.\n", s.ShortId)
	return nil
}
