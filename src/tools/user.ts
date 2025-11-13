import { getUserDevices, getUserGoals } from "../withings/api.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "tools:user" });

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
      logger.info("Tool invoked: get_user_devices");
      try {
        const devices = await getUserDevices(mcpAccessToken);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(devices, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_user_devices");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
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
      logger.info("Tool invoked: get_user_goals");
      try {
        const goals = await getUserGoals(mcpAccessToken);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(goals, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_user_goals");
        return {
          content: [
            {
              type: "text",
              text: `Error: ${
                error instanceof Error ? error.message : String(error)
              }`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
