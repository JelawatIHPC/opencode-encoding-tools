# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `charset="utf8bom"` (alias `utf-8-sig`): writes UTF-8 with a BOM. New files get one, an existing UTF-8 file without a BOM gets one added with a warning, and an existing BOM is preserved without a warning.

## [0.1.0] - 2026-11-06

### Added

- Charset-aware `read`, `write`, `edit`, `patch`, `grep` and `shell` tools that replace the native OpenCode implementations.
- Detection for BOM-prefixed UTF-8/16/32, strict and near-valid UTF-8, GB18030 four-byte sequences, and chardet-based candidates (GBK/GB2312/GB18030, Big5, Shift_JIS, EUC, single-byte code pages).
- Repertoire enforcement for `gbk`, `cp936` and `gb2312` requests, including an embedded 7445-character GB2312 table.
- EOL-insensitive matching for `edit`/`patch` with byte-preserving writes; mixed-EOL input warnings.
- `grep` with ripgrep-style `include` matching, content-based binary sniffing, junction/symlink avoidance, and a time-only budget.
- `shell` output decoding driven by the actual bytes, with native-compatible status text, background streaming, and spill-to-temp truncation.
- Ordered batch error digest for concurrent plugin tool failures.

[0.1.0]: https://github.com/JelawatIHPC/opencode-encoding-tools/releases/tag/0.1.0
