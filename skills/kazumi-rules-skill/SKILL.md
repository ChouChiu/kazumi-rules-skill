---
name: kazumi-rules-skill
description: "Create, validate, encode, probe, and debug Kazumi 2.2.x anime rules for API level 8 and legacy XPath levels 1-7. Use when asked to build or repair Kazumi XPath rules, JSON API rules, mixed XPath/API rules, search or chapter extraction, restricted JSONPath, anti-crawler settings, video-page resolution, or kazumi:// import links. Use Chrome DevTools to discover DOM paths and Fetch/XHR interfaces, curl to reproduce minimal requests, bundled Node TypeScript tools to validate and probe rules, and Kazumi for authoritative playback testing."
---

# Kazumi Rules

Build one Kazumi rule as one JSON object. Never wrap a single rule in an array.

Target Kazumi 2.2.x and rule API level 8. Keep legacy API 1-7 XPath rules valid. Treat `useWebview` and `useNativePlayer` as retained schema compatibility fields, not mode selectors.

## Read the relevant references

- Read [references/xpath-rules.md](references/xpath-rules.md) before creating or debugging an XPath search or chapter phase.
- Read [references/api-rules.md](references/api-rules.md) before creating or debugging an API search or chapter phase.
- Read [references/discovery-and-testing.md](references/discovery-and-testing.md) before using Chrome DevTools, curl, anti-crawler handling, or playback probing.

For a mixed rule, read both XPath and API references. The two phases are independent.

## Choose each phase independently

Set `searchMode` and `chapterMode` separately:

| Search | Chapters | Use |
|---|---|---|
| `xpath` | `xpath` | Server-rendered search and detail/play HTML |
| `api` | `api` | JSON search and JSON chapter/detail interfaces |
| `api` | `xpath` | API search returns a page URL that exposes chapter HTML |
| `xpath` | `api` | HTML search returns an ID or source accepted by a chapter API |

Default absent mode fields to `xpath` for legacy rules. Set `api` to `8` whenever either active mode is `api`. Do not reject an SPA merely because its HTML is client-rendered: inspect Fetch/XHR first and use API mode when a stable JSON interface is available. Stop only when neither usable server-rendered HTML nor a reproducible JSON interface exists.

## Follow the workflow

1. **Explore the site.** Search for a real title and identify the search-to-chapter-to-playback data flow.
2. **Classify both phases.** Prefer stable JSON interfaces over rendered DOM when the interface can be reproduced without ephemeral browser state. Otherwise use XPath.
3. **Discover selectors or interfaces.** Use Chrome DevTools snapshots for HTML and Network Fetch/XHR requests for APIs.
4. **Minimize API requests.** Reproduce discovered requests with curl. Remove nonessential headers one at a time; retain required headers, query, body, referer, or Cookie. Never disclose secrets.
5. **Write the rule.** Preserve inactive legacy fields as empty strings. Include API configs only when configured or active.
6. **Validate and probe.** Run the bundled codec, then the live probe. Fix configuration errors before interpreting site failures.
7. **Test in Kazumi.** Use the built-in rule editor/test diagnostics. Confirm search, chapters, generated episode URLs, and playback. Kazumi playback is authoritative because the static probe cannot execute the full platform WebView resolver.
8. **Export.** Return the normalized JSON object and the verified `kazumi://` link.

## Use the bundled tools

Use Node.js 22.18 or newer. Run the TypeScript files directly with Node's built-in type stripping; do not install npm dependencies.

```bash
node scripts/kazumi_rule_codec.ts /tmp/rule.json \
  --output /tmp/rule.normalized.json \
  --link-output /tmp/rule.link \
  --report

node scripts/kazumi_rule_probe.ts /tmp/rule.normalized.json \
  --keyword "葬送的芙莉莲" \
  --probe-iframe \
  --report-output /tmp/probe.json
```

Use paths relative to this Skill directory, or resolve the scripts to absolute paths.

The codec accepts JSON, raw Base64, and Kazumi links. It accepts `kazumi:` or `kazumi://`, case-insensitive schemes, percent-encoded payloads, whitespace, URL-safe Base64, and omitted padding. It always exports canonical `kazumi://` plus standard padded Base64.

Write JSON containing XPath quotes to a file before invoking the codec. Do not pass it as an inline shell argument: shell quoting can silently remove quotes such as those in `[@class='result']`. Compare the normalized selector strings with the intended JSON before publishing the link.

The probe executes the active search and chapter modes, supports mixed rules, and reports sanitized curl commands. Treat `<redacted>` values as instructions to recover the real value from the authorized browser session; never copy credentials into chat output.

## Apply current runtime rules

- Encode `@keyword` in XPath `searchURL` and API request URLs. Use `@source` for API chapter requests.
- Allow API request templates in URL, headers, query, and active POST bodies. Support only GET and POST; support `none`, `json`, and `form` body types.
- Apply anti-crawler detection only to XPath search responses. A non-JSON API response is an API parse failure, not the XPath CAPTCHA flow.
- Resolve relative episode URLs against `baseURL`. Normalize an HTTP/HTTPS URL to the declared `baseURL` scheme only for the same host and explicit-port shape. Preserve cross-origin protocols; never force every URL to HTTPS.
- Expect malformed individual result, road, or episode nodes to be skipped with diagnostics. Do not claim success when all nodes were skipped.
- Keep `useLegacyParser` enabled when actual Kazumi playback needs it, even if static HTML contains a media URL.
- Use `referer`, `userAgent`, and `adBlocker` only when the source actually requires them.

## Validate before delivery

Confirm all of the following:

- The rule is one JSON object with `name`, `version`, and `baseURL`.
- Active XPath fields are non-empty, start with `//`, and use the supported subset.
- Active API configs have valid requests and restricted JSONPath expressions.
- API chapters provide either `episodeUrlPath` or a non-empty `episodePage.url`.
- Template variables exist and use the correct zero- or one-based index.
- Codec validation passes and the import link decodes back to the same object.
- Probe search and chapter checks pass, or any unavoidable browser-only limitation is stated precisely.
- The user receives both normalized JSON and the verified import link, plus a request to test playback in Kazumi.

## Primary sources

- [Kazumi LLM documentation index](https://kazumi.app/llms.txt)
- [XPath rule development](https://kazumi.app/docs/rules/develop-rules/)
- [API rule development](https://kazumi.app/docs/rules/develop-api-rules/)
- [Video sniffing architecture](https://kazumi.app/docs/architecture/video-parser/)
- [Kazumi source and commits](https://github.com/Predidit/Kazumi/commits/main/)
