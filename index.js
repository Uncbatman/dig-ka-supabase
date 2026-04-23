require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// --- CONFIG ---
const SHOP_PHONE = "+254792120237"; // Normalized format
const MESSAGE_QUEUE = [];
const PROCESSED_MESSAGE_IDS = new Set();
const QUEUE_PROCESSING = { active: false };

// --- LOGGER ---
function log(event, data) {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${event}:`, data);
}

// --- P0.1: PHONE NORMALIZATION & VALIDATION (Single Entry Point) ---
function normalizeAndValidatePhone(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("INVALID_PHONE_TYPE");
  }

  let cleaned = raw.replace(/\D/g, "");

  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.slice(1);
  }

  const phone = "+" + cleaned;

  if (!/^\+2547\d{8}$/.test(phone)) {
    throw new Error("INVALID_PHONE_FORMAT");
  }

  return phone;
}

// --- P1.7: TEMPORARY ERROR DETECTION ---
function isTemporaryError(error) {
  const temporaryErrors = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
  ];
  return temporaryErrors.some((code) => error.message?.includes(code));
}

// --- PARSER ---
function simpleParse(text) {
  if (!text) return [];

  const items = [];
  const parts = text.toLowerCase().split(/,|and|na/);

  for (let part of parts) {
    const words = part.trim().split(" ");
    let qty = 1;

    const num = words.find((w) => !isNaN(w));
    if (num) qty = parseInt(num);

    const name = words.filter((w) => isNaN(w)).join(" ");

    if (name) {
      items.push({ name: name.trim(), qty });
    }
  }

  return items;
}

// --- FORMAT ---
function formatOrder(items) {
  if (!items || items.length === 0) return "No items detected.";
  return items.map((i) => `${i.qty} x ${i.name}`).join("\n");
}

function buildConfirmation(items) {
  return `You ordered:\n${formatOrder(items)}\n\nReply YES to confirm or edit.`;
}

function formatForShop(order) {
  return `New Order:\n${formatOrder(order.items)}\n\nCustomer: ${order.phone}`;
}

// --- P0.4: SEND MESSAGE WITH SUCCESS GATE ---
async function sendWhatsAppMessage(to, message, retryCount = 0) {
  const MAX_RETRIES = 1;

  try {
    // Validate phone before send (P0.4)
    const validPhone = normalizeAndValidatePhone(to);

    log("send_attempt", { phone: validPhone, messageLength: message.length });

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: validPhone,
          type: "text",
          text: { body: message },
        }),
      },
    );

    const data = await res.json();

    // Check for API success
    if (!res.ok || data.error) {
      const error = data.error || `HTTP ${res.status}`;
      log("send_failure", { phone: validPhone, error });
      throw new Error(`API_ERROR: ${JSON.stringify(error)}`);
    }

    log("send_success", {
      phone: validPhone,
      messageId: data.messages?.[0]?.id,
    });
    return { success: true, data };
  } catch (err) {
    // P1.7: Retry only on temporary failures
    if (isTemporaryError(err) && retryCount < MAX_RETRIES) {
      log("send_retry", { phone: to, attempt: retryCount + 1 });
      await new Promise((r) => setTimeout(r, 1000 * (retryCount + 1))); // Backoff
      return sendWhatsAppMessage(to, message, retryCount + 1);
    }

    log("send_failure_final", { phone: to, error: err.message });
    return { success: false, error: err.message };
  }
}

// --- P1.8: MESSAGE QUEUE & PROCESSING ---
async function enqueueMessage(messageData) {
  MESSAGE_QUEUE.push(messageData);
  processQueue();
}

async function processQueue() {
  if (QUEUE_PROCESSING.active || MESSAGE_QUEUE.length === 0) return;

  QUEUE_PROCESSING.active = true;

  while (MESSAGE_QUEUE.length > 0) {
    const messageData = MESSAGE_QUEUE.shift();

    try {
      await handleIncomingMessage(messageData);
    } catch (err) {
      log("queue_process_error", { error: err.message });
    }
  }

  QUEUE_PROCESSING.active = false;
}

// --- P1.9: IDEMPOTENCY CHECK ---
function isMessageProcessed(messageId) {
  return PROCESSED_MESSAGE_IDS.has(messageId);
}

function markMessageProcessed(messageId) {
  PROCESSED_MESSAGE_IDS.add(messageId);
}

// --- MAIN MESSAGE HANDLER ---
async function handleIncomingMessage(msg) {
  const message = msg?.text?.body;
  const from = msg?.from;
  const messageId = msg?.id;

  if (!message || !from) {
    log("invalid_message", { message: "Missing message or from field" });
    return;
  }

  // P1.9: Idempotency - reject already-processed messages
  if (isMessageProcessed(messageId)) {
    log("message_duplicate", { messageId });
    return;
  }

  let phone;
  try {
    // P0.3: Validate phone at entry point
    phone = normalizeAndValidatePhone(from);
  } catch (err) {
    log("invalid_phone_input", { raw: from, error: err.message });
    return;
  }

  const lower = message.toLowerCase().trim();

  // --- STORE RAW MESSAGE ---
  const { data: rawData, error: rawError } = await supabase
    .from("raw_messages")
    .insert([{ phone, message }])
    .select()
    .single();

  if (rawError) {
    log("raw_message_insert_error", { error: rawError.message });
    return;
  }

  markMessageProcessed(messageId);

  // =========================
  // 1. CONFIRMATION HANDLER
  // =========================
  if (lower === "yes") {
    try {
      // Fetch pending order
      const { data: lastOrder, error: orderError } = await supabase
        .from("parsed_orders")
        .select("*")
        .eq("phone", phone)
        .eq("status", "pending")
        .order("created_at", { ascending: false })
        .limit(1)
        .single();

      if (orderError || !lastOrder) {
        log("no_pending_order", { phone });
        const res = await sendWhatsAppMessage(phone, "No pending order found.");
        if (!res.success) {
          log("confirmation_noop_send_failed", { phone });
        }
        return;
      }

      // P0.6: ATOMIC UPDATE - Only confirm if status is "pending"
      const { error: updateError } = await supabase
        .from("parsed_orders")
        .update({ status: "confirmation_sent" })
        .eq("id", lastOrder.id)
        .eq("status", "pending");

      if (updateError) {
        log("confirmation_update_error", { error: updateError.message });
        return;
      }

      // P0.4: Send confirmation only if update succeeded
      const confirmRes = await sendWhatsAppMessage(phone, "Order confirmed.");

      if (!confirmRes.success) {
        // Rollback state on send failure
        await supabase
          .from("parsed_orders")
          .update({ status: "pending" })
          .eq("id", lastOrder.id)
          .eq("status", "confirmation_sent");

        log("confirmation_send_failed_rollback", {
          phone,
          orderId: lastOrder.id,
        });
        return;
      }

      // P0.5: Mark as confirmed only after successful send
      await supabase
        .from("parsed_orders")
        .update({ status: "confirmed" })
        .eq("id", lastOrder.id);

      // =========================
      // 2. FORWARD TO SHOP
      // =========================
      const shopMsg = formatForShop(lastOrder);
      const shopRes = await sendWhatsAppMessage(SHOP_PHONE, shopMsg);

      if (!shopRes.success) {
        log("shop_forward_failed", { phone, orderId: lastOrder.id });
        // Order is confirmed but shop wasn't notified - log for manual review
        return;
      }

      // Mark as forwarded only after successful shop notification
      await supabase
        .from("parsed_orders")
        .update({ status: "forwarded" })
        .eq("id", lastOrder.id);

      log("order_complete", { phone, orderId: lastOrder.id });
    } catch (err) {
      log("confirmation_handler_error", { error: err.message });
    }

    return;
  }

  // =========================
  // 3. NEW ORDER (OR EDIT)
  // =========================
  try {
    const parsed = simpleParse(message);

    if (parsed.length === 0) {
      log("no_items_parsed", { phone, message });
      const res = await sendWhatsAppMessage(
        phone,
        "Could not parse items. Please try again.",
      );
      if (!res.success) {
        log("parse_error_send_failed", { phone });
      }
      return;
    }

    // Insert order
    const { data: orderData, error: orderError } = await supabase
      .from("parsed_orders")
      .insert([
        {
          raw_message_id: rawData.id,
          phone,
          items: parsed,
          status: "pending",
        },
      ])
      .select()
      .single();

    if (orderError) {
      log("order_insert_error", { error: orderError.message });
      return;
    }

    // P0.4: Send confirmation only after order is stored
    const confirmation = buildConfirmation(parsed);
    const confirmRes = await sendWhatsAppMessage(phone, confirmation);

    if (!confirmRes.success) {
      // Mark order as failed to send
      await supabase
        .from("parsed_orders")
        .update({ status: "confirmation_failed" })
        .eq("id", orderData.id);

      log("order_confirmation_send_failed", {
        phone,
        orderId: orderData.id,
      });
      return;
    }

    // P0.5: Mark as confirmation_sent only after successful send
    await supabase
      .from("parsed_orders")
      .update({ status: "confirmation_sent" })
      .eq("id", orderData.id);

    log("order_created", { phone, orderId: orderData.id, items: parsed });
  } catch (err) {
    log("new_order_handler_error", { error: err.message });
  }
}

// --- DEBUG ENDPOINT ---
app.get("/", (req, res) => {
  res.send("Server is alive");
});

// --- VERIFY WEBHOOK ---
app.get("/webhook", (req, res) => {
  const VERIFY_TOKEN = process.env.VERIFY_TOKEN || "my_verify_token";

  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    return res.status(200).send(req.query["hub.challenge"]);
  }

  log("webhook_verify_failed", { token: req.query["hub.verify_token"] });
  return res.sendStatus(403);
});

// --- MAIN WEBHOOK ---
app.post("/webhook", (req, res) => {
  try {
    res.sendStatus(200); // NEVER FAIL WEBHOOK

    // P1.8: Queue the message instead of direct processing
    setImmediate(async () => {
      try {
        const value = req.body.entry?.[0]?.changes?.[0]?.value;

        if (!value?.messages) {
          log("webhook_no_messages", {});
          return;
        }

        const msg = value.messages[0];
        await enqueueMessage(msg);
      } catch (err) {
        log("webhook_error", { error: err.message });
      }
    });
  } catch (err) {
    log("webhook_crash", { error: err.message });
    res.sendStatus(200);
  }
});

// --- HEALTH CHECK ENDPOINT ---
app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    queueLength: MESSAGE_QUEUE.length,
    processingActive: QUEUE_PROCESSING.active,
  });
});

app.listen(3000, () => {
  log("server_start", { port: 3000 });
});
