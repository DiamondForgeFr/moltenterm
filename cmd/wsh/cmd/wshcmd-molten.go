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
	"github.com/wavetermdev/waveterm/pkg/molten"
	"github.com/wavetermdev/waveterm/pkg/util/utilfn"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
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
	MoltenTrustPromptRpcCommand = "moltentrustprompt"
	MoltenModsChangedEvent      = "molten:modschanged"
)

const MoltenRpcTimeoutMs = 5000
const MoltenRunDefaultTimeoutSec = 60
const MoltenMaxStdinBytes = 1 << 20

// must match MoltenTrustTimeoutMs in frontend/molten/molten-trust.tsx; molten waits a little longer than the prompt
const MoltenTrustTimeoutMs = 5 * 60 * 1000
const MoltenTrustRpcTimeoutMs = MoltenTrustTimeoutMs + 10*1000

const (
	MoltenTrustAnswerTrusted  = "trusted"
	MoltenTrustAnswerDeclined = "declined"
	MoltenTrustAnswerTimeout  = "timeout"
)

type MoltenModStatus struct {
	Id       string   `json:"id"`
	Name     string   `json:"name,omitempty"`
	Version  string   `json:"version,omitempty"`
	Path     string   `json:"path"`
	State    string   `json:"state"`
	Error    string   `json:"error,omitempty"`
	Commands []string `json:"commands"`
	Builtin  bool     `json:"builtin,omitempty"`
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
	Trust   string `json:"trust,omitempty"`
}

type MoltenTrustPromptResult struct {
	Answer string `json:"answer"`
}

var moltenJson bool
var moltenNewName string
var moltenNewDescription string

var moltenCmd = &cobra.Command{
	Use:   "molten [command] [args...]",
	Short: "manage MoltenTerm mods and run the commands they provide",
	// Flags after a mod command belong to that command, so molten parses its own options by hand
	// (moltenParseRunOptions).
	DisableFlagParsing: true,
	Args:               cobra.ArbitraryArgs,
}

var moltenHelpCmd = &cobra.Command{
	Use:     "help",
	Short:   "list the built-in commands and the commands of the enabled mods",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenHelpRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenUndoCmd = &cobra.Command{
	Use:     "undo",
	Short:   "restore the mods as they were before the last change; repeat to keep going back",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenUndoRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenHistoryCmd = &cobra.Command{
	Use:     "history",
	Short:   "list the recorded changes to the mods",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenHistoryRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenAgentYes bool

var moltenAgentCmd = &cobra.Command{
	Use:   "agent",
	Short: "install the molten guides (/molten-feature, /molten-pipeline) for your coding agent",
	Args:  cobra.ArbitraryArgs,
	RunE:  moltenAgentRun,
}

var moltenAgentListCmd = &cobra.Command{
	Use:     "list",
	Short:   "list the supported coding agents and where the molten guides are installed",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenAgentListRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenAgentInstallCmd = &cobra.Command{
	Use:     "install <agent>",
	Short:   "install /molten-feature and /molten-pipeline for a coding agent (at user level)",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenAgentInstallRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenAgentRemoveCmd = &cobra.Command{
	Use:     "remove <agent>",
	Short:   "remove the molten guides from a coding agent",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenAgentRemoveRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenDocsCmd = &cobra.Command{
	Use:     "docs",
	Short:   "write the offline mod documentation of this version and print its folder",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenDocsRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenModCmd = &cobra.Command{
	Use:   "mod",
	Short: "manage mods",
	Args:  cobra.ArbitraryArgs,
	RunE:  moltenModRun,
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
	Short:   "enable a mod in every tab (asks you to trust it first)",
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

var moltenModUntrustCmd = &cobra.Command{
	Use:     "untrust <id>",
	Short:   "stop a mod in every tab and forget that you trusted it",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenModUntrustRun),
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
	// Set here, not in the literal: moltenRootRun looks up moltenCmd's subcommands, which would be an init cycle.
	moltenCmd.RunE = moltenRootRun

	moltenAgentInstallCmd.Flags().BoolVarP(&moltenAgentYes, "yes", "y", false, "write without asking")
	for _, cmd := range []*cobra.Command{moltenAgentListCmd, moltenAgentInstallCmd, moltenAgentRemoveCmd, moltenDocsCmd,
		moltenHelpCmd, moltenUndoCmd, moltenHistoryCmd, moltenModNewCmd, moltenModListCmd, moltenModValidateCmd,
		moltenModEnableCmd, moltenModDisableCmd, moltenModUntrustCmd, moltenModRemoveCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
	}
	moltenModNewCmd.Flags().StringVar(&moltenNewName, "name", "", "name shown to the user (default: the id)")
	moltenModNewCmd.Flags().StringVar(&moltenNewDescription, "description", "", "one sentence describing the mod")
	rootCmd.AddCommand(moltenCmd)
	moltenCmd.AddCommand(moltenHelpCmd)
	moltenCmd.AddCommand(moltenUndoCmd)
	moltenCmd.AddCommand(moltenDocsCmd)
	moltenCmd.AddCommand(moltenAgentCmd)
	moltenAgentCmd.AddCommand(moltenAgentListCmd)
	moltenAgentCmd.AddCommand(moltenAgentInstallCmd)
	moltenAgentCmd.AddCommand(moltenAgentRemoveCmd)
	moltenCmd.AddCommand(moltenHistoryCmd)
	moltenCmd.AddCommand(moltenModCmd)
	for _, cmd := range []*cobra.Command{moltenModNewCmd, moltenModListCmd, moltenModValidateCmd, moltenModEnableCmd,
		moltenModDisableCmd, moltenModUntrustCmd, moltenModRemoveCmd} {
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
		return fmt.Errorf("molten must run in a MoltenTerm terminal (WAVETERM_TABID is not set)")
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

// Without RunE, cobra answers an unknown subcommand with its help and exit code 0; agents need a failure.
func moltenModRun(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return cmd.Help()
	}
	moltenReportError(fmt.Errorf("unknown mod subcommand %q (see molten help)", args[0]))
	return nil
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
		id := mod.Id
		if mod.Builtin {
			id += " (built-in)"
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\t%s\n", id, mod.State, version, commands, errText)
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

// Built-in mods have no folder: the calling tab knows them. A tab that cannot answer means no built-in check, and the
// command goes on with the mod folders.
func moltenIsBuiltin(id string) bool {
	list, err := moltenGetModList()
	if err != nil {
		return false
	}
	for _, mod := range list.Mods {
		if mod.Id == id {
			return mod.Builtin
		}
	}
	return false
}

func moltenRefuseBuiltin(id string, action string) error {
	if moltenIsBuiltin(id) {
		return fmt.Errorf("%q is a built-in mod and cannot be %s; turn it off with molten mod disable %s", id, action, id)
	}
	return nil
}

func moltenBuiltinToggle(configDir string, id string, enable bool) error {
	changed, err := moltenSetBuiltinEnabled(configDir, id, enable)
	if err != nil {
		return err
	}
	if changed {
		moltenAnnounceChange(id)
	}
	action := "disable"
	if enable {
		action = "enable"
	}
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: action, Changed: changed, Path: "builtin:" + id, Trust: "builtin"})
	}
	switch {
	case changed && enable:
		WriteStdout("enabled built-in mod %q\n", id)
	case changed:
		WriteStdout("disabled built-in mod %q\n", id)
	case enable:
		WriteStdout("built-in mod %q is already enabled\n", id)
	default:
		WriteStdout("built-in mod %q is already disabled\n", id)
	}
	return nil
}

func moltenModToggle(id string, enable bool) error {
	configDir, err := moltenGetPath("config")
	if err != nil {
		return err
	}
	if err := moltenCheckModId(id); err != nil {
		return err
	}
	if moltenIsBuiltin(id) {
		return moltenBuiltinToggle(configDir, id, enable)
	}
	dir, err := moltenExistingModDir(configDir, id)
	if err != nil {
		return err
	}
	trustState := ""
	if enable {
		if _, err := os.Stat(filepath.Join(dir, MoltenManifestFileName)); err != nil {
			return fmt.Errorf("mod %q has no %s", id, MoltenManifestFileName)
		}
		trustState, err = moltenEnsureTrusted(id)
		if err != nil {
			return err
		}
	}
	changed, err := moltenSetEnabled(configDir, id, enable)
	if err != nil {
		return err
	}
	// An enabled but untrusted mod (mods.json edited by hand) starts once trusted, though its state did not change.
	changed = changed || trustState == MoltenTrustAnswerTrusted
	action := "disable"
	if enable {
		action = "enable"
	}
	if changed {
		moltenAnnounceChange(id)
	}
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: action, Changed: changed, Path: dir, Trust: trustState})
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

// Asks the calling tab whether the user trusts the mod, unless they already did, and records the answer. Nothing of
// the mod runs before this returns "trusted".
func moltenEnsureTrusted(id string) (string, error) {
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return "", err
	}
	trusted, err := moltenIsTrusted(dataDir, id)
	if err != nil {
		return "", err
	}
	if trusted {
		return "already", nil
	}
	WriteStderr("molten: waiting for your approval of mod %q in MoltenTerm…\n", id)
	var result MoltenTrustPromptResult
	err = moltenTabRequest(MoltenTrustPromptRpcCommand, map[string]any{"id": id}, MoltenTrustRpcTimeoutMs, &result)
	if err != nil {
		return "", err
	}
	err = moltenTrustAnswerError(id, result.Answer)
	if err != nil {
		return "", err
	}
	name := id
	if manifest, readErr := moltenReadTemplateManifest(id); readErr == nil && manifest.Name != "" {
		name = manifest.Name
	}
	err = moltenSetTrusted(dataDir, id, name, time.Now())
	if err != nil {
		return "", err
	}
	return MoltenTrustAnswerTrusted, nil
}

func moltenTrustAnswerError(id string, answer string) error {
	switch answer {
	case MoltenTrustAnswerTrusted:
		return nil
	case MoltenTrustAnswerDeclined:
		return fmt.Errorf("mod %q was not trusted: it stays disabled", id)
	case MoltenTrustAnswerTimeout:
		return fmt.Errorf("mod %q waits for your approval: no answer within %d minutes, run molten mod enable %s again", id, MoltenTrustTimeoutMs/60000, id)
	default:
		return fmt.Errorf("unexpected answer %q from the trust prompt", answer)
	}
}

func moltenReadTemplateManifest(id string) (MoltenTemplateManifest, error) {
	var manifest MoltenTemplateManifest
	configDir, err := moltenGetPath("config")
	if err != nil {
		return manifest, err
	}
	data, err := os.ReadFile(filepath.Join(moltenModsDir(configDir), id, MoltenManifestFileName))
	if err != nil {
		return manifest, err
	}
	err = json.Unmarshal(data, &manifest)
	return manifest, err
}

func moltenModUntrustRun(cmd *cobra.Command, args []string) error {
	id := args[0]
	err := moltenCheckModId(id)
	if err != nil {
		return err
	}
	err = moltenRefuseBuiltin(id, "untrusted")
	if err != nil {
		return err
	}
	configDir, err := moltenGetPath("config")
	if err != nil {
		return err
	}
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return err
	}
	forgotten, err := moltenForgetTrust(dataDir, id)
	if err != nil {
		return err
	}
	disabled, err := moltenSetEnabled(configDir, id, false)
	if err != nil {
		return err
	}
	changed := forgotten || disabled
	if changed {
		moltenAnnounceChange(id)
	}
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: "untrust", Changed: changed})
	}
	if !changed {
		WriteStdout("mod %q was not trusted\n", id)
		return nil
	}
	WriteStdout("mod %q is stopped and no longer trusted; enabling it again asks you first\n", id)
	return nil
}

func moltenGetHistory() (*molten.History, error) {
	configDir, err := moltenGetPath("config")
	if err != nil {
		return nil, err
	}
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return nil, err
	}
	return molten.MakeHistory(molten.HistoryDir(dataDir), moltenModsDir(configDir), moltenStateFile(configDir)), nil
}

func moltenUndoRun(cmd *cobra.Command, args []string) error {
	history, err := moltenGetHistory()
	if err != nil {
		return err
	}
	target, undoEntry, err := history.Undo(time.Now())
	if err != nil {
		return err
	}
	moltenAnnounceChange(undoEntry.Ids...)
	if moltenJson {
		return moltenWriteJson(map[string]any{"restored": target, "recorded": undoEntry})
	}
	changed := strings.Join(undoEntry.Ids, ", ")
	if changed == "" {
		changed = "no mod"
	}
	WriteStdout("restored the mods as after change #%d (%s); changed: %s\n", target.Seq, moltenFormatTime(target.Time), changed)
	return nil
}

func moltenHistoryRun(cmd *cobra.Command, args []string) error {
	history, err := moltenGetHistory()
	if err != nil {
		return err
	}
	entries, err := history.Entries()
	if err != nil {
		return err
	}
	position, _ := molten.HistoryPosition(entries)
	if moltenJson {
		if entries == nil {
			entries = []molten.HistoryEntry{}
		}
		return moltenWriteJson(map[string]any{"position": position, "entries": entries})
	}
	WriteStdout("%s", formatMoltenHistory(entries, position))
	return nil
}

func moltenFormatTime(rfc3339 string) string {
	t, err := time.Parse(time.RFC3339, rfc3339)
	if err != nil {
		return rfc3339
	}
	return t.Local().Format("2006-01-02 15:04:05")
}

// Newest first; the arrow marks the change whose state the mods are in.
func formatMoltenHistory(entries []molten.HistoryEntry, position int) string {
	if len(entries) == 0 {
		return "no recorded change yet\n"
	}
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "\t#\tTIME\tKIND\tMODS\n")
	for i := len(entries) - 1; i >= 0; i-- {
		entry := entries[i]
		mark := ""
		if entry.Seq == position {
			mark = "->"
		}
		kind := entry.Kind
		if entry.Kind == molten.HistoryKindUndo {
			kind = fmt.Sprintf("undo (back to #%d)", entry.Target)
		}
		mods := strings.Join(entry.Ids, ",")
		if mods == "" {
			mods = "-"
		}
		fmt.Fprintf(tw, "%s\t%d\t%s\t%s\t%s\n", mark, entry.Seq, moltenFormatTime(entry.Time), kind, mods)
	}
	tw.Flush()
	return sb.String()
}

// Like `mod`: without RunE cobra would answer an unknown subcommand with exit code 0.
func moltenAgentRun(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return cmd.Help()
	}
	moltenReportError(fmt.Errorf("unknown agent subcommand %q (see molten help)", args[0]))
	return nil
}

func moltenAgentEnv() (molten.AgentEnv, error) {
	home, err := os.UserHomeDir()
	if err != nil {
		return molten.AgentEnv{}, err
	}
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return molten.AgentEnv{}, err
	}
	return molten.AgentEnv{Home: home, DataDir: dataDir, Getenv: os.Getenv}, nil
}

func moltenAgentListRun(cmd *cobra.Command, args []string) error {
	env, err := moltenAgentEnv()
	if err != nil {
		return err
	}
	statuses := []molten.AgentStatus{}
	for _, profile := range molten.AgentProfiles {
		statuses = append(statuses, profile.Status(env))
	}
	if moltenJson {
		return moltenWriteJson(statuses)
	}
	WriteStdout("%s", formatMoltenAgents(statuses))
	return nil
}

func moltenGuideState(installed bool, foreign bool, version string) string {
	switch {
	case installed:
		return "v" + version
	case foreign:
		return "no (path taken)"
	}
	return "no"
}

// The folder holding the agent's guides: a skill is a folder of its own inside it, a command a file.
func moltenGuidesDir(status molten.AgentStatus) string {
	if status.Format == "skill" {
		return filepath.Dir(filepath.Dir(status.Path))
	}
	return filepath.Dir(status.Path)
}

func formatMoltenAgents(statuses []molten.AgentStatus) string {
	var sb strings.Builder
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	header := []string{"AGENT"}
	for _, guide := range molten.AgentGuides {
		header = append(header, strings.ToUpper(guide.Name))
	}
	fmt.Fprintf(tw, "%s\tTYPE\tPATH\n", strings.Join(header, "\t"))
	for _, status := range statuses {
		cells := []string{status.Id}
		for i := range molten.AgentGuides {
			if i < len(status.Guides) {
				g := status.Guides[i]
				cells = append(cells, moltenGuideState(g.Installed, g.Foreign, g.Version))
				continue
			}
			if i == 0 {
				cells = append(cells, moltenGuideState(status.Installed, status.Foreign, status.Version))
				continue
			}
			cells = append(cells, "no")
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\n", strings.Join(cells, "\t"), status.Format, moltenGuidesDir(status))
	}
	tw.Flush()
	sb.WriteString("\ninstall or update with: molten agent install <agent>\n")
	return sb.String()
}

// The user sees where molten writes before it writes (FR-MORPH-006); --yes is for scripts and agents.
func moltenConfirm(question string) bool {
	if moltenAgentYes || !moltenStdinIsTerminal() {
		return true
	}
	WriteStderr("%s [y/N] ", question)
	var answer string
	fmt.Fscanln(os.Stdin, &answer)
	answer = strings.ToLower(strings.TrimSpace(answer))
	return answer == "y" || answer == "yes"
}

func moltenStdinIsTerminal() bool {
	info, err := os.Stdin.Stat()
	return err == nil && info.Mode()&os.ModeCharDevice != 0
}

func moltenAgentInstallRun(cmd *cobra.Command, args []string) error {
	profile, err := molten.FindAgent(args[0])
	if err != nil {
		return err
	}
	env, err := moltenAgentEnv()
	if err != nil {
		return err
	}
	if !moltenJson {
		WriteStdout("molten will write these %s files for %s:\n", profile.Format, profile.Name)
		for _, guide := range molten.AgentGuides {
			WriteStdout("  %s\n", profile.GuidePath(env, guide))
		}
	}
	if !moltenConfirm("write it?") {
		return fmt.Errorf("nothing written")
	}
	_, installErr := profile.Install(env, wavebase.WaveVersion)
	status := profile.Status(env)
	if moltenJson {
		if installErr != nil {
			return installErr
		}
		return moltenWriteJson(status)
	}
	where := "In " + profile.Name + ", type:"
	if profile.Id == "generic" {
		where = "Tell your coding agent:"
	}
	for _, guide := range status.Guides {
		if guide.Installed {
			WriteStdout("%s installed. %s\n  %s\n", guide.Name, where, guide.Invocation)
		}
	}
	return installErr
}

func moltenAgentRemoveRun(cmd *cobra.Command, args []string) error {
	profile, err := molten.FindAgent(args[0])
	if err != nil {
		return err
	}
	env, err := moltenAgentEnv()
	if err != nil {
		return err
	}
	path, removed, err := profile.Remove(env)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"id": profile.Id, "path": path, "removed": removed})
	}
	if !removed {
		WriteStdout("no molten guide is installed for %s\n", profile.Name)
		return nil
	}
	WriteStdout("removed %s\n", path)
	return nil
}

func moltenDocsRun(cmd *cobra.Command, args []string) error {
	dataDir, err := moltenGetPath("data")
	if err != nil {
		return err
	}
	dir := molten.DocsDir(dataDir, wavebase.WaveVersion)
	err = molten.WriteDocs(dir)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(map[string]any{"path": dir, "version": wavebase.WaveVersion})
	}
	WriteStdout("%s\n", dir)
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
	err = moltenRefuseBuiltin(id, "removed")
	if err != nil {
		return err
	}
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
	{"mod enable <id>", "enable a mod in every tab (asks you to trust it first)"},
	{"mod disable <id>", "disable a mod in every tab"},
	{"mod untrust <id>", "stop a mod and forget that you trusted it"},
	{"mod remove <id>", "disable a mod and move its folder to the trash"},
	{"undo", "restore the mods as they were before the last change (repeat to go further back)"},
	{"history", "list the recorded changes to the mods"},
	{"docs", "write the offline mod documentation and print its folder"},
	{"agent list", "the supported coding agents and where the molten guides are installed"},
	{"agent install <agent>", "install /molten-feature and /molten-pipeline for a coding agent"},
	{"agent remove <agent>", "remove the molten guides from a coding agent"},
	{"project link [folder]", "link this workspace to its project (default: this terminal's folder)"},
	{"project show", "show this workspace's project, its pipeline and its conventions"},
	{"project logo [file]", "use an image of the project as the workspace icon"},
	{"project validate [folder]", "check the project's pipeline (.molten/project.json) without running it"},
	{"project unlink", "remove this workspace's project link"},
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
	// `molten --json history` reaches here because the options come first: hand it to the built-in subcommand.
	if moltenIsBuiltinSubcommand(opts.Command) {
		return moltenRunSubcommand(opts)
	}
	return moltenWrap(func(cmd *cobra.Command, _ []string) error { return moltenRunModCommand(opts) })(cmd, nil)
}

func moltenIsBuiltinSubcommand(name string) bool {
	for _, sub := range moltenCmd.Commands() {
		if sub.Name() == name {
			return true
		}
	}
	return false
}

func moltenRunSubcommand(opts moltenRunOptions) error {
	sub, rest, err := moltenCmd.Find(append([]string{opts.Command}, opts.Args...))
	if err != nil || sub == moltenCmd || sub.RunE == nil {
		moltenReportError(fmt.Errorf("unknown subcommand %q (see molten help)", strings.Join(append([]string{opts.Command}, opts.Args...), " ")))
		return nil
	}
	if sub == moltenModCmd && len(rest) > 0 {
		return moltenModRun(sub, rest)
	}
	err = sub.ParseFlags(rest)
	if err != nil {
		moltenReportError(err)
		return nil
	}
	moltenJson = moltenJson || opts.Json
	err = sub.ValidateArgs(sub.Flags().Args())
	if err != nil {
		moltenReportError(err)
		return nil
	}
	return sub.RunE(sub, sub.Flags().Args())
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
		out := map[string]any{"command": opts.Command, "output": result.Output, "exitcode": result.ExitCode}
		if result.Error != "" {
			out["error"] = result.Error
		}
		return moltenWriteJson(out)
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
