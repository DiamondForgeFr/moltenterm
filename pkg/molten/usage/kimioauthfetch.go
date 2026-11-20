// Copyright 2026, DiamondForge
// SPDX-License-Identifier: AGPL-3.0-only

package usage

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"math"
	"mime"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

func (s *KimiOAuthSource) checkEndpoint(endpoint ...string) (*url.URL, error) {
	candidate := s.endpoint
	if len(endpoint) > 0 {
		candidate = endpoint[0]
	}
	u, err := url.Parse(candidate)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Host == "" {
		return nil, errEndpointRefused
	}
	if !s.anyEndpoint && u.String() != KimiUsageEndpoint && u.String() != KimiAIUsageEndpoint {
		return nil, errEndpointRefused
	}
	if s.anyEndpoint && u.Hostname() != "127.0.0.1" && u.Hostname() != "localhost" && u.Hostname() != "::1" {
		return nil, errEndpointRefused
	}
	return u, nil
}

func (s *KimiOAuthSource) fetch(ctx context.Context) (UsageSnapshot, oauthOutcome) {
	endpoint := s.endpoint
	if connection, ok := ctx.Value(kimiConnectionContextKey{}).(kimiManagedConnection); ok && !s.anyEndpoint && connection.usageEndpoint != "" {
		endpoint = connection.usageEndpoint
	}
	u, err := s.checkEndpoint(endpoint)
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFailed}
	}
	if _, err := s.connection(); err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonOf(err)}
	}
	token, expiresAt, err := s.credentials(ctx)
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonOf(err)}
	}
	if token == "" {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonSignedOut}
	}
	if expiresAt > 0 && expiresAt <= s.now().UnixMilli() {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonTokenExpired}
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return UsageSnapshot{}, oauthOutcome{reason: ReasonFailed}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
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
	snap, reason := parseKimiUsage(body)
	if reason != "" {
		return UsageSnapshot{}, oauthOutcome{reason: reason}
	}
	snap.ReadAt = s.now().UnixMilli()
	return snap, oauthOutcome{}
}

func kimiNumber(raw json.RawMessage) (float64, bool) {
	if len(raw) == 0 || string(bytes.TrimSpace(raw)) == "null" {
		return 0, false
	}
	if number, ok := parseNumber(raw); ok {
		if math.IsNaN(number) || math.IsInf(number, 0) {
			return 0, false
		}
		return number, true
	}
	var text string
	if json.Unmarshal(raw, &text) != nil {
		return 0, false
	}
	number, err := strconv.ParseFloat(strings.TrimSpace(text), 64)
	if err != nil || math.IsNaN(number) || math.IsInf(number, 0) {
		return 0, false
	}
	return number, true
}

func kimiInteger(raw json.RawMessage) (float64, bool) {
	number, ok := kimiNumber(raw)
	if !ok {
		return 0, false
	}
	return math.Trunc(number), true
}

func parseKimiWindow(raw json.RawMessage) usageWindowDoc {
	obj, ok := parseObject(raw)
	if !ok {
		return usageWindowDoc{}
	}
	ratio, ok := kimiNumber(obj["used_ratio"])
	if !ok {
		return usageWindowDoc{}
	}
	ratio = min(max(ratio, 0), 1)
	var resetsAt int64
	var text string
	if json.Unmarshal(obj["reset_time"], &text) == nil {
		if parsed, err := time.Parse(time.RFC3339Nano, text); err == nil {
			resetsAt = parsed.UnixMilli()
		}
	}
	return usageWindowDoc{ok: true, usedPercent: ratio * 100, resetsAt: resetsAt}
}

func kimiFixedPointCents(value float64) (int64, bool) {
	cents := value / 1_000_000
	if math.IsNaN(cents) || math.IsInf(cents, 0) || math.Abs(cents) >= float64(math.MaxInt64) {
		return 0, false
	}
	if cents > 0 && cents < 1 {
		return 1, true
	}
	return int64(math.Round(cents)), true
}

func parseKimiMoney(raw json.RawMessage) (int64, string, bool) {
	obj, ok := parseObject(raw)
	if !ok {
		return 0, "", false
	}
	cents, ok := kimiInteger(obj["priceInCents"])
	if !ok || math.Abs(cents) >= float64(math.MaxInt64) {
		return 0, "", false
	}
	var currency string
	json.Unmarshal(obj["currency"], &currency)
	return int64(cents), currency, true
}

func parseKimiBoosterWallet(raw json.RawMessage) *UsageCredits {
	obj, ok := parseObject(raw)
	if !ok {
		return nil
	}
	balance, ok := parseObject(obj["balance"])
	if !ok {
		return nil
	}
	var kind string
	if json.Unmarshal(balance["type"], &kind) != nil || kind != "BOOSTER" {
		return nil
	}
	amount, ok := kimiInteger(balance["amount"])
	if !ok || amount <= 0 {
		return nil
	}
	if _, ok := kimiFixedPointCents(amount); !ok {
		return nil
	}
	var balanceCents int64
	if amountLeft, ok := kimiInteger(balance["amountLeft"]); ok && amountLeft >= 0 {
		balanceCents, _ = kimiFixedPointCents(amountLeft)
	}
	monthlyUsed, usedCurrency, _ := parseKimiMoney(obj["monthlyUsed"])
	monthlyLimit, limitCurrency, _ := parseKimiMoney(obj["monthlyChargeLimit"])
	currency := limitCurrency
	if currency == "" {
		currency = usedCurrency
	}
	if currency == "" {
		currency = "USD"
	}
	return &UsageCredits{
		Enabled: true,
		Balance: strconv.FormatFloat(float64(balanceCents)/100, 'f', 2, 64),
		Unit:    currency,
		Monthly: &UsageMonthlySpend{
			Used:         float64(monthlyUsed) / 100,
			Limit:        float64(monthlyLimit) / 100,
			LimitEnabled: string(bytes.TrimSpace(obj["monthlyChargeLimitEnabled"])) == "true",
			Unit:         currency,
		},
	}
}

func parseKimiUsage(body []byte) (UsageSnapshot, string) {
	doc, ok := parseObject(body)
	if !ok {
		return UsageSnapshot{}, ReasonFormat
	}
	usagesRaw, hasUsages := doc["usages"]
	walletRaw, hasWallet := doc["boosterWallet"]
	if !hasUsages && !hasWallet {
		return UsageSnapshot{}, ReasonFormat
	}
	snap := UsageSnapshot{Agent: "kimi", Source: KimiOAuthSourceId}
	if usages, ok := parseObject(usagesRaw); ok {
		add := func(key string, id string, label string, mins int64) {
			raw, present := usages[key]
			if !present {
				return
			}
			window := parseKimiWindow(raw)
			if !window.ok {
				return
			}
			snap.Windows = append(snap.Windows, UsageWindow{Id: id, Label: label, UsedPercent: window.usedPercent, ResetsAt: window.resetsAt, WindowMins: mins})
		}
		add("limit_5h", WindowSession, "Current session", fiveHourMins)
		add("limit_7d", WindowWeek, "This week", sevenDayMins)
		add("limit_month_total", WindowMonth, "This month", 0)
	}
	if hasWallet && string(bytes.TrimSpace(walletRaw)) != "null" {
		snap.Credits = parseKimiBoosterWallet(walletRaw)
	}
	if len(snap.Windows) == 0 && snap.Credits == nil {
		return UsageSnapshot{}, ReasonNoPlan
	}
	return snap, ""
}
