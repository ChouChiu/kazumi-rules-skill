#!/usr/bin/env python3
"""Probe a Kazumi rule against a live site with a small Kazumi-like parser."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from html.parser import HTMLParser
from pathlib import Path
from typing import Any, Iterable

from kazumi_rule_codec import RuleCodecError, load_rule, validate_rule


MEDIA_RE = re.compile(
    r"""(?P<url>https?:\\?/\\?/[^'"<>\s\\]+?\.(?:m3u8|mp4|flv|mpd)(?:\?[^'"<>\s\\]*)?)""",
    re.I,
)


class ProbeError(RuntimeError):
    pass


@dataclass
class Node:
    tag: str
    attrs: dict[str, str] = field(default_factory=dict)
    parent: "Node | None" = None
    children: list["Node"] = field(default_factory=list)
    text_parts: list[str] = field(default_factory=list)

    def append(self, child: "Node") -> None:
        self.children.append(child)
        child.parent = self

    def text(self) -> str:
        parts = list(self.text_parts)
        for child in self.children:
            parts.append(child.text())
        return " ".join(" ".join(parts).split())

    def descendants(self) -> Iterable["Node"]:
        for child in self.children:
            yield child
            yield from child.descendants()


class TreeBuilder(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = Node("__document__")
        self.stack = [self.root]

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        node = Node(tag.lower(), {k.lower(): v or "" for k, v in attrs})
        self.stack[-1].append(node)
        if tag.lower() not in {"area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"}:
            self.stack.append(node)

    def handle_endtag(self, tag: str) -> None:
        tag = tag.lower()
        for idx in range(len(self.stack) - 1, 0, -1):
            if self.stack[idx].tag == tag:
                del self.stack[idx:]
                break

    def handle_data(self, data: str) -> None:
        if data.strip():
            self.stack[-1].text_parts.append(data.strip())


@dataclass
class Step:
    axis: str
    tag: str
    predicates: list[str]


def parse_html(content: str) -> Node:
    parser = TreeBuilder()
    parser.feed(content)
    return parser.root


def evaluate_xpath(context: Node, xpath: str) -> list[Node]:
    xpath = xpath.strip()
    if not xpath:
        return []
    if not xpath.startswith("//") and not xpath.startswith("/"):
        xpath = "/" + xpath
    steps = _parse_steps(xpath)
    current = [context]
    for step in steps:
        next_nodes: list[Node] = []
        for node in current:
            candidates = list(node.descendants()) if step.axis == "desc" else node.children
            matches = [candidate for candidate in candidates if _tag_matches(candidate, step.tag)]
            next_nodes.extend(_apply_predicates(matches, step.predicates))
        current = next_nodes
    return current


def _parse_steps(xpath: str) -> list[Step]:
    steps: list[Step] = []
    idx = 0
    while idx < len(xpath):
        if xpath.startswith("//", idx):
            axis = "desc"
            idx += 2
        elif xpath.startswith("/", idx):
            axis = "child"
            idx += 1
        else:
            axis = "child"
        start = idx
        bracket_depth = 0
        while idx < len(xpath):
            char = xpath[idx]
            if char == "[":
                bracket_depth += 1
            elif char == "]":
                bracket_depth -= 1
            elif char == "/" and bracket_depth == 0:
                break
            idx += 1
        token = xpath[start:idx].strip()
        if token:
            steps.append(_parse_step(axis, token))
    return steps


def _parse_step(axis: str, token: str) -> Step:
    tag_match = re.match(r"^([A-Za-z0-9_*:-]+)", token)
    if not tag_match:
        raise ProbeError(f"unsupported XPath step: {token}")
    tag = tag_match.group(1).lower()
    predicates = re.findall(r"\[[^\]]+\]", token[tag_match.end() :])
    leftover = re.sub(r"\[[^\]]+\]", "", token[tag_match.end() :]).strip()
    if leftover:
        raise ProbeError(f"unsupported XPath step suffix: {token}")
    return Step(axis=axis, tag=tag, predicates=predicates)


def _tag_matches(node: Node, tag: str) -> bool:
    return tag == "*" or node.tag == tag


def _apply_predicates(nodes: list[Node], predicates: list[str]) -> list[Node]:
    current = nodes
    for predicate in predicates:
        body = predicate[1:-1].strip()
        if body.isdigit():
            pos = int(body)
            current = [current[pos - 1]] if 1 <= pos <= len(current) else []
            continue
        match = re.match(r"^@([\w:-]+)\s*(=|~=|\^=|\$=|\*=)\s*(['\"])(.*?)\3$", body)
        if not match:
            raise ProbeError(f"unsupported XPath predicate: [{body}]")
        attr, op, _, expected = match.groups()
        attr = attr.lower()
        current = [node for node in current if _attr_matches(node.attrs.get(attr, ""), op, expected)]
    return current


def _attr_matches(actual: str, op: str, expected: str) -> bool:
    if op == "=":
        return actual == expected
    if op == "~=":
        return expected in actual.split()
    if op == "^=":
        return actual.startswith(expected)
    if op == "$=":
        return actual.endswith(expected)
    if op == "*=":
        return expected in actual
    return False


def fetch(url: str, rule: dict[str, Any], timeout: int, method: str = "GET", body: bytes | None = None) -> tuple[str, str]:
    headers = {
        "User-Agent": rule.get("userAgent") or "Mozilla/5.0 KazumiRuleProbe/1.0",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    }
    referer = rule.get("referer") or rule.get("baseURL")
    if referer:
        headers["Referer"] = str(referer)
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read()
            final_url = response.geturl()
            charset = response.headers.get_content_charset() or _guess_charset(raw) or "utf-8"
            return raw.decode(charset, errors="replace"), final_url
    except urllib.error.HTTPError as exc:
        raise ProbeError(f"HTTP {exc.code} for {url}") from exc
    except urllib.error.URLError as exc:
        raise ProbeError(f"request failed for {url}: {exc.reason}") from exc


def _guess_charset(raw: bytes) -> str | None:
    head = raw[:2048].decode("ascii", errors="ignore")
    match = re.search(r"charset=['\"]?([\w.-]+)", head, re.I)
    return match.group(1) if match else None


def absolutize(url: str, base: str) -> str:
    return urllib.parse.urljoin(base, html.unescape(url.strip()))


def first_link(node: Node, base_url: str) -> str:
    for key in ("href", "src", "data-src"):
        if node.attrs.get(key):
            return absolutize(node.attrs[key], base_url)
    for child in node.descendants():
        for key in ("href", "src", "data-src"):
            if child.attrs.get(key):
                return absolutize(child.attrs[key], base_url)
    return ""


def find_media_urls(content: str) -> list[str]:
    cleaned = _decode_js_escapes(html.unescape(content))
    urls: list[str] = []
    for match in MEDIA_RE.finditer(cleaned):
        url = match.group("url").replace("\\/", "/")
        if url not in urls:
            urls.append(url)
    return urls


def _decode_js_escapes(content: str) -> str:
    content = content.replace("\\/", "/")
    return re.sub(
        r"\\u([0-9a-fA-F]{4})",
        lambda match: chr(int(match.group(1), 16)),
        content,
    )


def iframe_urls(root: Node, base_url: str) -> list[str]:
    urls: list[str] = []
    for node in evaluate_xpath(root, "//iframe"):
        src = node.attrs.get("src") or node.attrs.get("data-src")
        if src:
            urls.append(absolutize(src, base_url))
    return urls


def build_search_url(rule: dict[str, Any], keyword: str) -> str:
    encoded = urllib.parse.quote(keyword, safe="")
    search_url = str(rule["searchURL"]).replace("@keyword", encoded)
    return absolutize(search_url, str(rule["baseURL"]))


def probe(rule: dict[str, Any], args: argparse.Namespace) -> dict[str, Any]:
    report: dict[str, Any] = {
        "ok": False,
        "rule": rule.get("name"),
        "keyword": args.keyword,
        "validationErrors": validate_rule(rule),
        "search": {},
        "playlist": {},
        "parse": {},
        "suggestions": [],
    }

    search_url = build_search_url(rule, args.keyword)
    body = args.post_body.encode("utf-8") if args.post_body else None
    method = "POST" if rule.get("usePost") else "GET"
    search_html, final_search_url = fetch(search_url, rule, args.timeout, method=method, body=body)
    search_root = parse_html(search_html)
    items = evaluate_xpath(search_root, str(rule["searchList"]))
    report["search"] = {
        "ok": bool(items),
        "url": final_search_url,
        "itemCount": len(items),
    }
    if not items:
        report["suggestions"].append("searchList returned 0 nodes; re-check searchURL and searchList")
        return report

    item = items[min(args.result_index, len(items) - 1)]
    name_nodes = evaluate_xpath(item, str(rule["searchName"]))
    result_nodes = evaluate_xpath(item, str(rule["searchResult"]))
    title = name_nodes[0].text() if name_nodes else item.text()
    detail_url = first_link(result_nodes[0], final_search_url) if result_nodes else first_link(item, final_search_url)
    report["search"].update(
        {
            "selectedTitle": title,
            "selectedDetailUrl": detail_url,
            "nameMatched": bool(name_nodes),
            "resultMatched": bool(result_nodes),
        }
    )
    if not detail_url:
        report["suggestions"].append("searchResult did not expose href/src; inspect the result item's link path")
        return report

    detail_html, final_detail_url = fetch(detail_url, rule, args.timeout)
    detail_root = parse_html(detail_html)
    roads = evaluate_xpath(detail_root, str(rule.get("chapterRoads") or ""))
    playlists: list[dict[str, Any]] = []
    for road in roads:
        chapter_nodes = evaluate_xpath(road, str(rule.get("chapterResult") or ""))
        chapters = []
        for chapter in chapter_nodes[: args.max_chapters]:
            chapters.append({"name": chapter.text(), "url": first_link(chapter, final_detail_url)})
        playlists.append({"name": road.text()[:80], "chapterCount": len(chapter_nodes), "sampleChapters": chapters})

    report["playlist"] = {
        "ok": any(playlist["chapterCount"] for playlist in playlists),
        "url": final_detail_url,
        "roadCount": len(roads),
        "playlists": playlists,
    }
    if not roads:
        report["suggestions"].append("chapterRoads returned 0 nodes; confirm searchResult opens the detail page")
        return report
    if not report["playlist"]["ok"]:
        report["suggestions"].append("chapterResult returned 0 links inside matched roads")
        return report

    episode_url = ""
    for playlist in playlists:
        for chapter in playlist["sampleChapters"]:
            if chapter["url"]:
                episode_url = chapter["url"]
                break
        if episode_url:
            break
    if not episode_url:
        report["suggestions"].append("chapterResult matched text but no href/src URL")
        return report

    episode_html, final_episode_url = fetch(episode_url, rule, args.timeout)
    media_urls = find_media_urls(episode_html)
    episode_root = parse_html(episode_html)
    frames = iframe_urls(episode_root, final_episode_url)
    iframe_media: list[str] = []
    if args.probe_iframe:
        for frame in frames[: args.max_iframes]:
            try:
                frame_html, _ = fetch(frame, rule, args.timeout)
            except ProbeError:
                continue
            iframe_media.extend(find_media_urls(frame_html))

    parse_ok = bool(media_urls or iframe_media)
    uses_legacy = bool(rule.get("useLegacyParser"))
    suggest_enable_legacy = bool(frames and not media_urls and not uses_legacy)
    if suggest_enable_legacy:
        report["suggestions"].append("episode page uses iframe and no direct media URL was found; set useLegacyParser=true and retest in Kazumi")
    if not parse_ok and not frames:
        report["suggestions"].append("no direct media URL or iframe detected; this site may require WebView JavaScript execution")
    if uses_legacy:
        report["suggestions"].append("rule already enables useLegacyParser; keep it when Kazumi playback requires LegacyParser")

    report["parse"] = {
        "ok": parse_ok,
        "url": final_episode_url,
        "directMediaUrls": media_urls[: args.max_media],
        "iframeUrls": frames[: args.max_iframes],
        "iframeMediaUrls": iframe_media[: args.max_media],
        "ruleUsesLegacyParser": uses_legacy,
        "suggestEnableLegacyParser": suggest_enable_legacy,
        "legacyParserNote": (
            "The rule already enables useLegacyParser. Static probing may still find media URLs, but that does not prove LegacyParser can be disabled."
            if uses_legacy
            else "Static probing can suggest enabling LegacyParser, but it cannot prove LegacyParser is unnecessary. Kazumi playback testing is authoritative."
        ),
    }
    report["ok"] = bool(report["search"]["ok"] and report["playlist"]["ok"] and report["parse"]["ok"])
    return report


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Test whether a Kazumi rule can search, list chapters, and discover playable media hints.",
    )
    parser.add_argument("input", help="Rule JSON file, raw JSON, raw base64, kazumi:// link, or - for stdin")
    parser.add_argument("--keyword", "-k", default="葬送的芙莉莲", help="Search keyword")
    parser.add_argument("--timeout", type=int, default=15, help="HTTP timeout in seconds")
    parser.add_argument("--result-index", type=int, default=0, help="Search result index to open")
    parser.add_argument("--max-chapters", type=int, default=5, help="Number of chapter links to include per road")
    parser.add_argument("--max-media", type=int, default=5, help="Number of media URLs to include")
    parser.add_argument("--max-iframes", type=int, default=3, help="Number of iframe URLs to probe/include")
    parser.add_argument("--probe-iframe", action="store_true", help="Fetch iframe pages and scan for media URLs")
    parser.add_argument("--post-body", default="", help="Optional POST body for usePost rules")
    parser.add_argument("--report-output", help="Write JSON report to this file")
    parser.add_argument("--no-fail", action="store_true", help="Return exit code 0 even when probe checks fail")
    args = parser.parse_args(argv)

    try:
        rule = load_rule(args.input)
        report = probe(rule, args)
    except (RuleCodecError, ProbeError) as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2

    output = json.dumps(report, ensure_ascii=False, indent=2)
    if args.report_output:
        Path(args.report_output).write_text(output + "\n", encoding="utf-8")
    print(output)

    if args.no_fail:
        return 0
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
