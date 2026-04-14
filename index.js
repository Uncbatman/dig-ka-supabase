require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// --- CONFIG ---
const SHOP_PHONE = "2547XXXXXXXX"; // replace with shop number

// --- SAFE PYTHON RUNNER ---
function runPython(message) {
  return new Promise((resolve) => {
    exec(`python engine/parser.py "${message}"`, (error, stdout) => {
      if (error) {
        console.error("Python error:", error);
        return resolve({ items: [], intent: "unknown", confidence: 0 });
      }

      try {
        resolve(JSON.parse(stdout));
      } catch {
        return resolve({ items: [], intent: "unknown", confidence: 0 });
      }
    });
  });
}

// --- FORMAT ---
function formatOrder(items) {
  if (!items || items.length === 0) return "No items detected.";
  return items.map(i => `${i.qty} x ${i.name}`).join("\n");
}

function buildConfirmation(items) {
  return `You ordered:\n${formatOrder(items)}\n\nReply YES to confirm or edit.`;
}

function formatForShop(order) {
  return `New Order:\n${formatOrder(order.items)}\n\nCustomer: ${order.phone}`;
}

// --- SEND MESSAGE ---
async function sendWhatsAppMessage(to, message) {
  try {
    await fetch(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to,
          type: "text",
          text: { body: message },
        }),
      }
    );
  } catch (err) {
    console.error("Send error:", err);
  }
}

// --- VERIFY WEBHOOK ---
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = "my_verify_token";

  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }

  return res.sendStatus(403);
});

// --- MAIN WEBHOOK ---
app.post("/webhook", (req, res) => {
  try {
    res.sendStatus(200); // NEVER FAIL WEBHOOK

    setImmediate(async () => {
      try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;

        if (!value?.messages) return;

        const msg = value.messages[0];
        const message = msg?.text?.body;
        const from = msg?.from;

        if (!message || !from) return;

        const lower = message.toLowerCase().trim();

        // --- STORE RAW ---
        const raw = await supabase
          .from("raw_messages")
          .insert([{ phone: from, message }])
          .select()
          .single();

        if (raw.error) return console.error(raw.error);

        // =========================
        // 1. CONFIRMATION HANDLER
        // =========================
        if (lower === "yes") {
          const { data: lastOrder } = await supabase
            .from("parsed_orders")
            .select("*")
            .eq("phone", from)
            .eq("status", "pending")
            .order("created_at", { ascending: false })
            .limit(1)
            .single();

          if (!lastOrder) {
            await sendWhatsAppMessage(from, "No pending order found.");
            return;
          }

          // Mark confirmed
          await supabase
            .from("parsed_orders")
            .update({ status: "confirmed" })
            .eq("id", lastOrder.id);

          await sendWhatsAppMessage(from, "Order confirmed.");

          // =========================
          // 2. FORWARD TO SHOP
          // =========================
          const shopMsg = formatForShop(lastOrder);
          await sendWhatsAppMessage(SHOP_PHONE, shopMsg);

          return;
        }

        // =========================
        // 3. NEW ORDER (OR EDIT)
        // =========================
        const parsed = await runPython(message);

        const order = await supabase
          .from("parsed_orders")
          .insert([
            {
              raw_message_id: raw.data.id,
              phone: from,
              items: parsed.items,
              intent: parsed.intent,
              confidence: parsed.confidence,
              status: "pending",
            },
          ])
          .select()
          .single();

        if (order.error) return console.error(order.error);

        // --- SEND CONFIRMATION ---
        const confirmation = buildConfirmation(parsed.items);
        await sendWhatsAppMessage(from, confirmation);

      } catch (err) {
        console.error("Async error:", err);
      }
    });
  } catch (err) {
    console.error("Webhook crash:", err);
    res.sendStatus(200);
  }
});

app.listen(process.env.PORT, () => {
  console.log("Server running");
});