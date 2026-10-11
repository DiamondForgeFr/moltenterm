// Copyright 2026, DiamondForge
// SPDX-License-Identifier: Apache-2.0

package wps

// HasSubscribers reports whether Publish would deliver an event of this type with this scope to anyone, so a hot
// publisher (terminal output, FR-PERF-010) can skip building an event nobody receives. Only for events that are not
// persisted: a persisted event must be published even without subscribers.
func (b *BrokerType) HasSubscribers(eventName string, scope string) bool {
	return len(b.getMatchingRouteIds(WaveEvent{Event: eventName, Scopes: []string{scope}})) > 0
}
