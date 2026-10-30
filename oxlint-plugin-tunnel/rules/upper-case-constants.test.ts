import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("upper-case-constants");

rule.valid("upper-case constants", "const MAX_SIZE = 4;\nexport const PREFIX = 'x';\nconst WINDOW = 5 * 60_000;\nconst NEGATIVE = -1;");
rule.valid("a value that is no literal", "const empty = new Uint8Array(0);\nconst table = { a: 1 };\nconst pattern = /x/;");
rule.valid("a constant inside a function", "function f() { const size = 4; return size; }");
rule.valid("a template with a value", "const name = `${1}`;");
rule.invalid("a lower-case literal", "const maxSize = 4;", 1);
rule.invalid("an exported lower-case sum", "export const window = 5 * 60_000;", 1);
rule.invalid("a lower-case string", "const prefix = 'x';\nconst path = `/secure`;", 2);
