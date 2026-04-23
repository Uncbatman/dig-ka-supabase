require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");

const app = express();

// --- FIX #2: RAW BODY MIDDLEWARE (BEFORE JSON PARSING) ---
// Store raw body before Express parses JSON
// Required for correct webhook signature verification
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8"); // Store exact bytes
    },
  }),
);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// --- CONFIG VALIDATION ---
function validateConfig() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "PHONE_NUMBER_ID",
    "ACCESS_TOKEN",
    "APP_SECRET",
    "VERIFY_TOKEN",
    "SHOP_PHONE",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  try {
    normalizeAndValidatePhone(process.env.SHOP_PHONE);
  } catch (err) {
    throw new Error(`Invalid SHOP_PHONE format: ${err.message}`);
  }

  if (process.env.VERIFY_TOKEN === "my_verify_token") {
    throw new Error(
      "VERIFY_TOKEN cannot be default value. Set in environment.",
    );
  }
}

validateConfig();

const SHOP_PHONE = process.env.SHOP_PHONE;
const APP_SECRET = process.env.APP_SECRET;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// --- FIX #6: QUEUE OVERFLOW CAP ---
const MAX_QUEUE_SIZE = 5000;
const MESSAGE_QUEUE = [];
const QUEUE_PROCESSING = { active: false };

// --- LOGGER ---
function log(event, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

// --- FIX #2: WEBHOOK SIGNATURE VERIFICATION (USING RAW BODY) ---
function verifyWebhookSignature(req) {
  const signature = req.headers["x-hub-signature-256"];

  if (!signature) {
    log("webhook_verify_missing_signature");
    return false;
  }

  // FIX: Use raw body, not parsed JSON
  const body = req.rawBody;

  if (!body) {
    log("webhook_verify_no_raw_body");
    return false;
  }

  const hash = crypto
    .createHmac("sha256", APP_SECRET)
    .update(body)
    .digest("hex");

  const expectedSignature = `sha256=${hash}`;

  try {
    const result = crypto.timingSafeEqual(
      Buffer.from(expectedSignature),
      Buffer.from(signature),
    );
    return result;
  } catch (err) {
    log("webhook_verify_signature_mismatch");
    return false;
  }
}

// --- PHONE NORMALIZATION & VALIDATION ---
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

// --- RETRY LOGIC ---
function isTemporaryError(error) {
  const temporaryErrors = [
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EHOSTUNREACH",
  ];
  return temporaryErrors.some((code) => error.message?.includes(code));
}

function calculateBackoff(retryCount) {
  const baseDelay = 1000;
  const maxDelay = 60000;
  const delay =
    baseDelay * Math.pow(2, retryCount) * (0.5 + Math.random() * 0.5);
  return Math.min(delay, maxDelay);
}

// --- FIX #4: DURABLE DEDUPLICATION (DATABASE-BACKED) ---
async function isMessageProcessed(messageId) {
  try {
    const { data } = await supabase
      .from("processed_messages")
      .select("message_id")
      .eq("message_id", messageId)
      .single();
    return !!data;
  } catch (err) {
    // If table doesn't exist or error, assume not processed
    // Better to risk duplication than block valid messages
    return false;
  }
}

async function markMessageProcessed(messageId, phone) {
  try {
    await supabase.from("processed_messages").insert([
      {
        message_id: messageId,
        phone,
        processed_at: new Date().toISOString(),
      },
    ]);
  } catch (err) {
    log("mark_message_processed_error", {
      messageId,
      errorCode: err.code,
    });
    // Continue anyway - don't let dedup failure block processing
  }
}

// --- FIX #8: PERIODIC CLEANUP OF OLD DEDUP RECORDS ---
async function cleanupOldProcessedMessages() {
  try {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await supabase
      .from("processed_messages")
      .delete()
      .lt("processed_at", thirtyDaysAgo.toISOString());
    log("cleanup_processed_messages_success");
  } catch (err) {
    log("cleanup_processed_messages_error", { errorCode: err.code });
  }
}

// Run cleanup daily
setInterval(cleanupOldProcessedMessages, 24 * 60 * 60 * 1000);

// --- PARSER WITH CONFIDENCE (FIX #7) ---
function simpleParse(text) {
  if (!text || typeof text !== "string" || text.length < 3) {
    return [];
  }

  const items = [];
  const parts = text.toLowerCase().split(/,|and|na/);

  for (let part of parts) {
    const words = part.trim().split(/\s+/);
    let qty = 1;

    const num = words.find((w) => !isNaN(w) && w.length > 0);
    if (num) qty = Math.max(1, parseInt(num));

    const name = words
      .filter((w) => isNaN(w) || w.length === 0)
      .join(" ")
      .trim();

    // FIX #7: Require minimum name length (prevent junk)
    if (name && name.length >= 3) {
      items.push({ name, qty });
    }
  }

  return items;
}

// --- PARSER CONFIDENCE CHECK ---
function hasParsingConfidence(items) {
  if (items.length === 0) {
    return false; // No items parsed
  }

  if (items.length === 1 && items[0].qty === 1 && items[0].name.length <= 4) {
    return false; // Very simple - could be noise ("ok", "yes", "hi")
  }

  return true; // Reasonable confidence
}

// --- FORMAT ---
function formatOrder(items) {
  if (!items || items.length === 0) {
    return "No items detected.";
  }
  return items.map((i) => `${i.qty} x ${i.name}`).join("\n");
}

function buildConfirmation(items) {
  return `You ordered:\n${formatOrder(items)}\n\nReply YES to confirm or edit.`;
}

function formatForShop(order) {
  return `New Order:\n${formatOrder(order.items)}\n\nCustomer: ${order.phone}`;
}

// --- SEND MESSAGE ---
async function sendWhatsAppMessage(to, message, retryCount = 0) {
  const MAX_RETRIES = 3;

  try {
    const validPhone = normalizeAndValidatePhone(to);

    log("send_attempt", {
      phone: validPhone,
      messageLength: message.length,
      retryCount,
    });

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${process.env.PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: validPhone,
          type: "text",
          text: { body: message },
        }),
      },
    );

    const data = await res.json();

    if (!res.ok || data.error) {
      log("send_api_error", {
        phone: validPhone,
        status: res.status,
        errorCode: data.error?.code,
      });
      throw new Error(`API_ERROR_${res.status}`);
    }

    log("send_success", {
      phone: validPhone,
      messageId: data.messages?.[0]?.id,
    });
    return { success: true, data };
  } catch (err) {
    if (isTemporaryError(err) && retryCount < MAX_RETRIES) {
      const delay = calculateBackoff(retryCount);
      log("send_retry", { phone: to, attempt: retryCount + 1, delayMs: delay });
      await new Promise((r) => setTimeout(r, delay));
      return sendWhatsAppMessage(to, message, retryCount + 1);
    }

    log("send_failure_final", {
      phone: to,
      errorType: err.message?.split("_")[0] || "UNKNOWN",
    });
    return { success: false, error: err.message };
  }
}

// --- FIX #6: QUEUE ENQUEUE WITH OVERFLOW CHECK ---
async function enqueueMessage(messageData) {
  if (MESSAGE_QUEUE.length >= MAX_QUEUE_SIZE) {
    log("queue_full_rejecting_message", {
      queueSize: MESSAGE_QUEUE.length,
      phone: messageData?.from,
    });
    // Don't add, don't process
    // Webhook still returned 200, so Facebook thinks we got it
    // Facebook will retry after backoff
    return;
  }

  MESSAGE_QUEUE.push(messageData);
  processQueue();
}

// --- QUEUE PROCESSING ---
async function processQueue() {
  if (QUEUE_PROCESSING.active || MESSAGE_QUEUE.length === 0) {
    return;
  }

  QUEUE_PROCESSING.active = true;

  while (MESSAGE_QUEUE.length > 0) {
    const messageData = MESSAGE_QUEUE.shift();

    try {
      await handleIncomingMessage(messageData);
    } catch (err) {
      log("queue_process_error", {
        errorType: err.message?.split("_")[0],
      });
      // Continue processing other messages
    }
  }

  QUEUE_PROCESSING.active = false;
}

// --- FIX #8: ORDER EXPIRY LOGIC ---
async function expireStaleOrders() {
  try {
    const now = new Date().toISOString();
    const { data: stale, error } = await supabase
      .from("parsed_orders")
      .select("id, phone, status")
      .lt("expires_at", now)
      .in("status", ["pending", "confirmation_sent"]);

    if (error) {
      log("expire_orders_query_error", { errorCode: error.code });
      return;
    }

    for (const order of stale || []) {
      await supabase
        .from("parsed_orders")
        .update({ status: "expired" })
        .eq("id", order.id);

      log("order_expired", {
        orderId: order.id,
        phone: order.phone,
        previousStatus: order.status,
      });
    }
  } catch (err) {
    log("expire_stale_orders_error", {
      errorType: err.message?.split("_")[0],
    });
  }
}

// Run expiry check every 5 minutes
setInterval(expireStaleOrders, 5 * 60 * 1000);

// --- MAIN MESSAGE HANDLER ---
async function handleIncomingMessage(msg) {
  const message = msg?.text?.body;
  const from = msg?.from;
  const messageId = msg?.id;

  if (!message || !from || !messageId) {
    log("invalid_message", {
      hasMissing: !message || !from || !messageId,
    });
    return;
  }

  // FIX #5: CHECK DEDUP FIRST, BEFORE STORING
  if (await isMessageProcessed(messageId)) {
    log("message_duplicate", { messageId });
    return;
  }

  let phone;
  try {
    phone = normalizeAndValidatePhone(from);
  } catch (err) {
    log("invalid_phone_rejected", {
      errorType: err.message,
    });
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
    log("raw_message_insert_error", {
      errorCode: rawError.code,
    });
    return;
  }

  // Mark processed AFTER successful storage
  await markMessageProcessed(messageId, phone);

  // =========================
  // 1. CONFIRMATION HANDLER
  // =========================
  if (lower === "yes") {
    try {
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

      // Atomic update - only if still pending
      const { data: updated, error: updateError } = await supabase
        .from("parsed_orders")
        .update({ status: "confirmation_sent" })
        .eq("id", lastOrder.id)
        .eq("status", "pending")
        .select()
        .single();

      if (updateError || !updated) {
        log("confirmation_update_failed", {
          orderId: lastOrder.id,
          errorCode: updateError?.code,
        });
        return;
      }

      // Send confirmation
      const confirmRes = await sendWhatsAppMessage(phone, "Order confirmed.");

      if (!confirmRes.success) {
        // Rollback on send failure
        await supabase
          .from("parsed_orders")
          .update({ status: "pending" })
          .eq("id", lastOrder.id);

        log("confirmation_send_failed_rollback", {
          orderId: lastOrder.id,
        });
        return;
      }

      // Mark confirmed
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
        log("shop_forward_failed", { orderId: lastOrder.id });
        return;
      }

      // Mark forwarded
      await supabase
        .from("parsed_orders")
        .update({ status: "forwarded" })
        .eq("id", lastOrder.id);

      log("order_complete", { orderId: lastOrder.id });
    } catch (err) {
      log("confirmation_handler_error", {
        errorType: err.message?.split("_")[0],
      });
    }

    return;
  }

  // =========================
  // 3. NEW ORDER
  // =========================
  try {
    const parsed = simpleParse(message);

    // FIX #7: CHECK CONFIDENCE
    if (!hasParsingConfidence(parsed)) {
      log("parse_confidence_low", {
        phone,
        itemCount: parsed.length,
        message,
      });
      const res = await sendWhatsAppMessage(
        phone,
        "I didn't understand. Please try:\nitem1, item2, item3\n\nExample: chapati 2, tea 3, samosa 5",
      );
      if (!res.success) {
        log("parse_error_send_failed", { phone });
      }
      return;
    }

    // FIX #8: SET EXPIRY TIME (10 MINUTES)
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();

    // Insert order
    const { data: orderData, error: orderError } = await supabase
      .from("parsed_orders")
      .insert([
        {
          raw_message_id: rawData.id,
          phone,
          items: parsed,
          status: "pending",
          expires_at: expiresAt,
          created_at: new Date().toISOString(),
        },
      ])
      .select()
      .single();

    if (orderError) {
      log("order_insert_error", {
        errorCode: orderError.code,
      });
      return;
    }

    // Send confirmation
    const confirmation = buildConfirmation(parsed);
    const confirmRes = await sendWhatsAppMessage(phone, confirmation);

    if (!confirmRes.success) {
      await supabase
        .from("parsed_orders")
        .update({ status: "confirmation_failed" })
        .eq("id", orderData.id);

      log("order_confirmation_send_failed", {
        orderId: orderData.id,
      });
      return;
    }

    // Mark confirmation sent
    await supabase
      .from("parsed_orders")
      .update({ status: "confirmation_sent" })
      .eq("id", orderData.id);

    log("order_created", {
      orderId: orderData.id,
      itemCount: parsed.length,
      expiresAt,
    });
  } catch (err) {
    log("new_order_handler_error", {
      errorType: err.message?.split("_")[0],
    });
  }
}

// --- DEBUG ENDPOINT ---
app.get("/", (req, res) => {
  res.send("Server is alive");
});

// --- WEBHOOK VERIFICATION ---
app.get("/webhook", (req, res) => {
  if (
    req.query["hub.mode"] === "subscribe" &&
    req.query["hub.verify_token"] === VERIFY_TOKEN
  ) {
    log("webhook_verify_success");
    return res.status(200).send(req.query["hub.challenge"]);
  }

  log("webhook_verify_failed", {
    mode: req.query["hub.mode"],
    hasToken: !!req.query["hub.verify_token"],
  });
  return res.sendStatus(403);
});

// --- FIX #1: RATE LIMITER MIDDLEWARE (BEFORE HANDLER) ---
const webhookRateLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 1000,
  keyGenerator: (req) => {
    const from = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
    return from || req.ip;
  },
  skip: (req) => {
    return req.method === "GET";
  },
  message: "Too many webhook requests",
});

// --- FIX #1: WEBHOOK HANDLER WITH SIGNATURE VERIFICATION ---
app.post(
  "/webhook",
  webhookRateLimiter, // Apply rate limit FIRST
  (req, res) => {
    // Verify signature FIRST
    if (!verifyWebhookSignature(req)) {
      log("webhook_signature_invalid");
      return res.sendStatus(403);
    }

    try {
      res.sendStatus(200); // Immediate ack

      setImmediate(async () => {
        try {
          const value = req.body.entry?.[0]?.changes?.[0]?.value;

          if (!value?.messages) {
            log("webhook_no_messages");
            return;
          }

          const msg = value.messages[0];
          await enqueueMessage(msg);
        } catch (err) {
          log("webhook_error", {
            errorType: err.message?.split("_")[0],
          });
        }
      });
    } catch (err) {
      log("webhook_crash", {
        errorType: err.message?.split("_")[0],
      });
      res.sendStatus(200);
    }
  },
);

// --- AUTHENTICATED HEALTH ENDPOINT ---
function authenticateHealthCheck(req, res, next) {
  const token = req.headers.authorization?.split(" ")[1];
  const healthToken = process.env.HEALTH_TOKEN;

  if (!healthToken || token !== healthToken) {
    return res.sendStatus(403);
  }

  next();
}

app.get("/health", authenticateHealthCheck, (req, res) => {
  log("health_check_success");
  res.json({
    status: "ok",
    queueLength: MESSAGE_QUEUE.length,
    processingActive: QUEUE_PROCESSING.active,
    timestamp: new Date().toISOString(),
  });
});

// --- METRICS ENDPOINT ---
app.get("/metrics", authenticateHealthCheck, (req, res) => {
  res.json({
    queueLength: MESSAGE_QUEUE.length,
    processingActive: QUEUE_PROCESSING.active,
    maxQueueSize: MAX_QUEUE_SIZE,
    timestamp: new Date().toISOString(),
  });
});

// --- GRACEFUL SHUTDOWN ---
process.on("SIGTERM", () => {
  log("shutdown_signal_received");
  setTimeout(() => {
    log("shutdown_timeout_force_exit");
    process.exit(1);
  }, 30000);
});

// --- START SERVER ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("server_start", { port: PORT });
});
