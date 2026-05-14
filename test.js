// save as debug.js
require("dotenv").config();
const { createClient } = require("@supabase/supabase-js");

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_KEY;

console.log("Connecting to:", url ? url : "⚠️ MISSING SUPABASE_URL");
console.log(
  "Key starts with:",
  key ? key.substring(0, 10) + "..." : "⚠️ MISSING SUPABASE_KEY",
);

if (!url || !key) {
  console.error("❌ Missing environment variables.");
  process.exit(1);
}

// Test raw fetch first (bypass Supabase client for clarity)
async function testDirectFetch() {
  const restUrl = `${url}/rest/v1/shops?select=id&limit=1`;
  console.log("Trying direct fetch to:", restUrl);

  try {
    const res = await fetch(restUrl, {
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
    });
    console.log("Status:", res.status, res.statusText);
    const data = await res.text();
    console.log("Response body (first 200 chars):", data.substring(0, 200));
    if (res.ok) {
      console.log("✅ Direct HTTP call successful.");
    } else {
      console.error("❌ Direct HTTP call failed.");
    }
  } catch (err) {
    console.error("❌ Direct fetch error:", err.cause || err.message);
  }
}

async function testSupabaseClient() {
  const supabase = createClient(url, key);
  try {
    const { data, error } = await supabase
      .from("shops")
      .select("id", { count: "exact", head: true });

    if (error) {
      console.error(
        "Supabase client error object:",
        JSON.stringify(error, null, 2),
      );
      // Also try to stringify the whole thing to catch non-standard fields
      console.error("Error message:", error.message);
      console.error("Error code:", error.code);
      console.error("Error hint:", error.hint);
      console.error("Error details:", error.details);
    } else {
      console.log(
        "✅ Supabase client connected. Shops count:",
        data?.length ?? 0,
      );
    }
  } catch (err) {
    console.error("Supabase client threw exception:", err);
  }
}

(async () => {
  await testDirectFetch();
  console.log("---");
  await testSupabaseClient();
})();
