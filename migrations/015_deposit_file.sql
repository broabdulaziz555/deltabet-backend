-- Store receipt file as base64 data URI (PDF/image)
ALTER TABLE deposits ADD COLUMN IF NOT EXISTS cheque_file TEXT;

-- Rename: cheque_ref now stores filename instead of text ref
-- Existing rows keep their text value as filename
-- Index for admin search still works on cheque_ref
COMMENT ON COLUMN deposits.cheque_ref IS 'Original filename of uploaded receipt';
COMMENT ON COLUMN deposits.cheque_file IS 'Base64 data URI of receipt file (max 20MB)';
