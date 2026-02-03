/**
 * Database Migration Script
 * 
 * Run with: npx tsx script/migrate.ts
 * 
 * This script runs all pending database migrations.
 */

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

async function runMigrations() {
  const databaseUrl = process.env.DATABASE_URL;
  
  if (!databaseUrl) {
    console.error("ERROR: DATABASE_URL environment variable is required");
    process.exit(1);
  }

  console.log("Running database migrations...");
  
  // Create a connection for migrations using the same pg pool as the app
  const pool = new pg.Pool({
    connectionString: databaseUrl,
    max: 1,
  });
  
  const db = drizzle(pool);
  
  try {
    await migrate(db, { migrationsFolder: "./migrations" });
    console.log("Migrations completed successfully");
  } catch (error) {
    console.error("Migration failed:", error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigrations();
