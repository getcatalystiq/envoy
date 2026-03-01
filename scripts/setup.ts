import { Pool } from "@neondatabase/serverless";
import bcrypt from "bcryptjs";
import * as readline from "readline";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function ask(question: string): Promise<string> {
  return new Promise((resolve) => rl.question(question, resolve));
}

async function setup() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    console.error("DATABASE_URL environment variable is required");
    process.exit(1);
  }

  console.log("Envoy Setup");
  console.log("===========\n");
  console.log("This will create your organization and admin account.\n");

  const orgName = await ask("Organization name: ");
  if (!orgName.trim()) {
    console.error("Organization name is required");
    process.exit(1);
  }

  const email = await ask("Admin email: ");
  if (!email.trim() || !email.includes("@")) {
    console.error("A valid email is required");
    process.exit(1);
  }

  const password = await ask("Admin password (min 8 chars): ");
  if (password.length < 8) {
    console.error("Password must be at least 8 characters");
    process.exit(1);
  }

  rl.close();

  const pool = new Pool({ connectionString: databaseUrl });

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // Check if org already exists
      const existingOrg = await client.query(
        "SELECT id FROM organizations WHERE name = $1",
        [orgName.trim()]
      );
      if (existingOrg.rows.length > 0) {
        console.error(`Organization "${orgName.trim()}" already exists`);
        await client.query("ROLLBACK");
        process.exit(1);
      }

      // Check if user already exists
      const existingUser = await client.query(
        "SELECT id FROM users WHERE email = $1",
        [email.trim()]
      );
      if (existingUser.rows.length > 0) {
        console.error(`User "${email.trim()}" already exists`);
        await client.query("ROLLBACK");
        process.exit(1);
      }

      // Create organization
      const orgResult = await client.query(
        "INSERT INTO organizations (name) VALUES ($1) RETURNING id",
        [orgName.trim()]
      );
      const orgId = orgResult.rows[0].id;

      // Create admin user
      const passwordHash = await bcrypt.hash(password, 10);
      await client.query(
        `INSERT INTO users (organization_id, email, password_hash, first_name, last_name, role, scopes, status)
         VALUES ($1::uuid, $2, $3, 'Admin', 'User', 'admin', $4, 'active')`,
        [orgId, email.trim(), passwordHash, ["read", "write", "admin"]]
      );

      await client.query("COMMIT");

      console.log("\nSetup complete!");
      console.log(`  Organization: ${orgName.trim()}`);
      console.log(`  Admin email:  ${email.trim()}`);
      console.log("\nYou can now start the app with: npm run dev");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  } finally {
    await pool.end();
  }
}

setup().catch((err) => {
  console.error("Setup failed:", err);
  process.exit(1);
});
