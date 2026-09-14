---
name: media
description: Use when the user asks to inspect, extract, understand, or process a local image, audio, video, PDF, DOCX, XLSX, or other attachment through NUAAI media tools. Report only returned metadata or extracted content.
license: MIT
compatibility: Requires the configured media integration and a permitted local path or attachment.
metadata:
  author: tylerdotai
  version: "1.0"
  triggers: "image, photo, audio, video, PDF, pdf, DOCX, docx, XLSX, xlsx, spreadsheet, document, attachment, media, inspect file, extract frames, extract audio"
allowed-tools: "media.inspect workspace.inspect"
---

# Media Inspection

- Use `media.inspect` for supported media extraction and `workspace.inspect` for bounded metadata when appropriate.
- Verify the exact path or attachment identity before inspection.
- Report unsupported formats, missing files, extraction errors, and partial output plainly.
- Do not claim to have viewed or transcribed media without a completed inspection result.
- Do not expose embedded credentials or private metadata that the user did not request.

See [references/media-contract.md](references/media-contract.md).
