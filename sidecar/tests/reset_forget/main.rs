//! Command-surface journeys for Reset, Forget, and the 30-day restore
//! (ADR 0014 D5, ticket tuxbooks-ip6.7). Every test drives the JSON-RPC seam
//! the app uses, not the private tables, except where the acceptance criterion
//! is explicitly about aliases and identities.

mod basics;
mod churn;
mod common;
mod contention;
