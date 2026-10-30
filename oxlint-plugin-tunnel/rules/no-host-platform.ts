import { defineRule } from "@oxlint/plugins";
import { fieldOf, identifierName, memberNames } from "../shared/syntax.ts";

/** The host's clock, timers and randomness, as `object.method` calls. */
const HOST_CALLS = [
	["Date", "now"],
	["performance", "now"],
	["Math", "random"],
	["crypto", "getRandomValues"],
	["crypto", "randomUUID"],
] as const;

/** The host's timers, called by name. */
const HOST_TIMERS = new Set(["setTimeout", "setInterval", "clearTimeout", "clearInterval"]);

/**
 * Portable code reads no clock, timer or randomness of the host's: the client takes them from the `Platform` its caller
 * gives, and the relay core from its host's interfaces, so a test moves the clock and an engine without them still runs.
 */
export default defineRule({
	meta: { type: "problem", docs: { description: "Disallow the host's clock, timers and randomness in portable code." } },
	create(context) {
		const message = "Portable code takes its clock, timers and randomness from the Platform or the host it is given.";
		return {
			CallExpression(node) {
				const names = memberNames(fieldOf(node, "callee"));
				const timer = identifierName(fieldOf(node, "callee"));
				const host = names !== undefined && HOST_CALLS.some(([object, method]) => names[0] === object && names[1] === method);
				if (host || (timer !== undefined && HOST_TIMERS.has(timer))) context.report({ node, message });
			},
			NewExpression(node) {
				if (identifierName(node.callee) === "Date" && node.arguments.length === 0) context.report({ node, message });
			},
		};
	},
});
