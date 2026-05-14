/**
 * DIG.KA - Order Management System
 * ================================
 * Single shop. Hardened reliability. Orders never disappear.
 *
 * Core principles:
 * 1. Simple: One shop, no multi-tenancy
 * 2. Reliable: Retry logic, unique constraints, recovery paths
 * 3. Visible: Every order tracked with status timeline
 * 4. Recoverable: Admin fallback when automation fails
 */

require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();

// ============================================================================
// 🔧 CONFIGURATION
// ============================================================================

const CONFIG = {
  SUPABASE_URL: process.env.SUPABASE_URL,
  SUPABASE_KEY: process.env.SUPABASE_KEY,
  PHONE_NUMBER_ID: process.env.PHONE_NUMBER_ID,
  ACCESS_TOKEN: process.env.ACCESS_TOKEN,
  APP_SECRET: process.env.WHATSAPP_APP_SECRET,
  VERIFY_TOKEN: process.env.VERIFY_TOKEN,
  ADMIN_PHONE: process.env.ADMIN_PHONE, // Shop owner phone
  SHOP_PHONE: process.env.SHOP_PHONE, // Shop's WhatsApp number (for messaging)
};

// Validate required config
Object.entries(CONFIG).forEach(([key, value]) => {
  if (!value) {
    console.error(`❌ Missing required: ${key}`);
    process.exit(1);
  }
});

const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_KEY);

// Middleware
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

// ============================================================================
// 📊 LOGGING
// ============================================================================

function log(event, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(JSON.stringify({ timestamp, event, ...data }));
}

// ============================================================================
// 🔐 SIGNATURE VERIFICATION
// ============================================================================

function verifyWebhookSignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) return false;

  const body = req.rawBody;
  if (!body) return false;

  const hash = crypto
    .createHmac("sha256", CONFIG.APP_SECRET)
    .update(body)
    .digest("hex");

  const expected = `sha256=${hash}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signature),
    );
  } catch {
    return false;
  }
}

// ============================================================================
// 📦 CORE DATA: ORDER LIFECYCLE
// ============================================================================

/**
 * Order status flow:
 * created → (admin reviews) → confirmed/rejected
 * confirmed → sent_to_shop → ready/failed
 * ready → completed/cancelled
 */

const ORDER_STATUSES = {
  CREATED: "created", // Initial state, awaiting confirmation
  CONFIRMED: "confirmed", // Customer confirmed their order
  REJECTED: "rejected", // Admin rejected (out of stock, etc)
  SENT_TO_SHOP: "sent_to_shop", // Shop received notification
  READY: "ready", // Shop says order is ready
  FAILED: "failed", // Shop says order failed
  COMPLETED: "completed", // Customer picked up
  CANCELLED: "cancelled", // Customer cancelled
};

// ============================================================================
// 🛠️ UTILITIES
// ============================================================================

function normalizePhone(raw) {
  if (!raw || typeof raw !== "string") return null;

  let cleaned = raw.replace(/\D/g, "");

  // Handle 0-prefixed Kenyan numbers
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.slice(1);
  }

  // Validate Kenyan format: 2547XXXXXXXX
  if (!/^2547\d{8}$/.test(cleaned)) return null;

  return cleaned;
}

function generateOrderId() {
  // 6-char alphanumeric: shorter, easier to type
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let id = "";
  for (let i = 0; i < 6; i++) {
    id += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return id;
}

function parseOrderItems(text) {
  if (!text || typeof text !== "string") return [];
  return text
    .split(/[,;\n]/)
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

// ============================================================================
// 🔄 WHATSAPP MESSAGING - WITH RETRY LOGIC
// ============================================================================

/**
 * Send message with automatic retry.
 * Retries: 3 attempts with exponential backoff.
 */
async function sendWhatsAppMessage(
  to,
  text,
  buttons = null,
  maxRetries = 3,
) {
  const normalizedTo = normalizePhone(to);
  if (!normalizedTo) {
    log("message_invalid_phone", { to });
    return { success: false, error: "invalid_phone" };
  }

  let lastError = null;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const payload = {
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: normalizedTo,
        type: buttons ? "interactive" : "text",
      };

      if (buttons) {
        payload.interactive = {
          type: "button",
          body: { text },
          action: {
            buttons: buttons.map((btn) => ({
              type: "reply",
              reply: { id: btn.id, title: btn.title },
            })),
          },
        };
      } else {
        payload.text = { preview_url: true, body: text };
      }

      const response = await fetch(
        `https://graph.instagram.com/v21.0/${CONFIG.PHONE_NUMBER_ID}/messages`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${CONFIG.ACCESS_TOKEN}`,
          },
          body: JSON.stringify(payload),
        },
      );

      const result = await response.json();

      if (!response.ok) {
        lastError = result.error?.message || "unknown_error";
        if (attempt < maxRetries) {
          const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }
        throw new Error(lastError);
      }

      const messageId = result.messages?.[0]?.id;
      log("whatsapp_message_sent", {
        to: normalizedTo,
        messageId,
        attempt,
        isButtonMessage: !!buttons,
      });

      return { success: true, messageId };
    } catch (err) {
      lastError = err.message;
      if (attempt < maxRetries) {
        const delay = Math.pow(2, attempt - 1) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  log("whatsapp_message_failed", {
    to: normalizedTo,
    maxRetries,
    lastError,
  });

  return { success: false, error: lastError };
}

// ============================================================================
// 🗄️ DATABASE OPERATIONS - WITH UNIQUE CONSTRAINTS
// ============================================================================

/**
 * Create order.
 * UNIQUE constraint on (customer_phone, created_at) within same minute
 * prevents accidental duplicates from retries.
 */
async function createOrder(customerPhone, itemText) {
  const orderId = generateOrderId();
  const normalizedPhone = normalizePhone(customerPhone);

  if (!normalizedPhone) {
    return { success: false, error: "invalid_phone" };
  }

  try {
    const { data, error } = await supabase.from("orders").insert([
      {
        order_id: orderId,
        customer_phone: normalizedPhone,
        items: itemText,
        status: ORDER_STATUSES.CREATED,
        created_at: new Date().toISOString(),
        confirmation_expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      },
    ]);

    if (error) {
      // 23505 = unique constraint violation (duplicate)
      if (error.code === "23505") {
        log("order_duplicate_detected", { orderId, customerPhone });
        // Find existing order
        const existing = await getOrderByPhoneRecent(normalizedPhone);
        return { success: true, orderId: existing?.order_id, isDuplicate: true };
      }

      log("order_creation_error", {
        orderId,
        errorCode: error.code,
        errorMessage: error.message,
      });
      return { success: false, error: error.message };
    }

    log("order_created", { orderId, customerPhone: normalizedPhone });
    return { success: true, orderId };
  } catch (err) {
    log("order_creation_exception", { error: err.message });
    return { success: false, error: err.message };
  }
}

async function getOrderByPhoneRecent(normalizedPhone) {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("customer_phone", normalizedPhone)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error && error.code !== "PGRST116") {
      log("order_fetch_error", { errorCode: error.code });
      return null;
    }

    return data || null;
  } catch (err) {
    log("order_fetch_exception", { error: err.message });
    return null;
  }
}

async function getOrderById(orderId) {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (error && error.code !== "PGRST116") {
      return null;
    }

    return data || null;
  } catch {
    return null;
  }
}

async function updateOrderStatus(orderId, newStatus) {
  try {
    const { error } = await supabase
      .from("orders")
      .update({
        status: newStatus,
        updated_at: new Date().toISOString(),
      })
      .eq("order_id", orderId);

    if (error) {
      log("order_update_error", { orderId, newStatus, errorCode: error.code });
      return false;
    }

    log("order_status_updated", { orderId, newStatus });
    return true;
  } catch (err) {
    log("order_update_exception", { error: err.message });
    return false;
  }
}

// ============================================================================
// ✅ MESSAGE HANDLING - TEXT & BUTTONS
// ============================================================================

async function handleIncomingMessage(from, text, messageId, messageType) {
  const normalizedPhone = normalizePhone(from);
  if (!normalizedPhone) {
    log("invalid_phone", { from });
    return;
  }

  // Check for YES/NO text responses
  const textUpper = (text || "").toUpperCase().trim();

  if (messageType === "button_reply") {
    // Button press
    const buttonId = text; // Interactive buttons send ID as text
    await handleButtonReply(normalizedPhone, buttonId);
  } else if (textUpper === "YES" || textUpper === "CONFIRM") {
    // Plain text confirmation
    const order = await getOrderByPhoneRecent(normalizedPhone);
    if (order && order.status === ORDER_STATUSES.CREATED) {
      await handleOrderConfirmation(order.order_id, normalizedPhone);
    } else {
      await sendWhatsAppMessage(
        normalizedPhone,
        "❓ I don't see a pending order. Send items to place a new order!",
      );
    }
  } else if (textUpper === "NO" || textUpper === "CANCEL") {
    // Plain text cancellation
    const order = await getOrderByPhoneRecent(normalizedPhone);
    if (order && order.status === ORDER_STATUSES.CREATED) {
      await updateOrderStatus(order.order_id, ORDER_STATUSES.CANCELLED);
      await sendWhatsAppMessage(
        normalizedPhone,
        `❌ Order #${order.order_id} cancelled.\n\nSend items again to place a new order.`,
      );
      log("order_cancelled_by_customer", {
        orderId: order.order_id,
        customerPhone: normalizedPhone,
      });
    } else {
      await sendWhatsAppMessage(
        normalizedPhone,
        "❓ I don't see a pending order to cancel.",
      );
    }
  } else {
    // Treat as new order
    const items = parseOrderItems(text);
    if (items.length === 0) {
      await sendWhatsAppMessage(
        normalizedPhone,
        "📝 Please send items separated by commas.\nExample: Sugar, Soap, Rice",
      );
      return;
    }

    await createAndConfirmOrder(normalizedPhone, text);
  }
}

async function createAndConfirmOrder(customerPhone, itemText) {
  const result = await createOrder(customerPhone, itemText);

  if (!result.success) {
    log("order_creation_failed", { customerPhone, error: result.error });

    // Admin notification
    await notifyAdmin(`❌ Order creation failed for ${customerPhone}: ${result.error}`);
    return;
  }

  const orderId = result.orderId;
  const items = parseOrderItems(itemText);

  const confirmationText =
    `✅ Order #${orderId} received!\n\n` +
    `📦 Items:\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}\n\n` +
    `Confirm? Reply: YES or NO`;

  const buttons = [
    { id: `confirm_${orderId}`, title: "✓ YES" },
    { id: `cancel_${orderId}`, title: "✗ NO" },
  ];

  const { success } = await sendWhatsAppMessage(
    customerPhone,
    confirmationText,
    buttons,
  );

  if (success) {
    log("confirmation_message_sent", { orderId, customerPhone });
  } else {
    log("confirmation_message_failed", { orderId, customerPhone });

    // Fallback: send plain text only
    await sendWhatsAppMessage(customerPhone, confirmationText);

    // Admin notification
    await notifyAdmin(
      `⚠️ Button message failed for order #${orderId}. Sent plain text fallback.`,
    );
  }
}

async function handleButtonReply(customerPhone, buttonId) {
  if (buttonId.startsWith("confirm_")) {
    const orderId = buttonId.split("_")[1];
    await handleOrderConfirmation(orderId, customerPhone);
  } else if (buttonId.startsWith("cancel_")) {
    const orderId = buttonId.split("_")[1];
    const success = await updateOrderStatus(orderId, ORDER_STATUSES.CANCELLED);
    if (success) {
      await sendWhatsAppMessage(
        customerPhone,
        `❌ Order #${orderId} cancelled.\n\nSend items again to place a new order.`,
      );
      log("order_cancelled_by_customer", { orderId, customerPhone });
    }
  } else if (buttonId.startsWith("ready_")) {
    const orderId = buttonId.split("_")[1];
    const success = await updateOrderStatus(orderId, ORDER_STATUSES.READY);
    if (success) {
      const order = await getOrderById(orderId);
      if (order) {
        await sendWhatsAppMessage(
          order.customer_phone,
          `✅ Order #${orderId} is ready for pickup!`,
        );
      }
      log("order_marked_ready", { orderId });
    }
  } else if (buttonId.startsWith("failed_")) {
    const orderId = buttonId.split("_")[1];
    const success = await updateOrderStatus(orderId, ORDER_STATUSES.FAILED);
    if (success) {
      const order = await getOrderById(orderId);
      if (order) {
        await sendWhatsAppMessage(
          order.customer_phone,
          `❌ Order #${orderId} could not be fulfilled. Try again?`,
        );
      }
      await notifyAdmin(`⚠️ Order #${orderId} marked as failed by shop.`);
      log("order_marked_failed", { orderId });
    }
  }
}

async function handleOrderConfirmation(orderId, customerPhone) {
  const order = await getOrderById(orderId);

  if (!order) {
    await sendWhatsAppMessage(customerPhone, "❓ Order not found.");
    return;
  }

  if (order.status !== ORDER_STATUSES.CREATED) {
    await sendWhatsAppMessage(
      customerPhone,
      `Order #${orderId} is already ${order.status}.`,
    );
    return;
  }

  const success = await updateOrderStatus(orderId, ORDER_STATUSES.CONFIRMED);

  if (success) {
    await sendWhatsAppMessage(
      customerPhone,
      `✅ Order #${orderId} confirmed!\n\n⏳ Shop will respond shortly.`,
    );

    // Send to shop
    await sendOrderToShop(order);

    log("order_confirmed", { orderId, customerPhone });
  } else {
    await notifyAdmin(`❌ Failed to confirm order #${orderId}`);
  }
}

async function sendOrderToShop(order) {
  const items = parseOrderItems(order.items);
  const shopMessage =
    `📬 New Order #${order.order_id}\n\n` +
    `👤 From: ${order.customer_phone}\n\n` +
    `📦 Items:\n${items.map((item, i) => `${i + 1}. ${item}`).join("\n")}`;

  const buttons = [
    { id: `ready_${order.order_id}`, title: "✓ READY" },
    { id: `failed_${order.order_id}`, title: "✗ FAILED" },
  ];

  const { success } = await sendWhatsAppMessage(
    CONFIG.SHOP_PHONE,
    shopMessage,
    buttons,
  );

  if (success) {
    await updateOrderStatus(order.order_id, ORDER_STATUSES.SENT_TO_SHOP);
    log("order_sent_to_shop", { orderId: order.order_id });
  } else {
    // Fallback: send plain text
    await sendWhatsAppMessage(CONFIG.SHOP_PHONE, shopMessage);
    log("order_sent_to_shop_fallback", { orderId: order.order_id });

    await notifyAdmin(
      `⚠️ Button message failed for order #${order.order_id}. Sent plain text.`,
    );
  }
}

// ============================================================================
// 🚨 ADMIN NOTIFICATIONS & RECOVERY
// ============================================================================

async function notifyAdmin(message) {
  const { success } = await sendWhatsAppMessage(CONFIG.ADMIN_PHONE, message);
  if (!success) {
    log("admin_notification_failed", { message });
  }
}

async function getFailedOrders() {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .in("status", [
        ORDER_STATUSES.CREATED,
        ORDER_STATUSES.CONFIRMED,
        ORDER_STATUSES.SENT_TO_SHOP,
      ])
      .order("created_at", { ascending: true });

    if (error) return [];
    return data || [];
  } catch {
    return [];
  }
}

// ============================================================================
// 🌐 WEBHOOK ENDPOINTS
// ============================================================================

app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === CONFIG.VERIFY_TOKEN) {
    log("webhook_verified");
    res.status(200).send(challenge);
  } else {
    log("webhook_verify_failed");
    res.status(403).send("Unauthorized");
  }
});

app.post("/webhook", async (req, res) => {
  if (!verifyWebhookSignature(req)) {
    log("webhook_signature_invalid");
    return res.status(403).send("Unauthorized");
  }

  log("webhook_received");

  // Acknowledge immediately
  res.status(200).send("Received");

  try {
    const body = req.body;
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;

    // Handle messages
    const messages = value?.messages || [];
    for (const message of messages) {
      const from = message.from;
      const messageId = message.id;
      let messageType = message.type;
      let text = null;

      if (messageType === "interactive") {
        messageType = "button_reply";
        text = message.interactive?.button_reply?.id;
      } else if (messageType === "text") {
        text = message.text?.body;
      } else {
        log("message_type_unsupported", { from, messageType });
        continue;
      }

      if (!text) continue;

      await handleIncomingMessage(from, text, messageId, messageType);
    }

    // Handle delivery receipts
    const statuses = value?.statuses || [];
    for (const status of statuses) {
      log("delivery_status", {
        messageId: status.id,
        status: status.status,
        timestamp: status.timestamp,
      });
    }
  } catch (err) {
    log("webhook_processing_error", {
      error: err.message,
      stack: err.stack,
    });

    // Notify admin of critical errors
    await notifyAdmin(
      `🚨 CRITICAL: Webhook processing error: ${err.message}`,
    );
  }
});

// ============================================================================
// 📊 METRICS & HEALTH
// ============================================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

app.get("/metrics", async (req, res) => {
  try {
    const { count: totalOrders } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true });

    const { count: createdOrders } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("status", ORDER_STATUSES.CREATED);

    const { count: readyOrders } = await supabase
      .from("orders")
      .select("*", { count: "exact", head: true })
      .eq("status", ORDER_STATUSES.READY);

    res.status(200).json({
      timestamp: new Date().toISOString(),
      totalOrders,
      createdOrders,
      readyOrders,
      systemStatus: "operational",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ============================================================================
// ⏰ PERIODIC TASKS
// ============================================================================

// Every 5 minutes: check for expired unconfirmed orders
setInterval(async () => {
  try {
    const now = new Date().toISOString();
    const { data: expiredOrders, error } = await supabase
      .from("orders")
      .select("*")
      .eq("status", ORDER_STATUSES.CREATED)
      .lt("confirmation_expires_at", now);

    if (error) {
      log("expired_order_check_error", { errorCode: error.code });
      return;
    }

    for (const order of expiredOrders || []) {
      const success = await updateOrderStatus(
        order.order_id,
        ORDER_STATUSES.CANCELLED,
      );

      if (success) {
        await sendWhatsAppMessage(
          order.customer_phone,
          `⏱️ Order #${order.order_id} expired.\n\nYou didn't confirm in time. Send items again?`,
        );

        log("order_expired", { orderId: order.order_id });
      }
    }
  } catch (err) {
    log("expired_order_check_exception", { error: err.message });
  }
}, 5 * 60 * 1000);

// Every hour: cleanup old processing messages (deduplication)
setInterval(async () => {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("message_dedup")
      .delete()
      .lt("created_at", oneHourAgo);

    if (error) {
      log("dedup_cleanup_error", { errorCode: error.code });
    } else {
      log("dedup_cleanup_success");
    }
  } catch (err) {
    log("dedup_cleanup_exception", { error: err.message });
  }
}, 60 * 60 * 1000);

// ============================================================================
// 🚀 SERVER START
// ============================================================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  log("server_started", { port: PORT });
  console.log(`✅ dig.ka is running on port ${PORT}`);
  console.log(`📊 Metrics: http://localhost:${PORT}/metrics`);
  console.log(`💚 Health: http://localhost:${PORT}/health`);
});