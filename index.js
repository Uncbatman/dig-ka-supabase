require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

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

// Webhook verification (GET)
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === process.env.VERIFY_TOKEN) {
    console.log("Webhook verified");
    return res.status(200).send(challenge);
  }

  return res.sendStatus(403);
});

// Incoming messages (POST)
app.post("/webhook", async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const changes = entry?.changes?.[0];
    const message = changes?.value?.messages?.[0];

    if (message) {
      const phone = message.from;
      const text = message.text?.body;

      console.log("Incoming:", phone, text);

      const parsedItems = parseMessage(text);
      console.log("Parsed:", parsedItems);

      const { error } = await supabase.from("orders").insert([
        {
          customer_phone: phone,
          message: text,
          items: parsedItems,
          status: "pending",
        },
      ]);

      if (error) console.error("SUPABASE ERROR:", error);
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("SERVER ERROR:", err);
    res.sendStatus(500);
  }
});
function formatOrder(items) {
  return items
    .map((i) => `${i.qty} x ${i.name}${i.unit ? ` (${i.unit})` : ""}`)
    .join("\n");
}

function buildConfirmation(parsedItems) {
  const summary = formatOrder(parsedItems);

  return `Order received:\n${summary}`;
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

app.listen(process.env.PORT, () => {
  console.log(`Server running on port ${process.env.PORT}`);
});
