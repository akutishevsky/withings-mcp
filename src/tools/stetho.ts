import { z } from "zod";
import { listStethoRecords, getStethoSignal } from "../withings/api.js";
import { addReadableTimestamps } from "../utils/timestamp.js";
import { withAnalytics } from "./index.js";

export function registerStethoTools(server: any, mcpAccessToken: string) {
  // Register list_stetho_records tool
  server.registerTool(
    "list_stetho_records",
    {
      description:
        "Get a list of stethoscope recordings for a given time period. Returns metadata including signal IDs, timestamps, device IDs, valve heart disease (VHD) indicators, and timezone information. Use the signal ID from this list with get_stetho_signal to retrieve the full audio signal data.",
      inputSchema: {
        startdate: z
          .string()
          .optional()
          .describe(
            "Start date in YYYY-MM-DD format (e.g., '2025-11-01'). The date represents midnight UTC of that day."
          ),
        enddate: z
          .string()
          .optional()
          .describe(
            "End date in YYYY-MM-DD format (e.g., '2025-11-30')."
          ),
        offset: z
          .number()
          .optional()
          .describe(
            "Pagination offset. Use value from previous response when more=true"
          ),
      },
    },
    async (args: any) => {
      return withAnalytics(
        "list_stetho_records",
        async () => {
          const records = await listStethoRecords(
            mcpAccessToken,
            args.startdate,
            args.enddate,
            args.offset
          );

          // Add readable datetime fields for timestamps
          const processedData = addReadableTimestamps(records);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(processedData, null, 2),
              },
            ],
          };
        },
        args
      );
    }
  );

  // Register get_stetho_signal tool
  server.registerTool(
    "get_stetho_signal",
    {
      description:
        "Get detailed stethoscope audio signal data for a specific recording. Returns the raw audio signal array along with technical metadata including frequency, duration, format, size, resolution, channel information, device model, stethoscope position, and valve heart disease (VHD) indicators. First use list_stetho_records to get the signal ID.",
      inputSchema: {
        signalid: z
          .string()
          .describe(
            "ID of the stethoscope signal to retrieve. Obtain this from list_stetho_records response."
          ),
      },
    },
    async (args: any) => {
      return withAnalytics("get_stetho_signal", async () => {
        const signal = await getStethoSignal(mcpAccessToken, args.signalid);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(signal, null, 2),
            },
          ],
        };
      });
    }
  );
}
