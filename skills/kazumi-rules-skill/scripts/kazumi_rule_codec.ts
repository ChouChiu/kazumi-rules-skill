#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// biome-ignore lint/suspicious/noExplicitAny: Rule represents arbitrary JSON object structures
export type Rule = Record<string, any>;

export const SECRET_RE =
	/authorization|cookie|token|secret|api[-_]?key|csrf|signature|password|passwd|auth/i;
export const TEMPLATE_RE = /(?<![A-Za-z0-9_])@([A-Za-z_][A-Za-z0-9_]*)/g;

const COMMON_FIELDS = ["api", "type", "name", "version", "baseURL"];
const SEARCH_XPATH_FIELDS = [
	"searchURL",
	"searchList",
	"searchName",
	"searchResult",
];
const CHAPTER_XPATH_FIELDS = ["chapterRoads", "chapterResult"];

const UNSUPPORTED_XPATH: Array<[RegExp, string]> = [
	[
		/\bcontains\s*\(/i,
		"contains() is not Kazumi-compatible; use [@attr*='value']",
	],
	[
		/\bstarts-with\s*\(/i,
		"starts-with() is not Kazumi-compatible; use [@attr^='value']",
	],
	[
		/\b(?:normalize-space|substring|string|last|text)\s*\(/i,
		"XPath functions and text() are not supported in Kazumi",
	],
	[/\b(?:and|or)\b/i, "XPath boolean predicates (and/or) are not supported"],
	[/\|/, "XPath union (|) is not supported"],
	[/::/, "XPath axes (::) are not supported"],
	[/(^|\/)\.\.($|\/)/, "Parent traversal (..) is not supported"],
];

export class RuleCodecError extends Error {}

export function compactJson(rule: Rule): string {
	return JSON.stringify(rule);
}

export function encodeRule(rule: Rule): string {
	return Buffer.from(compactJson(rule), "utf8").toString("base64");
}

export function importLink(rule: Rule): string {
	return `kazumi://${encodeRule(rule)}`;
}

export function requireRuleObject(value: unknown): Rule {
	if (Array.isArray(value)) {
		throw new RuleCodecError(
			"Kazumi rule must be a single JSON object, not an array",
		);
	}
	if (value === null || typeof value !== "object") {
		throw new RuleCodecError("Kazumi rule must decode to a JSON object");
	}
	return value as Rule;
}

export function decodePayload(input: string): Rule {
	let raw = input.trim();
	const scheme = raw.match(/^kazumi:(?:\/\/)?/i);
	if (scheme) {
		raw = raw.slice(scheme[0].length);
	} else if (raw.includes("://")) {
		throw new RuleCodecError("Invalid Kazumi rule link scheme");
	}

	try {
		raw = decodeURIComponent(raw);
	} catch (error) {
		throw new RuleCodecError(`Percent decoding failed: ${String(error)}`);
	}

	raw = raw.replace(/\s/g, "").replace(/-/g, "+").replace(/_/g, "/");
	if (!raw) {
		throw new RuleCodecError("Kazumi rule link payload is empty");
	}

	if (!/^[A-Za-z0-9+/]*={0,2}$/.test(raw) || raw.length % 4 === 1) {
		throw new RuleCodecError(
			"Base64 decoding failed: invalid characters or length",
		);
	}

	raw += "=".repeat((4 - (raw.length % 4)) % 4);

	try {
		return requireRuleObject(
			JSON.parse(Buffer.from(raw, "base64").toString("utf8")),
		);
	} catch (error) {
		if (error instanceof RuleCodecError) throw error;
		throw new RuleCodecError(
			`Base64 payload is not valid UTF-8 JSON: ${String(error)}`,
		);
	}
}

export function loadRule(source: string): Rule {
	const text =
		source === "-"
			? readFileSync(0, "utf8")
			: existsSync(source)
				? readFileSync(source, "utf8")
				: source;
	const trimmed = text.trim();
	if (!trimmed) {
		throw new RuleCodecError("Empty input");
	}
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return requireRuleObject(JSON.parse(trimmed));
		} catch (error) {
			if (error instanceof RuleCodecError) throw error;
			throw new RuleCodecError(`JSON parse failed: ${String(error)}`);
		}
	}
	return decodePayload(trimmed);
}

export function ruleMode(rule: Rule, phase: "search" | "chapter"): string {
	return String(rule[`${phase}Mode`] ?? "xpath");
}

function bracketEnd(expression: string, start: number): number {
	let quote = "";
	let escaped = false;
	for (let index = start + 1; index < expression.length; index++) {
		const char = expression[index];
		if (escaped) {
			escaped = false;
		} else if (char === "\\") {
			escaped = true;
		} else if (quote) {
			if (char === quote) quote = "";
		} else if (char === "'" || char === '"') {
			quote = char;
		} else if (char === "]") {
			return index;
		}
	}
	return -1;
}

export function validateJsonPath(expression: unknown): string | null {
	if (typeof expression !== "string" || !expression.startsWith("$")) {
		return "JSONPath must be a string starting with $";
	}
	let index = 1;
	while (index < expression.length) {
		if (expression[index] === ".") {
			const match = expression.slice(++index).match(/^[A-Za-z0-9_$-]+/);
			if (!match) return `unsupported JSONPath: ${expression}`;
			index += match[0].length;
			continue;
		}
		if (expression[index] === "[") {
			const end = bracketEnd(expression, index);
			if (end < 0) return `JSONPath is missing ]: ${expression}`;
			const part = expression.slice(index + 1, end).trim();
			const quoted =
				part.length >= 2 &&
				["'", '"'].includes(part[0]) &&
				part.at(-1) === part[0];
			if (!(part === "*" || /^\d+$/.test(part) || quoted)) {
				return `unsupported JSONPath segment [${part}]`;
			}
			index = end + 1;
			continue;
		}
		return `unsupported JSONPath: ${expression}`;
	}
	return null;
}

export function templateNames(value: unknown): Set<string> {
	const names = new Set<string>();
	const visit = (item: unknown): void => {
		if (typeof item === "string") {
			for (const match of item.matchAll(TEMPLATE_RE)) names.add(match[1]);
		} else if (Array.isArray(item)) {
			item.forEach(visit);
		} else if (item && typeof item === "object") {
			for (const [key, child] of Object.entries(item)) {
				visit(key);
				visit(child);
			}
		}
	};
	visit(value);
	return names;
}

function validateXpath(rule: Rule, fields: string[], errors: string[]): void {
	for (const field of fields) {
		const value = rule[field];
		if (typeof value !== "string" || !value.trim()) {
			errors.push(`${field} must be a non-empty string in XPath mode`);
			continue;
		}
		if (field === "searchURL") {
			if (!value.includes("@keyword")) {
				errors.push("searchURL must contain @keyword in XPath mode");
			}
			continue;
		}
		if (!value.startsWith("//")) {
			errors.push(`${field} should start with //`);
		}
		if (value.includes("@keyword")) {
			errors.push(`${field} must not contain @keyword`);
		}
		for (const match of value.matchAll(/\[([^\]]+)\]/g)) {
			const predicate = match[1];
			if (
				!/^\s*\d+\s*$/.test(predicate) &&
				!/^\s*@[\w:-]+\s*(?:=|~=|\^=|\$=|\*=)\s*(['"]).*\1\s*$/.test(predicate)
			) {
				errors.push(
					`${field}: unsupported or unquoted predicate [${predicate}]`,
				);
			}
		}
		for (const [pattern, message] of UNSUPPORTED_XPATH) {
			if (pattern.test(value)) errors.push(`${field}: ${message}`);
		}
	}
}

function validateRequest(
	config: unknown,
	label: string,
	allowed: Set<string>,
	errors: string[],
): void {
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		errors.push(`${label} must be an object`);
		return;
	}
	const request = config as Rule;
	const method = String(request.method ?? "GET").toUpperCase();
	if (!new Set(["GET", "POST"]).has(method)) {
		errors.push(`${label}.method must be GET or POST`);
	}
	if (typeof request.url !== "string" || !request.url.trim()) {
		errors.push(`${label}.url must be a non-empty string`);
	}
	for (const key of ["headers", "query"]) {
		if (
			key in request &&
			(!request[key] ||
				typeof request[key] !== "object" ||
				Array.isArray(request[key]))
		) {
			errors.push(`${label}.${key} must be an object`);
		}
	}
	const bodyType = String(request.bodyType ?? "none");
	if (!new Set(["none", "json", "form"]).has(bodyType)) {
		errors.push(`${label}.bodyType must be none, json, or form`);
	}
	if (method === "POST" && bodyType !== "none" && !("body" in request)) {
		errors.push(
			`${label}.body is required for active POST ${bodyType} requests`,
		);
	}
	const unknown = [...templateNames(request)].filter(
		(name) => !allowed.has(name),
	);
	if (unknown.length) {
		errors.push(
			`${label} uses unknown template variables: ${unknown
				.sort()
				.map((name) => `@${name}`)
				.join(", ")}`,
		);
	}
}

function validateApiSearch(rule: Rule, errors: string[]): void {
	const config = rule.searchApiConfig;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		errors.push("searchApiConfig must be an object in API mode");
		return;
	}
	validateRequest(
		config.request,
		"searchApiConfig.request",
		new Set(["keyword"]),
		errors,
	);
	for (const field of ["listPath", "namePath", "sourcePath"]) {
		const error = validateJsonPath(config[field]);
		if (error) errors.push(`searchApiConfig.${field}: ${error}`);
	}
}

function validateApiChapters(rule: Rule, errors: string[]): void {
	const config = rule.chapterApiConfig;
	if (!config || typeof config !== "object" || Array.isArray(config)) {
		errors.push("chapterApiConfig must be an object in API mode");
		return;
	}
	validateRequest(
		config.request,
		"chapterApiConfig.request",
		new Set(["source"]),
		errors,
	);
	const format = String(config.format ?? "nested");
	if (!new Set(["nested", "delimited"]).has(format)) {
		errors.push("chapterApiConfig.format must be nested or delimited");
		return;
	}
	const variables = config.variables ?? {};
	if (!variables || typeof variables !== "object" || Array.isArray(variables)) {
		errors.push("chapterApiConfig.variables must be an object");
	} else {
		for (const [name, path] of Object.entries(variables)) {
			const error = validateJsonPath(path);
			if (error) errors.push(`chapterApiConfig.variables.${name}: ${error}`);
		}
	}
	if (format === "delimited") {
		for (const field of ["roadNamesPath", "roadEpisodesPath"]) {
			const error = validateJsonPath(config[field]);
			if (error) errors.push(`chapterApiConfig.${field}: ${error}`);
		}
		for (const [field, fallback] of [
			["roadSeparator", "$$$"],
			["episodeSeparator", "#"],
			["fieldSeparator", "$"],
		]) {
			if (!String(config[field] ?? fallback)) {
				errors.push(`chapterApiConfig.${field} must not be empty`);
			}
		}
	} else {
		for (const field of ["roadsPath", "roadNamePath"]) {
			if (config[field]) {
				const error = validateJsonPath(config[field]);
				if (error) errors.push(`chapterApiConfig.${field}: ${error}`);
			}
		}
		for (const field of ["episodesPath", "episodeNamePath"]) {
			const error = validateJsonPath(config[field]);
			if (error) errors.push(`chapterApiConfig.${field}: ${error}`);
		}
		if (config.episodeUrlPath) {
			const error = validateJsonPath(config.episodeUrlPath);
			if (error) errors.push(`chapterApiConfig.episodeUrlPath: ${error}`);
		} else if (!config.episodePage || typeof config.episodePage !== "object") {
			errors.push("chapterApiConfig requires episodeUrlPath or episodePage");
		}
	}
	if (config.episodePage !== undefined) {
		const page = config.episodePage;
		if (
			!page ||
			typeof page !== "object" ||
			typeof page.url !== "string" ||
			!page.url.trim()
		) {
			errors.push(
				"chapterApiConfig.episodePage.url must be a non-empty string",
			);
		} else if (
			page.query !== undefined &&
			(!page.query ||
				typeof page.query !== "object" ||
				Array.isArray(page.query))
		) {
			errors.push("chapterApiConfig.episodePage.query must be an object");
		}
		const allowed = new Set([
			"source",
			"episodeUrl",
			"roadIndex",
			"roadNumber",
			"episodeIndex",
			"episodeNumber",
			...Object.keys(variables),
		]);
		const unknown = [...templateNames(page)].filter(
			(name) => !allowed.has(name),
		);
		if (unknown.length) {
			errors.push(
				`chapterApiConfig.episodePage uses unknown template variables: ${unknown
					.sort()
					.map((name) => `@${name}`)
					.join(", ")}`,
			);
		}
	}
}

export function normalizeRule(rawRule: Rule): Rule {
	const searchMode = ruleMode(rawRule, "search");
	const chapterMode = ruleMode(rawRule, "chapter");
	const isApi = searchMode === "api" || chapterMode === "api";

	const normalized: Rule = {
		api: String(rawRule.api ?? (isApi ? "8" : "1")),
		type: String(rawRule.type ?? "anime"),
		name: String(rawRule.name ?? ""),
		version: String(rawRule.version ?? "1.0"),
		muliSources: Boolean(rawRule.muliSources ?? true),
		useWebview: Boolean(rawRule.useWebview ?? true),
		useNativePlayer: Boolean(rawRule.useNativePlayer ?? true),
		usePost: Boolean(rawRule.usePost ?? false),
		useLegacyParser: Boolean(rawRule.useLegacyParser ?? false),
		adBlocker: Boolean(rawRule.adBlocker ?? false),
		userAgent: String(rawRule.userAgent ?? ""),
		baseURL: String(rawRule.baseURL ?? ""),
		searchURL: String(rawRule.searchURL ?? ""),
		searchList: String(rawRule.searchList ?? ""),
		searchName: String(rawRule.searchName ?? ""),
		searchResult: String(rawRule.searchResult ?? ""),
		chapterRoads: String(rawRule.chapterRoads ?? ""),
		chapterResult: String(rawRule.chapterResult ?? ""),
		referer: String(rawRule.referer ?? ""),
		searchMode,
		chapterMode,
	};

	if (searchMode === "api" || rawRule.searchApiConfig) {
		normalized.searchApiConfig = rawRule.searchApiConfig ?? {
			request: {
				method: "GET",
				url: "",
				headers: {},
				query: { q: "@keyword" },
				bodyType: "none",
			},
			listPath: "$.data[*]",
			namePath: "$.name",
			sourcePath: "$.id",
		};
	}

	if (chapterMode === "api" || rawRule.chapterApiConfig) {
		normalized.chapterApiConfig = rawRule.chapterApiConfig ?? {
			request: {
				method: "GET",
				url: "",
				headers: {},
				query: {},
				bodyType: "none",
			},
			format: "nested",
			roadsPath: "$.data.roads[*]",
			roadNamePath: "$.name",
			episodesPath: "$.episodes[*]",
			episodeNamePath: "$.name",
			episodeUrlPath: "$.url",
		};
	}

	if (rawRule.antiCrawlerConfig || !isApi) {
		normalized.antiCrawlerConfig = {
			enabled: Boolean(rawRule.antiCrawlerConfig?.enabled ?? false),
			captchaType: Number(rawRule.antiCrawlerConfig?.captchaType ?? 1),
			captchaImage: String(rawRule.antiCrawlerConfig?.captchaImage ?? ""),
			captchaInput: String(rawRule.antiCrawlerConfig?.captchaInput ?? ""),
			captchaButton: String(rawRule.antiCrawlerConfig?.captchaButton ?? ""),
			captchaDetectType: Number(
				rawRule.antiCrawlerConfig?.captchaDetectType ?? 1,
			),
			captchaDetectValue: String(
				rawRule.antiCrawlerConfig?.captchaDetectValue ?? "",
			),
			captchaScript: String(rawRule.antiCrawlerConfig?.captchaScript ?? ""),
		};
	}

	return normalized;
}

export function validateRule(rule: Rule): string[] {
	const errors: string[] = [];
	const missing = COMMON_FIELDS.filter((field) => !(field in rule));
	if (missing.length) {
		errors.push(`missing required fields: ${missing.join(", ")}`);
	}
	if (String(rule.type ?? "anime") !== "anime") {
		errors.push('type should be "anime"');
	}
	const search = ruleMode(rule, "search");
	const chapter = ruleMode(rule, "chapter");
	if (!new Set(["xpath", "api"]).has(search)) {
		errors.push("searchMode must be xpath or api");
	}
	if (!new Set(["xpath", "api"]).has(chapter)) {
		errors.push("chapterMode must be xpath or api");
	}
	if (
		[search, chapter].includes("api") &&
		(!/^\d+$/.test(String(rule.api)) || Number(rule.api) < 8)
	) {
		errors.push("API search/chapter mode requires api level 8 or newer");
	}
	if (search === "xpath") validateXpath(rule, SEARCH_XPATH_FIELDS, errors);
	else if (search === "api") validateApiSearch(rule, errors);
	if (chapter === "xpath") validateXpath(rule, CHAPTER_XPATH_FIELDS, errors);
	else if (chapter === "api") validateApiChapters(rule, errors);

	if (rule.antiCrawlerConfig) {
		const ac = rule.antiCrawlerConfig;
		if (typeof ac !== "object" || Array.isArray(ac)) {
			errors.push("antiCrawlerConfig must be an object");
		} else {
			if ("captchaType" in ac && ![1, 2, 3].includes(Number(ac.captchaType))) {
				errors.push("antiCrawlerConfig.captchaType must be 1, 2, or 3");
			}
			if (
				"captchaDetectType" in ac &&
				![1, 2, 3].includes(Number(ac.captchaDetectType))
			) {
				errors.push("antiCrawlerConfig.captchaDetectType must be 1, 2, or 3");
			}
		}
	}

	if (
		JSON.stringify(decodePayload(encodeRule(rule))) !== JSON.stringify(rule)
	) {
		errors.push("base64 round-trip decoded JSON does not match the input rule");
	}
	return errors;
}

export function buildReport(rule: Rule): Rule {
	const base64 = encodeRule(rule);
	const errors = validateRule(rule);
	return {
		ok: !errors.length,
		errors,
		name: rule.name,
		api: rule.api,
		searchMode: ruleMode(rule, "search"),
		chapterMode: ruleMode(rule, "chapter"),
		base64,
		importLink: `kazumi://${base64}`,
		decodedMatchesInput:
			JSON.stringify(decodePayload(base64)) === JSON.stringify(rule),
		payloadShape: "object",
	};
}

function usage(): never {
	console.error(
		"Usage: node kazumi_rule_codec.ts INPUT [--output FILE] [--link-output FILE] [--normalize] [--compact] [--report] [--quiet]",
	);
	process.exit(2);
}

export function main(argv = process.argv.slice(2)): number {
	if (!argv.length || argv.includes("--help")) {
		if (argv.includes("--help")) {
			console.log(
				"Validate, normalize, and encode a single Kazumi XPath/API rule object.",
			);
			return 0;
		}
		usage();
	}
	const input = argv[0];
	const option = (name: string): string | undefined => {
		const index = argv.indexOf(name);
		return index >= 0 ? argv[index + 1] : undefined;
	};
	try {
		let rule = loadRule(input);
		if (argv.includes("--normalize")) {
			rule = normalizeRule(rule);
		}
		const report = buildReport(rule);
		const text = argv.includes("--compact")
			? JSON.stringify(rule)
			: JSON.stringify(rule, null, 2);
		const output = option("--output") ?? option("-o");
		if (output) writeFileSync(output, `${text}\n`, "utf8");
		const linkOutput = option("--link-output");
		if (linkOutput) writeFileSync(linkOutput, `${report.importLink}\n`, "utf8");
		for (const error of report.errors) console.error(`ERROR: ${error}`);
		if (!argv.includes("--quiet")) {
			console.log(
				argv.includes("--report")
					? JSON.stringify(report, null, 2)
					: `Normalized rule JSON:\n${text}\n\nImport link:\n${report.importLink}`,
			);
		}
		return report.ok ? 0 : 1;
	} catch (error) {
		console.error(
			`ERROR: ${error instanceof Error ? error.message : String(error)}`,
		);
		return 2;
	}
}

if (
	process.argv[1] &&
	import.meta.url === pathToFileURL(process.argv[1]).href
) {
	process.exitCode = main();
}
