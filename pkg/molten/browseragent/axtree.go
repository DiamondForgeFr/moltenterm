// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package browseragent

import (
	"fmt"
	"sort"
	"strconv"
	"strings"
	"unicode"
)

// The accessibility tree behind read_page and find (DS-BRW-014): DevTools' Accessibility.getFullAXTree, flattened to
// one line per element with refs the later tools resolve. Pure functions over the decoded tree, so they are tested
// without a browser.

const (
	defaultReadDepth = 15
	maxReadDepth     = 100
	defaultMaxChars  = 50000
	maxMaxChars      = 500000
	maxNameRunes     = 200
	maxValueRunes    = 200
	maxFindResults   = 20
	// Beyond this, refs of a document start over: a page read again and again cannot grow the table forever.
	maxRefsPerDocument = 50000

	maskedValue = "••••"
	refPrefix   = "ref_"
)

// The roles read_page's interactive filter keeps.
var interactiveRoles = map[string]bool{
	"link": true, "button": true, "textbox": true, "checkbox": true, "radio": true, "combobox": true, "menuitem": true,
	"tab": true, "switch": true, "slider": true, "searchbox": true, "option": true, "spinbutton": true, "listbox": true,
	"menuitemcheckbox": true, "menuitemradio": true, "treeitem": true,
}

// Fields whose value the agent may see is checked against the DOM: these roles hold typed text.
var editableRoles = map[string]bool{"textbox": true, "searchbox": true, "combobox": true, "spinbutton": true}

// Wrappers with no name of their own: their children are listed in their place.
var transparentRoles = map[string]bool{
	"generic": true, "none": true, "presentation": true, "LineBreak": true, "InlineTextBox": true, "LayoutTable": true,
	"LayoutTableRow": true, "LayoutTableCell": true,
}

type axValue struct {
	Type  string `json:"type"`
	Value any    `json:"value"`
}

type axProperty struct {
	Name  string  `json:"name"`
	Value axValue `json:"value"`
}

type axNode struct {
	NodeId           string       `json:"nodeId"`
	Ignored          bool         `json:"ignored"`
	Role             *axValue     `json:"role"`
	Name             *axValue     `json:"name"`
	Description      *axValue     `json:"description"`
	Value            *axValue     `json:"value"`
	Properties       []axProperty `json:"properties"`
	ChildIds         []string     `json:"childIds"`
	ParentId         string       `json:"parentId"`
	BackendDOMNodeId int64        `json:"backendDOMNodeId"`
}

type axTree struct {
	Nodes []axNode `json:"nodes"`
}

// fieldInfo is what the DOM says of an editable element: whether its value is a secret, and its placeholder.
type fieldInfo struct {
	sensitive   bool
	placeholder string
}

// axDoc is a decoded tree with its document id (the root's DOM node) and the fields checked against the DOM.
type axDoc struct {
	byId   map[string]*axNode
	order  []string
	root   *axNode
	docId  int64
	fields map[int64]fieldInfo
}

func makeAxDoc(tree axTree) *axDoc {
	doc := &axDoc{byId: make(map[string]*axNode, len(tree.Nodes)), fields: map[int64]fieldInfo{}}
	for i := range tree.Nodes {
		n := &tree.Nodes[i]
		if n.NodeId == "" {
			continue
		}
		doc.byId[n.NodeId] = n
		doc.order = append(doc.order, n.NodeId)
	}
	for _, id := range doc.order {
		n := doc.byId[id]
		if n.ParentId == "" || doc.byId[n.ParentId] == nil {
			doc.root = n
			break
		}
	}
	if doc.root != nil {
		doc.docId = doc.root.BackendDOMNodeId
	}
	return doc
}

func axString(v *axValue) string {
	if v == nil || v.Value == nil {
		return ""
	}
	switch val := v.Value.(type) {
	case string:
		return val
	case float64:
		return strconv.FormatFloat(val, 'f', -1, 64)
	case bool:
		return strconv.FormatBool(val)
	}
	return ""
}

func (n *axNode) role() string {
	return axString(n.Role)
}

func (n *axNode) property(name string) string {
	for _, p := range n.Properties {
		if p.Name == name {
			return axString(&p.Value)
		}
	}
	return ""
}

// oneLine keeps page text on its line: a page cannot start a fake line of the tree with a newline in a name.
func oneLine(text string, max int) string {
	var b strings.Builder
	space := false
	count := 0
	for _, r := range text {
		if unicode.IsSpace(r) || unicode.IsControl(r) {
			space = b.Len() > 0
			continue
		}
		if space {
			b.WriteRune(' ')
			count++
			space = false
		}
		if count >= max {
			b.WriteString("…")
			break
		}
		b.WriteRune(r)
		count++
	}
	return b.String()
}

func quoted(text string) string {
	return `"` + strings.ReplaceAll(text, `"`, `'`) + `"`
}

// editableNodes are the elements whose DOM must be checked before their value is shown.
func (d *axDoc) editableNodes() []int64 {
	var rtn []int64
	for _, id := range d.order {
		n := d.byId[id]
		if n.Ignored || n.BackendDOMNodeId == 0 {
			continue
		}
		if editableRoles[n.role()] || n.property("editable") != "" {
			rtn = append(rtn, n.BackendDOMNodeId)
		}
	}
	return rtn
}

// valueOf is the value to show: a field the DOM did not clear (a password, a card number, one whose check failed)
// reads •••• (NFR-BRW-006).
func (d *axDoc) valueOf(n *axNode) string {
	value := axString(n.Value)
	if value == "" {
		return ""
	}
	if editableRoles[n.role()] || n.property("editable") != "" {
		info, checked := d.fields[n.BackendDOMNodeId]
		if !checked || info.sensitive {
			return maskedValue
		}
	}
	return oneLine(value, maxValueRunes)
}

// isSensitiveField: password fields, card fields and one-time codes (DS-BRW-014), from the element's attributes.
func isSensitiveField(nodeName string, attrs map[string]string) bool {
	if strings.EqualFold(nodeName, "input") && strings.EqualFold(strings.TrimSpace(attrs["type"]), "password") {
		return true
	}
	for _, token := range strings.Fields(strings.ToLower(attrs["autocomplete"])) {
		if strings.HasPrefix(token, "cc-") || token == "current-password" || token == "new-password" || token == "one-time-code" {
			return true
		}
	}
	return false
}

// attrMap reads DOM.describeNode's flat attribute list.
func attrMap(flat []string) map[string]string {
	rtn := make(map[string]string, len(flat)/2)
	for i := 0; i+1 < len(flat); i += 2 {
		rtn[strings.ToLower(flat[i])] = flat[i+1]
	}
	return rtn
}

type treeLine struct {
	depth     int
	backendId int64
	text      string
}

type readOptions struct {
	interactive bool
	depth       int
	fromNode    *axNode
}

// lines flattens the tree under the start node: ignored and unnamed wrapper nodes give their place to their children,
// text that only repeats its parent's name is left out, and depth counts the lines' own levels.
func (d *axDoc) lines(opts readOptions) []treeLine {
	start := opts.fromNode
	if start == nil {
		start = d.root
	}
	if start == nil {
		return nil
	}
	var rtn []treeLine
	seen := make(map[string]bool)
	var walk func(n *axNode, depth int, parentName string)
	walk = func(n *axNode, depth int, parentName string) {
		if n == nil || seen[n.NodeId] || depth > opts.depth {
			return
		}
		seen[n.NodeId] = true
		role := n.role()
		name := oneLine(axString(n.Name), maxNameRunes)
		shown := !n.Ignored && !(transparentRoles[role] && name == "")
		if role == "StaticText" && (name == "" || strings.Contains(parentName, name)) {
			shown = false
		}
		if role == "RootWebArea" && n == d.root && n != opts.fromNode {
			shown = false
		}
		if opts.interactive && !interactiveRoles[role] {
			shown = false
		}
		childDepth := depth
		childParent := parentName
		if shown {
			rtn = append(rtn, treeLine{depth: depth, backendId: n.BackendDOMNodeId, text: d.describe(n, name)})
			if !opts.interactive {
				childDepth = depth + 1
			}
			childParent = name
		} else if !n.Ignored && name != "" {
			childParent = name
		}
		for _, childId := range n.ChildIds {
			walk(d.byId[childId], childDepth, childParent)
		}
	}
	walk(start, 0, "")
	return rtn
}

// describe is one element's line, without its ref: role "name" value="…" and the states an agent acts on.
func (d *axDoc) describe(n *axNode, name string) string {
	role := n.role()
	if role == "StaticText" {
		role = "text"
	}
	var b strings.Builder
	b.WriteString(role)
	if name != "" {
		b.WriteString(" ")
		b.WriteString(quoted(name))
	}
	if value := d.valueOf(n); value != "" {
		b.WriteString(" value=")
		b.WriteString(quoted(value))
	}
	if placeholder := d.fields[n.BackendDOMNodeId].placeholder; placeholder != "" && axString(n.Value) == "" {
		b.WriteString(" placeholder=")
		b.WriteString(quoted(oneLine(placeholder, maxNameRunes)))
	}
	for _, state := range []string{"checked", "selected", "expanded", "pressed", "disabled", "required"} {
		value := n.property(state)
		if value == "" || value == "false" {
			continue
		}
		if value == "true" {
			b.WriteString(" " + state)
		} else {
			b.WriteString(" " + state + "=" + oneLine(value, 20))
		}
	}
	if level := n.property("level"); level != "" && role == "heading" {
		b.WriteString(" level=" + oneLine(level, 4))
	}
	if href := n.property("url"); href != "" && role == "link" {
		b.WriteString(" href=" + quoted(oneLine(href, maxValueRunes)))
	}
	return b.String()
}

// nodeForBackend finds the tree node of a DOM node (a ref's target).
func (d *axDoc) nodeForBackend(backendId int64) *axNode {
	for _, id := range d.order {
		n := d.byId[id]
		if n.BackendDOMNodeId == backendId && !n.Ignored {
			return n
		}
	}
	for _, id := range d.order {
		if n := d.byId[id]; n.BackendDOMNodeId == backendId {
			return n
		}
	}
	return nil
}

// renderLines joins lines with their refs, cut at a line boundary at maxChars, with a note giving the full size.
func renderLines(lines []treeLine, refOf func(int64) string, maxChars int) (string, bool) {
	full := make([]string, len(lines))
	total := 0
	for i, l := range lines {
		text := strings.Repeat("  ", l.depth) + l.text
		if ref := refOf(l.backendId); ref != "" {
			text += " [" + ref + "]"
		}
		full[i] = text
		total += len(text) + 1
	}
	var b strings.Builder
	for _, line := range full {
		if b.Len()+len(line)+1 > maxChars {
			fmt.Fprintf(&b, "[Cut at %d of %d characters: pass a larger max_chars, or use depth or ref_id to read part of the page.]", b.Len(), total)
			return b.String(), true
		}
		b.WriteString(line)
		b.WriteString("\n")
	}
	return strings.TrimSuffix(b.String(), "\n"), false
}

// refTable maps refs to the DOM nodes of one document; it starts over when the tab shows another document.
type refTable struct {
	docId  int64
	next   int
	byRef  map[string]int64
	byNode map[int64]string
}

func makeRefTable(docId int64) *refTable {
	return &refTable{docId: docId, byRef: map[string]int64{}, byNode: map[int64]string{}}
}

func (r *refTable) refFor(backendId int64) string {
	if backendId == 0 {
		return ""
	}
	if ref, ok := r.byNode[backendId]; ok {
		return ref
	}
	r.next++
	ref := refPrefix + strconv.Itoa(r.next)
	r.byNode[backendId] = ref
	r.byRef[ref] = backendId
	return ref
}

// Words of a find query that say nothing about the element.
var findStopwords = map[string]bool{
	"the": true, "a": true, "an": true, "of": true, "to": true, "on": true, "in": true, "for": true, "with": true,
	"that": true, "this": true, "and": true, "or": true, "containing": true, "contains": true, "named": true,
	"called": true, "labeled": true, "labelled": true, "element": true, "page": true, "my": true, "at": true, "is": true,
	"which": true, "it": true, "its": true, "from": true, "by": true, "please": true,
}

// Words of a find query that name a role.
var findRoleWords = map[string][]string{
	"button":    {"button"},
	"buttons":   {"button"},
	"link":      {"link"},
	"links":     {"link"},
	"checkbox":  {"checkbox", "switch", "menuitemcheckbox"},
	"check":     {"checkbox"},
	"radio":     {"radio", "menuitemradio"},
	"tab":       {"tab"},
	"tabs":      {"tab", "tablist"},
	"menu":      {"menu", "menubar", "menuitem"},
	"heading":   {"heading"},
	"title":     {"heading"},
	"header":    {"heading", "banner"},
	"image":     {"image", "img"},
	"icon":      {"image", "img"},
	"logo":      {"image", "img", "link"},
	"picture":   {"image", "img"},
	"input":     {"textbox", "searchbox", "combobox", "spinbutton"},
	"field":     {"textbox", "searchbox", "combobox", "spinbutton"},
	"textbox":   {"textbox", "searchbox"},
	"textarea":  {"textbox"},
	"box":       {"textbox", "searchbox", "combobox", "checkbox"},
	"bar":       {"searchbox", "textbox", "toolbar", "navigation", "progressbar"},
	"dropdown":  {"combobox", "listbox", "menu"},
	"select":    {"combobox", "listbox"},
	"combobox":  {"combobox"},
	"list":      {"list", "listbox"},
	"option":    {"option"},
	"switch":    {"switch"},
	"toggle":    {"switch", "checkbox", "button"},
	"slider":    {"slider"},
	"table":     {"table", "grid"},
	"row":       {"row"},
	"dialog":    {"dialog", "alertdialog"},
	"modal":     {"dialog", "alertdialog"},
	"form":      {"form"},
	"nav":       {"navigation"},
	"article":   {"article"},
	"paragraph": {"paragraph"},
}

// Phrases written several ways, folded to one token before matching, in the query and on the page.
var findPhrases = []struct{ from, to string }{
	{"sign in", "signin"}, {"sign-in", "signin"}, {"log in", "signin"}, {"log-in", "signin"}, {"login", "signin"},
	{"logon", "signin"}, {"log on", "signin"},
	{"sign up", "signup"}, {"sign-up", "signup"}, {"register", "signup"}, {"create account", "signup"},
	{"sign out", "signout"}, {"log out", "signout"}, {"logout", "signout"},
	{"e-mail", "email"}, {"e mail", "email"},
	{"searchbox", "search box"},
	{"check box", "checkbox"}, {"text box", "textbox"}, {"text field", "textbox"}, {"drop down", "dropdown"},
	{"drop-down", "dropdown"},
}

func findTokens(text string) []string {
	lower := " " + strings.ToLower(text) + " "
	for _, p := range findPhrases {
		lower = strings.ReplaceAll(lower, " "+p.from+" ", " "+p.to+" ")
	}
	words := strings.FieldsFunc(lower, func(r rune) bool { return !unicode.IsLetter(r) && !unicode.IsNumber(r) })
	// Folding again catches phrases the punctuation split ("Log-in" became "log in").
	joined := " " + strings.Join(words, " ") + " "
	for _, p := range findPhrases {
		joined = strings.ReplaceAll(joined, " "+p.from+" ", " "+p.to+" ")
	}
	return strings.Fields(joined)
}

type findQuery struct {
	words []string
	roles map[string]bool
}

func parseFindQuery(query string) findQuery {
	q := findQuery{roles: map[string]bool{}}
	for _, token := range findTokens(query) {
		if findStopwords[token] {
			continue
		}
		if roles, ok := findRoleWords[token]; ok {
			for _, r := range roles {
				q.roles[r] = true
			}
			continue
		}
		q.words = append(q.words, token)
	}
	// "search" is both the purpose of a box and a word on the page.
	for _, w := range q.words {
		if w == "search" {
			q.roles["searchbox"] = true
		}
	}
	return q
}

type findMatch struct {
	node    *axNode
	text    string
	score   int
	matched int
	order   int
}

func wordSet(text string) map[string]bool {
	rtn := map[string]bool{}
	for _, t := range findTokens(text) {
		rtn[t] = true
	}
	return rtn
}

func matchWords(words []string, text string) (int, int) {
	if text == "" {
		return 0, 0
	}
	set := wordSet(text)
	matched := 0
	prefix := 0
	for _, w := range words {
		if set[w] {
			matched++
			continue
		}
		for t := range set {
			if len(w) >= 3 && strings.HasPrefix(t, w) {
				prefix++
				break
			}
		}
	}
	return matched, prefix
}

// elementFor is the element a text node belongs to: its closest ancestor that is not text or a nameless wrapper.
func (d *axDoc) elementFor(n *axNode) *axNode {
	for p := d.byId[n.ParentId]; p != nil; p = d.byId[p.ParentId] {
		role := p.role()
		if p.Ignored || role == "StaticText" || role == "InlineTextBox" {
			continue
		}
		if transparentRoles[role] && axString(p.Name) == "" && p.ParentId != "" {
			continue
		}
		return p
	}
	return nil
}

// find ranks the elements of the page against a query by words (no model): accessible name first, then placeholder,
// value and description, the role words of the query, and interactive elements before the others.
func (d *axDoc) find(query string) []findMatch {
	q := parseFindQuery(query)
	if len(q.words) == 0 && len(q.roles) == 0 {
		return nil
	}
	best := map[*axNode]*findMatch{}
	for i, id := range d.order {
		n := d.byId[id]
		if n.Ignored || n == d.root || n.BackendDOMNodeId == 0 {
			continue
		}
		role := n.role()
		if role == "InlineTextBox" {
			continue
		}
		target := n
		text := ""
		if role == "StaticText" {
			target = d.elementFor(n)
			if target == nil || target == d.root {
				continue
			}
			text = oneLine(axString(n.Name), maxNameRunes)
		}
		targetRole := target.role()
		name := axString(target.Name)
		score := 0
		matched := 0
		if len(q.words) > 0 {
			nameHits, namePrefix := matchWords(q.words, name)
			textHits, textPrefix := matchWords(q.words, text)
			placeholderHits, _ := matchWords(q.words, d.fields[target.BackendDOMNodeId].placeholder)
			valueHits := 0
			if value := d.valueOf(target); value != maskedValue {
				valueHits, _ = matchWords(q.words, value)
			}
			descHits, _ := matchWords(q.words, axString(target.Description))
			matched = max(nameHits, textHits, placeholderHits, valueHits, descHits)
			score = 4*nameHits + 2*namePrefix + 3*textHits + textPrefix + 3*placeholderHits + valueHits + descHits
			if nameHits == len(q.words) && len(wordSet(name)) == len(q.words) {
				score += 3
			}
			if matched == 0 && namePrefix+textPrefix == 0 {
				continue
			}
			if 2*max(matched, min(namePrefix+textPrefix, len(q.words))) < len(q.words) {
				continue
			}
		}
		if len(q.roles) > 0 {
			if q.roles[targetRole] {
				score += 3
			} else if len(q.words) == 0 {
				continue
			}
		}
		if interactiveRoles[targetRole] {
			score++
		}
		if transparentRoles[targetRole] && name == "" {
			score--
		}
		if prev, ok := best[target]; ok {
			if score > prev.score {
				prev.score = score
				prev.matched = matched
				prev.text = text
			}
			continue
		}
		best[target] = &findMatch{node: target, text: text, score: score, matched: matched, order: i}
	}
	rtn := make([]findMatch, 0, len(best))
	for _, m := range best {
		rtn = append(rtn, *m)
	}
	sort.Slice(rtn, func(i, j int) bool {
		if rtn[i].score != rtn[j].score {
			return rtn[i].score > rtn[j].score
		}
		return rtn[i].order < rtn[j].order
	})
	return rtn
}

// findLine is one result: the element's line, and the text that matched when it is not the element's name.
func (d *axDoc) findLine(m findMatch) string {
	line := d.describe(m.node, oneLine(axString(m.node.Name), maxNameRunes))
	if m.text != "" && !strings.Contains(axString(m.node.Name), m.text) {
		line += " text=" + quoted(m.text)
	}
	return line
}
