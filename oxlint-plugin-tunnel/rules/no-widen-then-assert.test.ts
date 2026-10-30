import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-widen-then-assert");

rule.valid("a widened binding never asserted", "const source = { id: 'first' }; const widened: unknown = source;");
rule.valid("an assertion of input that was never known", "declare const input: unknown; const parsed = input as { readonly id: string };");

rule.invalid(
	"a known value widened to unknown and asserted back",
	"const source = { id: 'second' }; const widened: unknown = source; const parsed = widened as { readonly id: string };",
	'Binding "widened" discards type evidence and later recreates it with an assertion. Keep the precise type from initialization through use; parse boundary input once.',
);
