#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { createOAuthRouter, initOAuthStore } from "./oauth.js";
import { tokenStore } from "./token-store.js";
import { streamSSE } from "hono/streaming";
import { HonoSSETransport, sessionManager } from "./mcp-transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getSleepSummary, getMeasures, getWorkouts } from "./withings-api.js";
import { z } from "zod";

// Initialize stores
await tokenStore.init();
await initOAuthStore();

const app = new Hono();

// OAuth configuration
const oauthConfig = {
  clientId: process.env.WITHINGS_CLIENT_ID || "",
  clientSecret: process.env.WITHINGS_CLIENT_SECRET || "",
  redirectUri: process.env.WITHINGS_REDIRECT_URI || "http://localhost:3000/callback",
};

// Mount OAuth router at root level (per spec)
app.route("/", createOAuthRouter(oauthConfig));

// Backwards compatibility redirect for old callback URL
app.get("/auth/callback", (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const url = new URL(c.req.url);
  url.pathname = "/callback";
  return c.redirect(url.toString());
});

const mcpServer = new McpServer(
  {
    name: "withings-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// TODO: Register tools here when ready
// Example: mcpServer.registerTool("tool_name", { description: "..." }, async (args) => { ... });

// MCP endpoint - handles both GET (SSE) and POST (JSON-RPC messages)
const mcpEndpoint = "/mcp";

// Bearer token authentication middleware
const authenticateBearer = async (c: any, next: any) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.error("MCP request missing Bearer token");
    return c.json({ error: "unauthorized", error_description: "Bearer token required" }, 401);
  }

  const token = authHeader.substring(7);
  const isValid = await tokenStore.isValid(token);
  if (!isValid) {
    console.error("MCP request with invalid token");
    return c.json({ error: "invalid_token", error_description: "Token is invalid or expired" }, 401);
  }

  console.log("MCP request authenticated successfully");

  // Store token in context for later use
  c.set("accessToken" as any, token);
  await next();
};

// GET - Initiate SSE stream for MCP
app.get(mcpEndpoint, authenticateBearer, async (c) => {
  // Get or create session ID
  const sessionId = c.req.header("Mcp-Session-Id") || crypto.randomUUID();

  console.log("SSE connection request for session:", sessionId);

  // Get the MCP access token from context
  const mcpAccessToken = (c as any).get("accessToken") as string;

  // Check for existing session
  const existingSession = sessionManager.getSession(sessionId);
  if (existingSession) {
    console.log("Closing existing session");
    // Close existing transport if any
    await existingSession.transport.close();
    sessionManager.deleteSession(sessionId);
  }

  console.log("Setting response headers with session ID:", sessionId);

  // Create a ReadableStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Helper to write SSE events
  const writeSSE = async (data: string, event?: string) => {
    try {
      if (event) {
        await writer.write(encoder.encode(`event: ${event}\n`));
      }
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    } catch (error) {
      console.error("Error writing SSE:", error);
    }
  };

  // Create transport
  const transport = new HonoSSETransport();
  transport.attachStream({
    writeSSE: async (data: { data: string; event?: string; id?: string }) => {
      await writeSSE(data.data, data.event);
    },
    close: () => {
      writer.close();
    },
  });

  console.log("Transport created and stream attached");

  // Start async initialization
  (async () => {
    try {
      // Create new MCP server instance for this session
      const sessionServer = new McpServer(
      {
        name: "withings-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register Withings tools
    console.log("Registering Withings tools...");
    sessionServer.registerTool(
      "get_sleep_summary",
      {
        description: "Get sleep summary data including sleep duration, sleep stages (light, deep, REM), heart rate, breathing quality, and sleep score. Returns aggregated sleep metrics for specified date range.",
        inputSchema: {
          startdateymd: z.string().optional().describe("Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."),
          enddateymd: z.string().optional().describe("End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."),
          lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."),
          data_fields: z.string().optional().describe("Comma-separated list of data fields to return (e.g., 'total_sleep_time,sleep_score,hr_average'). If not specified, all available fields are returned."),
        },
      },
      async (args: any) => {
        console.log("get_sleep_summary tool called with args:", args);
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
          console.error("Error fetching sleep data:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    sessionServer.registerTool(
      "get_measures",
      {
        description: "Get health measures including weight, height, body composition, blood pressure, heart rate, temperature, and more. Supports single or multiple measure types.",
        inputSchema: {
          meastype: z.number().optional().describe("Single measure type ID. Available types: 1=Weight(kg), 4=Height(meter), 5=Fat Free Mass(kg), 6=Fat Ratio(%), 8=Fat Mass Weight(kg), 9=Diastolic Blood Pressure(mmHg), 10=Systolic Blood Pressure(mmHg), 11=Heart Pulse(bpm)-only for BPM and scale devices, 12=Temperature(celsius), 54=SP02(%), 71=Body Temperature(celsius), 73=Skin Temperature(celsius), 76=Muscle Mass(kg), 77=Hydration(kg), 88=Bone Mass(kg), 91=Pulse Wave Velocity(m/s), 123=VO2 max is a numerical measurement of your body's ability to consume oxygen(ml/min/kg), 130=Atrial fibrillation result, 135=QRS interval duration based on ECG signal, 136=PR interval duration based on ECG signal, 137=QT interval duration based on ECG signal, 138=Corrected QT interval duration based on ECG signal, 139=Atrial fibrillation result from PPG, 155=Vascular age, 167=Nerve Health Score Conductance 2 electrodes Feet, 168=Extracellular Water in kg, 169=Intracellular Water in kg, 170=Visceral Fat(without unity), 173=Fat Free Mass for segments, 174=Fat Mass for segments in mass unit, 175=Muscle Mass for segments, 196=Electrodermal activity feet, 226=Basal Metabolic Rate(BMR), 227=Metabolic Age, 229=Electrochemical Skin Conductance(ESC)"),
          meastypes: z.string().optional().describe("Comma-separated list of measure type IDs (e.g., '1,9,10' for weight and blood pressure). Available types: 1=Weight(kg), 4=Height(meter), 5=Fat Free Mass(kg), 6=Fat Ratio(%), 8=Fat Mass Weight(kg), 9=Diastolic Blood Pressure(mmHg), 10=Systolic Blood Pressure(mmHg), 11=Heart Pulse(bpm)-only for BPM and scale devices, 12=Temperature(celsius), 54=SP02(%), 71=Body Temperature(celsius), 73=Skin Temperature(celsius), 76=Muscle Mass(kg), 77=Hydration(kg), 88=Bone Mass(kg), 91=Pulse Wave Velocity(m/s), 123=VO2 max is a numerical measurement of your body's ability to consume oxygen(ml/min/kg), 130=Atrial fibrillation result, 135=QRS interval duration based on ECG signal, 136=PR interval duration based on ECG signal, 137=QT interval duration based on ECG signal, 138=Corrected QT interval duration based on ECG signal, 139=Atrial fibrillation result from PPG, 155=Vascular age, 167=Nerve Health Score Conductance 2 electrodes Feet, 168=Extracellular Water in kg, 169=Intracellular Water in kg, 170=Visceral Fat(without unity), 173=Fat Free Mass for segments, 174=Fat Mass for segments in mass unit, 175=Muscle Mass for segments, 196=Electrodermal activity feet, 226=Basal Metabolic Rate(BMR), 227=Metabolic Age, 229=Electrochemical Skin Conductance(ESC)"),
          startdate: z.number().optional().describe("Start date as Unix timestamp"),
          enddate: z.number().optional().describe("End date as Unix timestamp"),
          lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated/created after this date. Use for synchronization instead of startdate/enddate"),
          offset: z.number().optional().describe("Pagination offset. Use value from previous response when more=1"),
        },
      },
      async (args: any) => {
        console.log("get_measures tool called with args:", args);
        try {
          const measures = await getMeasures(
            mcpAccessToken,
            args.meastype,
            args.meastypes,
            args.startdate,
            args.enddate,
            args.lastupdate,
            args.offset
          );

          // Map measure type IDs to descriptions
          const measureTypeMap: Record<number, string> = {
            1: "Weight (kg)",
            4: "Height (meter)",
            5: "Fat Free Mass (kg)",
            6: "Fat Ratio (%)",
            8: "Fat Mass Weight (kg)",
            9: "Diastolic Blood Pressure (mmHg)",
            10: "Systolic Blood Pressure (mmHg)",
            11: "Heart Pulse (bpm) - only for BPM and scale devices",
            12: "Temperature (celsius)",
            54: "SP02 (%)",
            71: "Body Temperature (celsius)",
            73: "Skin Temperature (celsius)",
            76: "Muscle Mass (kg)",
            77: "Hydration (kg)",
            88: "Bone Mass (kg)",
            91: "Pulse Wave Velocity (m/s)",
            123: "VO2 max is a numerical measurement of your body's ability to consume oxygen (ml/min/kg)",
            130: "Atrial fibrillation result",
            135: "QRS interval duration based on ECG signal",
            136: "PR interval duration based on ECG signal",
            137: "QT interval duration based on ECG signal",
            138: "Corrected QT interval duration based on ECG signal",
            139: "Atrial fibrillation result from PPG",
            155: "Vascular age",
            167: "Nerve Health Score Conductance 2 electrodes Feet",
            168: "Extracellular Water in kg",
            169: "Intracellular Water in kg",
            170: "Visceral Fat (without unity)",
            173: "Fat Free Mass for segments",
            174: "Fat Mass for segments in mass unit",
            175: "Muscle Mass for segments",
            196: "Electrodermal activity feet",
            226: "Basal Metabolic Rate (BMR)",
            227: "Metabolic Age",
            229: "Electrochemical Skin Conductance (ESC)",
          };

          // Add type descriptions and calculated values to each measure
          if (measures?.measuregrps) {
            measures.measuregrps = measures.measuregrps.map((grp: any) => {
              if (grp.measures) {
                grp.measures = grp.measures.map((measure: any) => {
                  const calculatedValue = measure.value * Math.pow(10, measure.unit);
                  return {
                    ...measure,
                    type_description: measureTypeMap[measure.type] || `Unknown type ${measure.type}`,
                    calculated_value: calculatedValue,
                  };
                });
              }
              return grp;
            });
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(measures, null, 2),
              },
            ],
          };
        } catch (error) {
          console.error("Error fetching measures:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    sessionServer.registerTool(
      "get_workouts",
      {
        description: "Get workout summaries including calories burned, heart rate data, distance, steps, elevation, and swimming metrics. Returns aggregated data for each workout session. By default returns ALL available data fields.",
        inputSchema: {
          startdateymd: z.string().optional().describe("Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."),
          enddateymd: z.string().optional().describe("End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."),
          lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."),
          offset: z.number().optional().describe("Pagination offset. Use value from previous response when more=true"),
          data_fields: z.string().optional().default("calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length").describe("Comma-separated list of data fields to return. Available fields: calories=Active calories(Kcal), intensity=Workout intensity(0-100), manual_distance=User-entered distance(m), manual_calories=User-entered calories(Kcal), hr_average=Average heart rate(bpm), hr_min=Min heart rate(bpm), hr_max=Max heart rate(bpm), hr_zone_0=Light zone duration(sec), hr_zone_1=Moderate zone duration(sec), hr_zone_2=Intense zone duration(sec), hr_zone_3=Maximal zone duration(sec), pause_duration=User pause time(sec), algo_pause_duration=Device-detected pause time(sec), spo2_average=Average SpO2(%), steps=Step count, distance=Distance(m), elevation=Floors climbed, pool_laps=Pool lap count, strokes=Stroke count, pool_length=Pool length(m). Defaults to all fields."),
        },
      },
      async (args: any) => {
        console.log("get_workouts tool called with args:", args);
        try {
          const workouts = await getWorkouts(
            mcpAccessToken,
            args.startdateymd,
            args.enddateymd,
            args.lastupdate,
            args.offset,
            args.data_fields
          );

          // Remove category field from each workout in the series
          if (workouts?.series) {
            workouts.series = workouts.series.map((workout: any) => {
              const { category, ...rest } = workout;
              return rest;
            });
          }

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(workouts, null, 2),
              },
            ],
          };
        } catch (error) {
          console.error("Error fetching workouts:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    console.log("Tools registered successfully");

    // Set up logging for transport messages
    const originalOnMessage = transport.onmessage;
    transport.onmessage = async (message) => {
      console.log("Transport received message:", {
        method: (message as any).method,
        id: (message as any).id
      });
      await originalOnMessage(message);
    };

    try {
      // Connect server to transport
      console.log("Connecting MCP server to transport...");
      await sessionServer.connect(transport);
      console.log("MCP server connected successfully");

      // Store session
      sessionManager.createSession(sessionId, transport);
      console.log("Session stored in session manager");

      // Handle connection close
      c.req.raw.signal.addEventListener("abort", () => {
        sessionManager.deleteSession(sessionId);
      });

      // Keep connection alive - send heartbeat
      const heartbeat = setInterval(async () => {
        try {
          await writeSSE("", "ping");
        } catch (error) {
          clearInterval(heartbeat);
        }
      }, 15000);

      // Cleanup on abort
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
        sessionManager.deleteSession(sessionId);
      });

      } catch (error) {
        console.error("Failed to establish MCP connection:", error);
        sessionManager.deleteSession(sessionId);
        writer.close();
      }
    } catch (error) {
      console.error("Failed to setup MCP server:", error);
      writer.close();
    }
  })();  // End of async IIFE

  // Return SSE response with proper headers immediately
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Mcp-Session-Id": sessionId,
  };

  console.log("Creating SSE response with headers:", headers);

  const response = new Response(readable, { headers });

  console.log("Response created, header check - Mcp-Session-Id:", response.headers.get("Mcp-Session-Id"));

  return response;
});

// POST - Receive JSON-RPC messages from client
app.post(mcpEndpoint, authenticateBearer, async (c) => {
  let sessionId = c.req.header("Mcp-Session-Id");
  const mcpToken = (c as any).get("accessToken") as string;

  console.log("POST message received for session:", sessionId, "token:", mcpToken?.substring(0, 10));

  // If no session ID, this is an initial POST that should establish SSE stream
  if (!sessionId) {
    console.log("POST without session ID - initiating SSE stream");
    sessionId = crypto.randomUUID();

    // Get the JSON-RPC message first
    const message = await c.req.json() as JSONRPCMessage;
    console.log("Initial JSON-RPC message:", { method: (message as any).method, id: (message as any).id });

    // Create SSE stream for response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const writeSSE = async (data: string, event?: string) => {
      try {
        if (event) {
          await writer.write(encoder.encode(`event: ${event}\n`));
        }
        await writer.write(encoder.encode(`data: ${data}\n\n`));
      } catch (error) {
        console.error("Error writing SSE:", error);
      }
    };

    // Create transport
    const transport = new HonoSSETransport();
    transport.attachStream({
      writeSSE: async (data: { data: string; event?: string; id?: string }) => {
        await writeSSE(data.data, data.event);
      },
      close: () => {
        writer.close();
      },
    });

    console.log("Transport created for POST-initiated stream");

    // Start async initialization
    (async () => {
      try {
        // Create new MCP server instance for this session
        const sessionServer = new McpServer(
          {
            name: "withings-mcp",
            version: "1.0.0",
          },
          {
            capabilities: {
              tools: {},
            },
          }
        );

        // Register Withings tools
        console.log("Registering Withings tools...");
        sessionServer.registerTool(
          "get_sleep_summary",
          {
            description: "Get sleep summary data including sleep duration, sleep stages (light, deep, REM), heart rate, breathing quality, and sleep score. Returns aggregated sleep metrics for specified date range.",
            inputSchema: {
              startdateymd: z.string().optional().describe("Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."),
              enddateymd: z.string().optional().describe("End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."),
              lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."),
              data_fields: z.string().optional().describe("Comma-separated list of data fields to return (e.g., 'total_sleep_time,sleep_score,hr_average'). If not specified, all available fields are returned."),
            },
          },
          async (args: any) => {
            console.log("get_sleep_summary tool called with args:", args);
            try {
              const sleepData = await getSleepSummary(
                mcpToken,
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
              console.error("Error fetching sleep data:", error);
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          }
        );

        sessionServer.registerTool(
          "get_measures",
          {
            description: "Get health measures including weight, height, body composition, blood pressure, heart rate, temperature, and more. Supports single or multiple measure types.",
            inputSchema: {
              meastype: z.number().optional().describe("Single measure type ID. Available types: 1=Weight(kg), 4=Height(meter), 5=Fat Free Mass(kg), 6=Fat Ratio(%), 8=Fat Mass Weight(kg), 9=Diastolic Blood Pressure(mmHg), 10=Systolic Blood Pressure(mmHg), 11=Heart Pulse(bpm)-only for BPM and scale devices, 12=Temperature(celsius), 54=SP02(%), 71=Body Temperature(celsius), 73=Skin Temperature(celsius), 76=Muscle Mass(kg), 77=Hydration(kg), 88=Bone Mass(kg), 91=Pulse Wave Velocity(m/s), 123=VO2 max is a numerical measurement of your body's ability to consume oxygen(ml/min/kg), 130=Atrial fibrillation result, 135=QRS interval duration based on ECG signal, 136=PR interval duration based on ECG signal, 137=QT interval duration based on ECG signal, 138=Corrected QT interval duration based on ECG signal, 139=Atrial fibrillation result from PPG, 155=Vascular age, 167=Nerve Health Score Conductance 2 electrodes Feet, 168=Extracellular Water in kg, 169=Intracellular Water in kg, 170=Visceral Fat(without unity), 173=Fat Free Mass for segments, 174=Fat Mass for segments in mass unit, 175=Muscle Mass for segments, 196=Electrodermal activity feet, 226=Basal Metabolic Rate(BMR), 227=Metabolic Age, 229=Electrochemical Skin Conductance(ESC)"),
              meastypes: z.string().optional().describe("Comma-separated list of measure type IDs (e.g., '1,9,10' for weight and blood pressure). Available types: 1=Weight(kg), 4=Height(meter), 5=Fat Free Mass(kg), 6=Fat Ratio(%), 8=Fat Mass Weight(kg), 9=Diastolic Blood Pressure(mmHg), 10=Systolic Blood Pressure(mmHg), 11=Heart Pulse(bpm)-only for BPM and scale devices, 12=Temperature(celsius), 54=SP02(%), 71=Body Temperature(celsius), 73=Skin Temperature(celsius), 76=Muscle Mass(kg), 77=Hydration(kg), 88=Bone Mass(kg), 91=Pulse Wave Velocity(m/s), 123=VO2 max is a numerical measurement of your body's ability to consume oxygen(ml/min/kg), 130=Atrial fibrillation result, 135=QRS interval duration based on ECG signal, 136=PR interval duration based on ECG signal, 137=QT interval duration based on ECG signal, 138=Corrected QT interval duration based on ECG signal, 139=Atrial fibrillation result from PPG, 155=Vascular age, 167=Nerve Health Score Conductance 2 electrodes Feet, 168=Extracellular Water in kg, 169=Intracellular Water in kg, 170=Visceral Fat(without unity), 173=Fat Free Mass for segments, 174=Fat Mass for segments in mass unit, 175=Muscle Mass for segments, 196=Electrodermal activity feet, 226=Basal Metabolic Rate(BMR), 227=Metabolic Age, 229=Electrochemical Skin Conductance(ESC)"),
              startdate: z.number().optional().describe("Start date as Unix timestamp"),
              enddate: z.number().optional().describe("End date as Unix timestamp"),
              lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated/created after this date. Use for synchronization instead of startdate/enddate"),
              offset: z.number().optional().describe("Pagination offset. Use value from previous response when more=1"),
            },
          },
          async (args: any) => {
            console.log("get_measures tool called with args:", args);
            try {
              const measures = await getMeasures(
                mcpToken,
                args.meastype,
                args.meastypes,
                args.startdate,
                args.enddate,
                args.lastupdate,
                args.offset
              );

              // Map measure type IDs to descriptions
              const measureTypeMap: Record<number, string> = {
                1: "Weight (kg)",
                4: "Height (meter)",
                5: "Fat Free Mass (kg)",
                6: "Fat Ratio (%)",
                8: "Fat Mass Weight (kg)",
                9: "Diastolic Blood Pressure (mmHg)",
                10: "Systolic Blood Pressure (mmHg)",
                11: "Heart Pulse (bpm) - only for BPM and scale devices",
                12: "Temperature (celsius)",
                54: "SP02 (%)",
                71: "Body Temperature (celsius)",
                73: "Skin Temperature (celsius)",
                76: "Muscle Mass (kg)",
                77: "Hydration (kg)",
                88: "Bone Mass (kg)",
                91: "Pulse Wave Velocity (m/s)",
                123: "VO2 max is a numerical measurement of your body's ability to consume oxygen (ml/min/kg)",
                130: "Atrial fibrillation result",
                135: "QRS interval duration based on ECG signal",
                136: "PR interval duration based on ECG signal",
                137: "QT interval duration based on ECG signal",
                138: "Corrected QT interval duration based on ECG signal",
                139: "Atrial fibrillation result from PPG",
                155: "Vascular age",
                167: "Nerve Health Score Conductance 2 electrodes Feet",
                168: "Extracellular Water in kg",
                169: "Intracellular Water in kg",
                170: "Visceral Fat (without unity)",
                173: "Fat Free Mass for segments",
                174: "Fat Mass for segments in mass unit",
                175: "Muscle Mass for segments",
                196: "Electrodermal activity feet",
                226: "Basal Metabolic Rate (BMR)",
                227: "Metabolic Age",
                229: "Electrochemical Skin Conductance (ESC)",
              };

              // Add type descriptions and calculated values to each measure
              if (measures?.measuregrps) {
                measures.measuregrps = measures.measuregrps.map((grp: any) => {
                  if (grp.measures) {
                    grp.measures = grp.measures.map((measure: any) => {
                      const calculatedValue = measure.value * Math.pow(10, measure.unit);
                      return {
                        ...measure,
                        type_description: measureTypeMap[measure.type] || `Unknown type ${measure.type}`,
                        calculated_value: calculatedValue,
                      };
                    });
                  }
                  return grp;
                });
              }

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(measures, null, 2),
                  },
                ],
              };
            } catch (error) {
              console.error("Error fetching measures:", error);
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          }
        );

        sessionServer.registerTool(
          "get_workouts",
          {
            description: "Get workout summaries including calories burned, heart rate data, distance, steps, elevation, and swimming metrics. Returns aggregated data for each workout session. By default returns ALL available data fields.",
            inputSchema: {
              startdateymd: z.string().optional().describe("Start date in YYYY-MM-DD format (e.g., '2024-01-15'). Required if lastupdate not provided."),
              enddateymd: z.string().optional().describe("End date in YYYY-MM-DD format (e.g., '2024-01-20'). Required if startdateymd is provided."),
              lastupdate: z.number().optional().describe("Unix timestamp for requesting data updated or created after this date. Use this instead of date range for synchronization."),
              offset: z.number().optional().describe("Pagination offset. Use value from previous response when more=true"),
              data_fields: z.string().optional().default("calories,intensity,manual_distance,manual_calories,hr_average,hr_min,hr_max,hr_zone_0,hr_zone_1,hr_zone_2,hr_zone_3,pause_duration,algo_pause_duration,spo2_average,steps,distance,elevation,pool_laps,strokes,pool_length").describe("Comma-separated list of data fields to return. Available fields: calories=Active calories(Kcal), intensity=Workout intensity(0-100), manual_distance=User-entered distance(m), manual_calories=User-entered calories(Kcal), hr_average=Average heart rate(bpm), hr_min=Min heart rate(bpm), hr_max=Max heart rate(bpm), hr_zone_0=Light zone duration(sec), hr_zone_1=Moderate zone duration(sec), hr_zone_2=Intense zone duration(sec), hr_zone_3=Maximal zone duration(sec), pause_duration=User pause time(sec), algo_pause_duration=Device-detected pause time(sec), spo2_average=Average SpO2(%), steps=Step count, distance=Distance(m), elevation=Floors climbed, pool_laps=Pool lap count, strokes=Stroke count, pool_length=Pool length(m). Defaults to all fields."),
            },
          },
          async (args: any) => {
            console.log("get_workouts tool called with args:", args);
            try {
              const workouts = await getWorkouts(
                mcpToken,
                args.startdateymd,
                args.enddateymd,
                args.lastupdate,
                args.offset,
                args.data_fields
              );

              // Remove category field from each workout in the series
              if (workouts?.series) {
                workouts.series = workouts.series.map((workout: any) => {
                  const { category, ...rest } = workout;
                  return rest;
                });
              }

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(workouts, null, 2),
                  },
                ],
              };
            } catch (error) {
              console.error("Error fetching workouts:", error);
              return {
                content: [
                  {
                    type: "text",
                    text: `Error: ${error instanceof Error ? error.message : String(error)}`,
                  },
                ],
                isError: true,
              };
            }
          }
        );

        console.log("Tools registered successfully");

        // Connect server to transport
        console.log("Connecting MCP server to transport...");
        await sessionServer.connect(transport);
        console.log("MCP server connected successfully");

        // Store session
        sessionManager.createSession(sessionId!, transport);
        console.log("Session stored in session manager");

        // Handle the initial message
        console.log("Processing initial message...");
        await transport.handleIncomingMessage(message);

        // Handle connection close
        c.req.raw.signal.addEventListener("abort", () => {
          sessionManager.deleteSession(sessionId!);
        });

        // Keep connection alive - send heartbeat
        const heartbeat = setInterval(async () => {
          try {
            await writeSSE("", "ping");
          } catch (error) {
            clearInterval(heartbeat);
          }
        }, 15000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          sessionManager.deleteSession(sessionId!);
        });

      } catch (error) {
        console.error("Failed to establish MCP connection:", error);
        sessionManager.deleteSession(sessionId!);
        writer.close();
      }
    })();

    // Return SSE response with session ID header
    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Mcp-Session-Id": sessionId,
    };

    console.log("Returning SSE stream with session ID:", sessionId);
    return new Response(readable, { headers });
  }

  // Existing session - handle message and return 202
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    console.error("Session not found:", sessionId);
    return c.json({
      error: "invalid_session",
      error_description: "Session not found or expired"
    }, 404);
  }

  try {
    const message = await c.req.json() as JSONRPCMessage;
    console.log("Received JSON-RPC message:", { method: (message as any).method, id: (message as any).id });

    // Forward message to transport
    await session.transport.handleIncomingMessage(message);

    // Return 202 Accepted (response will come via SSE)
    return c.body(null, 202);
  } catch (error) {
    console.error("Error handling MCP message:", error);
    return c.json({
      error: "internal_error",
      error_description: "Failed to process message"
    }, 500);
  }
});

// OAuth metadata discovery endpoint
app.get("/.well-known/oauth-authorization-server", (c) => {
  const baseUrl = new URL(c.req.url).origin;
  return c.json({
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    // MCP-specific metadata
    mcp_endpoint: `${baseUrl}${mcpEndpoint}`,
  });
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

// Export for Deno Deploy
export default {
  fetch: app.fetch,
};
