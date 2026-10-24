// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package pipelinesetup

// The choices a target constrains (DS-MC-031), as data: a new packager adds rows here, the stepper shows whatever the
// rows say, with their reason. Reasons are i18n codes, read by the frontend as mc.setup.reason.<code>.

const (
	TargetMsi           = "msi"
	TargetNsis          = "nsis"
	TargetDmg           = "dmg"
	TargetLinux         = "linux"
	TargetNpm           = "npm"
	TargetContainer     = "container"
	TargetGithubRelease = "githubrelease"
	TargetPages         = "pages"
	TargetAll           = "*"

	PackagerElectronBuilder = "electron-builder"
	PackagerTauri           = "tauri"
	PackagerNpm             = "npm"
	PackagerDocker          = "docker"
	PackagerWorkflow        = "workflow"

	RcFormatNumeric = "numeric"
	RcFormatRcDot   = "rcdot"

	BranchModelPromote = "promote"
	BranchModelSingle  = "single"
	BranchModelRcPr    = "rcpr"

	MergeCommit = "merge"
	MergeSquash = "squash"
	MergeRebase = "rebase"

	// Why a choice is unavailable, or what it implies.
	ReasonMsiNumeric   = "msiNumeric"
	ReasonChainNumeric = "chainNumeric"
	ReasonNpmDistTag   = "npmDistTag"
	ReasonChainMerge   = "chainMerge"
	// The release branch takes pull requests only; a merge method its protection does not allow (#1046).
	ReasonProtectedRelease = "protectedRelease"
	ReasonProtectionMerge  = "protectionMerge"
	ReasonSingleBranch     = "singleBranch"
	ReasonNoReleaseTrunk   = "noReleaseBranch"
)

// A rule about one choice for one target: the choice is refused (Allowed false) or allowed with a note.
type ChoiceRule struct {
	Choice  string
	Target  string
	Allowed bool
	Reason  string
}

// RcFormatRules: an MSI installer only takes numbers after the dash (the Tauri bundler's .msi target accepts a
// numeric pre-release only, https://v2.tauri.app/release/tauri-bundler/v1.2.0/; Windows Installer's ProductVersion is
// numeric fields, https://learn.microsoft.com/en-us/windows/win32/msi/productversion). npm takes -rc.N with a dist-tag
// such as next. MoltenTerm's release chain (pkg/molten/versions) numbers candidates -N for every project for now.
var RcFormatRules = []ChoiceRule{
	{Choice: RcFormatRcDot, Target: TargetMsi, Allowed: false, Reason: ReasonMsiNumeric},
	{Choice: RcFormatRcDot, Target: TargetNpm, Allowed: true, Reason: ReasonNpmDistTag},
	{Choice: RcFormatRcDot, Target: TargetAll, Allowed: false, Reason: ReasonChainNumeric},
}

var BranchModelRules = []ChoiceRule{}

// applyProtection refuses what the release branch's protection refuses (#1046): a promotion pushed straight to a
// branch that takes pull requests only, a merge method its rules do not allow.
func applyProtection(models []Choice, merges []Choice, p *Protection) {
	if p.RequiresPr() {
		for i := range models {
			if models[i].Id == BranchModelPromote {
				models[i].Allowed = false
				models[i].Reasons = append(models[i].Reasons, ChoiceReason{Code: ReasonProtectedRelease, Target: p.Branch, Refuses: true})
			}
		}
	}
	for i := range merges {
		if !p.AllowsMerge(merges[i].Id) {
			merges[i].Allowed = false
			merges[i].Reasons = append(merges[i].Reasons, ChoiceReason{Code: ReasonProtectionMerge, Target: p.Branch, Refuses: true})
		}
	}
}

var MergeRules = []ChoiceRule{
	{Choice: MergeSquash, Target: TargetAll, Allowed: false, Reason: ReasonChainMerge},
	{Choice: MergeRebase, Target: TargetAll, Allowed: false, Reason: ReasonChainMerge},
}

// A choice as the stepper offers it: allowed or not, and every reason the rules give (the target named).
type Choice struct {
	Id      string         `json:"id"`
	Allowed bool           `json:"allowed"`
	Reasons []ChoiceReason `json:"reasons,omitempty"`
}

type ChoiceReason struct {
	Code    string `json:"code"`
	Target  string `json:"target,omitempty"`
	Refuses bool   `json:"refuses"`
}

// EvaluateChoices applies the rules to the choices for the targets found; a choice is allowed unless a rule refuses it.
func EvaluateChoices(ids []string, rules []ChoiceRule, targets []string) []Choice {
	has := map[string]bool{TargetAll: true}
	for _, t := range targets {
		has[t] = true
	}
	rtn := make([]Choice, 0, len(ids))
	for _, id := range ids {
		choice := Choice{Id: id, Allowed: true}
		for _, rule := range rules {
			if rule.Choice != id || !has[rule.Target] {
				continue
			}
			target := rule.Target
			if target == TargetAll {
				target = ""
			}
			choice.Reasons = append(choice.Reasons, ChoiceReason{Code: rule.Reason, Target: target, Refuses: !rule.Allowed})
			if !rule.Allowed {
				choice.Allowed = false
			}
		}
		rtn = append(rtn, choice)
	}
	return rtn
}
