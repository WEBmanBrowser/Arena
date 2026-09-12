/**
 * Transactional checkpoint for supplier-import row processing.
 *
 * Production: intentional no-op.
 * Tests may mock this boundary to pause or fail a worker while it is inside
 * the current batch transaction, without coupling recovery semantics to
 * pricing or any particular row implementation.
 */
export async function supplierImportApplyCheckpoint(): Promise<void> {
  // Intentionally empty.
}
