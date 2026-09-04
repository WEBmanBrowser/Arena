CREATE TABLE IF NOT EXISTS supplier_import_profiles (
  id SERIAL PRIMARY KEY,
  supplier_id INTEGER NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  mapping JSONB NOT NULL DEFAULT '{}',
  delimiter VARCHAR(10),
  created_by INTEGER REFERENCES users(id),
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS sip_supplier_unique ON supplier_import_profiles(supplier_id);
CREATE INDEX IF NOT EXISTS sip_supplier_idx ON supplier_import_profiles(supplier_id);
