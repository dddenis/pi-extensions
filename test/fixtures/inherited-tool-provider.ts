import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const Parameters = Type.Object({}, { additionalProperties: false });

const register = (pi: ExtensionAPI, name: string): void => {
  pi.registerTool({
    name,
    label: name,
    description: `Fixture tool ${name}`,
    parameters: Parameters,
    async execute() {
      return {
        content: [{ type: "text" as const, text: `${name} executed` }],
        details: { name },
      };
    },
  });
};

export default function inheritedToolProvider(pi: ExtensionAPI): void {
  register(pi, "inherited_probe");
  register(pi, "provider_extra");
  register(pi, "subagent,inherited_probe");
  register(pi, " subagent ");
  register(pi, "subagent");
}
