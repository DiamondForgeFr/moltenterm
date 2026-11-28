// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package cmd

import (
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// `molten browser list|open|read|show|close` (#2596, FR-BRW-008): the tools of MoltenTerm's browser server for an agent
// that can run a command and has no MCP server. Each command is built from a binding of pkg/molten/mcpbrowser (its
// arguments and its help come from the tool's own definition) and sends one call of that tool to wavesrv, which runs the
// tool's code as it does for the MCP server, with the same scope, permissions and questions to the developer. Only a
// local page, which no tool opens, goes the way `molten open` sends it: queued in the browser panel, which asks the
// developer before it loads the file.

const (
	// Longer than wavesrv's own limit on a call (a 2-minute site permission wait, then a page load), like the MCP servers'.
	moltenBrowserCliTimeoutMs = 200000

	// The tool a command was built from, for the guard test.
	moltenBrowserToolAnnotation = "molten:tool"

	moltenBrowserSchemeRefused = "Only http and https pages and existing local files can be opened"
)

var moltenBrowserCmd = &cobra.Command{
	Use:   mcpbrowser.CliGroup,
	Short: "use MoltenTerm's browser panel from a shell, with no MCP server: list, open, read, show, close",
	Long: "Use the browser panel next to this terminal from a shell: the tools of MoltenTerm's browser server, for an agent that\n" +
		"has no MCP server (Claude Code, Codex and Kimi Code alike). Run molten browser list to see what you hold, then open,\n" +
		"read, show and close. Details: pages.md in the folder molten docs prints.",
	Args: cobra.NoArgs,
	RunE: func(cmd *cobra.Command, args []string) error {
		return cmd.Help()
	},
}

func init() {
	moltenCmd.AddCommand(moltenBrowserCmd)
	for _, b := range mcpbrowser.CliBindings() {
		if b.Existing || !strings.HasPrefix(b.Command, mcpbrowser.CliGroup+" ") {
			continue
		}
		moltenBrowserCmd.AddCommand(makeMoltenBrowserCommand(b))
	}
}

func makeMoltenBrowserCommand(b mcpbrowser.CliBinding) *cobra.Command {
	words := strings.Fields(b.Command)
	use := words[len(words)-1]
	required := 0
	for _, arg := range b.Args {
		if arg.Optional {
			use += " [" + arg.Name + "]"
			continue
		}
		use += " <" + arg.Name + ">"
		required++
	}
	cmd := &cobra.Command{
		Use:   use,
		Short: b.Short,
		Long: b.Short + ".\n\nThis runs the tool " + b.Tool + " of MoltenTerm's browser server without an MCP server, with the same rules: only your own\n" +
			"tabs and the ones the developer shared with you, in this workspace; the first action on a site asks the developer;\n" +
			"what a page says comes back inside a notice that it is not from the user. Details: pages.md in the folder molten docs prints.",
		Args:        cobra.RangeArgs(required, len(b.Args)),
		RunE:        moltenWrap(func(cmd *cobra.Command, args []string) error { return moltenBrowserRun(b, cmd, args) }),
		PreRunE:     moltenBrowserPreRun,
		Annotations: map[string]string{moltenBrowserToolAnnotation: b.Tool},
	}
	for _, f := range b.Flags {
		cmd.Flags().Bool(f.Name, false, mcpbrowser.CliUsage(b.Tool, f.Property))
	}
	cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	return cmd
}

func moltenBrowserToken() (string, error) {
	token := os.Getenv(wshutil.WaveJwtTokenVarName)
	if token == "" {
		return "", fmt.Errorf("%s", mcpbrowser.ErrNotInMoltenTerm)
	}
	return token, nil
}

// moltenBrowserPreRun answers outside a MoltenTerm terminal with the sentence the MCP tools answer there.
func moltenBrowserPreRun(cmd *cobra.Command, args []string) error {
	if _, err := moltenBrowserToken(); err != nil {
		return err
	}
	return preRunSetupRpcClient(cmd, args)
}

// moltenBrowserSend is how a request reaches wavesrv, which the tests replace.
var moltenBrowserSend = func(command string, data any, opts *wshrpc.RpcOpts) (any, error) {
	return RpcClient.SendRpcRequest(command, data, opts)
}

// moltenBrowserCallTool sends one call of a tool to wavesrv, which finds the terminal's session from its token.
func moltenBrowserCallTool(tool string, input json.RawMessage) (mcpbrowser.CallResult, error) {
	var result mcpbrowser.CallResult
	token, err := moltenBrowserToken()
	if err != nil {
		return result, err
	}
	resp, err := moltenBrowserSend(mcpbrowser.CliCommand, mcpbrowser.CliRequest{Token: token, Tool: tool, Args: input},
		&wshrpc.RpcOpts{Route: mcpbrowser.RouteId, Timeout: moltenBrowserCliTimeoutMs})
	if err != nil {
		return result, fmt.Errorf("%s", strings.TrimSpace(err.Error()))
	}
	if err := utilfn.ReUnmarshal(&result, resp); err != nil {
		return result, fmt.Errorf("unreadable answer from MoltenTerm: %v", err)
	}
	return result, nil
}

func moltenBrowserCall(tool string, input json.RawMessage) (mcpbrowser.CliView, error) {
	result, err := moltenBrowserCallTool(tool, input)
	if err != nil {
		return mcpbrowser.CliView{}, err
	}
	return mcpbrowser.CliViewOf(tool, result)
}

// moltenBrowserLatestTab is the tab a command takes when none is named: the newest one the terminal's session holds.
func moltenBrowserLatestTab() (int64, error) {
	result, err := moltenBrowserCallTool(mcpbrowser.ToolTabsContext, json.RawMessage(`{}`))
	if err != nil {
		return 0, err
	}
	if result.IsError {
		_, err := mcpbrowser.CliViewOf(mcpbrowser.ToolTabsContext, result)
		return 0, err
	}
	var data mcpbrowser.ContextData
	if err := json.Unmarshal(result.Data, &data); err != nil {
		return 0, fmt.Errorf("unreadable answer from MoltenTerm: %v", err)
	}
	tab, ok := mcpbrowser.LatestTab(data.Tabs)
	if !ok {
		return 0, fmt.Errorf("%s", mcpbrowser.ErrNoTab)
	}
	return tab, nil
}

func moltenBrowserPrint(view mcpbrowser.CliView) error {
	if moltenJson {
		return moltenWriteJson(view.Json)
	}
	WriteStdout("%s\n", strings.TrimRight(view.Text, "\n"))
	return nil
}

func moltenBrowserRun(b mcpbrowser.CliBinding, cmd *cobra.Command, args []string) error {
	set := map[string]bool{}
	for _, f := range b.Flags {
		if on, _ := cmd.Flags().GetBool(f.Name); on {
			set[f.Name] = true
		}
	}
	if b.Tool == mcpbrowser.ToolTabsCreate {
		return moltenBrowserOpen(b, args[0], set)
	}
	if len(args) < len(b.Args) && b.Args[len(args)].Optional && b.Args[len(args)].Property == "tabId" {
		tab, err := moltenBrowserLatestTab()
		if err != nil {
			return err
		}
		args = append(args, strconv.FormatInt(tab, 10))
	}
	input, err := mcpbrowser.CliArgs(b, args, set)
	if err != nil {
		return err
	}
	view, err := moltenBrowserCall(b.Tool, input)
	if err != nil {
		return err
	}
	return moltenBrowserPrint(view)
}

// A page's address, as `molten open` reads one: a scheme is written out, a bare host is an address (localhost gets http).
var moltenBrowserSchemeRe = regexp.MustCompile(`^[a-zA-Z][a-zA-Z0-9+.-]*://`)
var moltenBrowserDriveRe = regexp.MustCompile(`^[a-zA-Z]:[\\/]`)

// moltenBrowserTarget tells what open was asked for: a web address, which the tool opens, or a local file, which
// the developer confirms in the panel (file is its file: address then).
func moltenBrowserTarget(arg string) (page string, file string, err error) {
	text := strings.TrimSpace(arg)
	lower := strings.ToLower(text)
	switch {
	case text == "":
		return "", "", fmt.Errorf("say which page to open: a web address or a file")
	case strings.HasPrefix(lower, "file:"):
		path, err := moltenBrowserFilePath(text)
		if err != nil {
			return "", "", err
		}
		file, err = moltenBrowserLocalFile(path)
		return "", file, err
	case strings.HasPrefix(lower, "about:") || strings.HasPrefix(lower, "data:") || strings.HasPrefix(lower, "javascript:"):
		return "", "", fmt.Errorf("%s", moltenBrowserSchemeRefused)
	case moltenBrowserSchemeRe.MatchString(text):
		if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
			return "", "", fmt.Errorf("%s", moltenBrowserSchemeRefused)
		}
		return text, "", nil
	case moltenBrowserLooksLikePath(text):
		file, err = moltenBrowserLocalFile(text)
		return "", file, err
	}
	return moltenPageUrl(text), "", nil
}

func moltenBrowserLooksLikePath(text string) bool {
	for _, prefix := range []string{"/", "./", "../", "~/", `.\`, `..\`, `~\`, `\\`} {
		if strings.HasPrefix(text, prefix) {
			return true
		}
	}
	if moltenBrowserDriveRe.MatchString(text) {
		return true
	}
	info, err := os.Stat(text)
	return err == nil && info.Mode().IsRegular()
}

// moltenBrowserFilePath is the path a file: address names, on this computer's own files only.
func moltenBrowserFilePath(text string) (string, error) {
	parsed, err := url.Parse(text)
	if err != nil || (parsed.Host != "" && !strings.EqualFold(parsed.Host, "localhost")) || parsed.Path == "" {
		return "", fmt.Errorf("a file address must name a file of this computer: file:///path/to/page.html")
	}
	path := parsed.Path
	if runtime.GOOS == "windows" && moltenBrowserDriveRe.MatchString(strings.TrimPrefix(path, "/")) {
		path = strings.TrimPrefix(path, "/")
	}
	return path, nil
}

// moltenBrowserLocalFile checks that the path is a file that exists and returns its file: address.
func moltenBrowserLocalFile(path string) (string, error) {
	if path == "~" || strings.HasPrefix(path, "~/") || strings.HasPrefix(path, `~\`) {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("cannot find your home folder: %v", err)
		}
		path = filepath.Join(home, path[1:])
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return "", fmt.Errorf("%s is not a path: %v", path, err)
	}
	info, err := os.Stat(abs)
	if err != nil || !info.Mode().IsRegular() {
		return "", fmt.Errorf("%s is not a file that exists: only a web address or an existing file opens", path)
	}
	slashed := filepath.ToSlash(abs)
	if !strings.HasPrefix(slashed, "/") {
		slashed = "/" + slashed
	}
	return (&url.URL{Scheme: "file", Path: slashed}).String(), nil
}

func moltenBrowserOpen(b mcpbrowser.CliBinding, arg string, set map[string]bool) error {
	page, file, err := moltenBrowserTarget(arg)
	if err != nil {
		return err
	}
	if file != "" {
		return moltenBrowserOpenLocal(file, set["new-tab"])
	}
	input, err := mcpbrowser.CliArgs(b, []string{page}, set)
	if err != nil {
		return err
	}
	view, err := moltenBrowserCall(b.Tool, input)
	if err != nil {
		return err
	}
	return moltenBrowserPrint(view)
}

// moltenBrowserOpenLocal queues a local file in the browser panel as `molten open` does: the panel loads it only once the
// developer confirms it there, naming the file. It is theirs to confirm and no tab of the session: no tool reads it.
func moltenBrowserOpenLocal(file string, newTab bool) error {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("%s", mcpbrowser.ErrNotInMoltenTerm)
	}
	panel, reused, err := openInMoltenTerm(tabId, file, newTab)
	if err != nil {
		return err
	}
	text := fmt.Sprintf("Opened %s in MoltenTerm's browser (panel block:%s). The developer confirms a local page in the panel before it loads. "+
		"It has no tab number and no command reads it.", file, panel)
	return moltenBrowserPrint(mcpbrowser.CliView{
		Json: map[string]any{"url": file, "panel": panel, "local": true, "reused": reused, "text": text},
		Text: text,
	})
}
