/**
 * The scan of platform-neutral sources: what the Hermes of React Native 0.88 (260318099.0.4) refuses or lacks, as its
 * compiler builds code after React Native's Babel preset, and what no platform-neutral code may rely on, such as the
 * host's clock, timers and randomness, which the client takes as its `Platform`.
 */

/** What the Hermes of React Native 0.88 refuses or lacks, and what no platform-neutral code may rely on. */
export const FORBIDDEN: readonly { readonly name: string; readonly pattern: RegExp }[] = [
	// Hermes compiles no async generator; `for await` it runs.
	{ name: "an async generator", pattern: /\basync\s+function\s*\*|\basync\s*\*\s*[\w$["']/ },
	{ name: "using", pattern: /\b(?:await\s+)?using\s+[\w$]+\s*=/ },
	{ name: "an accessor field", pattern: /\baccessor\s+[\w$#]+/ },
	// Comments are gone and strings emptied, so an `@` left in code starts a decorator.
	{ name: "a decorator", pattern: /@[A-Za-z_$]/ },
	// React Native's Babel preset refuses a class static block.
	{ name: "a class static block", pattern: /\bstatic\s*\{/ },
	// Hermes runs scripts; Metro resolves modules before it.
	{ name: "dynamic import or import.meta", pattern: /\bimport\s*\(|\bimport\.meta\b/ },
	// Arrays have `toReversed`, `toSpliced` and `with`; the scan conservatively refuses them with typed arrays.
	{ name: "a missing array method", pattern: /\.(?:toSorted|toReversed|toSpliced|with)\(|\bArray\.fromAsync\b/ },
	{ name: "Uint8Array's base64 or hex", pattern: /\.(?:toBase64|toHex|setFromBase64|setFromHex)\(|\bUint8Array\.from(?:Base64|Hex)\b/ },
	{
		name: "a missing built-in",
		pattern:
			/\.getOrInsert(?:Computed)?\(|\.(?:resize|transfer|transferToFixedLength|[gs]etFloat16)\(|\.detached\b|\bmaxByteLength\b|\b(?:DisposableStack|AsyncDisposableStack|SuppressedError|Symbol\.(?:dispose|asyncDispose|species|unscopables)|RegExp\.escape|Float16Array|Math\.f16round|SharedArrayBuffer|Atomics|Iterator\.(?:concat|zip)|JSON\.(?:rawJSON|isRawJSON)|Temporal|Error\.(?:stackTraceLimit|prepareStackTrace))\b/,
	},
	{
		name: "a missing Intl service",
		pattern: /\bIntl\.(?:PluralRules|RelativeTimeFormat|ListFormat|DisplayNames|Locale|Segmenter|DurationFormat|supportedValuesOf)\b/,
	},
	// Neither the engine nor React Native has these.
	{ name: "a missing global", pattern: /\b(?:structuredClone|WebAssembly|CompressionStream|DecompressionStream)\b/ },
	// workerd makes no code at run time, and code that makes code is not deterministic.
	{ name: "code made at run time", pattern: /\beval\s*\(|\bnew\s+Function\b|\bFunction\s*\(/ },
	{
		name: "a platform global",
		pattern:
			/(?<![\w$.])(?:Buffer|process|Bun|Deno|navigator)\s*\.|(?<![\w$.])require\s*\(\s*""|\bwindow\.(?:location|localStorage|sessionStorage|addEventListener|removeEventListener|dispatchEvent)\b|\bdocument\.(?:createElement|getElementById|querySelector|addEventListener|removeEventListener)\b/,
	},
	{ name: "crypto", pattern: /\bcrypto\b/ },
	// Hermes reads date strings its own way, invalid ones included; a string emptied to "" is still a string.
	{ name: "date parsing", pattern: /\bDate\.parse\b|\bnew\s+Date\s*\(\s*""/ },
	// React Native's URL is not the WHATWG URL.
	{ name: "a URL", pattern: /\bnew\s+URL\b|\bURL\.(?:parse|canParse)\b|\bURLSearchParams\b/ },
	{ name: "a regular expression modifier", pattern: /\(\?[imsx-]+:/ },
	{ name: "the regular expression v flag", pattern: /\/[dgimsuy]*v[dgimsuy]*(?=[\s,;).\]]|$)/m },
];

/** Hidden time, allowed in `/web` alone: the caller's clock gives the time, a rule of the client's, not a Hermes limit. */
export const CLOCK: readonly { readonly name: string; readonly pattern: RegExp }[] = [
	{ name: "Date.now", pattern: /\bDate\.now\b|\bnew\s+Date\s*\(\s*\)/ },
	{ name: "performance time", pattern: /\bperformance\.(?:now|timeOrigin)\b/ },
	{ name: "a timer", pattern: /\b(?:setTimeout|setInterval|setImmediate|clearTimeout|clearInterval)\b/ },
];
/** Hidden randomness, which a platform supplies. */
export const RANDOM = /\bMath\.random\b/;

/** Source with comments and literal text removed, leaving template expressions in the scan. */
export function sourceCode(text: string): string {
	return sourceParts(text).code;
}

function sourceParts(text: string): { readonly code: string; readonly expressions: readonly string[] } {
	let code = "";
	const expressions: string[] = [];
	const templates: number[] = [];
	let templateText = false;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		const next = text[index + 1];
		if (templateText) {
			if (character === "\\") index++;
			else if (character === "`") templateText = false;
			else if (character === "$" && next === "{") {
				templates.push(0);
				templateText = false;
				index++;
			}
			continue;
		}
		if (character === "`") {
			templateText = true;
			code += '""';
			continue;
		}
		if (character === '"' || character === "'") {
			index = quotedEnd(text, index);
			code += '""';
			continue;
		}
		if (character === "/" && (next === "/" || next === "*")) {
			index = commentEnd(text, index);
			code += "\n";
			continue;
		}
		const expression = character === "/" ? regexLiteralAt(text, index, code) : undefined;
		if (expression !== undefined) {
			expressions.push(expression);
			code += "/expression/";
			index += expression.length - 1;
			continue;
		}
		const depth = templates.at(-1);
		if (depth !== undefined) {
			if (character === "{") templates[templates.length - 1] = depth + 1;
			if (character === "}") {
				if (depth === 0) {
					templates.pop();
					templateText = true;
					continue;
				}
				templates[templates.length - 1] = depth - 1;
			}
		}
		code += character;
	}
	return { code, expressions };
}

/** The index of the quote that closes the string literal opening at `start`, or the end of `text`. */
function quotedEnd(text: string, start: number): number {
	const quote = text[start];
	let index = start;
	while (++index < text.length) {
		if (text[index] === "\\") index++;
		else if (text[index] === quote) break;
	}
	return index;
}

/** The index of the last character of the comment opening at `start`: the one before its line break, or its closing slash. */
function commentEnd(text: string, start: number): number {
	const block = text[start + 1] === "*";
	const closing = block ? text.indexOf("*/", start + 2) : text.indexOf("\n", start + 2);
	return closing < 0 ? text.length : closing + (block ? 1 : 0);
}

/** The regular expression literal at `index`, where the code before it leaves a slash no division; undefined otherwise. */
function regexLiteralAt(text: string, index: number, codeBefore: string): string | undefined {
	if (!/(?:^|[({[=,:;!?&|+*%^~<>-]|\breturn|\bthrow|\bcase|\byield)\s*$/.test(codeBefore)) return undefined;
	return /^\/(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\n])+\/[a-z]*/i.exec(text.slice(index))?.[0];
}

/** Portability rules violated by source text. */
export function portabilityFindings(text: string): string[] {
	const { code, expressions } = sourceParts(text);
	const findings = FORBIDDEN.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name);
	for (const expression of expressions) {
		for (const rule of FORBIDDEN) {
			if (rule.name.includes("regular expression") && rule.pattern.test(expression) && !findings.includes(rule.name)) findings.push(rule.name);
		}
		const names = [...expression.matchAll(/\(\?<([\w$]+)>/g)].map((group) => group[1]);
		if (new Set(names).size !== names.length) findings.push("a repeated regular expression group");
	}
	return findings;
}

/** Reads of the host's time, timers or randomness that neutral callers receive through a platform. */
export function platformReadings(text: string): string[] {
	const code = sourceCode(text);
	return [...CLOCK.filter(({ pattern }) => pattern.test(code)).map(({ name }) => name), ...(RANDOM.test(code) ? ["Math.random"] : [])];
}

/**
 * What in `text`, the source of the platform-neutral file `file`, breaks the Hermes rules or reads the host's time,
 * timers or randomness: one line per finding, naming the file.
 */
export function portabilityProblems(file: string, text: string): string[] {
	return [...portabilityFindings(text), ...platformReadings(text)].map((name) => `${file} uses ${name}`);
}
