// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// The molten command (FR-MORPH-005, DS-MORPH-004). The mod host runs in each tab's renderer, so molten asks the tab
// it runs in. It sends plain command names over the tab route instead of declaring RPC types in pkg/wshrpc, the
// package upstream changes most. File changes (new, enable, disable, remove) are made here, then announced to every
// tab on the event bus.

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/spf13/cobra"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wps"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

const MoltenProgramName = "molten"

// must match the constants in frontend/molten/molten-start.ts
const (
	MoltenModListRpcCommand     = "moltenmodlist"
	MoltenModValidateRpcCommand = "moltenmodvalidate"
	MoltenRunRpcCommand         = "moltenrun"
	MoltenModsChangedEvent      = "molten:modschanged"
)

const MoltenRpcTimeoutMs = 5000
const MoltenRunDefaultTimeoutSec = 60
const MoltenMaxStdinBytes = 1 << 20

type MoltenModStatus struct {
	Id       string   `json:"id"`
	Name     string   `json:"name,omitempty"`
	Version  string   `json:"version,omitempty"`
	Path     string   `json:"path"`
	State    string   `json:"state"`
	Error    string   `json:"error,omitempty"`
	Commands []string `json:"commands"`
}

type MoltenCommandInfo struct {
	Name        string `json:"name"`
	ModId       string `json:"modid"`
	Description string `json:"description"`
}

type MoltenModList struct {
	ApiVersions []int               `json:"apiversions"`
	SafeMode    bool                `json:"safemode"`
	ModsDir     string              `json:"modsdir"`
	Mods        []MoltenModStatus   `json:"mods"`
	Commands    []MoltenCommandInfo `json:"commands"`
}

type MoltenRunRequest struct {
	Command string   `json:"command"`
	Args    []string `json:"args"`
	Stdin   string   `json:"stdin,omitempty"`
	BlockId string   `json:"blockid,omitempty"`
}

type MoltenRunResult struct {
	Found    bool     `json:"found"`
	Output   string   `json:"output,omitempty"`
	ExitCode int      `json:"exitcode"`
	Error    string   `json:"error,omitempty"`
	Commands []string `json:"commands,omitempty"`
}

type MoltenValidationProblem struct {
	File    string `json:"file"`
	Line    int    `json:"line,omitempty"`
	Column  int    `json:"column,omitempty"`
	Message string `json:"message"`
}

type MoltenValidationResult struct {
	Id       string                    `json:"id"`
	Ok       bool                      `json:"ok"`
	Problems []MoltenValidationProblem `json:"problems"`
}

type MoltenValidateResponse struct {
	Results []MoltenValidationResult `json:"results"`
}

type MoltenModChange struct {
	Id      string `json:"id"`
	Action  string `json:"action"`
	Changed bool   `json:"changed"`
	Path    string `json:"path,omitempty"`
}

var moltenJson bool
var moltenNewName string
var moltenNewDescription string

var moltenCmd = &cobra.Command{
	Use:   "molten [command] [args...]",
	Short: "manage Moltenterm mods and run the commands they provide",
	// Flags after a mod command belong to that command, so molten parses its own options by hand
	// (moltenParseRunOptions).
	DisableFlagParsing: true,
	Args:               cobra.ArbitraryArgs,
	RunE:               moltenRootRun,
}

var moltenHelpCmd = &cobra.Command{
	Use:     "help",
	Short:   "list the built-in commands and the commands of the enabled mods",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenHelpRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenModCmd = &cobra.Command{
	Use:   "mod",
	Short: "manage mods",
}

var moltenModNewCmd = &cobra.Command{
	Use:     "new <id>",
	Short:   "create a mod from a template (disabled until enabled)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenModNewRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenModListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the mods of this tab and their state",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenModListRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenModValidateCmd = &cobra.Command{
	Use:     "validate [id...]",
	Short:   "check mods without running them (all mods when no id is given)",
	RunE:    moltenWrap(moltenModValidateRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenModEnableCmd = &cobra.Command{
	Use:     "enable <id>",
	Short:   "enable a mod in every tab",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(func(cmd *cobra.Command, args []string) error { return moltenModToggle(args[0], true) }),
	PreRunE: preRunSetupRpcClient,
}

var moltenModDisableCmd = &cobra.Command{
	Use:     "disable <id>",
	Short:   "disable a mod in every tab",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(func(cmd *cobra.Command, args []string) error { return moltenModToggle(args[0], false) }),
	PreRunE: preRunSetupRpcClient,
}

var moltenModRemoveCmd = &cobra.Command{
	Use:     "remove <id>",
	Short:   "disable a mod and move its folder to the trash",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenModRemoveRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	// Installed as a link to wsh named molten (pkg/util/shellutil/moltenterm_molten.go): `molten x` runs as
	// `wsh molten x`.
	os.Args = moltenRewriteArgs(os.Args)

	for _, cmd := range []*cobra.Command{moltenHelpCmd, moltenModNewCmd, moltenModListCmd, moltenModValidateCmd,
		moltenModEnableCmd, moltenModDisableCmd, moltenModRemoveCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	}
	moltenModNewCmd.Flags().StringVar(&moltenNewName, "name", "", "name shown to the user (default: the id)")
	moltenModNewCmd.Flags().StringVar(&moltenNewDescription, "description", "", "one sentence describing the mod")
	rootCmd.AddCommand(moltenCmd)
	moltenCmd.AddCommand(moltenHelpCmd)
	moltenCmd.AddCommand(moltenModCmd)
	for _, cmd := range []*cobra.Command{moltenModNewCmd, moltenModListCmd, moltenModValidateCmd, moltenModEnableCmd,
		moltenModDisableCmd, moltenModRemoveCmd} {
		moltenModCmd.AddCommand(cmd)
	}
}

func moltenRewriteArgs(args []string) []string {
	if len(args) == 0 {
		return args
	}
	// Both separators: the name is checked the same way whatever the OS the tests run on.
	base := args[0][strings.LastIndexAny(args[0], `/\`)+1:]
	base = strings.TrimSuffix(base, ".exe")
	if base != MoltenProgramName {
		return args
	}
	rtn := []string{args[0], MoltenProgramName}
	return append(rtn, args[1:]...)
}

// Every molten command fails the same way: a non-zero exit code and the error on stderr, as JSON with --json.
func moltenWrap(fn func(cmd *cobra.Command, args []string) error) func(cmd *cobra.Command, args []string) error {
	return func(cmd *cobra.Command, args []string) error {
		err := fn(cmd, args)
		sendActivity("molten", err == nil)
		if err == nil {
			return nil
		}
		moltenReportError(err)
		return nil
	}
}

func moltenReportError(err error) {
	if WshExitCode == 0 {
		WshExitCode = 1
	}
	if moltenJson {
		out, _ := json.Marshal(map[string]string{"error": err.Error()})
		WriteStderr("%s\n", out)
		return
	}
	WriteStderr("molten: %v\n", err)
}

func moltenWriteJson(value any) error {
	out, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	WriteStdout("%s\n", out)
	return nil
}

func moltenTabRequest(command string, data any, timeoutMs int, out any) error {
	tabId := getTabIdFromEnv()
	if tabId == "" {
		return fmt.Errorf("molten must run in a Moltenterm terminal (WAVETERM_TABID is not set)")
	}
	resp, err := RpcClient.SendRpcRequest(command, data, &wshrpc.RpcOpts{
		Route:   wshutil.MakeTabRouteId(tabId),
		Timeout: int64(timeoutMs),
	})
	if err != nil {
		return fmt.Errorf("asking this tab (%s): %w", command, err)
	}
	if resp == nil {
		return fmt.Errorf("this tab did not answer: its mod host has not started")
	}
	err = utilfn.ReUnmarshal(out, resp)
	if err != nil {
		return fmt.Errorf("reading the answer of this tab: %w", err)
	}
	return nil
}

func moltenGetModList() (*MoltenModList, error) {
	var list MoltenModList
	err := moltenTabRequest(MoltenModListRpcCommand, nil, MoltenRpcTimeoutMs, &list)
	if err != nil {
		return nil, err
	}
	return &list, nil
}

func moltenGetPath(pathType string) (string, error) {
	path, err := wshclient.PathCommand(RpcClient, wshrpc.PathCommandData{PathType: pathType, TabId: getTabIdFromEnv()}, nil)
	if err != nil {
		return "", fmt.Errorf("getting the %s directory: %w", pathType, err)
	}
	return path, nil
}

func moltenAnnounceChange(ids ...string) {
	event := wps.WaveEvent{
		Event: MoltenModsChangedEvent,
		Data:  map[string]any{"ids": ids},
	}
	err := wshclient.EventPublishCommand(RpcClient, event, &wshrpc.RpcOpts{NoResponse: true})
	if err != nil {
		WriteStderr("molten: the change is saved but the open tabs were not told (%v)\n", err)
	}
}

func moltenModListRun(cmd *cobra.Command, args []string) error {
	list, err := moltenGetModList()
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(list)
	}
	WriteStdout("%s", formatMoltenModList(list))
	return nil
}

func formatMoltenModList(list *MoltenModList) string {
	var sb strings.Builder
	if list.SafeMode {
		sb.WriteString("safe mode: no mod is loaded\n")
	}
	if len(list.Mods) == 0 {
		fmt.Fprintf(&sb, "no mods in %s\n", list.ModsDir)
		return sb.String()
	}
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "ID\tSTATE\tVERSION\tCOMMANDS\tERROR\n")
	for _, mod := range list.Mods {
		version := mod.Version
		if version == "" {
			version = "-"
		}
		commands := strings.Join(mod.Commands, ",")
		if commands == "" {
			commands = "-"
		}
		errText := strings.ReplaceAll(mod.Error, "\n", " ")
		if errText == "" {
			errText = "-"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", mod.Id, mod.State, version, commands, errText)
	}
	tw.Flush()
	return sb.String()
}

func moltenModNewRun(cmd *cobra.Command, args []string) error {
	configDir, err := moltenGetPath("config")
	if err != nil {
		return err
	}
	id := args[0]
	dir, err := moltenNewMod(configDir, id, moltenNewName, moltenNewDescription)
	if err != nil {
		return err
	}
	moltenAnnounceChange(id)
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: "new", Changed: true, Path: dir})
	}
	WriteStdout("created mod %q in %s\nnext: molten mod validate %s && molten mod enable %s\n", id, dir, id, id)
	return nil
}

func moltenModToggle(id string, enable bool) error {
	configDir, err := moltenGetPath("config")
	if err != nil {
		return err
	}
	dir, err := moltenExistingModDir(configDir, id)
	if err != nil {
		return err
	}
	if enable {
		if _, err := os.Stat(filepath.Join(dir, MoltenManifestFileName)); err != nil {
			return fmt.Errorf("mod %q has no %s", id, MoltenManifestFileName)
		}
	}
	changed, err := moltenSetEnabled(configDir, id, enable)
	if err != nil {
		return err
	}
	action := "disable"
	if enable {
		action = "enable"
	}
	if changed {
		moltenAnnounceChange(id)
	}
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: action, Changed: changed, Path: dir})
	}
	switch {
	case changed && enable:
		WriteStdout("enabled mod %q; check it with: molten mod list\n", id)
	case changed:
		WriteStdout("disabled mod %q\n", id)
	case enable:
		WriteStdout("mod %q is already enabled\n", id)
	default:
		WriteStdout("mod %q is already disabled\n", id)
	}
	return nil
}

func moltenModRemoveRun(cmd *cobra.Command, args []string) error {
	configDir, err := moltenGetPath("config")
	if err != nil {
		return err
	}
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return err
	}
	id := args[0]
	dest, err := moltenRemoveMod(configDir, dataDir, moltenSystemTrashDir(), id, time.Now())
	if err != nil {
		return err
	}
	moltenAnnounceChange(id)
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: "remove", Changed: true, Path: dest})
	}
	WriteStdout("removed mod %q; its folder is now %s\n", id, dest)
	return nil
}

func moltenModValidateRun(cmd *cobra.Command, args []string) error {
	for _, id := range args {
		if err := moltenCheckModId(id); err != nil {
			return err
		}
	}
	var resp MoltenValidateResponse
	err := moltenTabRequest(MoltenModValidateRpcCommand, map[string]any{"ids": args}, MoltenRpcTimeoutMs, &resp)
	if err != nil {
		return err
	}
	failed := 0
	for _, result := range resp.Results {
		if !result.Ok {
			failed++
		}
	}
	if failed > 0 {
		WshExitCode = 1
	}
	if moltenJson {
		return moltenWriteJson(resp)
	}
	WriteStdout("%s", formatMoltenValidation(resp.Results))
	return nil
}

func formatMoltenValidation(results []MoltenValidationResult) string {
	if len(results) == 0 {
		return "no mods to validate\n"
	}
	var sb strings.Builder
	for _, result := range results {
		if result.Ok {
			fmt.Fprintf(&sb, "%s: ok\n", result.Id)
			continue
		}
		for _, problem := range result.Problems {
			location := problem.File
			if problem.Line > 0 {
				location = fmt.Sprintf("%s:%d", location, problem.Line)
				if problem.Column > 0 {
					location = fmt.Sprintf("%s:%d", location, problem.Column)
				}
			}
			fmt.Fprintf(&sb, "%s: %s: %s\n", result.Id, location, problem.Message)
		}
	}
	return sb.String()
}

func moltenHelpRun(cmd *cobra.Command, args []string) error {
	list, listErr := moltenGetModList()
	if moltenJson {
		builtins := []MoltenCommandInfo{}
		for _, line := range moltenBuiltinHelp {
			builtins = append(builtins, MoltenCommandInfo{Name: line[0], Description: line[1]})
		}
		out := map[string]any{"builtin": builtins, "commands": []MoltenCommandInfo{}}
		if listErr == nil {
			out["commands"] = list.Commands
		}
		return moltenWriteJson(out)
	}
	WriteStdout("%s", formatMoltenHelp(list))
	if listErr != nil {
		WriteStderr("molten: mod commands unavailable: %v\n", listErr)
	}
	return nil
}

var moltenBuiltinHelp = [][2]string{
	{"mod new <id>", "create a mod from a template (disabled until enabled)"},
	{"mod list", "list the mods of this tab and their state"},
	{"mod validate [id...]", "check mods without running them"},
	{"mod enable <id>", "enable a mod in every tab"},
	{"mod disable <id>", "disable a mod in every tab"},
	{"mod remove <id>", "disable a mod and move its folder to the trash"},
	{"help", "this list"},
	{"<command> [args...]", "run a command provided by an enabled mod"},
}

func formatMoltenHelp(list *MoltenModList) string {
	var sb strings.Builder
	sb.WriteString("usage: molten [--json] [--timeout <seconds>] <command> [args...]\n\nbuilt-in commands:\n")
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	for _, line := range moltenBuiltinHelp {
		fmt.Fprintf(tw, "  %s\t%s\n", line[0], line[1])
	}
	tw.Flush()
	sb.WriteString("\nmod commands:\n")
	if list == nil || len(list.Commands) == 0 {
		sb.WriteString("  (none: enable a mod with molten mod enable <id>)\n")
		return sb.String()
	}
	tw = tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	for _, command := range list.Commands {
		description := command.Description
		if description == "" {
			description = "-"
		}
		fmt.Fprintf(tw, "  %s\t%s\t(%s)\n", command.Name, description, command.ModId)
	}
	tw.Flush()
	return sb.String()
}

type moltenRunOptions struct {
	Json       bool
	TimeoutSec int
	Help       bool
	Command    string
	Args       []string
}

// Options are read only before the command name; everything after it goes to the mod command untouched.
func moltenParseRunOptions(args []string) (moltenRunOptions, error) {
	opts := moltenRunOptions{TimeoutSec: MoltenRunDefaultTimeoutSec}
	for i := 0; i < len(args); i++ {
		arg := args[i]
		switch {
		case arg == "--json":
			opts.Json = true
		case arg == "-h" || arg == "--help":
			opts.Help = true
		case arg == "--timeout" || strings.HasPrefix(arg, "--timeout="):
			value := strings.TrimPrefix(arg, "--timeout=")
			if arg == "--timeout" {
				if i+1 >= len(args) {
					return opts, fmt.Errorf("--timeout needs a number of seconds")
				}
				i++
				value = args[i]
			}
			seconds, err := strconv.Atoi(value)
			if err != nil || seconds <= 0 {
				return opts, fmt.Errorf("--timeout needs a positive number of seconds (got %q)", value)
			}
			opts.TimeoutSec = seconds
		case strings.HasPrefix(arg, "-"):
			return opts, fmt.Errorf("unknown option %q (molten options go before the command)", arg)
		default:
			opts.Command = arg
			opts.Args = append([]string{}, args[i+1:]...)
			return opts, nil
		}
	}
	return opts, nil
}

func moltenRootRun(cmd *cobra.Command, args []string) error {
	opts, err := moltenParseRunOptions(args)
	moltenJson = opts.Json
	if err != nil {
		moltenReportError(err)
		return nil
	}
	err = preRunSetupRpcClient(cmd, args)
	if err != nil {
		moltenReportError(err)
		return nil
	}
	if opts.Help || opts.Command == "" {
		return moltenWrap(moltenHelpRun)(cmd, nil)
	}
	return moltenWrap(func(cmd *cobra.Command, _ []string) error { return moltenRunModCommand(opts) })(cmd, nil)
}

func moltenReadStdin() (string, error) {
	info, err := os.Stdin.Stat()
	if err != nil {
		return "", nil
	}
	// Only a pipe or a file is read: a terminal would wait for the user, and a closed stdin has nothing to give.
	if info.Mode()&(os.ModeNamedPipe) == 0 && !info.Mode().IsRegular() {
		return "", nil
	}
	data, err := io.ReadAll(io.LimitReader(os.Stdin, MoltenMaxStdinBytes+1))
	if err != nil {
		return "", fmt.Errorf("reading stdin: %w", err)
	}
	if len(data) > MoltenMaxStdinBytes {
		return "", fmt.Errorf("stdin is larger than %d bytes", MoltenMaxStdinBytes)
	}
	return string(data), nil
}

func moltenRunModCommand(opts moltenRunOptions) error {
	stdin, err := moltenReadStdin()
	if err != nil {
		return err
	}
	req := MoltenRunRequest{
		Command: opts.Command,
		Args:    opts.Args,
		Stdin:   stdin,
		BlockId: os.Getenv("WAVETERM_BLOCKID"),
	}
	var result MoltenRunResult
	err = moltenTabRequest(MoltenRunRpcCommand, req, opts.TimeoutSec*1000, &result)
	if err != nil {
		return err
	}
	if !result.Found {
		return errors.New(formatMoltenUnknownCommand(opts.Command, result.Commands))
	}
	WshExitCode = result.ExitCode
	if opts.Json {
		return moltenWriteJson(map[string]any{
			"command":  opts.Command,
			"output":   result.Output,
			"exitcode": result.ExitCode,
			"error":    result.Error,
		})
	}
	if result.Output != "" {
		WriteStdout("%s", result.Output)
		if !strings.HasSuffix(result.Output, "\n") {
			WriteStdout("\n")
		}
	}
	if result.Error != "" {
		WriteStderr("molten: %s: %s\n", opts.Command, result.Error)
	}
	return nil
}

func formatMoltenUnknownCommand(command string, available []string) string {
	if len(available) == 0 {
		return fmt.Sprintf("unknown command %q; no mod command is available (built-in: mod, help)", command)
	}
	return fmt.Sprintf("unknown command %q; available: %s (built-in: mod, help)", command, strings.Join(available, ", "))
}
