require("dotenv").config();
const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const crypto = require("crypto");

const app = express();

// ============================================================================
// INITIALIZATION & VALIDATION
// ============================================================================

// Critical secrets - fail fast if missing
if (!process.env.WHATSAPP_APP_SECRET) {
  console.error("❌ CRITICAL: Missing WHATSAPP_APP_SECRET in .env");
  process.exit(1);
}

// Raw body middleware - required for signature verification
app.use(
  express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf.toString("utf8");
    },
  }),
);

// Supabase client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY,
);

// Configuration validation
function validateConfig() {
  const required = [
    "SUPABASE_URL",
    "SUPABASE_KEY",
    "PHONE_NUMBER_ID",
    "ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "VERIFY_TOKEN",
  ];

  for (const key of required) {
    if (!process.env[key]) {
      throw new Error(`Missing required env var: ${key}`);
    }
  }

  if (process.env.VERIFY_TOKEN === "my_verify_token") {
    throw new Error("VERIFY_TOKEN cannot be default. Set in environment.");
  }
}

validateConfig();

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const APP_SECRET = process.env.WHATSAPP_APP_SECRET;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;

// ============================================================================
// MULTI-SHOP QUEUE SYSTEM
// Each shop has its own isolated queue
// ============================================================================

class ShopQueue {
  constructor(shopId) {
    this.shopId = shopId;
    this.messages = [];
    this.isProcessing = false;
  }

  enqueue(message) {
    this.messages.push(message);
  }

  dequeue() {
    return this.messages.shift();
  }

  length() {
    return this.messages.length;
  }

  isEmpty() {
    return this.messages.length === 0;
  }
}

// Global shop queue map: { [shopId]: ShopQueue }
const SHOP_QUEUES = {};

// Get or create queue for a shop
function getShopQueue(shopId) {
  if (!SHOP_QUEUES[shopId]) {
    SHOP_QUEUES[shopId] = new ShopQueue(shopId);
  }
  return SHOP_QUEUES[shopId];
}

// ============================================================================
// LOGGING
// ============================================================================

function log(event, data = {}) {
  const timestamp = new Date().toISOString();
  const logEntry = {
    timestamp,
    event,
    ...data,
  };
  console.log(JSON.stringify(logEntry));
}

// ============================================================================
// CRYPTOGRAPHY & SIGNATURES
// ============================================================================

// Verify webhook signature (security check)
function verifyWebhookSignature(req) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    log("webhook_verify_missing_signature");
    return false;
  }

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

// ============================================================================
// UTILITIES
// ============================================================================

// Normalize and validate Kenyan phone numbers
function normalizeAndValidatePhone(raw) {
  if (!raw || typeof raw !== "string") {
    throw new Error("INVALID_PHONE_TYPE");
  }

  let cleaned = raw.replace(/\D/g, "");

  // Handle 0-prefixed Kenyan numbers
  if (cleaned.startsWith("0")) {
    cleaned = "254" + cleaned.slice(1);
  }

  const phone = cleaned; // No leading + for Supabase queries

  // Validate Kenyan format: 2547XXXXXXXX
  if (!/^2547\d{8}$/.test(phone)) {
    throw new Error("INVALID_PHONE_FORMAT");
  }

  return phone;
}

// Generate unique order ID (4-5 digits)
function generateOrderId() {
  return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// ============================================================================
// DEDUPLICATION (Pessimistic - Mark Before Processing)
// ============================================================================

async function markMessageProcessing(messageId) {
  // INSERT a "processing" marker before we process
  // If we crash, the marker stays and prevents replay on WhatsApp retry
  try {
    const { error } = await supabase
      .from("processing_messages")
      .insert([
        {
          message_id: messageId,
          status: "processing",
          created_at: new Date().toISOString(),
        },
      ]);

    if (error) {
      log("dedup_insert_error", { messageId, errorCode: error.code });
      // If insert fails, don't process (safer than duplicating)
      return false;
    }
    return true;
  } catch (err) {
    log("dedup_insert_error", { messageId, error: err.message });
    return false;
  }
}

async function isMessageAlreadyProcessing(messageId) {
  try {
    const { data } = await supabase
      .from("processing_messages")
      .select("message_id")
      .eq("message_id", messageId)
      .eq("status", "processing")
      .single();

    return !!data;
  } catch (err) {
    // If query fails, assume not processing (let it go through)
    return false;
  }
}

async function markMessageDone(messageId) {
  try {
    await supabase
      .from("processing_messages")
      .update({ status: "done" })
      .eq("message_id", messageId);
  } catch (err) {
    log("dedup_mark_done_error", { messageId, error: err.message });
  }
}

// ============================================================================
// SHOP MANAGEMENT
// ============================================================================

async function getShopById(shopId) {
  try {
    const { data, error } = await supabase
      .from("shops")
      .select("*")
      .eq("id", shopId)
      .single();

    if (error) {
      log("shop_fetch_error", { shopId, errorCode: error.code });
      return null;
    }

    return data;
  } catch (err) {
    log("shop_fetch_error", { shopId, error: err.message });
    return null;
  }
}

async function getShopByPhone(phone) {
  try {
    const normalized = normalizeAndValidatePhone(phone);
    const { data, error } = await supabase
      .from("shops")
      .select("*")
      .eq("phone", normalized)
      .eq("active", true)
      .single();

    if (error) {
      log("shop_fetch_by_phone_error", { phone: normalized, errorCode: error.code });
      return null;
    }

    return data;
  } catch (err) {
    log("shop_fetch_by_phone_error", { phone, error: err.message });
    return null;
  }
}

// ============================================================================
// CUSTOMER SESSION MANAGEMENT
// ============================================================================

async function getCustomerSession(customerPhone) {
  try {
    const normalized = normalizeAndValidatePhone(customerPhone);
    const { data, error } = await supabase
      .from("customer_sessions")
      .select("*")
      .eq("phone", normalized)
      .order("created_at", { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // No session found, that's OK
      return null;
    }

    return data;
  } catch (err) {
    log("session_fetch_error", { phone: customerPhone, error: err.message });
    return null;
  }
}

async function storeCustomerShopSelection(customerPhone, shopId) {
  try {
    const normalized = normalizeAndValidatePhone(customerPhone);
    const { error } = await supabase
      .from("customer_sessions")
      .insert([
        {
          phone: normalized,
          selected_shop_id: shopId,
          created_at: new Date().toISOString(),
        },
      ]);

    if (error) {
      log("session_store_error", { phone: normalized, shopId, errorCode: error.code });
      return false;
    }

    return true;
  } catch (err) {
    log("session_store_error", { phone: customerPhone, shopId, error: err.message });
    return false;
  }
}

// ============================================================================
// ORDER MANAGEMENT
// ============================================================================

async function createOrder(orderData) {
  // orderData: {
  //   order_id,
  //   customer_phone,
  //   shop_id,
  //   shop_phone,
  //   raw_text,
  //   parsed_items,
  //   status,
  // }

  try {
    const { error } = await supabase
      .from("orders")
      .insert([
        {
          ...orderData,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(), // 15 min expiry
        },
      ]);

    if (error) {
      log("order_create_error", { order_id: orderData.order_id, errorCode: error.code });
      return false;
    }

    return true;
  } catch (err) {
    log("order_create_error", { order_id: orderData.order_id, error: err.message });
    return false;
  }
}

async function getOrder(orderId) {
  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .eq("order_id", orderId)
      .single();

    if (error) {
      log("order_fetch_error", { order_id: orderId, errorCode: error.code });
      return null;
    }

    return data;
  } catch (err) {
    log("order_fetch_error", { order_id: orderId, error: err.message });
    return null;
  }
}

async function updateOrderStatus(orderId, newStatus, metadata = {}) {
  try {
    const updateData = {
      status: newStatus,
      updated_at: new Date().toISOString(),
      ...metadata,
    };

    const { error } = await supabase
      .from("orders")
      .update(updateData)
      .eq("order_id", orderId);

    if (error) {
      log("order_update_error", { order_id: orderId, newStatus, errorCode: error.code });
      return false;
    }

    return true;
  } catch (err) {
    log("order_update_error", { order_id: orderId, newStatus, error: err.message });
    return false;
  }
}

// ============================================================================
// PARSING (Accept Raw Text, Don't Try to Parse Yet)
// ============================================================================

function simpleParse(text) {
  // PHASE 1: Just store raw text
  // Don't try to be smart about parsing
  // Customer + shop will collaborate on the text

  if (!text || typeof text !== "string" || text.length < 2) {
    return [];
  }

  // Minimal parsing: split by comma or "and"
  const items = [];
  const parts = text.split(/,|and|na/i);

  for (let part of parts) {
    const trimmed = part.trim();
    if (trimmed.length >= 2) {
      items.push({ name: trimmed, qty: 1 });
    }
  }

  return items;
}

// ============================================================================
// MESSAGE FORMATTING
// ============================================================================

function formatOrderForConfirmation(items) {
  if (!items || items.length === 0) {
    return "No items detected";
  }
  return items.map((i) => `${i.qty}x ${i.name}`).join("\n");
}

// ============================================================================
// WHATSAPP MESSAGE SENDING (Interactive Buttons)
// ============================================================================

async function sendInteractiveButtonMessage(to, bodyText, buttons, retryCount = 0) {
  // Send interactive message with quick reply buttons
  // buttons: [{ id: "confirm_4527", title: "YES ✓" }, ...]

  const MAX_RETRIES = 3;

  try {
    const normalizedPhone = normalizeAndValidatePhone(to);

    log("send_interactive_attempt", {
      phone: normalizedPhone,
      buttonCount: buttons.length,
      retryCount,
    });

    const payload = {
      messaging_product: "whatsapp",
      to: normalizedPhone,
      type: "interactive",
      interactive: {
        type: "button",
        body: {
          text: bodyText,
        },
        action: {
          buttons: buttons.map((btn) => ({
            type: "reply",
            reply: {
              id: btn.id,
              title: btn.title,
            },
          })),
        },
      },
    };

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
        body: JSON.stringify(payload),
      },
    );

    const responseData = await res.json();

    if (res.ok) {
      log("send_interactive_success", {
        phone: normalizedPhone,
        messageId: responseData.messages?.[0]?.id,
      });
      return true;
    }

    // Temporary error - retry
    if (responseData.error?.code === 400) {
      log("send_interactive_permanent_error", {
        phone: normalizedPhone,
        error: responseData.error?.message,
      });
      return false;
    }

    // Possibly temporary
    if (retryCount < MAX_RETRIES) {
      const backoff = 1000 * Math.pow(2, retryCount);
      log("send_interactive_retry", {
        phone: normalizedPhone,
        retryCount,
        backoff,
      });
      await new Promise((resolve) => setTimeout(resolve, backoff));
      return sendInteractiveButtonMessage(to, bodyText, buttons, retryCount + 1);
    }

    log("send_interactive_failed_max_retries", { phone: normalizedPhone });
    return false;
  } catch (err) {
    log("send_interactive_exception", { phone: to, error: err.message });

    if (retryCount < MAX_RETRIES && err.message.includes("timeout")) {
      const backoff = 1000 * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      return sendInteractiveButtonMessage(to, bodyText, buttons, retryCount + 1);
    }

    return false;
  }
}

async function sendTextMessage(to, bodyText, retryCount = 0) {
  // Send simple text message (no buttons)

  const MAX_RETRIES = 3;

  try {
    const normalizedPhone = normalizeAndValidatePhone(to);

    log("send_text_attempt", {
      phone: normalizedPhone,
      textLength: bodyText.length,
      retryCount,
    });

    const res = await fetch(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        timeout: 10000,
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: normalizedPhone,
          type: "text",
          text: { body: bodyText },
        }),
      },
    );

    const responseData = await res.json();

    if (res.ok) {
      log("send_text_success", {
        phone: normalizedPhone,
        messageId: responseData.messages?.[0]?.id,
      });
      return true;
    }

    // Permanent error
    if (responseData.error?.code === 400) {
      log("send_text_permanent_error", {
        phone: normalizedPhone,
        error: responseData.error?.message,
      });
      return false;
    }

    // Retry on temporary error
    if (retryCount < MAX_RETRIES) {
      const backoff = 1000 * Math.pow(2, retryCount);
      log("send_text_retry", {
        phone: normalizedPhone,
        retryCount,
        backoff,
      });
      await new Promise((resolve) => setTimeout(resolve, backoff));
      return sendTextMessage(to, bodyText, retryCount + 1);
    }

    log("send_text_failed_max_retries", { phone: normalizedPhone });
    return false;
  } catch (err) {
    log("send_text_exception", { phone: to, error: err.message });

    if (retryCount < MAX_RETRIES && err.message.includes("timeout")) {
      const backoff = 1000 * Math.pow(2, retryCount);
      await new Promise((resolve) => setTimeout(resolve, backoff));
      return sendTextMessage(to, bodyText, retryCount + 1);
    }

    return false;
  }
}

// ============================================================================
// MAIN MESSAGE PROCESSING LOGIC
// ============================================================================

async function processMessage(from, messageId, messageType, messageContent) {
  // This is the core logic for handling incoming messages
  // Four message types:
  // 1. "text" - customer sending order or shop selection
  // 2. "button_reply" - customer/shop pressing a button
  // 3. "delivery" - delivery receipt (ignore for now)
  // 4. "read" - read receipt (ignore for now)

  // Deduplication: Mark processing BEFORE we process
  const canProcess = await markMessageProcessing(messageId);
  if (!canProcess) {
    log("message_skipped_already_marked", {
      from,
      messageId,
    });
    return;
  }

  try {
    if (messageType === "button_reply") {
      // Customer or shop pressed a button
      await handleButtonReply(from, messageContent);
    } else if (messageType === "text") {
      // Customer sent text (order or shop selection)
      await handleTextMessage(from, messageContent);
    }

    // Mark processing as complete
    await markMessageDone(messageId);
  } catch (err) {
    log("process_message_error", {
      from,
      messageId,
      error: err.message,
    });
    // Still mark as done so we don't retry infinitely
    await markMessageDone(messageId);
  }
}

// Handle button presses (YES, NO, READY, NOT AVAILABLE)
async function handleButtonReply(from, buttonData) {
  const buttonId = buttonData?.button_reply?.id;
  if (!buttonId) {
    log("button_reply_no_id", { from });
    return;
  }

  log("button_reply_received", { from, buttonId });

  // Extract order ID from button ID
  // Format: "confirm_4527", "cancel_4527", "done_4527", "failed_4527"
  const [action, orderId] = buttonId.split("_");

  if (!orderId) {
    log("button_reply_invalid_format", { from, buttonId });
    await sendTextMessage(from, "❌ Invalid button. Try again.");
    return;
  }

  // Determine if this is customer or shop based on action
  if (action === "confirm" || action === "cancel") {
    // Customer confirming/cancelling order
    await handleCustomerConfirmation(from, orderId, action);
  } else if (action === "done" || action === "failed") {
    // Shop responding to order
    await handleShopConfirmation(from, orderId, action);
  } else {
    log("button_reply_unknown_action", { from, action });
  }
}

// Handle customer YES/NO confirmation
async function handleCustomerConfirmation(from, orderId, action) {
  const order = await getOrder(orderId);

  if (!order) {
    log("order_not_found", { orderId, from });
    await sendTextMessage(from, `❌ Order #${orderId} not found. Try again.`);
    return;
  }

  if (order.status !== "pending_confirmation") {
    log("order_wrong_status", {
      orderId,
      expectedStatus: "pending_confirmation",
      actualStatus: order.status,
    });
    await sendTextMessage(
      from,
      `❌ Order #${orderId} is no longer pending. Status: ${order.status}`,
    );
    return;
  }

  if (action === "confirm") {
    // Customer said YES
    log("customer_confirmed_order", { orderId, from });

    // Update order status
    const success = await updateOrderStatus(orderId, "confirmed", {
      customer_confirmed_at: new Date().toISOString(),
    });

    if (!success) {
      await sendTextMessage(from, `❌ Failed to confirm order #${orderId}. Try again.`);
      return;
    }

    // Send to shop
    const shop = await getShopById(order.shop_id);
    if (!shop) {
      log("shop_not_found_for_order", { orderId, shopId: order.shop_id });
      await sendTextMessage(from, `❌ Shop not found. Contact support.`);
      return;
    }

    // Update status to "forwarded"
    await updateOrderStatus(orderId, "forwarded", {
      shop_notified_at: new Date().toISOString(),
    });

    // Send interactive message to shop
    const formattedOrder = formatOrderForConfirmation(order.parsed_items);
    const shopMessage = `🔔 Order #${orderId}\n\n${formattedOrder}\n\nCustomer: ${from}`;

    const buttons = [
      { id: `done_${orderId}`, title: "READY ✓" },
      { id: `failed_${orderId}`, title: "NOT AVAILABLE" },
    ];

    await sendInteractiveButtonMessage(shop.phone, shopMessage, buttons);

    log("order_forwarded_to_shop", { orderId, shopId: order.shop_id });
  } else if (action === "cancel") {
    // Customer said NO
    log("customer_cancelled_order", { orderId, from });

    const success = await updateOrderStatus(orderId, "cancelled_by_customer");
    if (success) {
      await sendTextMessage(
        from,
        `Order #${orderId} cancelled.\n\nSend a new order whenever ready!`,
      );
    } else {
      await sendTextMessage(from, `❌ Failed to cancel order. Try again.`);
    }
  }
}

// Handle shop READY/NOT AVAILABLE confirmation
async function handleShopConfirmation(from, orderId, action) {
  const order = await getOrder(orderId);

  if (!order) {
    log("order_not_found_shop", { orderId, from });
    await sendTextMessage(from, `❌ Order #${orderId} not found.`);
    return;
  }

  if (order.status !== "forwarded") {
    log("order_wrong_status_shop", {
      orderId,
      expectedStatus: "forwarded",
      actualStatus: order.status,
    });
    await sendTextMessage(from, `❌ Order #${orderId} is not pending. Status: ${order.status}`);
    return;
  }

  if (action === "done") {
    // Shop said READY
    log("shop_confirmed_order", { orderId, from });

    const success = await updateOrderStatus(orderId, "done", {
      shop_confirmed_at: new Date().toISOString(),
    });

    if (!success) {
      await sendTextMessage(from, `❌ Failed to confirm order. Try again.`);
      return;
    }

    // Notify customer
    const shop = await getShopById(order.shop_id);
    const shopName = shop?.name || "the shop";

    const customerMessage = `✓ Your order is ready!\n\nOrder #${orderId}\n${formatOrderForConfirmation(order.parsed_items)}\n\nPick up from ${shopName}`;

    await sendTextMessage(order.customer_phone, customerMessage);

    log("customer_notified_ready", { orderId });
  } else if (action === "failed") {
    // Shop said NOT AVAILABLE
    log("shop_unavailable_order", { orderId, from });

    const success = await updateOrderStatus(orderId, "failed");
    if (success) {
      const customerMessage = `❌ Order #${orderId} is not available.\n\nTry another shop or item.`;
      await sendTextMessage(order.customer_phone, customerMessage);
    }

    log("customer_notified_failed", { orderId });
  }
}

// Handle text messages (shop selection or new order)
async function handleTextMessage(from, textContent) {
  const text = textContent?.text?.body || "";

  if (!text) {
    log("text_message_empty", { from });
    return;
  }

  log("text_message_received", { from, text });

  // Check if customer has a session with selected shop
  const session = await getCustomerSession(from);

  // Determine if this is a shop selection or an order
  const isShopSelection = /^[1-3]$/.test(text.trim());

  if (isShopSelection && !session) {
    // Customer hasn't selected a shop yet, and they're replying with a number
    // Treat as shop selection
    await handleShopSelection(from, text.trim());
  } else if (session) {
    // Customer has a shop selected, treat as order
    await handleNewOrder(from, session.selected_shop_id, text);
  } else {
    // No shop selected yet, ask for selection
    await sendShopSelectionMessage(from);
  }
}

// Handle shop selection (customer replies with shop number)
async function handleShopSelection(from, shopNumber) {
  log("shop_selection_received", { from, shopNumber });

  // For now, we only have 1 shop. Later, fetch from database
  // This is a placeholder - you would query the shops table
  // and let customer choose from available shops

  const shops = [
    { id: "shop_1", name: "Test Shop", number: "1" },
    // Add more shops later
  ];

  const selectedShop = shops.find((s) => s.number === shopNumber);

  if (!selectedShop) {
    await sendTextMessage(from, "❌ Invalid shop number. Reply 1, 2, or 3");
    return;
  }

  // Store customer's shop selection
  const success = await storeCustomerShopSelection(from, selectedShop.id);

  if (success) {
    await sendTextMessage(
      from,
      `✓ Selected: ${selectedShop.name}\n\nNow send your order. Example:\nmilk 2, eggs 5, bread`,
    );
  } else {
    await sendTextMessage(from, `❌ Failed to save selection. Try again.`);
  }
}

// Send shop selection message
async function sendShopSelectionMessage(from) {
  const message = `Welcome to dig.ka!\n\nWhich shop?\n1️⃣ Test Shop\n\nReply with the number`;

  await sendTextMessage(from, message);
}

// Handle new order from customer
async function handleNewOrder(from, shopId, rawText) {
  log("new_order_received", { from, shopId, rawText });

  // Generate order ID
  const orderId = generateOrderId();

  // Parse order
  const parsedItems = simpleParse(rawText);

  if (parsedItems.length === 0) {
    await sendTextMessage(
      from,
      "❌ Couldn't parse your order. Please try again.\nExample: milk 2, eggs 5, bread",
    );
    return;
  }

  // Get shop details
  const shop = await getShopById(shopId);
  if (!shop) {
    log("shop_not_found", { shopId });
    await sendTextMessage(from, "❌ Shop not found. Try again.");
    return;
  }

  // Create order in database
  const orderCreated = await createOrder({
    order_id: orderId,
    customer_phone: from,
    shop_id: shopId,
    shop_phone: shop.phone,
    raw_text: rawText,
    parsed_items: parsedItems,
    status: "pending_confirmation",
  });

  if (!orderCreated) {
    await sendTextMessage(
      from,
      `❌ Failed to create order. Try again.`,
    );
    return;
  }

  log("order_created", { orderId, from, shopId });

  // Send confirmation message with buttons to customer
  const formattedOrder = formatOrderForConfirmation(parsedItems);
  const confirmationText = `Got it! You ordered:\n\n${formattedOrder}\n\nReply YES to confirm or NO to cancel`;

  const buttons = [
    { id: `confirm_${orderId}`, title: "YES ✓" },
    { id: `cancel_${orderId}`, title: "NO ✗" },
  ];

  const confirmationSent = await sendInteractiveButtonMessage(
    from,
    confirmationText,
    buttons,
  );

  if (!confirmationSent) {
    log("confirmation_send_failed", { orderId });
    // Order is created, but customer didn't get confirmation
    // They can retry or order times out in 15 minutes
  } else {
    log("confirmation_sent", { orderId });
  }
}

// ============================================================================
// PERIODIC TASKS
// ============================================================================

// Clean up old processing messages every hour
async function cleanupOldProcessingMessages() {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { error } = await supabase
      .from("processing_messages")
      .delete()
      .lt("created_at", oneHourAgo);

    if (error) {
      log("cleanup_error", { errorCode: error.code });
    } else {
      log("cleanup_success");
    }
  } catch (err) {
    log("cleanup_error", { error: err.message });
  }
}

// Cancel expired orders every 5 minutes
async function cancelExpiredOrders() {
  try {
    const now = new Date().toISOString();
    const { data: expiredOrders, error } = await supabase
      .from("orders")
      .select("*")
      .eq("status", "pending_confirmation")
      .lt("expires_at", now);

    if (error) {
      log("expire_check_error", { errorCode: error.code });
      return;
    }

    for (const order of expiredOrders || []) {
      const success = await updateOrderStatus(order.order_id, "expired");

      if (success) {
        // Notify customer
        await sendTextMessage(
          order.customer_phone,
          `⏱️ Your order #${order.order_id} expired.\n\nYou didn't confirm in time. Send a new order?`,
        );

        log("order_expired", { orderId: order.order_id });
      }
    }
  } catch (err) {
    log("expire_check_error", { error: err.message });
  }
}

// Run cleanup tasks
setInterval(cleanupOldProcessingMessages, 60 * 60 * 1000); // Every hour
setInterval(cancelExpiredOrders, 5 * 60 * 1000); // Every 5 minutes

// ============================================================================
// WEBHOOK ENDPOINTS
// ============================================================================

// GET /webhook - WhatsApp verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === VERIFY_TOKEN) {
    log("webhook_verified");
    res.status(200).send(challenge);
  } else {
    log("webhook_verify_failed", { mode, token });
    res.status(403).send("Unauthorized");
  }
});

// POST /webhook - Handle incoming messages
app.post("/webhook", async (req, res) => {
  // Verify signature immediately
  if (!verifyWebhookSignature(req)) {
    log("webhook_signature_invalid");
    return res.status(403).send("Unauthorized");
  }

  log("webhook_received");

  // Acknowledge to WhatsApp immediately (required)
  res.status(200).send("Received");

  const body = req.body;

  // Parse webhook payload
  const entry = body.entry?.[0];
  const changes = entry?.changes?.[0];
  const value = changes?.value;
  const messages = value?.messages || [];
  const statuses = value?.statuses || [];

  // Process messages
  for (const message of messages) {
    const from = message.from;
    const messageId = message.id;
    const timestamp = message.timestamp;

    // Determine message type
    let messageType = message.type; // "text", "interactive", "image", etc
    let messageContent = null;

    if (messageType === "interactive") {
      messageType = "button_reply";
      messageContent = message.interactive;
    } else if (messageType === "text") {
      messageContent = message.text;
    } else {
      // Ignore other types for now
      log("message_type_unsupported", { from, messageType });
      continue;
    }

    // Process message
    await processMessage(from, messageId, messageType, messageContent);
  }

  // Log delivery receipts (optional)
  for (const status of statuses) {
    log("delivery_receipt", {
      phone: status.recipient_id,
      messageId: status.id,
      status: status.status,
    });
  }
});

// ============================================================================
// HEALTH CHECK
// ============================================================================

app.get("/health", (req, res) => {
  res.status(200).json({
    status: "ok",
    timestamp: new Date().toISOString(),
    queues: Object.keys(SHOP_QUEUES).map((shopId) => ({
      shopId,
      length: SHOP_QUEUES[shopId].length(),
    })),
  });
});

// ============================================================================
// START SERVER
// ============================================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  log("server_started", { port: PORT });
  console.log(`✓ dig.ka is running on port ${PORT}`);
});