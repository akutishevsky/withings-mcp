import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "supabase" });

// Use 'any' for the database schema since we're not using Supabase CLI to generate types
type SupabaseDatabase = SupabaseClient<any, "public", any>;

let supabaseClient: SupabaseDatabase | null = null;

/**
 * Get the Supabase client singleton
 */
export function getSupabaseClient(): SupabaseDatabase {
  if (!supabaseClient) {
    throw new Error("Supabase client not initialized. Call initSupabase() first.");
  }
  return supabaseClient;
}

/**
 * Initialize Supabase client and verify connection
 */
export async function initSupabase(): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SECRET_KEY;

  if (!supabaseUrl || !supabaseKey) {
    throw new Error(
      "Missing Supabase environment variables. Set SUPABASE_URL and SUPABASE_SECRET_KEY."
    );
  }

  supabaseClient = createClient(supabaseUrl, supabaseKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  // Verify connection by making a simple query
  const { error } = await supabaseClient.from("mcp_tokens").select("id").limit(1);

  if (error) {
    logger.error("Failed to connect to Supabase", { error: error.message });
    throw new Error(`Supabase connection failed: ${error.message}`);
  }

  logger.info("Supabase client initialized successfully");
}
