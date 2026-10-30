import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("no-host-platform");

rule.valid("the platform's clock", "export function later(platform) { return platform.clock.now() + 1; }");
rule.valid("the platform's timer", "export function wait(platform, run) { return platform.clock.setTimer(run, 10); }");
rule.valid("a date of a given time", "export function day(time) { return new Date(time).getUTCDay(); }");
rule.invalid("the host's clock", "export const now = () => Date.now();", 1);
rule.invalid("the host's timers", "setTimeout(() => {}, 1);\nsetInterval(() => {}, 1);", 2);
rule.invalid("the host's randomness", "const a = Math.random();\nconst b = crypto.getRandomValues(new Uint8Array(4));\nconst c = crypto.randomUUID();", 3);
rule.invalid("a date of now", "const now = new Date();", 1);
