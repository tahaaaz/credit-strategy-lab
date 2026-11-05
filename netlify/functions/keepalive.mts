// Supabase pauses free-tier projects after a week without activity. This scheduled
// function touches the database once a day so the live demo stays up for reviewers.
import type { Config } from "@netlify/functions";
import { select } from "./lib/db.ts";

export default async () => {
  try {
    await select("scenarios", "select=name&limit=1");
    console.log("keepalive ok");
  } catch (e) {
    console.error("keepalive failed", e);
  }
};

export const config: Config = { schedule: "@daily" };
