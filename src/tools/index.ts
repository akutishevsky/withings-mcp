import { registerSleepTools } from "./sleep.js";
import { registerMeasureTools } from "./measure.js";

/**
 * Register all Withings tools on an MCP server instance
 * @param server - The MCP server instance to register tools on
 * @param mcpAccessToken - The MCP access token for authentication
 */
export function registerAllTools(server: any, mcpAccessToken: string) {
  console.log("Registering Withings tools...");

  registerSleepTools(server, mcpAccessToken);
  registerMeasureTools(server, mcpAccessToken);

  console.log("Tools registered successfully");
}
