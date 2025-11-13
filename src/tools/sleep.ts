import { z } from "zod";
import { getSleepSummary } from "../withings/api.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "tools:sleep" });

export function registerSleepTools(server: any, mcpAccessToken: string) {
  server.registerTool(
    "get_sleep_summary",
    {
      description:
        "Get sleep summary data including sleep duration, sleep stages (light, deep, REM), heart rate, breathing quality, and sleep score. Returns aggregated sleep metrics for specified date range.",
      inputSchema: {
        startdateymd: z
          .string()
          .optional()
          .describe(
            "Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."
          ),
        enddateymd: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."
          ),
        lastupdate: z
          .number()
          .optional()
          .describe(
            "Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."
          ),
        data_fields: z
          .string()
          .optional()
          .describe(
            "Comma-separated list of data fields to return (e.g., 'total_sleep_time,sleep_score,hr_average'). If not specified, all available fields are returned."
          ),
      },
    },
    async (args: any) => {
      logger.info("Tool invoked: get_sleep_summary");
      try {
        const sleepData = await getSleepSummary(
          mcpAccessToken,
          args.startdateymd,
          args.enddateymd,
          args.lastupdate,
          args.data_fields
        );
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(sleepData, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_sleep_summary");
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
