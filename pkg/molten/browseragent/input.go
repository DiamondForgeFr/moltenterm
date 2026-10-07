// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"runtime"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/molten/mcpbrowser"
)

// The input tools (FR-BRW-010, DS-BRW-016): the computer tool's clicks, hover, scroll, scroll_to, key, type and drag,
// form_input, resize and browser_batch. Input goes to the tab's page through DevTools Input events only, never to
// MoltenTerm's interface or the OS; every action passes the site gate (onPage), shows on the control bar, and asks
// the user first when it is sensitive (sensitive.go).

const (
	// emain's operations for the input tools: fixed functions in MoltenTerm's isolated world.
	opInspect  = "Molten.inspect"
	opSetField = "Molten.setField"

	maxTypedRunes  = 10000
	typeChunkRunes = 100
	maxScrollTicks = 10
	defaultTicks   = 3
	scrollTickPx   = 100
	maxKeyRepeat   = 100
	dragSteps      = 10
	dragStepPause  = 8 * time.Millisecond
	minViewportPx  = 100
	maxViewportPx  = 4096
	maxBatchItems  = 50
	inputTimeout   = 20 * time.Second
	// A click on a link or a submit control may start a download a moment later: the call waits that long for it, so
	// the user's Deny fails this call.
	downloadSettle = 250 * time.Millisecond
	downloadPoll   = 25 * time.Millisecond

	buttonLeft   = "left"
	buttonRight  = "right"
	buttonNone   = "none"
	buttonsLeft  = 1
	buttonsRight = 2
)

type inputArgs struct {
	Action          string    `json:"action"`
	Coordinate      []float64 `json:"coordinate"`
	StartCoordinate []float64 `json:"start_coordinate"`
	Ref             string    `json:"ref"`
	Modifiers       string    `json:"modifiers"`
	Text            *string   `json:"text"`
	Repeat          *float64  `json:"repeat"`
	ScrollDirection string    `json:"scroll_direction"`
	ScrollAmount    *float64  `json:"scroll_amount"`
}

// inputPlan is a validated input action.
type inputPlan struct {
	action    string
	ref       string
	point     *point
	start     *point
	modifiers int
	text      string
	chords    []keyChord
	repeat    int
	dx, dy    float64
}

type point struct {
	x float64
	y float64
}

var inputActions = map[string]bool{
	mcpbrowser.ActionLeftClick: true, mcpbrowser.ActionRightClick: true, mcpbrowser.ActionDoubleClick: true,
	mcpbrowser.ActionTripleClick: true, mcpbrowser.ActionHover: true, mcpbrowser.ActionScroll: true,
	mcpbrowser.ActionScrollTo: true, mcpbrowser.ActionKey: true, mcpbrowser.ActionType: true, mcpbrowser.ActionLeftDrag: true,
}

func isInputAction(action string) bool {
	return inputActions[action]
}

func finitePoint(v []float64) (*point, bool) {
	if len(v) != 2 || math.IsNaN(v[0]) || math.IsNaN(v[1]) || math.IsInf(v[0], 0) || math.IsInf(v[1], 0) {
		return nil, false
	}
	return &point{x: v[0], y: v[1]}, true
}

// wholeInRange reads an optional count: def when absent, ok false when it is not a whole number in [lo, hi].
func wholeInRange(v *float64, def int, lo int, hi int) (int, bool) {
	if v == nil {
		return def, true
	}
	if math.IsNaN(*v) || *v != math.Trunc(*v) || *v < float64(lo) || *v > float64(hi) {
		return 0, false
	}
	return int(*v), true
}

// planInput checks an input action's arguments (FR-BRW-010's validation rules) before anything touches the tab.
func planInput(a inputArgs, macCommands bool) (inputPlan, string) {
	plan := inputPlan{action: strings.TrimSpace(a.Action), ref: strings.TrimSpace(a.Ref)}
	mods, ok := parseModifiers(a.Modifiers)
	if !ok {
		return plan, mcpbrowser.ErrModifiers
	}
	plan.modifiers = mods
	if a.Coordinate != nil {
		pt, ok := finitePoint(a.Coordinate)
		if !ok {
			return plan, mcpbrowser.ErrCoordinateOutside
		}
		plan.point = pt
	}
	switch plan.action {
	case mcpbrowser.ActionLeftClick, mcpbrowser.ActionRightClick, mcpbrowser.ActionDoubleClick, mcpbrowser.ActionTripleClick,
		mcpbrowser.ActionHover:
		if plan.point == nil && plan.ref == "" {
			return plan, mcpbrowser.ErrTargetRequired
		}
	case mcpbrowser.ActionScrollTo:
		if plan.ref == "" {
			return plan, mcpbrowser.ErrRefRequired
		}
	case mcpbrowser.ActionScroll:
		ticks, ok := wholeInRange(a.ScrollAmount, defaultTicks, 1, maxScrollTicks)
		if !ok {
			return plan, mcpbrowser.ErrScrollAmount
		}
		delta := float64(ticks * scrollTickPx)
		switch strings.ToLower(strings.TrimSpace(a.ScrollDirection)) {
		case "up":
			plan.dy = -delta
		case "down":
			plan.dy = delta
		case "left":
			plan.dx = -delta
		case "right":
			plan.dx = delta
		default:
			return plan, mcpbrowser.ErrScrollDirection
		}
	case mcpbrowser.ActionType:
		if a.Text == nil || *a.Text == "" {
			return plan, mcpbrowser.ErrTextRequired
		}
		if len([]rune(*a.Text)) > maxTypedRunes {
			return plan, mcpbrowser.ErrTextTooLong
		}
		plan.text = *a.Text
	case mcpbrowser.ActionKey:
		if a.Text == nil || strings.TrimSpace(*a.Text) == "" {
			return plan, mcpbrowser.ErrTextRequired
		}
		if len([]rune(*a.Text)) > maxTypedRunes {
			return plan, mcpbrowser.ErrTextTooLong
		}
		repeat, ok := wholeInRange(a.Repeat, 1, 1, maxKeyRepeat)
		if !ok {
			return plan, mcpbrowser.ErrRepeat
		}
		chords, ok := parseKeys(*a.Text, macCommands)
		if !ok {
			return plan, mcpbrowser.ErrUnknownKey
		}
		if len(chords)*repeat > maxKeyPresses {
			return plan, mcpbrowser.ErrTooManyKeys
		}
		plan.chords = chords
		plan.repeat = repeat
	case mcpbrowser.ActionLeftDrag:
		start, ok := finitePoint(a.StartCoordinate)
		if !ok || plan.point == nil {
			return plan, mcpbrowser.ErrStartRequired
		}
		plan.start = start
	default:
		return plan, mcpbrowser.ErrActionRequired
	}
	return plan, ""
}

func (m *Manager) inputAction(ctx context.Context, s sessionInfo, loc BlockLocation, args json.RawMessage) (mcpbrowser.CallResult, callLog) {
	tabId, _ := parseTabId(args)
	var parsed inputArgs
	if json.Unmarshal(args, &parsed) != nil {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrCoordinateOutside), callLog{tabId: tabId}
	}
	plan, errText := planInput(parsed, runtime.GOOS == "darwin")
	if errText != "" {
		return mcpbrowser.ErrorResult(errText), callLog{tabId: tabId}
	}
	return m.onPageMode(ctx, s, loc, args, "", mcpbrowser.ErrInputFailed, true, func(ctx context.Context, p pageContext) (mcpbrowser.CallResult, error) {
		inputCtx, cancel := context.WithTimeout(ctx, inputTimeout+m.permissionTimeout)
		defer cancel()
		return m.runInput(inputCtx, s, p, plan)
	})
}

// viewportSize is the page's layout viewport in CSS pixels (the emulated one after resize).
func (m *Manager) viewportSize(ctx context.Context, key TabKey) (float64, float64, error) {
	var metrics layoutMetrics
	if err := m.cdp(ctx, key, "Page.getLayoutMetrics", map[string]any{}, &metrics); err != nil {
		return 0, 0, err
	}
	return metrics.CssLayoutViewport.ClientWidth, metrics.CssLayoutViewport.ClientHeight, nil
}

func inViewport(pt point, width float64, height float64) bool {
	return pt.x >= 0 && pt.y >= 0 && pt.x < width && pt.y < height
}

// inspect asks emain what an element is (Molten.inspect). An element emain could not describe counts as one
// MoltenTerm cannot check, so typing there asks.
func (m *Manager) inspect(ctx context.Context, key TabKey, params map[string]any) targetInfo {
	var info targetInfo
	if err := m.cdp(ctx, key, opInspect, params, &info); err != nil {
		return unknownTarget
	}
	return info
}

type boxModel struct {
	Model struct {
		Content []float64 `json:"content"`
	} `json:"model"`
}

// refTarget scrolls a ref's element into view and returns its node, centre and box, in the viewport's CSS pixels.
func (m *Manager) refTarget(ctx context.Context, s sessionInfo, p pageContext, ref string) (int64, point, *rectValue, error) {
	backendId, err := m.resolveRef(ctx, s.id, p.tabId, p.key, ref)
	if err != nil {
		return 0, point{}, nil, err
	}
	if err := m.cdp(ctx, p.key, "DOM.scrollIntoViewIfNeeded", map[string]any{"backendNodeId": backendId}, nil); err != nil {
		if ctx.Err() != nil {
			return 0, point{}, nil, ctx.Err()
		}
		return 0, point{}, nil, refusal(mcpbrowser.ErrElementGone)
	}
	var box boxModel
	if err := m.cdp(ctx, p.key, "DOM.getBoxModel", map[string]any{"backendNodeId": backendId}, &box); err != nil || len(box.Model.Content) != 8 {
		if ctx.Err() != nil {
			return 0, point{}, nil, ctx.Err()
		}
		return 0, point{}, nil, refusal(mcpbrowser.ErrElementGone)
	}
	q := box.Model.Content
	minX, maxX := math.Min(math.Min(q[0], q[2]), math.Min(q[4], q[6])), math.Max(math.Max(q[0], q[2]), math.Max(q[4], q[6]))
	minY, maxY := math.Min(math.Min(q[1], q[3]), math.Min(q[5], q[7])), math.Max(math.Max(q[1], q[3]), math.Max(q[5], q[7]))
	rect := &rectValue{X: minX, Y: minY, Width: maxX - minX, Height: maxY - minY}
	return backendId, point{x: (minX + maxX) / 2, y: (minY + maxY) / 2}, rect, nil
}

// pointTarget resolves where a click, hover or scroll lands: the ref's element, or the coordinate, which must be
// inside the viewport. It also describes the element there.
func (m *Manager) pointTarget(ctx context.Context, s sessionInfo, p pageContext, plan inputPlan) (point, targetInfo, *ActionCue, error) {
	if plan.ref != "" {
		backendId, pt, rect, err := m.refTarget(ctx, s, p, plan.ref)
		if err != nil {
			return point{}, targetInfo{}, nil, err
		}
		width, height, err := m.viewportSize(ctx, p.key)
		if err != nil {
			return point{}, targetInfo{}, nil, err
		}
		if !inViewport(pt, width, height) {
			return point{}, targetInfo{}, nil, refusal(mcpbrowser.ErrRefOutside)
		}
		info := m.inspect(ctx, p.key, map[string]any{"backendnodeid": backendId})
		return pt, info, &ActionCue{Kind: "box", X: rect.X, Y: rect.Y, Width: rect.Width, Height: rect.Height}, nil
	}
	pt := *plan.point
	width, height, err := m.viewportSize(ctx, p.key)
	if err != nil {
		return point{}, targetInfo{}, nil, err
	}
	if !inViewport(pt, width, height) {
		return point{}, targetInfo{}, nil, refusal(mcpbrowser.ErrCoordinateOutside)
	}
	info := m.inspect(ctx, p.key, map[string]any{"x": pt.x, "y": pt.y})
	return pt, info, &ActionCue{Kind: "click", X: pt.x, Y: pt.y}, nil
}

// confirm asks the user for a sensitive action, then checks the page is still the one the user answered about.
func (m *Manager) confirm(ctx context.Context, s sessionInfo, p pageContext, reason string) error {
	if err := m.askAction(ctx, s, p.tabId, p.key, p.site, reason); err != nil {
		return err
	}
	page, err := m.currentPage(ctx, p.key)
	if err != nil {
		return err
	}
	if page.entryId != p.entryId || hostOf(page.url) != hostOf(p.url) {
		return refusal(mcpbrowser.ErrPageChanged)
	}
	if !m.siteAllowedNow(s.id, page.url) {
		return refusal(mcpbrowser.ErrSiteChanged)
	}
	return nil
}

func mouseParams(kind string, pt point, button string, clicks int, buttons int, mods int) map[string]any {
	return map[string]any{
		"type":       kind,
		"x":          pt.x,
		"y":          pt.y,
		"button":     button,
		"buttons":    buttons,
		"clickCount": clicks,
		"modifiers":  mods,
	}
}

func (m *Manager) mouse(ctx context.Context, key TabKey, params map[string]any) error {
	return m.cdp(ctx, key, "Input.dispatchMouseEvent", params, nil)
}

// click moves to the point and presses and releases clicks times, as a double click does (clickCount 1, then 2).
func (m *Manager) click(ctx context.Context, key TabKey, pt point, button string, clicks int, mods int) error {
	if err := m.mouse(ctx, key, mouseParams("mouseMoved", pt, buttonNone, 0, 0, mods)); err != nil {
		return err
	}
	held := buttonsLeft
	if button == buttonRight {
		held = buttonsRight
	}
	for i := 1; i <= clicks; i++ {
		if err := m.mouse(ctx, key, mouseParams("mousePressed", pt, button, i, held, mods)); err != nil {
			return err
		}
		if err := m.mouse(ctx, key, mouseParams("mouseReleased", pt, button, i, 0, mods)); err != nil {
			return err
		}
	}
	return nil
}

var clickVerbs = map[string]struct {
	verb   string
	button string
	clicks int
}{
	mcpbrowser.ActionLeftClick:   {"Clicked", buttonLeft, 1},
	mcpbrowser.ActionRightClick:  {"Right-clicked", buttonRight, 1},
	mcpbrowser.ActionDoubleClick: {"Double-clicked", buttonLeft, 2},
	mcpbrowser.ActionTripleClick: {"Triple-clicked", buttonLeft, 3},
}

func targetWords(plan inputPlan, pt point) string {
	if plan.ref != "" {
		return fmt.Sprintf("the element %s at (%d, %d)", plan.ref, int(pt.x), int(pt.y))
	}
	return fmt.Sprintf("(%d, %d)", int(pt.x), int(pt.y))
}

// runInput runs one validated input action on the allowed page p. Results hold MoltenTerm's own words only: element
// labels come from the page and go to the user's bar, never back to the agent outside the untrusted envelope.
func (m *Manager) runInput(ctx context.Context, s sessionInfo, p pageContext, plan inputPlan) (mcpbrowser.CallResult, error) {
	started := m.now()
	switch plan.action {
	case mcpbrowser.ActionLeftClick, mcpbrowser.ActionRightClick, mcpbrowser.ActionDoubleClick, mcpbrowser.ActionTripleClick:
		how := clickVerbs[plan.action]
		pt, info, cue, err := m.pointTarget(ctx, s, p, plan)
		if err != nil {
			return mcpbrowser.CallResult{}, err
		}
		if reason := clickReason(info, how.button); reason != "" {
			if err := m.confirm(ctx, s, p, reason); err != nil {
				return mcpbrowser.CallResult{}, err
			}
		}
		m.noteActionAt(s.id, p.tabId, actionLine(how.verb, info, pt.x, pt.y, true), cue)
		if err := m.click(ctx, p.key, pt, how.button, how.clicks, plan.modifiers); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		settle := time.Duration(0)
		if how.button == buttonLeft && (info.Link || info.SubmitControl) {
			settle = downloadSettle
		}
		if err := m.awaitDownload(ctx, s.id, p.tabId, started, settle); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		return mcpbrowser.TextResult(fmt.Sprintf("%s %s.", how.verb, targetWords(plan, pt))), nil
	case mcpbrowser.ActionHover:
		pt, info, cue, err := m.pointTarget(ctx, s, p, plan)
		if err != nil {
			return mcpbrowser.CallResult{}, err
		}
		m.noteActionAt(s.id, p.tabId, actionLine("Hovered over", info, pt.x, pt.y, true), cue)
		if err := m.mouse(ctx, p.key, mouseParams("mouseMoved", pt, buttonNone, 0, 0, plan.modifiers)); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		return mcpbrowser.TextResult(fmt.Sprintf("Moved the mouse to %s.", targetWords(plan, pt))), nil
	case mcpbrowser.ActionScroll:
		return m.scroll(ctx, s, p, plan)
	case mcpbrowser.ActionScrollTo:
		backendId, _, rect, err := m.refTarget(ctx, s, p, plan.ref)
		if err != nil {
			return mcpbrowser.CallResult{}, err
		}
		info := m.inspect(ctx, p.key, map[string]any{"backendnodeid": backendId})
		m.noteActionAt(s.id, p.tabId, actionLine("Scrolled to", info, 0, 0, false), &ActionCue{Kind: "box", X: rect.X, Y: rect.Y, Width: rect.Width, Height: rect.Height})
		return mcpbrowser.TextResult(fmt.Sprintf("Scrolled %s into view.", plan.ref)), nil
	case mcpbrowser.ActionType:
		return m.typeText(ctx, s, p, plan)
	case mcpbrowser.ActionKey:
		return m.pressKeys(ctx, s, p, plan, started)
	case mcpbrowser.ActionLeftDrag:
		return m.drag(ctx, s, p, plan)
	}
	return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrActionRequired)
}

func scrollWord(plan inputPlan) string {
	switch {
	case plan.dy < 0:
		return "up"
	case plan.dy > 0:
		return "down"
	case plan.dx < 0:
		return "left"
	}
	return "right"
}

func (m *Manager) scroll(ctx context.Context, s sessionInfo, p pageContext, plan inputPlan) (mcpbrowser.CallResult, error) {
	width, height, err := m.viewportSize(ctx, p.key)
	if err != nil {
		return mcpbrowser.CallResult{}, err
	}
	pt := point{x: math.Floor(width / 2), y: math.Floor(height / 2)}
	if plan.ref != "" {
		_, refPt, _, err := m.refTarget(ctx, s, p, plan.ref)
		if err != nil {
			return mcpbrowser.CallResult{}, err
		}
		pt = refPt
	} else if plan.point != nil {
		pt = *plan.point
	}
	if !inViewport(pt, width, height) {
		return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrCoordinateOutside)
	}
	m.noteActionAt(s.id, p.tabId, "Scrolled "+scrollWord(plan), &ActionCue{Kind: "click", X: pt.x, Y: pt.y})
	params := map[string]any{"type": "mouseWheel", "x": pt.x, "y": pt.y, "deltaX": plan.dx, "deltaY": plan.dy, "modifiers": plan.modifiers}
	if err := m.mouse(ctx, p.key, params); err != nil {
		return mcpbrowser.CallResult{}, err
	}
	return mcpbrowser.TextResult(fmt.Sprintf("Scrolled %s by %g CSS pixels at (%d, %d).", scrollWord(plan),
		math.Abs(plan.dx+plan.dy), int(pt.x), int(pt.y))), nil
}

func rectCue(r *rectValue) *ActionCue {
	if r == nil || r.Width <= 0 || r.Height <= 0 {
		return nil
	}
	return &ActionCue{Kind: "box", X: r.X, Y: r.Y, Width: r.Width, Height: r.Height}
}

// typeText inserts the text into the focused element, in chunks so Stop and takeover land between them.
func (m *Manager) typeText(ctx context.Context, s sessionInfo, p pageContext, plan inputPlan) (mcpbrowser.CallResult, error) {
	focused := m.inspect(ctx, p.key, map[string]any{"focused": true})
	if reason := typeReason(focused); reason != "" {
		if err := m.confirm(ctx, s, p, reason); err != nil {
			return mcpbrowser.CallResult{}, err
		}
	}
	m.noteActionAt(s.id, p.tabId, actionLine("Typing in", focused, 0, 0, false), rectCue(focused.Rect))
	runes := []rune(plan.text)
	for i := 0; i < len(runes); i += typeChunkRunes {
		if err := ctx.Err(); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		chunk := string(runes[i:min(i+typeChunkRunes, len(runes))])
		if err := m.cdp(ctx, p.key, "Input.insertText", map[string]any{"text": chunk}, nil); err != nil {
			return mcpbrowser.CallResult{}, err
		}
	}
	return mcpbrowser.TextResult(fmt.Sprintf("Typed %d characters into the focused element.", len(runes))), nil
}

func chordNames(chords []keyChord, repeat int) string {
	names := make([]string, 0, len(chords))
	for _, c := range chords {
		names = append(names, c.name)
	}
	line := strings.Join(names, " ")
	if runes := []rune(line); len(runes) > 60 {
		line = string(runes[:59]) + "…"
	}
	if repeat > 1 {
		line += fmt.Sprintf(" ×%d", repeat)
	}
	return line
}

// pressKeys sends each chord to the page, repeat times. The focused element is looked at again before every chord that
// can type or submit, since a key may move the focus; one Allow covers the rest of the call for the same reason.
func (m *Manager) pressKeys(ctx context.Context, s sessionInfo, p pageContext, plan inputPlan, started time.Time) (mcpbrowser.CallResult, error) {
	m.noteAction(s.id, p.tabId, "Pressed "+chordNames(plan.chords, plan.repeat))
	allowed := map[string]bool{}
	for r := 0; r < plan.repeat; r++ {
		for _, chord := range plan.chords {
			if err := ctx.Err(); err != nil {
				return mcpbrowser.CallResult{}, err
			}
			if keyNeedsInspection(chord) {
				focused := m.inspect(ctx, p.key, map[string]any{"focused": true})
				if reason := keyReason(focused, chord); reason != "" && !allowed[reason] {
					if err := m.confirm(ctx, s, p, reason); err != nil {
						return mcpbrowser.CallResult{}, err
					}
					allowed[reason] = true
				}
			}
			for _, event := range chord.keyEvents() {
				if err := m.cdp(ctx, p.key, "Input.dispatchKeyEvent", event, nil); err != nil {
					return mcpbrowser.CallResult{}, err
				}
			}
		}
	}
	if err := m.awaitDownload(ctx, s.id, p.tabId, started, 0); err != nil {
		return mcpbrowser.CallResult{}, err
	}
	return mcpbrowser.TextResult(fmt.Sprintf("Pressed %s.", chordNames(plan.chords, plan.repeat))), nil
}

// drag presses at the start, moves in steps with the button held, and releases at the end; Stop lands between steps.
func (m *Manager) drag(ctx context.Context, s sessionInfo, p pageContext, plan inputPlan) (mcpbrowser.CallResult, error) {
	width, height, err := m.viewportSize(ctx, p.key)
	if err != nil {
		return mcpbrowser.CallResult{}, err
	}
	from, to := *plan.start, *plan.point
	if !inViewport(from, width, height) || !inViewport(to, width, height) {
		return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrCoordinateOutside)
	}
	m.noteActionAt(s.id, p.tabId, fmt.Sprintf("Dragged from (%d, %d) to (%d, %d)", int(from.x), int(from.y), int(to.x), int(to.y)),
		&ActionCue{Kind: "click", X: to.x, Y: to.y})
	if err := m.mouse(ctx, p.key, mouseParams("mouseMoved", from, buttonNone, 0, 0, plan.modifiers)); err != nil {
		return mcpbrowser.CallResult{}, err
	}
	if err := m.mouse(ctx, p.key, mouseParams("mousePressed", from, buttonLeft, 1, buttonsLeft, plan.modifiers)); err != nil {
		return mcpbrowser.CallResult{}, err
	}
	for i := 1; i <= dragSteps; i++ {
		step := point{x: from.x + (to.x-from.x)*float64(i)/dragSteps, y: from.y + (to.y-from.y)*float64(i)/dragSteps}
		if err := m.mouse(ctx, p.key, mouseParams("mouseMoved", step, buttonLeft, 0, buttonsLeft, plan.modifiers)); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		select {
		case <-ctx.Done():
			return mcpbrowser.CallResult{}, ctx.Err()
		case <-time.After(dragStepPause):
		}
	}
	if err := m.mouse(ctx, p.key, mouseParams("mouseReleased", to, buttonLeft, 1, 0, plan.modifiers)); err != nil {
		return mcpbrowser.CallResult{}, err
	}
	return mcpbrowser.TextResult(fmt.Sprintf("Dragged from (%d, %d) to (%d, %d).", int(from.x), int(from.y), int(to.x), int(to.y))), nil
}

// tabDownload is the tab's download confirmation created since a call started, if any.
func (m *Manager) tabDownload(sessionId string, tabId int64, since time.Time) *permissionRequest {
	m.lock.Lock()
	defer m.lock.Unlock()
	t := m.sessions[sessionId].tabOrNil(tabId)
	if t == nil || t.download == nil || t.download.created.Before(since) {
		return nil
	}
	return t.download
}

// awaitDownload: a download the call started asks the user (AskDownload); the call waits for that answer, and the
// user's Deny fails it. settle is how long to look for one after the action.
func (m *Manager) awaitDownload(ctx context.Context, sessionId string, tabId int64, since time.Time, settle time.Duration) error {
	deadline := time.Now().Add(settle)
	for {
		if req := m.tabDownload(sessionId, tabId, since); req != nil {
			return m.waitAction(ctx, req)
		}
		if !time.Now().Before(deadline) {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(downloadPoll):
		}
	}
}

type formInputArgs struct {
	Ref   string          `json:"ref"`
	Value json.RawMessage `json:"value"`
}

type setFieldResult struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error"`
}

// formValue accepts what Claude in Chrome's form_input takes: a string, a number or a boolean.
func formValue(raw json.RawMessage) (any, bool) {
	var v any
	if len(raw) == 0 || json.Unmarshal(raw, &v) != nil {
		return nil, false
	}
	switch v.(type) {
	case string, bool, float64:
		return v, true
	}
	return nil, false
}

func (m *Manager) formInput(ctx context.Context, s sessionInfo, loc BlockLocation, args json.RawMessage) (mcpbrowser.CallResult, callLog) {
	tabId, _ := parseTabId(args)
	var parsed formInputArgs
	json.Unmarshal(args, &parsed)
	ref := strings.TrimSpace(parsed.Ref)
	if ref == "" {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrRefRequired), callLog{tabId: tabId}
	}
	value, ok := formValue(parsed.Value)
	if !ok {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrValueRequired), callLog{tabId: tabId}
	}
	return m.onPageMode(ctx, s, loc, args, "", mcpbrowser.ErrInputFailed, true, func(ctx context.Context, p pageContext) (mcpbrowser.CallResult, error) {
		inputCtx, cancel := context.WithTimeout(ctx, inputTimeout+m.permissionTimeout)
		defer cancel()
		backendId, err := m.resolveRef(inputCtx, s.id, p.tabId, p.key, ref)
		if err != nil {
			return mcpbrowser.CallResult{}, err
		}
		info := m.inspect(inputCtx, p.key, map[string]any{"backendnodeid": backendId})
		if !info.Found {
			return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrElementGone)
		}
		if info.FileInput {
			return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrFileInput)
		}
		if info.Sensitive {
			if err := m.confirm(inputCtx, s, p, reasonSensitiveFill); err != nil {
				return mcpbrowser.CallResult{}, err
			}
		}
		m.noteActionAt(s.id, p.tabId, actionLine("Set", info, 0, 0, false), rectCue(info.Rect))
		var out setFieldResult
		if err := m.cdp(inputCtx, p.key, opSetField, map[string]any{"backendnodeid": backendId, "value": value}, &out); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		if !out.Ok {
			switch out.Error {
			case "unsupported":
				return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrFieldUnsupported)
			case "option":
				return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrOptionNotFound)
			case "file":
				return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrFileInput)
			case "gone":
				return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrElementGone)
			}
			return mcpbrowser.CallResult{}, refusal(mcpbrowser.ErrInputFailed)
		}
		return mcpbrowser.TextResult(fmt.Sprintf("Set the field %s; the page got its input and change events.", ref)), nil
	})
}

type resizeArgs struct {
	Width  *float64 `json:"width"`
	Height *float64 `json:"height"`
}

func viewportBound(v *float64) (int, bool) {
	if v == nil || math.IsNaN(*v) || math.IsInf(*v, 0) {
		return 0, false
	}
	n := int(math.Round(*v))
	return n, n >= minViewportPx && n <= maxViewportPx
}

// resize emulates a viewport size inside the panel (DS-BRW-016); emain clears it when control ends.
func (m *Manager) resize(ctx context.Context, s sessionInfo, loc BlockLocation, args json.RawMessage) (mcpbrowser.CallResult, callLog) {
	tabId, _ := parseTabId(args)
	var parsed resizeArgs
	json.Unmarshal(args, &parsed)
	width, okW := viewportBound(parsed.Width)
	height, okH := viewportBound(parsed.Height)
	if !okW || !okH {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrResizeBounds), callLog{tabId: tabId}
	}
	return m.onPageMode(ctx, s, loc, args, "", mcpbrowser.ErrInputFailed, true, func(ctx context.Context, p pageContext) (mcpbrowser.CallResult, error) {
		params := map[string]any{"width": width, "height": height, "deviceScaleFactor": 0, "mobile": false}
		if err := m.cdp(ctx, p.key, "Emulation.setDeviceMetricsOverride", params, nil); err != nil {
			return mcpbrowser.CallResult{}, err
		}
		m.setViewport(s.id, p.tabId, &Viewport{Width: width, Height: height})
		m.noteAction(s.id, p.tabId, fmt.Sprintf("Resized the page to %d×%d", width, height))
		return mcpbrowser.TextResult(fmt.Sprintf("The page's viewport is now %d×%d CSS pixels, emulated inside the panel "+
			"until your control of the tab ends.", width, height)), nil
	})
}

type batchItem struct {
	Name  string          `json:"name"`
	Input json.RawMessage `json:"input"`
}

// batch runs its items in order, each through its own tool with its own checks, and stops at the first error with the
// results so far (FR-BRW-010 AC4).
func (m *Manager) batch(ctx context.Context, s sessionInfo, loc BlockLocation, args json.RawMessage) (mcpbrowser.CallResult, callLog) {
	var parsed struct {
		Actions []batchItem `json:"actions"`
	}
	if json.Unmarshal(args, &parsed) != nil || len(parsed.Actions) == 0 || len(parsed.Actions) > maxBatchItems {
		return mcpbrowser.ErrorResult(mcpbrowser.ErrBatchActions), callLog{}
	}
	var content []mcpbrowser.ContentItem
	var entry callLog
	for i, item := range parsed.Actions {
		name := strings.TrimSpace(item.Name)
		var result mcpbrowser.CallResult
		switch {
		case ctx.Err() != nil:
			result = mcpbrowser.ErrorResult(mcpbrowser.ErrSessionEnded)
		case name == mcpbrowser.ToolBatch:
			result = mcpbrowser.ErrorResult(mcpbrowser.ErrBatchNested)
		case !mcpbrowser.ToolNames()[name]:
			result = mcpbrowser.ErrorResult(mcpbrowser.ErrUnknownTool)
		default:
			input := item.Input
			if len(input) == 0 || string(input) == "null" {
				input = json.RawMessage(`{}`)
			}
			var itemEntry callLog
			result, itemEntry = m.dispatch(ctx, s, loc, name, input)
			if itemEntry.tabId > 0 {
				entry = itemEntry
			}
		}
		toolName := name
		if !mcpbrowser.ToolNames()[toolName] {
			toolName = "unknown tool"
		}
		if result.IsError {
			reason := ""
			if len(result.Content) > 0 {
				reason = result.Content[0].Text
			}
			content = append(content, mcpbrowser.ContentItem{Type: mcpbrowser.ContentText,
				Text: fmt.Sprintf("Item %d (%s) failed: %s\nThe batch stopped there; items after it did not run.", i+1, toolName, reason)})
			return mcpbrowser.CallResult{Content: content, IsError: true}, entry
		}
		content = append(content, mcpbrowser.ContentItem{Type: mcpbrowser.ContentText, Text: fmt.Sprintf("Item %d (%s):", i+1, toolName)})
		content = append(content, result.Content...)
	}
	return mcpbrowser.CallResult{Content: content}, entry
}
