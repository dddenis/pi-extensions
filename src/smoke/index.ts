import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const commandName = "pi-extensions-smoke";

export default function smokeExtension(pi: ExtensionAPI) {
  pi.registerCommand(commandName, {
    description: "Verify the pi-extensions smoke extension is loaded",
    handler: async (_args, ctx) => {
      ctx.ui.notify("pi-extensions smoke extension loaded", "info");
    },
  });
}
