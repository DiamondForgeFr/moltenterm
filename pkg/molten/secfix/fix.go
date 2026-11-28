// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package secfix

import (
	"fmt"
	"slices"
	"sort"
	"strings"
)

// The security fix (FR-REV-036 AC9 to AC13): one per set of advisories, kept per project. This file holds what a fix is
// and what the developer's consent to start one on its own is; it starts nothing, so the launcher in pkg/molten/review and
// the Integration list's answer read the same record.

// The setting that lets MoltenTerm start the fix without a click, and the developer's confirmation of it, written by the
// window in the client's meta. A terminal cannot write molten:* keys on the client (pkg/molten/metaguard) nor set the
// setting (pkg/wshrpc/wshserver configguard); an agent writing settings.json by hand gets the setting without the
// confirmation, which counts as off. Must match frontend/moltenterm-shell/settings/settings-catalog.ts ConfirmConsentKeys.
const (
	SettingKey = "review:securityfix"
	ConsentKey = "molten:securityfix"
)

// What the developer said about starting the fix on its own: never asked (the block asks once), no (MoltenTerm only offers
// it), or yes.
const (
	ConsentUnasked = "unasked"
	ConsentOff     = "off"
	ConsentOn      = "on"
)

// ConsentOf reads the developer's answer from the setting (nil when unset) and the client's meta. The setting alone never
// turns it on: the confirmation must be there too.
func ConsentOf(setting *bool, clientMeta map[string]any) string {
	if setting == nil {
		return ConsentUnasked
	}
	if !*setting {
		return ConsentOff
	}
	if at, ok := clientMeta[ConsentKey].(float64); ok && at > 0 {
		return ConsentOn
	}
	return ConsentOff
}

// The states of a fix. Waiting: starting it is held back (Reason says why); Working: its agent works; NeedsYou: it waits
// for the developer (Reason says why, Outcome is the agent's own line); Ready: its pull request is ready for the
// developer's merge; Merged: it landed; Stopped and Failed: it ended, and is never started again on its own.
const (
	FixWaiting  = "waiting"
	FixWorking  = "working"
	FixNeedsYou = "needsyou"
	FixReady    = "ready"
	FixMerged   = "merged"
	FixStopped  = "stopped"
	FixFailed   = "failed"
)

// Why a fix waits or needs the developer, as codes the window words in the interface language.
const (
	ReasonMachineBusy  = "machinebusy"
	ReasonAgentLimit   = "agentlimit"
	ReasonLaunchFailed = "launchfailed"
	ReasonNoAgent      = "noagent"
	ReasonNoWorkspace  = "noworkspace"
	ReasonAgentOutcome = "outcome"
	ReasonNoPr         = "nopr"
	ReasonChecksFailed = "checksfailed"
	ReasonNewAdvisory  = "newadvisory"
	ReasonAgentGone    = "agentgone"
	ReasonPrClosed     = "prclosed"
	ReasonNotReady     = "notready"
)

// What a fix does with the advisories: it bumps the dependency to the fixed version, or records that they do not apply
// (a review with its evidence, never an exception). Read from the PR once the agent says which.
const (
	ResolutionBump          = "bump"
	ResolutionNotApplicable = "notapplicable"
)

// mergedCovers is how long a merged fix still stands for its advisories: the scan on the trunk turns green only after the
// trunk's own CI ran on the merge, and until then the failure it fixed is still the last one it shows.
const mergedCovers = 3 * 60 * 60 * 1000

// maxKeptFixes bounds what a project keeps: its fixes in flight, and the latest ended ones.
const maxKeptFixes = 24

// Fix is the fix of one set of advisories.
type Fix struct {
	// Fingerprint keys the set the fix was started for; Ids are the advisories it covers now (a new one that appeared while
	// it was in flight joins them).
	Fingerprint string   `json:"fingerprint"`
	Ids         []string `json:"ids"`
	// Dir is the project the fix is of.
	Dir    string `json:"dir"`
	State  string `json:"state"`
	Reason string `json:"reason,omitempty"`
	// Auto: started without a click, under the developer's consent. External: someone else's work, not MoltenTerm's: a
	// pull request or an agent that was there first. MoltenTerm only follows it, never starts, readies or stops anything.
	Auto     bool `json:"auto,omitempty"`
	External bool `json:"external,omitempty"`
	Ticket   int  `json:"ticket,omitempty"`
	// TicketNew: MoltenTerm made the ticket (it is not one the project had).
	TicketNew bool   `json:"ticketnew,omitempty"`
	TicketUrl string `json:"ticketurl,omitempty"`
	Pr        int    `json:"pr,omitempty"`
	PrUrl     string `json:"prurl,omitempty"`
	Branch    string `json:"branch,omitempty"`
	Trunk     string `json:"trunk,omitempty"`
	Repo      string `json:"repo,omitempty"`
	// Tree is the worktree MoltenTerm made for the agent.
	Tree string `json:"tree,omitempty"`
	// What the fix does (Resolution…), once known.
	Resolution string `json:"resolution,omitempty"`
	// The agent that works on it and the terminal it works in.
	Agent       string `json:"agent,omitempty"`
	AgentName   string `json:"agentname,omitempty"`
	WorkspaceId string `json:"workspaceid,omitempty"`
	TabId       string `json:"tabid,omitempty"`
	BlockId     string `json:"blockid,omitempty"`
	// Outcome is the agent's last line, cleaned to one line.
	Outcome string `json:"outcome,omitempty"`
	// Extra are advisories that joined after the agent started and that it has not been told of yet.
	Extra []string `json:"extra,omitempty"`
	// Unblocks are the pull requests the fix's merge unblocks (the shared block's, the fix's own left out), as the last
	// assessment held them when the fix became ready and when it merged: the block goes once they are green, this stays.
	Unblocks []int `json:"unblocks,omitempty"`
	// Tries is how many times starting it failed before an agent was there; RetryAt (Unix ms) is when it may be tried
	// again without the developer.
	Tries   int   `json:"tries,omitempty"`
	RetryAt int64 `json:"retryat,omitempty"`
	// StartedAt is when the fix was begun, UpdatedAt its last change, MergedAt when its pull request landed (Unix ms).
	StartedAt int64 `json:"startedat"`
	UpdatedAt int64 `json:"updatedat"`
	MergedAt  int64 `json:"mergedat,omitempty"`
	// ReadiedAt is when MoltenTerm took the fix's pull request out of draft (Unix ms), claimed in the store before the call
	// is made: it is done once, and a pull request the developer takes back to draft is not marked ready again.
	ReadiedAt int64 `json:"readiedat,omitempty"`
}

// NormalizeIds gives ids their one spelling, once each, sorted.
func NormalizeIds(ids []string) []string {
	set := map[string]bool{}
	for _, id := range ids {
		if normalized := NormalizeId(id); normalized != "" {
			set[normalized] = true
		}
	}
	rtn := make([]string, 0, len(set))
	for id := range set {
		rtn = append(rtn, id)
	}
	sort.Strings(rtn)
	return rtn
}

// Active: the fix is in flight, so no other one starts and its advisories are covered.
func (f Fix) Active() bool {
	switch f.State {
	case FixWaiting, FixWorking, FixNeedsYou, FixReady:
		return true
	}
	return false
}

// Ended: the fix will not change on its own any more.
func (f Fix) Ended() bool {
	return f.State == FixMerged || f.State == FixStopped || f.State == FixFailed
}

// Covers tells whether every one of the advisories is one the fix was started for, took in since, or that joined it while
// it was in flight (Extra): the set it stands for.
func (f Fix) Covers(ids []string) bool {
	return covers(ids, f.Ids, f.Extra)
}

// CoversFixed is Covers for what the fix's work really holds: its own advisories, not the ones that only joined its set.
func (f Fix) CoversFixed(ids []string) bool {
	return covers(ids, f.Ids)
}

func covers(ids []string, sets ...[]string) bool {
	if len(ids) == 0 {
		return false
	}
	for _, id := range ids {
		id = NormalizeId(id)
		found := false
		for _, set := range sets {
			found = found || slices.Contains(set, id)
		}
		if !found {
			return false
		}
	}
	return true
}

// Plan says what a set of advisories calls for given the project's fixes.
const (
	// PlanLaunch: nothing stands for these advisories, a fix may be started.
	PlanLaunch = "launch"
	// PlanCovered: a fix stands for them (in flight, or merged a short while ago).
	PlanCovered = "covered"
	// PlanAddendum: a fix is in flight for other advisories; these join it.
	PlanAddendum = "addendum"
	// PlanHeld: the developer stopped the fix for this set, or it failed: it is not started again on its own.
	PlanHeld = "held"
)

// PlanOf decides what advisories call for, among fixes, at now (Unix ms). The Fix it returns is the one that decided: the
// covering fix, the one the advisories join, or the stopped or failed one that holds them.
func PlanOf(fixes []Fix, ids []string, now int64) (string, Fix) {
	var inFlight, covering *Fix
	for i := range fixes {
		fix := &fixes[i]
		if fix.Active() {
			if inFlight == nil || fix.StartedAt < inFlight.StartedAt {
				inFlight = fix
			}
			if fix.Covers(ids) {
				covering = fix
			}
		}
	}
	if covering != nil {
		return PlanCovered, *covering
	}
	if inFlight != nil {
		return PlanAddendum, *inFlight
	}
	var held, merged *Fix
	for i := range fixes {
		fix := &fixes[i]
		switch {
		case (fix.State == FixStopped || fix.State == FixFailed) && fix.Covers(ids):
			if held == nil || fix.UpdatedAt > held.UpdatedAt {
				held = fix
			}
		case fix.State == FixMerged && fix.CoversFixed(ids) && now-fix.MergedAt < mergedCovers:
			if merged == nil || fix.MergedAt > merged.MergedAt {
				merged = fix
			}
		}
	}
	if merged != nil {
		return PlanCovered, *merged
	}
	if held != nil {
		return PlanHeld, *held
	}
	return PlanLaunch, Fix{}
}

// FixOfBlock is the fix that stands for a block's advisories, or false: one in flight first, else the latest that ended.
func FixOfBlock(fixes []Fix, block Block) (Fix, bool) {
	ids := Ids(block.Advisories)
	var best *Fix
	for i := range fixes {
		fix := &fixes[i]
		if !fix.Covers(ids) && fix.Fingerprint != block.Fingerprint {
			continue
		}
		if best == nil || (fix.Active() && !best.Active()) || (fix.Active() == best.Active() && fix.UpdatedAt > best.UpdatedAt) {
			best = fix
		}
	}
	if best == nil {
		return Fix{}, false
	}
	return *best, true
}

// Slug is the part of a branch name that says what the fix is for: the advisories' ids, in lower case, bounded.
func Slug(ids []string) string {
	var parts []string
	for _, id := range ids {
		if clean := strings.ToLower(NormalizeId(id)); clean != "" {
			parts = append(parts, clean)
		}
		if len(parts) == 2 {
			break
		}
	}
	slug := strings.Join(parts, "-")
	if len(ids) > len(parts) && slug != "" {
		slug += fmt.Sprintf("-and-%d-more", len(ids)-len(parts))
	}
	if slug == "" {
		return "dependency-advisories"
	}
	return slug
}

// TicketTitle is the title of the ticket of a set of advisories.
func TicketTitle(ids []string) string {
	shown := ids
	more := 0
	if len(shown) > 3 {
		shown, more = ids[:3], len(ids)-3
	}
	title := "Dependency advisories: " + strings.Join(shown, ", ")
	if more > 0 {
		title += fmt.Sprintf(" and %d more", more)
	}
	return title
}

// markdownCell keeps a text that came from a report in one table cell: the advisory texts are cleaned already, and the
// pipe is the only character that would break the table.
func markdownCell(text string) string {
	text = strings.ReplaceAll(CleanLine(text, maxFieldRunes), "|", "/")
	if text == "" {
		return "-"
	}
	return text
}

// AdvisoryTable is the advisories as a Markdown table: what a ticket, a comment and a brief show of them. It carries only
// what the scan reported, cleaned.
func AdvisoryTable(advisories []Advisory) string {
	sorted := append([]Advisory{}, advisories...)
	sort.SliceStable(sorted, func(i, j int) bool {
		if sorted[i].Id != sorted[j].Id {
			return sorted[i].Id < sorted[j].Id
		}
		return sorted[i].Package < sorted[j].Package
	})
	var b strings.Builder
	b.WriteString("| Advisory | Package | Installed | Fixed in | Severity | Summary |\n| --- | --- | --- | --- | --- | --- |\n")
	for _, a := range sorted {
		fmt.Fprintf(&b, "| %s | %s | %s | %s | %s | %s |\n", markdownCell(a.Id), markdownCell(a.Package), markdownCell(a.Version),
			markdownCell(a.Fixed), markdownCell(a.Severity), markdownCell(a.Summary))
	}
	return b.String()
}

// TicketBody is the body of the ticket MoltenTerm makes for a set of advisories: what failed, the advisories, and what is
// asked. prs are the pull requests the scan blocks (their numbers); trunkFailing: the same scan fails on the trunk.
func TicketBody(advisories []Advisory, check string, trunk string, trunkFailing bool, prs []int) string {
	var b strings.Builder
	b.WriteString("The project's dependency scan")
	if check = CleanLine(check, 80); check != "" {
		fmt.Fprintf(&b, " (%s)", check)
	}
	b.WriteString(" fails on these advisories, and the failure is not the fault of the pull requests it blocks.\n\n")
	b.WriteString(AdvisoryTable(advisories))
	b.WriteString("\n")
	if trunkFailing && trunk != "" {
		fmt.Fprintf(&b, "The same scan fails on `%s`.\n", CleanLine(trunk, 60))
	}
	if len(prs) > 0 {
		var names []string
		for _, n := range prs {
			names = append(names, fmt.Sprintf("#%d", n))
		}
		fmt.Fprintf(&b, "Blocked pull requests: %s.\n", strings.Join(names, ", "))
	}
	b.WriteString("\nWhat is asked: bump each dependency to its fixed version. When a package has no fixed version, or the advisory does not apply " +
		"here, record a review of its applicability with the evidence, under the project's dependency policy. An exception is never an agent's: " +
		"it needs a human reviewer.\n\nOpened by MoltenTerm from the Integration panel. MoltenTerm never merges the fix.\n")
	return b.String()
}

// AddendumComment is the comment a set's ticket gets when advisories join it while its fix is in flight.
func AddendumComment(advisories []Advisory) string {
	return "More advisories join this set while its fix is in flight:\n\n" + AdvisoryTable(advisories)
}
