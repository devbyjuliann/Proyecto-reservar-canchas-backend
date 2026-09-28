export async function up({ context: connection }) {
  await connection.query(`
    ALTER TABLE bookings
      ADD CONSTRAINT chk_bookings_price_pair CHECK (
        (price_amount_minor IS NULL AND price_currency IS NULL)
        OR (price_amount_minor IS NOT NULL AND price_currency IS NOT NULL)
      )
  `);
}

export async function down({ context: connection }) {
  await connection.query('ALTER TABLE bookings DROP CONSTRAINT chk_bookings_price_pair');
}
