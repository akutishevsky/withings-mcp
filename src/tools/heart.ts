import { z } from "zod";
import { listHeartRecords, getHeartSignal } from "../withings/api.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "tools:heart" });

export function registerHeartTools(server: any, mcpAccessToken: string) {
  // Register list_heart_records tool
  server.registerTool(
    "list_heart_records",
    {
      description:
        "Get a list of ECG (electrocardiogram) records with Afib (atrial fibrillation) classification for a given time period. Returns ECG metadata including signal IDs, timestamps, heart rate, Afib detection results, and blood pressure measurements (if taken with BPM Core). Use the signal ID from this list with get_heart_signal to retrieve the full ECG waveform data.",
      inputSchema: {
        startdate: z
          .number()
          .optional()
          .describe("Start date as Unix timestamp. Optional."),
        enddate: z
          .number()
          .optional()
          .describe("End date as Unix timestamp. Optional."),
        offset: z
          .number()
          .optional()
          .describe(
            "Pagination offset. Use value from previous response when more=true"
          ),
      },
    },
    async (args: any) => {
      logger.info("Tool invoked: list_heart_records");
      try {
        const records = await listHeartRecords(
          mcpAccessToken,
          args.startdate,
          args.enddate,
          args.offset
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(records, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: list_heart_records");
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

  // Register get_heart_signal tool
  server.registerTool(
    "get_heart_signal",
    {
      description:
        "Get detailed ECG (electrocardiogram) signal data in micro-volts (μV) for a specific recording. Returns high-frequency waveform data with sampling information. Recording duration: BPM Core (20s), Move ECG/ScanWatch (30s). Sampling frequency: BPM Core (500 Hz), Move ECG/ScanWatch (300 Hz). First use list_heart_records to get the signal ID.",
      inputSchema: {
        signalid: z
          .string()
          .describe(
            "ID of the ECG signal to retrieve. Obtain this from list_heart_records response."
          ),
        with_filtered: z
          .boolean()
          .optional()
          .describe(
            "Request filtered version of the signal. Optional, defaults to false."
          ),
        with_intervals: z
          .boolean()
          .optional()
          .describe(
            "Request features with inactive ones. Optional, defaults to false."
          ),
      },
    },
    async (args: any) => {
      logger.info("Tool invoked: get_heart_signal");
      try {
        const signal = await getHeartSignal(
          mcpAccessToken,
          args.signalid,
          args.with_filtered,
          args.with_intervals
        );

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(signal, null, 2),
            },
          ],
        };
      } catch (error) {
        logger.error("Tool error: get_heart_signal");
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
