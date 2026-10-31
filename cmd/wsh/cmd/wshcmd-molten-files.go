// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/filesearch"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// `molten files` (FR-FILE-002, DS-FILE-002): an agent shows the files it searched for in its tab's file panel, and
// gets the same matches back. wavesrv computes the matches and writes the panel (pkg/molten/filesearch); a folder
// outside the project is asked in the panel first, and the command waits for the answer. The output is for agents:
// English, one match per line and a summary line, or JSON. Exit codes: 2 for bad usage, 1 for any other failure.

const (
	moltenFilesShowTimeoutMs = 60000
	// An answer request waits up to 20 s in wavesrv (filesearch.answerWaitMax) before it says "waiting".
	moltenFilesAnswerTimeoutMs = 40000

	moltenFilesExitUsage = 2
	moltenFilesExitFail  = 1

	MoltenFilesStayedMessage = "The user kept the file panel inside the project."
	MoltenFilesClosedMessage = "The file panel was closed before the user answered."
	moltenFilesWaitingNotice = "molten files: %s is outside the project; waiting for the user's answer in the file panel.\n"
)

var (
	moltenFilesFilter    string
	moltenFilesRecursive bool
	moltenFilesJson      bool
)

var moltenFilesCmd = &cobra.Command{
	Use:   "files [<folder>] [--filter <pattern>] [--recursive] [--json]",
	Short: "show the files of a project folder in this tab's file panel, filtered, and print the matches",
	Long: "Opens <folder> (relative to the working directory; the workspace folder when omitted) in this tab's file " +
		"panel and prints its entries whose name matches --filter: a case-insensitive substring, or a glob when the " +
		"pattern holds *, ? or [. With --recursive, every subfolder is searched (.git and node_modules skipped, at most " +
		"1000 matches). Without --filter the panel's filter is cleared. A folder outside the project is asked to the " +
		"user in the panel first. Details: files.md in the folder `molten docs` prints.",
	Args: cobra.ArbitraryArgs,
	RunE: moltenFilesRun,
}

// moltenFilesUsageError: bad usage, exit code 2.
type moltenFilesUsageError struct {
	msg string
}

func (e moltenFilesUsageError) Error() string {
	return e.msg
}

func init() {
	moltenFilesCmd.Flags().StringVar(&moltenFilesFilter, "filter", "", "show only the names matching this pattern (substring, or glob with * ? [)")
	moltenFilesCmd.Flags().BoolVar(&moltenFilesRecursive, "recursive", false, "search every subfolder and list the matches as one flat list")
	moltenFilesCmd.Flags().BoolVar(&moltenFilesJson, "json", false, "print the result as JSON")
	moltenFilesCmd.SetFlagErrorFunc(func(cmd *cobra.Command, err error) error {
		moltenFilesFail(moltenFilesUsageError{msg: err.Error()})
		return nil
	})
	moltenCmd.AddCommand(moltenFilesCmd)
}

type moltenFilesArgs struct {
	req  filesearch.ShowRequest
	json bool
}

// parseMoltenFilesArgs checks what the command can check alone; every error is bad usage.
func parseMoltenFilesArgs(args []string, filter string, recursive bool, asJson bool, cwd string) (moltenFilesArgs, error) {
	rtn := moltenFilesArgs{json: asJson, req: filesearch.ShowRequest{Cwd: cwd, Pattern: filter, Recursive: recursive}}
	if len(args) > 1 {
		return rtn, moltenFilesUsageError{msg: fmt.Sprintf("too many arguments: molten files takes at most one folder, got %d", len(args))}
	}
	if err := filesearch.ValidatePattern(filter); err != nil {
		return rtn, moltenFilesUsageError{msg: err.Error()}
	}
	if recursive && filter == "" {
		return rtn, moltenFilesUsageError{msg: filesearch.ErrRecursiveNeedsFilter.Error()}
	}
	if len(args) == 1 {
		folder := args[0]
		if folder == "" {
			return rtn, moltenFilesUsageError{msg: "the folder is empty"}
		}
		folder = wavebase.ExpandHomeDirSafe(folder)
		if !filepath.IsAbs(folder) {
			if cwd == "" {
				return rtn, fmt.Errorf("the working directory is unknown, give an absolute folder")
			}
			folder = filepath.Join(cwd, folder)
		}
		rtn.req.Folder = filepath.Clean(folder)
	}
	return rtn, nil
}

type moltenFilesClient interface {
	Show(req filesearch.ShowRequest) (filesearch.ShowResult, error)
	Answer(req filesearch.AnswerRequest) (filesearch.AnswerResult, error)
}

type moltenFilesRpcClient struct{}

func (moltenFilesRpcClient) call(command string, data any, timeoutMs int, out any) error {
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{Route: filesearch.RouteId, Timeout: int64(timeoutMs)})
	if err != nil {
		return err
	}
	return utilfn.ReUnmarshal(out, resp)
}

func (c moltenFilesRpcClient) Show(req filesearch.ShowRequest) (filesearch.ShowResult, error) {
	var rtn filesearch.ShowResult
	err := c.call(filesearch.ShowCommand, req, moltenFilesShowTimeoutMs, &rtn)
	return rtn, err
}

func (c moltenFilesRpcClient) Answer(req filesearch.AnswerRequest) (filesearch.AnswerResult, error) {
	var rtn filesearch.AnswerResult
	err := c.call(filesearch.AnswerCommand, req, moltenFilesAnswerTimeoutMs, &rtn)
	return rtn, err
}

// moltenFilesJsonResult is the --json output (AC-5).
type moltenFilesJsonResult struct {
	Folder    string             `json:"folder"`
	Pattern   string             `json:"pattern"`
	Recursive bool               `json:"recursive"`
	Matches   []moltenFilesMatch `json:"matches"`
	Truncated bool               `json:"truncated"`
}

type moltenFilesMatch struct {
	Path string `json:"path"`
	Type string `json:"type"`
}

func moltenFilesMatches(result filesearch.ShowResult) []moltenFilesMatch {
	rtn := make([]moltenFilesMatch, 0, len(result.Matches))
	for _, m := range result.Matches {
		kind := filesearch.MatchTypeFile
		if m.IsFolder() {
			kind = filesearch.MatchTypeDir
		}
		rtn = append(rtn, moltenFilesMatch{Path: m.Name, Type: kind})
	}
	return rtn
}

// formatMoltenFilesText: one match per line, relative to the folder, folders ending with /, then the summary line.
func formatMoltenFilesText(result filesearch.ShowResult) string {
	var sb strings.Builder
	for _, m := range moltenFilesMatches(result) {
		sb.WriteString(m.Path)
		if m.Type == filesearch.MatchTypeDir {
			sb.WriteString("/")
		}
		sb.WriteString("\n")
	}
	fmt.Fprintf(&sb, "%d matches in %s", len(result.Matches), result.Folder)
	if result.Truncated {
		fmt.Fprintf(&sb, " (truncated: the search stops at %d matches)", filesearch.MaxMatches)
	}
	sb.WriteString("\n")
	return sb.String()
}

func writeMoltenFilesResult(w io.Writer, result filesearch.ShowResult, asJson bool) error {
	if !asJson {
		_, err := io.WriteString(w, formatMoltenFilesText(result))
		return err
	}
	out, err := json.MarshalIndent(moltenFilesJsonResult{
		Folder:    result.Folder,
		Pattern:   result.Pattern,
		Recursive: result.Recursive,
		Matches:   moltenFilesMatches(result),
		Truncated: result.Truncated,
	}, "", "  ")
	if err != nil {
		return err
	}
	_, err = fmt.Fprintf(w, "%s\n", out)
	return err
}

// waitMoltenFilesAnswer asks wavesrv until the user answered the panel's question about a folder outside the project.
func waitMoltenFilesAnswer(client moltenFilesClient, result filesearch.ShowResult) error {
	for {
		answer, err := client.Answer(filesearch.AnswerRequest{Panel: result.Panel, Folder: result.Folder})
		if err != nil {
			return err
		}
		switch answer.State {
		case filesearch.AnswerWaiting:
			continue
		case filesearch.AnswerApproved:
			return nil
		case filesearch.AnswerStayed:
			return errors.New(MoltenFilesStayedMessage)
		case filesearch.AnswerClosed:
			return errors.New(MoltenFilesClosedMessage)
		default:
			return fmt.Errorf("unexpected answer %q", answer.State)
		}
	}
}

// runMoltenFiles shows the search, waits for the user when the folder is outside the project, and prints the result.
func runMoltenFiles(args moltenFilesArgs, client moltenFilesClient, stdout io.Writer, stderr io.Writer) error {
	result, err := client.Show(args.req)
	if err != nil {
		// wavesrv checks the pattern again; its refusal is bad usage too.
		if strings.Contains(err.Error(), filesearch.ErrBadPattern.Error()) || strings.Contains(err.Error(), filesearch.ErrRecursiveNeedsFilter.Error()) {
			return moltenFilesUsageError{msg: err.Error()}
		}
		return err
	}
	if result.Asked {
		fmt.Fprintf(stderr, moltenFilesWaitingNotice, result.Folder)
		if err := waitMoltenFilesAnswer(client, result); err != nil {
			return err
		}
	}
	return writeMoltenFilesResult(stdout, result, args.json)
}

// moltenFilesFail reports err on one line (as JSON with --json) and sets the exit code: 2 for bad usage, 1 otherwise.
func moltenFilesFail(err error) {
	WshExitCode = moltenFilesExitFail
	var usage moltenFilesUsageError
	if errors.As(err, &usage) {
		WshExitCode = moltenFilesExitUsage
	}
	msg := strings.ReplaceAll(err.Error(), "\n", " ")
	if moltenFilesJson {
		out, _ := json.Marshal(map[string]string{"error": msg})
		WriteStderr("%s\n", out)
		return
	}
	WriteStderr("molten files: %s\n", msg)
}

func moltenFilesRun(cmd *cobra.Command, args []string) error {
	cwd, _ := os.Getwd()
	parsed, err := parseMoltenFilesArgs(args, moltenFilesFilter, moltenFilesRecursive, moltenFilesJson, cwd)
	if err != nil {
		moltenFilesFail(err)
		return nil
	}
	if err := preRunSetupRpcClient(cmd, args); err != nil {
		moltenFilesFail(err)
		return nil
	}
	err = runMoltenFiles(parsed, moltenFilesRpcClient{}, WrappedStdout, WrappedStderr)
	sendActivity("molten", err == nil)
	if err != nil {
		moltenFilesFail(err)
	}
	return nil
}
