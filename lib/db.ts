import postgres from "postgres";

// One small connection per function instance, through Supabase's pooler (transaction mode,
// which doesn't support named prepared statements).
export const sql = postgres(process.env.POSTGRES_URL ?? "", {
  ssl: "require",
  prepare: false,
  max: 1,
  idle_timeout: 20,
});

export interface Match {
  match_id: number;
  facility_name: string;
  court_name: string;
  kickoff_time: Date;
  duration_minutes: number;
  max_players: number;
  field_cost_cents: number;
  base_price_cents: number;
  checkout_price_cents: number;
  status: "DRAFT" | "OPEN" | "LOCKED" | "CANCELLED";
  channel_id: string | null;
  message_id: string | null;
  created_by: string;
  poll_id: number | null; // the poll this game came from
}

export interface Registration {
  discord_user_id: string;
  discord_username: string;
  status: "PENDING" | "CONFIRMED" | "WAITLIST" | "CANCELLED";
  hold_expires_at: Date | null;
  offered_at: Date | null;
  paid_at: Date | null;
}
