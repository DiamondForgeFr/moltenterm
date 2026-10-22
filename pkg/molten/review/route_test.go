// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package review

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/molten/localroute"
	"github.com/wavetermdev/waveterm/pkg/molten/localroute/routetest"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
)

// callAs runs a command as the route would for a verified source: "tab:" a window, "proc:" a local terminal, anything
// else an unverified caller.
func callAs(l *routeLink, source string, command string, data any) (any, error) {
	caller := localroute.Caller{Source: source}
	switch {
	case strings.HasPrefix(source, wshutil.RoutePrefix_Tab):
		caller.IsWindow, caller.TabId = true, strings.TrimPrefix(source, wshutil.RoutePrefix_Tab)
	case strings.HasPrefix(source, wshutil.RoutePrefix_Proc):
		caller.IsLocalTerminal = true
	default:
		caller = localroute.Caller{}
	}
	if !l.route().Policy.Admits(command, caller) {
		return nil, errors.New(localroute.RefusalMark)
	}
	return l.handle(context.Background(), command, data)
}

// #662: a remote host, a forged window source included, neither reads nor changes a review; a local terminal reads
// and asks for a handoff, and only a window changes anything.
func TestRouteCallers(t *testing.T) {
	e := routetest.Make(t)
	link, err := localroute.MakeLink(e.Router, (&routeLink{service: &Service{}}).route())
	if err != nil {
		t.Fatal(err)
	}
	data := map[string]any{"repo": testRepo, "number": 7, "dir": "/tmp"}
	for _, command := range []string{FilesCommand, FileCommand, CompareCommand, StateCommand, MergePlanShownCommand, NotesCommand} {
		routetest.MustRefuse(t, link, e.NonLocal(), command, data)
	}
	notTerminals := append([]routetest.From{e.Window(), e.Electron()}, e.Forged()...)
	routetest.MustRefuseWith(t, link, notTerminals, HandoffCommand, data, "from a local MoltenTerm terminal")
	for _, command := range []string{OpenCommand, AiPaneCommand, WorktreeCommand, MergePlanCommand, MergeCommand, PublishCommand,
		RestartCommand, RebaseCommand, InvestigateCommand, ReleaseResolveCommand, MarkReadyCommand, CleanupCommand, CommentCommand, TranslateCommand} {
		routetest.MustRefuse(t, link, e.NonWindows(), command, data)
	}
}
