import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-unexplained-skips");

rule.valid("a plain test", "it('runs', () => {});");
rule.valid("a skipped test with a comment", "// The sandbox needs macOS's seatbelt.\nit.skip('sandboxes', () => {});");
rule.valid("a skipIf, whose condition is its reason", "it.skipIf(process.platform !== 'darwin')('sandboxes', () => {});");
rule.valid(
	"a test with its own timeout and a comment",
	"describe('cases', () => {\n\t// Each case runs on the host engine too.\n\tit('one', async () => {}, 30_000);\n});",
);

rule.invalid(
	"a skipped test without a comment",
	"it.skip('sandboxes', () => {});",
	"Say why in a comment right before it: a skipped test, or one with a timeout of its own.",
);
rule.invalid("a todo test without a comment", "test.todo('reconnects');", 1);
rule.invalid("a test with its own timeout and no comment", "describe('cases', () => {\n\tit('one', async () => {}, 30_000);\n});", 1);
rule.invalid("a test with a timeout option and no comment", "it('slow', async () => {}, { timeout: 5_000 });", 1);
