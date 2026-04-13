require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { exec } = require("child_process");

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Product catalog
const PRODUCTS = [
  { name: "unga ugali", keywords: ["unga", "ugali"] },
  { name: "milk", keywords: ["milk", "maziwa"] },
  { name: "sugar", keywords: ["sugar", "sukari"] },
  { name: "bread", keywords: ["bread", "mkate"] },
  { name: "eggs", keywords: ["eggs", "mayai"] },
];

// Execute Python parser
function runPython(message) {
  return new Promise((resolve, reject) => {
    exec(`python engine/parser.py "${message}"`, (error, stdout) => {
      if (error) return reject(error);
      resolve(JSON.parse(stdout));
    });
  });
}

// Parse message for product items
function parseMessage(text) {
  if (!text) return [];

  text = text.toLowerCase();
  const items = [];

  // Split by common separators to handle multiple items
  const parts = text.split(/,|and|na/);

  for (const part of parts) {
    const trimmedPart = part.trim();

    // Find matching product in this part
    for (const product of PRODUCTS) {
      const found = product.keywords.some((k) => trimmedPart.includes(k));

      if (found) {
        // Extract quantity from this part
        const qtyMatch = trimmedPart.match(/\d+/);
        const qty = qtyMatch ? parseInt(qtyMatch[0]) : 1;

        // Extract unit from this part
        const unitMatch = trimmedPart.match(/\b(kg|g|litre|l)\b/);
        const unit = unitMatch ? unitMatch[0] : null;

        items.push({
          name: product.name,
          qty,
          unit,
        });

        break; // Move to next part after finding first matching product
      }
    }
  }

  return items;
}

function formatOrder(items) {
  return items
    .map((i) => `${i.qty} x ${i.name}${i.unit ? ` (${i.unit})` : ""}`)
    .join("\n");
}

function buildConfirmation(parsedItems) {
  const summary = formatOrder(parsedItems);
  return `You ordered:\n${summary}\n\nReply YES to confirm or edit.`;
}

async function sendWhatsAppMessage(to, message) {
  const url = `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`;

  await fetch(url, {
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
  });
}

// Incoming messages webhook
app.post("/webhook", async (req, res) => {
  try {
    // Step 1: Extract WhatsApp message
    const { from, body } = req.body;

    if (!from || !body) {
      return res.status(400).json({ error: "Missing from or body" });
    }

    console.log(`Message from ${from}: ${body}`);

    // Step 2: Store RAW message to Supabase
    const raw = await supabase
      .from("raw_messages")
      .insert([{ phone: from, message: body }])
      .select()
      .single();

    if (raw.error) {
      console.error("Error storing raw message:", raw.error);
      return res.status(500).json({ error: "Failed to store message" });
    }

    console.log("Raw message stored:", raw.data.id);

    // Step 3: Parse message using Python engine
    const parsed = await runPython(body);

    console.log("ENGINE OUTPUT:", parsed);

    // Step 4: Store parsed result to Supabase
    const order = await supabase
      .from("parsed_orders")
      .insert([
        {
          raw_message_id: raw.data.id,
          items: parsed.items,
          intent: parsed.intent,
          confidence: parsed.confidence,
        },
      ])
      .select()
      .single();

    if (order.error) {
      console.error("Error storing parsed order:", order.error);
      return res.status(500).json({ error: "Failed to store parsed order" });
    }

    console.log("Order stored:", order.data.id);

    // Send confirmation
    const confirmation = buildConfirmation(parsed.items);
    await sendWhatsAppMessage(from, confirmation);

    res.json({
      success: true,
      rawMessageId: raw.data.id,
      orderId: order.data.id,
      parsed,
    });
  } catch (err) {
    console.error("Webhook error:", err);
    res.status(500).json({ error: "Error processing message" });
  }
});

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
