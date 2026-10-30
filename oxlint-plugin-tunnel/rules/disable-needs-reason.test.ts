import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("disable-needs-reason");
const LINT_MESSAGE = "Say why the rule is off, after ` -- `: `// oxlint-disable-next-line rule -- reason`.";
const TYPE_CHECK_MESSAGE = "Say why the type checker is silenced, after the directive: `// @ts-expect-error reason`.";

rule.valid(
	"a line disable with a reason",
	"// oxlint-disable-next-line no-control-regex -- matching control characters is the point\nconst pattern = /\\x1b/;",
);
rule.valid("a block disable with a reason", "/* oxlint-disable no-new -- constructing it is the parse */\nnew URL('a:');");
rule.valid("a comment that only mentions disable comments", "// The linter's disable comments say why.\nconst x = 1;");
rule.valid("a type-checker suppression with a reason", "// @ts-expect-error A yes/no answer has no chosen option.\nanswer.option;");
rule.valid(
	"a block type-checker suppression with a reason after a colon",
	"/* @ts-ignore: the generated file has no types */\nimport parse from './parse.js';",
);
rule.valid("a word that only starts like a directive", "// @ts-expect-errors are explained in the guide.\nconst y = 1;");

rule.invalid("a line disable without a reason", "// oxlint-disable-next-line unicorn/no-thenable\nconst value = { then() {} };", LINT_MESSAGE);
rule.invalid("an eslint line disable without a reason", "const a = 1; // eslint-disable-line no-unused-vars", 1);
rule.invalid("a block disable without a reason", "/* oxlint-disable no-new */\nnew URL('a:');", 1);
rule.invalid("a disable with an empty reason", "// oxlint-disable-next-line no-new --\nnew URL('a:');", 1);
rule.invalid("a type-checker suppression without a reason", "// @ts-expect-error\nanswer.option;", TYPE_CHECK_MESSAGE);
rule.invalid("a type-checker suppression whose reason is only punctuation", "// @ts-ignore -- \nanswer.option;", 1);
rule.invalid("a file-wide type-checker suppression without a reason", "/* @ts-nocheck */\nconst z = 1;", 1);
