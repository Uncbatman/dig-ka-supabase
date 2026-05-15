-- DIG.KA Database Schema
-- Single shop, hardened reliability, orders never disappear

-- ============================================================================
-- ORDERS TABLE - Core data
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  -- Order identity
  order_id TEXT NOT NULL UNIQUE, -- e.g., "ABC123"
  customer_phone TEXT NOT NULL, -- Normalized: 2547XXXXXXXX
  items TEXT NOT NULL, -- Raw text: "Sugar, Soap, Rice"
  
  -- Status tracking
  status TEXT NOT NULL DEFAULT 'created',
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW(),
  confirmation_expires_at TIMESTAMP,
  
  -- Indexes for queries
  -- Get customer's recent orders
  CONSTRAINT customer_phone_fk CHECK (customer_phone ~ '^2547[0-9]{8}$')
);

CREATE INDEX idx_orders_customer_phone ON orders(customer_phone DESC, created_at DESC);
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_created_at ON orders(created_at DESC);

-- Unique constraint: prevent duplicate orders from same customer within 1 minute
-- (deduplication for retry logic)
CREATE UNIQUE INDEX idx_orders_dedup 
  ON orders(customer_phone, DATE_TRUNC('minute', created_at))
  WHERE status = 'created';

-- ============================================================================
-- MESSAGE DEDUPLICATION TABLE
-- ============================================================================

CREATE TABLE IF NOT EXISTS message_dedup (
  message_id TEXT PRIMARY KEY,
  customer_phone TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  CONSTRAINT message_dedup_phone_fk CHECK (customer_phone ~ '^2547[0-9]{8}$')
);

CREATE INDEX idx_message_dedup_created_at ON message_dedup(created_at DESC);

-- ============================================================================
-- ORDER HISTORY / AUDIT LOG
-- ============================================================================

-- For recovery: see exactly what happened to each order
CREATE TABLE IF NOT EXISTS order_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT NOT NULL,
  event_type TEXT NOT NULL, -- created, confirmed, sent_to_shop, ready, failed, etc
  description TEXT,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  
  FOREIGN KEY (order_id) REFERENCES orders(order_id)
);

CREATE INDEX idx_order_events_order_id ON order_events(order_id, created_at DESC);

-- ============================================================================
-- ADMIN NOTIFICATIONS LOG
-- ============================================================================

-- Track what we've notified admin about
CREATE TABLE IF NOT EXISTS admin_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id TEXT,
  message TEXT NOT NULL,
  status TEXT DEFAULT 'pending', -- pending, sent, failed
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMP
);

CREATE INDEX idx_admin_notifications_status ON admin_notifications(status, created_at DESC);

-- ============================================================================
-- USEFUL VIEWS FOR ADMIN DASHBOARD
-- ============================================================================

-- View: Current pending orders
CREATE OR REPLACE VIEW pending_orders AS
SELECT 
  order_id,
  customer_phone,
  items,
  status,
  created_at,
  EXTRACT(MINUTE FROM NOW() - created_at) as minutes_pending
FROM orders
WHERE status IN ('created', 'confirmed', 'sent_to_shop')
ORDER BY created_at ASC;

-- View: Daily summary
CREATE OR REPLACE VIEW daily_summary AS
SELECT 
  DATE(created_at) as date,
  COUNT(*) as total_orders,
  COUNT(*) FILTER (WHERE status = 'confirmed') as confirmed,
  COUNT(*) FILTER (WHERE status = 'ready') as ready,
  COUNT(*) FILTER (WHERE status = 'failed') as failed,
  COUNT(*) FILTER (WHERE status = 'cancelled') as cancelled
FROM orders
GROUP BY DATE(created_at)
ORDER BY date DESC;

-- ============================================================================
-- SETUP QUERIES FOR NEW INSTANCE
-- ============================================================================

/*

After running the schema creation:

1. Enable RLS (Row Level Security) - optional but recommended:

ALTER TABLE orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_dedup ENABLE ROW LEVEL SECURITY;
ALTER TABLE order_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE admin_notifications ENABLE ROW LEVEL SECURITY;

-- Allow inserts (from app)
CREATE POLICY "Allow inserts" ON orders FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Allow updates" ON orders FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Allow selects" ON orders FOR SELECT TO authenticated USING (true);

-- Similar for other tables...

2. Check constraints are working:

INSERT INTO orders (order_id, customer_phone, items) 
VALUES ('TEST1', '25479123456789', 'Sugar, Rice');
-- Should succeed

INSERT INTO orders (order_id, customer_phone, items) 
VALUES ('TEST2', '254791234567899', 'Sugar'); 
-- Should FAIL - phone too long

3. Test deduplication:

INSERT INTO orders (order_id, customer_phone, items, status) 
VALUES ('TEST3', '25479123456789', 'Sugar', 'created');
-- Should succeed

INSERT INTO orders (order_id, customer_phone, items, status) 
VALUES ('TEST4', '25479123456789', 'Rice', 'created');
-- Should FAIL - same customer, same minute, status='created'
-- (This prevents accidental duplicate orders from retry)

*/
