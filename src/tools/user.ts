import { z } from "zod";
import { getUserDevices, getUserGoals } from "../withings/api.js";
import { addReadableTimestamps } from "../utils/timestamp.js";
import { withAnalytics } from "./index.js";

export function registerUserTools(server: any, mcpAccessToken: string) {
  // Register get_user_devices tool
  server.registerTool(
    "get_user_devices",
    {
      title: "User Devices",
      description:
        "Get the list of devices linked to the user's account. Returns device information including type, model, battery level, MAC address, firmware version, network status, timezone, and session dates.",
      inputSchema: {},
      outputSchema: {
        devices: z
          .array(z.object({}).passthrough())
          .describe("List of Withings devices"),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      return withAnalytics(
        "get_user_devices",
        async () => {
          const devices = await getUserDevices(mcpAccessToken);

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(devices);

          return {
            structuredContent: processedData,
            content: [
              {
                type: "text",
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        },
        { mcpAccessToken }
      );
    }
  );

  // Register get_user_goals tool
  server.registerTool(
    "get_user_goals",
    {
      title: "User Goals",
      description:
        "Get the user's health and fitness goals. Returns goals for steps (daily step count target), sleep (daily sleep duration target in seconds), and weight (target weight with value and unit).",
      inputSchema: {},
      outputSchema: {
        steps: z.number().optional(),
        sleep: z.number().optional(),
        weight: z
          .object({ value: z.number(), unit: z.number() })
          .passthrough()
          .optional(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: true,
      },
    },
    async () => {
      return withAnalytics(
        "get_user_goals",
        async () => {
          const goals = await getUserGoals(mcpAccessToken);

          return {
            structuredContent: goals,
            content: [
              {
                type: "text",
                text: JSON.stringify(goals, null, 2),
              },
            ],
          };
        },
        { mcpAccessToken }
      );
    }
  );
}
