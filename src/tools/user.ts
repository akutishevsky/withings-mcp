import { getUserDevices, getUserGoals } from "../withings/api.js";
import { addReadableTimestamps } from "../utils/timestamp.js";
import { withAnalytics } from "./index.js";

export function registerUserTools(server: any, mcpAccessToken: string) {
  // Register get_user_devices tool
  server.registerTool(
    "get_user_devices",
    {
      description:
        "Get the list of devices linked to the user's account. Returns device information including type, model, battery level, MAC address, firmware version, network status, timezone, and session dates.",
      inputSchema: {},
    },
    async () => {
      return withAnalytics(
        "get_user_devices",
        async () => {
          const devices = await getUserDevices(mcpAccessToken);

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(devices);

          return {
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
      description:
        "Get the user's health and fitness goals. Returns goals for steps (daily step count target), sleep (daily sleep duration target in seconds), and weight (target weight with value and unit).",
      inputSchema: {},
    },
    async () => {
      return withAnalytics(
        "get_user_goals",
        async () => {
          const goals = await getUserGoals(mcpAccessToken);

          return {
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
