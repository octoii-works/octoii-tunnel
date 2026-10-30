import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("require-export-doc");

rule.valid("a documented function", "/** Adds one. */\nexport function next(value: number): number { return value + 1; }");
rule.valid("a documented type and constant", "/** A size. */\nexport type Size = number;\n/** The largest size. */\nexport const MAX_SIZE = 4;");
rule.valid("a re-export", "export { next } from './next.ts';");
rule.valid("a documented default", "/** The plugin. */\nexport default { name: 'x' };");
rule.invalid("an undocumented function", "export function next(value: number): number { return value + 1; }", 1);
rule.invalid("a line comment is no doc comment", "// A size.\nexport type Size = number;", 1);
rule.invalid("a plain block comment is no doc comment", "/* A class. */\nexport class Thing {}", 1);
rule.invalid("an undocumented default", "export default function run() {}", 1);
