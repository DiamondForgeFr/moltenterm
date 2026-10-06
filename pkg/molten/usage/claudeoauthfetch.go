// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
)

// The endpoint's answer is undocumented (observed from Claude Code 2.1): `five_hour`, `seven_day` and
// `seven_day_<model>` windows {utilization 0-100, resets_at ISO-8601}, `limits` rows {kind "weekly_scoped", percent,
// resets_at, scope.model.display_name}, and `extra_usage` {is_enabled, monthly_limit, used_credits, currency} in
// minor units of the currency. Unknown keys are ignored; a missing or mistyped field drops its window only.

// seven_day_<key> windows that are not a model's.
var nonModelWeekKeys = map[string]bool{"oauth_apps": true, "cowork": true, "omelette": true, "overage_included": true}

var modelKeyPattern = regexp.MustCompile(`^[a-z0-9]+(?:_[a-z0-9]+)*$`)

var modelNamePattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9 .\-]{0,39}$`)

// Currencies without minor units; any other has two.
var zeroDecimalCurrencies = map[string]bool{
	"JPY": true, "KRW": true, "VND": true, "CLP": true, "ISK": true, "PYG": true, "UGX": true, "XAF": true, "XOF": true,
}

var currencyPattern = regexp.MustCompile(`^[A-Z]{3}$`)

var errEndpointRefused = errors.New("refused usage endpoint")

// checkEndpoint lets the token go to Anthropic's usage endpoint over https only.
func (s *ClaudeOAuthSource) checkEndpoint() (*url.URL, error) {
	u, err := url.Parse(s.endpoint)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return nil, errEndpointRefused
	}
	if !s.anyEndpoint && u.String() != ClaudeUsageEndpoint {
		return nil, errEndpointRefused
	}
	return u, nil
}

// fetch makes one call. The token goes into the request header only; every failure is a reason code, never an
// error that could carry it.
func (s *ClaudeOAuthSource) fetch(ctx context.Context) (UsageSnapshot, oauthOutcome) {
	u, err := s.checkEndpoint()
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFailed}
	}
	token, expiresAt, err := s.credentials(ctx)
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonOf(err)}
	}
	if token == "" {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonSignedOut}
	}
	// An expired token is never refreshed by MoltenTerm: Claude Code renews it the next time it runs.
	if expiresAt > 0 && expiresAt <= s.now().UnixMilli() {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonTokenExpired}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFailed}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("anthropic-beta", claudeOAuthBeta)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "MoltenTerm")
	resp, err := s.client.Do(req)
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonOffline}
	}
	defer resp.Body.Close()
	switch {
	case resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden:
		return UsageSnapshot{}, oauthOutcome{reason: ReasonDenied}
	case resp.StatusCode == http.StatusTooManyRequests:
		return UsageSnapshot{}, oauthOutcome{reason: ReasonRateLimited, rateLimited: true, retryAfter: retryAfter(resp.Header.Get("Retry-After"), s.now())}
	case resp.StatusCode != http.StatusOK:
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFailed}
	}
	if mt, _, err := mime.ParseMediaType(resp.Header.Get("Content-Type")); err != nil || mt != "application/json" {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFormat}
	}
	body, err := io.ReadAll(io.LimitReader(resp.Body, maxUsageResponseBytes+1))
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonOffline}
	}
	if len(body) > maxUsageResponseBytes {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFormat}
	}
	snap, reason := parseClaudeUsage(body)
	if reason != "" {
		return UsageSnapshot{}, oauthOutcome{reason: reason}
	}
	snap.ReadAt = s.now().UnixMilli()
	return snap, oauthOutcome{}
}

// retryAfter reads Retry-After as seconds or an HTTP date; 0 when absent or unreadable.
func retryAfter(value string, now time.Time) time.Duration {
	value = strings.TrimSpace(value)
	if value == "" {
		return 0
	}
	if secs, err := strconv.ParseInt(value, 10, 64); err == nil {
		return time.Duration(min(max(secs, 0), int64(oauthBackoffMax/time.Second))) * time.Second
	}
	if t, err := http.ParseTime(value); err == nil {
		return max(t.Sub(now), 0)
	}
	return 0
}

type usageWindowDoc struct {
	ok          bool
	usedPercent float64
	resetsAt    int64
}

func finitePercent(v float64) bool {
	return !math.IsNaN(v) && !math.IsInf(v, 0) && v >= 0 && v <= 1000
}

// parseResetsAt reads an ISO-8601 time; null or a time in another format is "not told" (0), a value that is not a
// string is a changed field.
func parseResetsAt(raw json.RawMessage) (int64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, true
	}
	var text string
	if err := json.Unmarshal(raw, &text); err != nil {
		return 0, false
	}
	t, err := time.Parse(time.RFC3339Nano, text)
	if err != nil {
		return 0, true
	}
	return t.UnixMilli(), true
}

// parseNumber reads a JSON number; null or absent is not one.
func parseNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || string(raw) == "null" {
		return 0, false
	}
	var v float64
	if err := json.Unmarshal(raw, &v); err != nil {
		return 0, false
	}
	return v, true
}

func parseObject(raw json.RawMessage) (map[string]json.RawMessage, bool) {
	trimmed := bytes.TrimSpace(raw)
	if len(trimmed) == 0 || trimmed[0] != '{' {
		return nil, false
	}
	var obj map[string]json.RawMessage
	if err := json.Unmarshal(trimmed, &obj); err != nil {
		return nil, false
	}
	return obj, true
}

// parseWindow reads {utilization, resets_at}; a null utilization is a window the plan does not have.
func parseWindow(raw json.RawMessage) usageWindowDoc {
	obj, ok := parseObject(raw)
	if !ok {
		return usageWindowDoc{}
	}
	pct, ok := parseNumber(obj["utilization"])
	if !ok || !finitePercent(pct) {
		return usageWindowDoc{}
	}
	resetsAt, ok := parseResetsAt(obj["resets_at"])
	if !ok {
		return usageWindowDoc{}
	}
	return usageWindowDoc{ok: true, usedPercent: pct, resetsAt: resetsAt}
}

func modelLabel(name string) string {
	return "This week (" + name + ")"
}

// modelDisplayName turns a key ("opus", "sonnet_4") into a name ("Opus", "Sonnet 4").
func modelDisplayName(key string) string {
	parts := strings.Split(key, "_")
	for i, p := range parts {
		if p != "" {
			parts[i] = strings.ToUpper(p[:1]) + p[1:]
		}
	}
	return strings.Join(parts, " ")
}

// modelWindowId names a model's window the same from a key ("opus_4_1") and from a display name ("Opus 4.1").
func modelWindowId(name string) string {
	id := strings.Map(func(r rune) rune {
		if r >= 'a' && r <= 'z' || r >= '0' && r <= '9' {
			return r
		}
		return '_'
	}, strings.ToLower(strings.TrimSpace(name)))
	return WindowModelPrefix + id
}

// parseClaudeUsage keeps only what the gauges show. A body that is not an object, or that has none of the windows
// this version knows, is a changed source; a known shape whose windows are all empty is a plan without limits.
func parseClaudeUsage(body []byte) (UsageSnapshot, string) {
	doc, ok := parseObject(body)
	if !ok {
		return UsageSnapshot{}, ReasonFormat
	}
	snap := UsageSnapshot{Agent: "claude", Source: ClaudeOAuthSourceId}
	seen := map[string]bool{}
	known := false
	add := func(id string, label string, w usageWindowDoc, mins int64) {
		if !w.ok || seen[id] {
			return
		}
		seen[id] = true
		snap.Windows = append(snap.Windows, UsageWindow{Id: id, Label: label, UsedPercent: w.usedPercent, ResetsAt: w.resetsAt, WindowMins: mins})
	}
	if raw, ok := doc["five_hour"]; ok {
		known = true
		add(WindowSession, "Current session", parseWindow(raw), fiveHourMins)
	}
	if raw, ok := doc["seven_day"]; ok {
		known = true
		add(WindowWeek, "This week", parseWindow(raw), sevenDayMins)
	}
	var modelKeys []string
	for k := range doc {
		if name, ok := strings.CutPrefix(k, "seven_day_"); ok && !nonModelWeekKeys[name] && modelKeyPattern.MatchString(name) && len(name) <= 32 {
			modelKeys = append(modelKeys, name)
		}
	}
	sort.Strings(modelKeys)
	for _, name := range modelKeys {
		known = true
		display := modelDisplayName(name)
		add(modelWindowId(display), modelLabel(display), parseWindow(doc["seven_day_"+name]), sevenDayMins)
	}
	if raw, ok := doc["limits"]; ok && string(bytes.TrimSpace(raw)) != "null" {
		known = true
		for _, row := range parseLimits(raw) {
			add(modelWindowId(row.name), modelLabel(row.name), row.window, sevenDayMins)
		}
	}
	if raw, ok := doc["extra_usage"]; ok {
		known = true
		snap.Credits = parseCredits(raw)
	}
	if !known {
		return UsageSnapshot{}, ReasonFormat
	}
	if len(snap.Windows) == 0 && snap.Credits == nil {
		return UsageSnapshot{}, ReasonNoPlan
	}
	return snap, ""
}

type limitRow struct {
	name   string
	window usageWindowDoc
}

// parseLimits keeps the weekly rows scoped to a model; a row of another kind or shape is skipped.
func parseLimits(raw json.RawMessage) []limitRow {
	var rows []json.RawMessage
	if err := json.Unmarshal(raw, &rows); err != nil {
		return nil
	}
	var rtn []limitRow
	for _, r := range rows {
		obj, ok := parseObject(r)
		if !ok {
			continue
		}
		var kind string
		if json.Unmarshal(obj["kind"], &kind) != nil || kind != "weekly_scoped" {
			continue
		}
		scope, ok := parseObject(obj["scope"])
		if !ok {
			continue
		}
		model, ok := parseObject(scope["model"])
		if !ok {
			continue
		}
		var name string
		if json.Unmarshal(model["display_name"], &name) != nil {
			continue
		}
		name = strings.TrimSpace(name)
		if !modelNamePattern.MatchString(name) {
			continue
		}
		pct, ok := parseNumber(obj["percent"])
		if !ok || !finitePercent(pct) {
			continue
		}
		resetsAt, ok := parseResetsAt(obj["resets_at"])
		if !ok {
			continue
		}
		rtn = append(rtn, limitRow{name: name, window: usageWindowDoc{ok: true, usedPercent: pct, resetsAt: resetsAt}})
	}
	return rtn
}

// parseCredits gives the extra usage line only while extra usage is on and has a limit, in major units.
func parseCredits(raw json.RawMessage) *UsageCredits {
	obj, ok := parseObject(raw)
	if !ok {
		return nil
	}
	var enabled bool
	if json.Unmarshal(obj["is_enabled"], &enabled) != nil || !enabled {
		return nil
	}
	limit, ok := parseNumber(obj["monthly_limit"])
	if !ok || limit <= 0 || math.IsInf(limit, 0) {
		return nil
	}
	used := 0.0
	if v, ok := parseNumber(obj["used_credits"]); ok {
		used = v
	} else if raw, has := obj["used_credits"]; has && string(raw) != "null" {
		return nil
	}
	if used < 0 || math.IsInf(used, 0) {
		return nil
	}
	currency := "USD"
	if raw, has := obj["currency"]; has && string(raw) != "null" {
		if json.Unmarshal(raw, &currency) != nil || !currencyPattern.MatchString(currency) {
			return nil
		}
	}
	divisor := 100.0
	if zeroDecimalCurrencies[currency] {
		divisor = 1
	}
	return &UsageCredits{Enabled: true, Used: used / divisor, Limit: limit / divisor, Unit: currency}
}
