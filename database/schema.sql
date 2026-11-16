-- GERDEV AI WORKFORCE - Skema instalasi V1.0 (PostgreSQL / Neon)
-- Aman dijalankan berulang (IF NOT EXISTS). Dapat ditempel utuh di Neon SQL Editor.
-- Database ini HARUS terpisah dari database proyek lain (mis. KASIRPRO).

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  slug text NOT NULL UNIQUE,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner','admin','manager','viewer')),
  active boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email));
CREATE INDEX IF NOT EXISTS users_workspace_idx ON users (workspace_id);

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash text NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  csrf_token text NOT NULL,
  ip text,
  user_agent text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS rate_limits (
  key text NOT NULL,
  window_start timestamptz NOT NULL,
  count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);

CREATE TABLE IF NOT EXISTS departments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS business_units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  description text,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, code)
);

CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  avatar text,
  title text NOT NULL,
  department text,
  description text,
  goal text,
  system_prompt text NOT NULL,
  skills text[] NOT NULL DEFAULT '{}',
  tools text[] NOT NULL DEFAULT '{}',
  permissions jsonb NOT NULL DEFAULT '{}'::jsonb,
  provider text NOT NULL DEFAULT 'openai' CHECK (provider IN ('openai','alt')),
  model text,
  max_tokens_per_run integer NOT NULL DEFAULT 2000 CHECK (max_tokens_per_run BETWEEN 200 AND 16000),
  monthly_token_limit bigint,
  monthly_cost_limit_usd numeric(10,2),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  role_key text,
  is_manager boolean NOT NULL DEFAULT false,
  reports_to uuid REFERENCES agents(id) ON DELETE SET NULL,
  template_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);
CREATE INDEX IF NOT EXISTS agents_ws_idx ON agents (workspace_id, status);
CREATE INDEX IF NOT EXISTS agents_role_idx ON agents (workspace_id, role_key);

CREATE TABLE IF NOT EXISTS customers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  name text NOT NULL,
  business_name text,
  category text,
  whatsapp text,
  email text,
  address text,
  website text,
  notes text,
  lead_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_ws_idx ON customers (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS leads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  business_name text NOT NULL,
  contact_name text,
  category text,
  whatsapp text,
  address text,
  website text,
  has_website boolean,
  source text,
  source_url text,
  evidence text,
  status text NOT NULL DEFAULT 'baru' CHECK (status IN ('baru','dihubungi','tertarik','penawaran','negosiasi','menang','kalah','tidak_cocok')),
  potential_value numeric(14,2),
  priority integer NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  notes text,
  verified boolean NOT NULL DEFAULT false,
  dedupe_key text NOT NULL,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS leads_ws_idx ON leads (workspace_id, priority DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS communications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  lead_id uuid REFERENCES leads(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  channel text NOT NULL DEFAULT 'catatan',
  direction text NOT NULL DEFAULT 'internal' CHECK (direction IN ('in','out','internal')),
  content text NOT NULL,
  status text NOT NULL DEFAULT 'tercatat',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS comms_lead_idx ON communications (lead_id);
CREATE INDEX IF NOT EXISTS comms_customer_idx ON communications (customer_id);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  name text NOT NULL,
  sku text,
  description text,
  type text NOT NULL DEFAULT 'jasa',
  price numeric(14,2) NOT NULL DEFAULT 0 CHECK (price >= 0),
  cost numeric(14,2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_ws_idx ON products (workspace_id, active);

CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  order_no text NOT NULL,
  status text NOT NULL DEFAULT 'confirmed' CHECK (status IN ('draft','pending_approval','confirmed','in_progress','completed','cancelled')),
  payment_status text NOT NULL DEFAULT 'unpaid' CHECK (payment_status IN ('unpaid','partial','paid','refunded')),
  total numeric(14,2) NOT NULL DEFAULT 0,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  notes text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, order_no)
);
CREATE INDEX IF NOT EXISTS orders_ws_idx ON orders (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS order_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id) ON DELETE SET NULL,
  name text NOT NULL,
  qty numeric(12,2) NOT NULL CHECK (qty > 0),
  price numeric(14,2) NOT NULL CHECK (price >= 0)
);
CREATE INDEX IF NOT EXISTS order_items_order_idx ON order_items (order_id);

CREATE TABLE IF NOT EXISTS quotations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  lead_id uuid REFERENCES leads(id) ON DELETE SET NULL,
  number text NOT NULL,
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total numeric(14,2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','sent','accepted','rejected')),
  notes text,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, number)
);

CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  customer_id uuid REFERENCES customers(id) ON DELETE SET NULL,
  invoice_no text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_approval','issued','paid','void')),
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  total numeric(14,2) NOT NULL DEFAULT 0,
  due_date date,
  issued_at timestamptz,
  notes text,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, invoice_no)
);

CREATE TABLE IF NOT EXISTS transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  type text NOT NULL CHECK (type IN ('income','expense')),
  category text NOT NULL DEFAULT 'lainnya',
  amount numeric(14,2) NOT NULL CHECK (amount > 0),
  currency text NOT NULL DEFAULT 'IDR',
  description text,
  order_id uuid REFERENCES orders(id) ON DELETE SET NULL,
  invoice_id uuid REFERENCES invoices(id) ON DELETE SET NULL,
  source text NOT NULL DEFAULT 'manual',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tx_ws_idx ON transactions (workspace_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  title text NOT NULL,
  description text,
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('once','minutes','hourly','daily','weekly')),
  interval_minutes integer CHECK (interval_minutes IS NULL OR interval_minutes >= 5),
  next_run_at timestamptz,
  last_run_at timestamptz,
  run_count integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
  priority integer NOT NULL DEFAULT 5,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS schedules_due_idx ON schedules (next_run_at) WHERE enabled;

CREATE TABLE IF NOT EXISTS tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE SET NULL,
  parent_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  root_task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  schedule_id uuid REFERENCES schedules(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'work' CHECK (kind IN ('goal','work','qa')),
  title text NOT NULL,
  description text,
  assigned_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','pending_deps','waiting_children','in_qa','review','done','failed','blocked','cancelled')),
  priority integer NOT NULL DEFAULT 5 CHECK (priority BETWEEN 1 AND 10),
  depth integer NOT NULL DEFAULT 0,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb,
  error text,
  attempts integer NOT NULL DEFAULT 0,
  max_attempts integer NOT NULL DEFAULT 3,
  revisions integer NOT NULL DEFAULT 0,
  timeout_seconds integer NOT NULL DEFAULT 55,
  qa_status text CHECK (qa_status IN ('pass','fail')),
  scheduled_for timestamptz,
  locked_at timestamptz,
  locked_by text,
  started_at timestamptz,
  finished_at timestamptz,
  dedupe_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_ws_status_idx ON tasks (workspace_id, status);
CREATE INDEX IF NOT EXISTS tasks_queue_idx ON tasks (priority DESC, created_at) WHERE status = 'queued';
CREATE INDEX IF NOT EXISTS tasks_parent_idx ON tasks (parent_task_id);
CREATE INDEX IF NOT EXISTS tasks_root_idx ON tasks (root_task_id);
CREATE INDEX IF NOT EXISTS tasks_agent_idx ON tasks (assigned_agent_id);
CREATE UNIQUE INDEX IF NOT EXISTS tasks_dedupe_uq ON tasks (workspace_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS task_dependencies (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  depends_on_task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);
CREATE INDEX IF NOT EXISTS task_deps_on_idx ON task_dependencies (depends_on_task_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed','timeout')),
  phase text,
  model text,
  steps integer NOT NULL DEFAULT 0,
  output jsonb,
  error text,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  duration_ms integer,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS runs_agent_idx ON agent_runs (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS runs_task_idx ON agent_runs (task_id);
CREATE INDEX IF NOT EXISTS runs_ws_idx ON agent_runs (workspace_id, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  from_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  to_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  from_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  kind text NOT NULL DEFAULT 'message' CHECK (kind IN ('message','delegation','report','review','owner')),
  content text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_ws_idx ON agent_messages (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS messages_task_idx ON agent_messages (task_id);

CREATE TABLE IF NOT EXISTS agent_memories (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  scope text NOT NULL CHECK (scope IN ('agent_short','agent_long','company','business','task','customer')),
  agent_id uuid REFERENCES agents(id) ON DELETE CASCADE,
  business_unit_id uuid REFERENCES business_units(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  customer_id uuid REFERENCES customers(id) ON DELETE CASCADE,
  content text NOT NULL,
  importance integer NOT NULL DEFAULT 5 CHECK (importance BETWEEN 1 AND 10),
  expires_at timestamptz,
  tsv tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memories_tsv_idx ON agent_memories USING gin (tsv);
CREATE INDEX IF NOT EXISTS memories_ws_idx ON agent_memories (workspace_id, scope);
CREATE INDEX IF NOT EXISTS memories_agent_idx ON agent_memories (agent_id);

CREATE TABLE IF NOT EXISTS tools (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text NOT NULL,
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  permission text NOT NULL DEFAULT 'read' CHECK (permission IN ('read','write','external')),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE IF NOT EXISTS tool_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  tool_name text NOT NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE CASCADE,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  input jsonb,
  output jsonb,
  status text NOT NULL CHECK (status IN ('success','error','denied')),
  error text,
  duration_ms integer,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tool_logs_ws_idx ON tool_logs (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS tool_logs_task_idx ON tool_logs (task_id);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  action_type text NOT NULL CHECK (action_type IN ('send_message','send_quotation','issue_invoice','deploy_website','purchase_service','make_payment','change_important_data','accept_order')),
  title text NOT NULL,
  description text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','review')),
  requested_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  requested_by_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  decided_by uuid REFERENCES users(id) ON DELETE SET NULL,
  decided_at timestamptz,
  decision_note text,
  executed_at timestamptz,
  execution_result jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_ws_idx ON approvals (workspace_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS api_usage (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  run_id uuid REFERENCES agent_runs(id) ON DELETE SET NULL,
  provider text NOT NULL,
  model text NOT NULL,
  prompt_tokens integer NOT NULL DEFAULT 0,
  completion_tokens integer NOT NULL DEFAULT 0,
  cost_usd numeric(12,6) NOT NULL DEFAULT 0,
  cost_estimated boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS usage_ws_idx ON api_usage (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS usage_agent_idx ON api_usage (agent_id, created_at DESC);

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('openai','alt_ai','web_search','database','email','whatsapp','storage')),
  enabled boolean NOT NULL DEFAULT true,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_test_at timestamptz,
  last_status text,
  last_error text,
  UNIQUE (workspace_id, kind)
);

CREATE TABLE IF NOT EXISTS files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  task_id uuid REFERENCES tasks(id) ON DELETE SET NULL,
  name text NOT NULL,
  mime text NOT NULL DEFAULT 'text/plain',
  content text NOT NULL,
  size integer NOT NULL DEFAULT 0,
  created_by_agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS files_ws_idx ON files (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS files_task_idx ON files (task_id);

CREATE TABLE IF NOT EXISTS audit_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  agent_id uuid REFERENCES agents(id) ON DELETE SET NULL,
  action text NOT NULL,
  entity text,
  entity_id text,
  details jsonb,
  ip text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_ws_idx ON audit_logs (workspace_id, created_at DESC);

INSERT INTO schema_migrations (version) VALUES ('001_init') ON CONFLICT DO NOTHING;
