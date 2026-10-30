import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-boolean-parameters");

rule.valid("a required boolean value", "export function cardState(card: Card, connected: boolean): State { return card.state; }");
rule.valid(
	"a flag inside an options object",
	"export function useNow(intervalMs: number, { ticking = true }: { readonly ticking?: boolean } = {}): number { return 0; }",
);
rule.valid("a flag of a function that is not exported", "function local(short = false): string { return String(short); }");
rule.valid("a default that is not a boolean", "export function retry(attempts = 3): void {}");
rule.valid("an exported arrow function", "export const values = (all = false) => all;");

rule.invalid(
	"a parameter that defaults to false",
	"export function gitLine(workspace: Workspace, short = false): string { return ''; }",
	"gitLine takes a boolean flag: make it two functions, or an options object that names the cases.",
);
rule.invalid("an optional boolean parameter", "export function toolResult(id: string, isError?: boolean): Result { return { id }; }", 1);
rule.invalid("a flag of a default export", "export default function render(visible = true): void {}", 1);
rule.invalid("each of two flags", "export function both(a = true, b?: boolean): void {}", 2);
