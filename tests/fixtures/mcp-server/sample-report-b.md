# Heron Audit Report

**Generated**: 2026-05-14 | **Risk Level**: HIGH

## Summary

Second fixture report. Same agent, after a config change: now writes to
the production database.

## Systems

- Greenhouse — read-only
- Slack — write (single channel)
- Production Postgres — write (single-tenant)

## Findings

1. **[HIGH] New direct write path to production Postgres without
   approval gating.** Recommend adding human-in-the-loop approval.
