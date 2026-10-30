import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-other-project-names");

rule.valid(
	"a name inside an MIT notice",
	"/** The base prompt is adapted from opencode's (github.com/sst/opencode), MIT License, Copyright (c) 2025 opencode. */\nexport const prompt = '';",
);
rule.valid(
	"a name inside an MIT notice wrapped across lines",
	"/*\n * Follows opencode's protocol (github.com/sst/opencode), MIT\n * License, Copyright (c) 2025 opencode.\n */\nexport const body = 1;",
);
rule.valid("a name in code, not in a comment", "// The words the transcription heard.\nexpect(words).toEqual(['hello', 'from', 'opencode']);");
rule.valid("a word that only contains a name", "// A chorded keystroke opens the palette.\nconst keys = 1;");

rule.invalid(
	"a name in a line comment",
	"// Matches what opencode does here.\nconst x = 1;",
	"Comments do not name other projects (opencode); an adapted file says where it came from in its MIT notice.",
);
rule.invalid("a name in a doc comment", "/** Ported from pi-mono's agent loop. */\nexport function loop(): void {}", 1);
rule.invalid("a capitalised name in a block comment", "const y = 2; /* as Chord names it */", 1);
