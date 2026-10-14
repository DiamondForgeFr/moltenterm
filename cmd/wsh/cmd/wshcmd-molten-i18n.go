// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

// `molten i18n` and `molten mod new --language` (FR-I18N-002, DS-I18N-009): what the developer's coding agent uses to
// write a language pack. The tab answers export, check and status from the dictionaries, the packs and the check it
// applies itself (frontend/moltenterm-shell/i18n/language-pack-tools.ts), so the agent sees MoltenTerm's verdict.
// Every message here stays English whatever the interface language: agents parse it (DS-I18N-007).

package cmd

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"text/tabwriter"

	"github.com/spf13/cobra"
)

// must match the constants in frontend/molten/molten-start.ts
const (
	MoltenI18nExportRpcCommand = "molteni18nexport"
	MoltenI18nCheckRpcCommand  = "molteni18ncheck"
	MoltenI18nStatusRpcCommand = "molteni18nstatus"
)

// The largest dictionary molten sends to the tab to check.
const MoltenI18nMaxFileBytes = 4 << 20

// must match LanguageCodePattern in frontend/molten/molten-manifest.ts
var moltenLanguageCodeRegex = regexp.MustCompile(`^[a-z]{2,3}(-([a-z]{2}|[0-9]{3}))?$`)

// must match the types in frontend/moltenterm-shell/i18n/language-pack-tools.ts
type MoltenI18nLanguage struct {
	Code         string `json:"code"`
	Name         string `json:"name"`
	Shipped      bool   `json:"shipped"`
	Pack         string `json:"pack,omitempty"`
	Untranslated int    `json:"untranslated"`
	Total        int    `json:"total"`
}

type MoltenI18nShadowed struct {
	ModId string `json:"modid"`
	Code  string `json:"code"`
	By    string `json:"by"`
}

type MoltenI18nRefused struct {
	Id    string `json:"id"`
	State string `json:"state"`
	Error string `json:"error"`
}

type MoltenI18nStatus struct {
	Active    string               `json:"active"`
	Languages []MoltenI18nLanguage `json:"languages"`
	Shadowed  []MoltenI18nShadowed `json:"shadowed"`
	Refused   []MoltenI18nRefused  `json:"refused"`
}

type MoltenI18nProblem struct {
	Key     string `json:"key"`
	Message string `json:"message"`
}

type MoltenI18nCheck struct {
	File       string              `json:"file,omitempty"`
	Code       string              `json:"code"`
	Ok         bool                `json:"ok"`
	Errors     []MoltenI18nProblem `json:"errors"`
	Warnings   []MoltenI18nProblem `json:"warnings"`
	Missing    int                 `json:"missing"`
	Translated int                 `json:"translated"`
	Total      int                 `json:"total"`
}

type MoltenI18nExportKey struct {
	Key          string   `json:"key"`
	English      string   `json:"english"`
	Placeholders []string `json:"placeholders"`
	Translation  string   `json:"translation,omitempty"`
}

type MoltenI18nExport struct {
	Language string                `json:"language,omitempty"`
	Missing  bool                  `json:"missing"`
	Count    int                   `json:"count"`
	Dict     json.RawMessage       `json:"dict"`
	Keys     []MoltenI18nExportKey `json:"keys"`
}

var moltenI18nLang string
var moltenI18nMissing bool
var moltenNewLanguage string
var moltenNewLanguageName string

var moltenI18nCmd = &cobra.Command{
	Use:   "i18n",
	Short: "the interface dictionaries, for writing a language pack (molten docs: language-pack.md)",
	Args:  cobra.ArbitraryArgs,
	RunE:  moltenI18nRun,
}

var moltenI18nExportCmd = &cobra.Command{
	Use:     "export",
	Short:   "print the English reference; --lang the current translation; --lang --missing the keys still to translate",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenI18nExportRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenI18nCheckCmd = &cobra.Command{
	Use:     "check <file>",
	Short:   "check a dictionary as MoltenTerm loads it: placeholders, unknown keys, missing strings",
	Args:    cobra.ExactArgs(1),
	RunE:    moltenWrap(moltenI18nCheckRun),
	PreRunE: preRunSetupRpcClient,
}

var moltenI18nStatusCmd = &cobra.Command{
	Use:     "status",
	Short:   "the interface languages, where each comes from and how many strings each lacks",
	Args:    cobra.NoArgs,
	RunE:    moltenWrap(moltenI18nStatusRun),
	PreRunE: preRunSetupRpcClient,
}

func init() {
	moltenI18nExportCmd.Flags().StringVar(&moltenI18nLang, "lang", "", "a language code (es, pt-br)")
	moltenI18nExportCmd.Flags().BoolVar(&moltenI18nMissing, "missing", false, "only the keys --lang does not translate yet, in English")
	moltenI18nCheckCmd.Flags().StringVar(&moltenI18nLang, "lang", "", "the language code (default: the file name, es.json gives es)")
	for _, cmd := range []*cobra.Command{moltenI18nExportCmd, moltenI18nCheckCmd, moltenI18nStatusCmd} {
		cmd.Flags().BoolVar(&moltenJson, "json", false, "print the result as JSON")
		moltenI18nCmd.AddCommand(cmd)
	}
	moltenCmd.AddCommand(moltenI18nCmd)
	moltenModNewCmd.Flags().StringVar(&moltenNewLanguage, "language", "", "create a language pack for this code (es, pt-br): data only, no code")
	moltenModNewCmd.Flags().StringVar(&moltenNewLanguageName, "language-name", "", "the language's own name, as the language picker shows it (Español)")
}

func moltenI18nRun(cmd *cobra.Command, args []string) error {
	if len(args) == 0 {
		return cmd.Help()
	}
	moltenReportError(fmt.Errorf("unknown i18n subcommand %q (see molten help)", args[0]))
	return nil
}

func moltenNormalizeLanguageCode(code string) string {
	return strings.ReplaceAll(strings.ToLower(strings.TrimSpace(code)), "_", "-")
}

func moltenCheckLanguageCode(code string) (string, error) {
	normalized := moltenNormalizeLanguageCode(code)
	if !moltenLanguageCodeRegex.MatchString(normalized) {
		return "", fmt.Errorf("invalid language code %q: use a BCP 47 primary subtag, optionally with a region (es, pt-br)", code)
	}
	return normalized, nil
}

func moltenI18nExportRun(cmd *cobra.Command, args []string) error {
	lang := ""
	if moltenI18nLang != "" {
		var err error
		lang, err = moltenCheckLanguageCode(moltenI18nLang)
		if err != nil {
			return err
		}
	}
	if moltenI18nMissing && lang == "" {
		return fmt.Errorf("--missing needs --lang <code>")
	}
	var resp MoltenI18nExport
	err := moltenTabRequest(MoltenI18nExportRpcCommand, map[string]any{"lang": lang, "missing": moltenI18nMissing}, MoltenRpcTimeoutMs, &resp)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(resp)
	}
	return moltenWriteJson(resp.Dict)
}

// The language a dictionary file is for: --lang, else its name (es.json, locales/pt-br.json).
func moltenLanguageOfFile(path string, given string) (string, error) {
	if given != "" {
		return moltenCheckLanguageCode(given)
	}
	base := strings.TrimSuffix(filepath.Base(path), filepath.Ext(path))
	code, err := moltenCheckLanguageCode(base)
	if err != nil {
		return "", fmt.Errorf("cannot tell the language of %s from its name: give --lang <code>", path)
	}
	return code, nil
}

func moltenI18nCheckRun(cmd *cobra.Command, args []string) error {
	path := args[0]
	code, err := moltenLanguageOfFile(path, moltenI18nLang)
	if err != nil {
		return err
	}
	info, err := os.Stat(path)
	if err != nil {
		return err
	}
	if info.Size() > MoltenI18nMaxFileBytes {
		return fmt.Errorf("%s is larger than %d MB", path, MoltenI18nMaxFileBytes>>20)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return err
	}
	var resp MoltenI18nCheck
	err = moltenTabRequest(MoltenI18nCheckRpcCommand, map[string]any{"code": code, "text": string(data)}, MoltenRpcTimeoutMs, &resp)
	if err != nil {
		return err
	}
	resp.File = path
	if !resp.Ok {
		WshExitCode = 1
	}
	if moltenJson {
		return moltenWriteJson(resp)
	}
	WriteStdout("%s", formatMoltenI18nCheck(resp))
	return nil
}

func formatMoltenI18nCheck(check MoltenI18nCheck) string {
	var sb strings.Builder
	if !check.Ok {
		fmt.Fprintf(&sb, "%s (%s): refused, nothing of it would apply\n", check.File, check.Code)
		for _, problem := range check.Errors {
			fmt.Fprintf(&sb, "  error: %s\n", problem.Message)
		}
	} else {
		fmt.Fprintf(&sb, "%s (%s): ok, %d of %d strings translated", check.File, check.Code, check.Translated, check.Total)
		if check.Missing > 0 {
			fmt.Fprintf(&sb, ", %d missing (they show in English; molten i18n export --lang %s --missing lists them)", check.Missing, check.Code)
		}
		sb.WriteString("\n")
	}
	for _, problem := range check.Warnings {
		fmt.Fprintf(&sb, "  warning: %s\n", problem.Message)
	}
	return sb.String()
}

func moltenI18nStatusRun(cmd *cobra.Command, args []string) error {
	var resp MoltenI18nStatus
	err := moltenTabRequest(MoltenI18nStatusRpcCommand, nil, MoltenRpcTimeoutMs, &resp)
	if err != nil {
		return err
	}
	if moltenJson {
		return moltenWriteJson(resp)
	}
	WriteStdout("%s", formatMoltenI18nStatus(resp))
	return nil
}

func formatMoltenI18nStatus(status MoltenI18nStatus) string {
	var sb strings.Builder
	fmt.Fprintf(&sb, "interface language: %s\n", status.Active)
	tw := tabwriter.NewWriter(&sb, 0, 0, 2, ' ', 0)
	fmt.Fprintf(tw, "CODE\tLANGUAGE\tSOURCE\tUNTRANSLATED\n")
	for _, lang := range status.Languages {
		source := "shipped"
		switch {
		case lang.Shipped && lang.Pack != "":
			source = "shipped, overrides from pack " + lang.Pack
		case lang.Pack != "":
			source = "pack " + lang.Pack
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%d of %d\n", lang.Code, lang.Name, source, lang.Untranslated, lang.Total)
	}
	tw.Flush()
	for _, s := range status.Shadowed {
		fmt.Fprintf(&sb, "\npack %q also gives %s: %q, enabled more recently, is used (molten mod disable %s)\n", s.ModId, s.Code, s.By, s.ModId)
	}
	for _, r := range status.Refused {
		fmt.Fprintf(&sb, "\npack %q is %s: %s\n", r.Id, r.State, strings.ReplaceAll(r.Error, "\n", "; "))
	}
	return sb.String()
}

func moltenNewLanguagePackRun(configDir string, id string) error {
	if moltenNewClaudeCode || moltenNewClaudeCodeVersion != "" {
		return fmt.Errorf("a language pack runs no code: --language cannot take a Claude Code part")
	}
	dir, file, err := moltenNewLanguagePack(configDir, id, moltenNewName, moltenNewDescription, moltenNewLanguage, moltenNewLanguageName)
	if err != nil {
		return err
	}
	moltenAnnounceChange(id)
	if moltenJson {
		return moltenWriteJson(MoltenModChange{Id: id, Action: "new", Changed: true, Path: dir})
	}
	WriteStdout("created language pack %q in %s\n", id, dir)
	WriteStdout("write the translation in %s (molten i18n export prints the English reference)\n", file)
	WriteStdout("next: molten i18n check %s && molten mod validate %s && molten mod enable %s\n", file, id, id)
	return nil
}

// A data-only mod for one language: a manifest naming the dictionary, and an empty dictionary (every string shows
// English until translated).
func moltenNewLanguagePack(configDir string, id string, name string, description string, code string, languageName string) (string, string, error) {
	err := moltenCheckModId(id)
	if err != nil {
		return "", "", err
	}
	code, err = moltenCheckLanguageCode(code)
	if err != nil {
		return "", "", err
	}
	dir := filepath.Join(moltenModsDir(configDir), id)
	_, err = os.Stat(dir)
	if err == nil {
		return "", "", fmt.Errorf("mod %q already exists in %s", id, dir)
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", "", err
	}
	if languageName == "" {
		languageName = code
	}
	if name == "" {
		name = fmt.Sprintf("%s language pack", languageName)
	}
	if description == "" {
		description = fmt.Sprintf("MoltenTerm's interface in %s", languageName)
	}
	rel := "locales/" + code + ".json"
	manifest := MoltenTemplateManifest{
		Id:          id,
		Name:        name,
		Version:     "0.1.0",
		Description: description,
		ApiVersion:  1,
		Languages:   []MoltenLanguageEntry{{Code: code, Name: languageName, File: rel}},
	}
	manifestData, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return "", "", err
	}
	file := filepath.Join(dir, filepath.FromSlash(rel))
	err = os.MkdirAll(filepath.Dir(file), 0755)
	if err != nil {
		return "", "", err
	}
	err = os.WriteFile(file, []byte("{}\n"), 0644)
	if err != nil {
		return "", "", err
	}
	err = os.WriteFile(filepath.Join(dir, MoltenManifestFileName), append(manifestData, '\n'), 0644)
	if err != nil {
		return "", "", err
	}
	return dir, file, nil
}
