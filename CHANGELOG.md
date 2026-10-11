# Changelog

All notable changes to this project are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to Semantic Versioning.

## [Unreleased]

### Added

- Expanded the workflow editor with persistent run history, invalid-reference repair, runtime edge highlighting, release notes, validated JSON import/export, multi-select editing, node execution policies, shared graph contracts, checkpoint resume, automatic layout, and system clipboard subgraph copy/paste.

### Fixed

- Validate pasted node bindings against both the existing workflow and the newly pasted subgraph, preserving valid internal references after node IDs are regenerated.
- Retry transient MCP SDK HTTP errors whose status is stored in the numeric `code` field; keep HTTP 400/401 failures non-retryable.
- Clear the canvas selection after confirming a checkpoint resume so the editor displays the current run preview.
- Give the node timeout number input an accessible label.
