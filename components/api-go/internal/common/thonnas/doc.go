// Package thonnas resolves portable Thonnas contracts for api-go (parity with api-nest CommonModule +
// ThonnasContractsModule). Each concern lives under metrics/, logger/, email/, events/ with noop defaults
// and wiring hooks set by *.wiring.* packages or optional vendor installers.
//
// Import this package from bootstrap (e.g. cmd/server) so imports_wiring.go side-effects register defaults.
// Feature modules consume contracts.ThonnasMetrics from Bundle — not concrete OTLP adapter types.
//
// @intent Single composition root for contract bindings; modules consume ctx.Contracts from BuildContext
package thonnas

