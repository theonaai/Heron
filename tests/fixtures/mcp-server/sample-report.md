# Heron Audit Report

**Generated**: 2026-05-13 | **Risk Level**: MEDIUM

## Summary

A fixture report used by Role B's MCP server tests. Mid-risk agent that
reads Greenhouse jobs and posts Slack messages.

## Systems

- Greenhouse — read-only
- Slack — write (single channel)

## Findings

1. **[MEDIUM] Slack write scope is broader than declared.** Recommend
   restricting to a single channel.
