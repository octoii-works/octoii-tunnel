import { ruleTester } from "../test/harness.ts";

const rule = ruleTester("connector-not-agent");

rule.valid("the connector", "const connector = 1;\nclass Connector {}\nfunction connectDevice() {}");
rule.valid("the HTTP user agent", "const userAgent = 'x';\nconst USER_AGENT = 'y';");
rule.invalid("an agent variable", "const agent = 1;", 1);
rule.invalid("an agent class and function", "class DeviceAgent {}\nfunction startAgent() {}", 2);
rule.invalid("an agent member and type", "type AgentOptions = {};\nclass X { agentId = 1; }", 2);
